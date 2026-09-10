import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { dirname, join } from "node:path";
import { composeCourseBuildPrompt } from "../app/course-prompts";
import { getSystemPrompt, renderSystemPrompt } from "../app/system-prompts";
import { readSystemPromptOverrides } from "./system-prompt-store";
import { acquireYouTubeTranscript } from "./transcript-acquisition";
import { VidmarkDatabase } from "./vidmark-db";

const PROVIDER_PORT = 31418;
const KEYCHAIN_SERVICE = "com.vidmark.model-provider";

type ProviderKind = "local" | "openrouter";
type ProviderSettings = {
  configured: boolean;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  enableWebSearch: boolean;
  updatedAt: number;
};
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type BuildJob = { id: string; courseId: string; status: "queued" | "running" | "complete" | "failed"; phase: string; message: string; startedAt: number; updatedAt: number; error?: string };

const defaultSettings = (): ProviderSettings => ({ configured: false, provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "", enableWebSearch: false, updatedAt: Date.now() });
const buildJobs = new Map<string, BuildJob>();

const normalizeBaseUrl = (value: string) => {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Model host must use http:// or https://.");
  if (parsed.username || parsed.password) throw new Error("Do not place credentials in the model host URL.");
  return parsed.toString().replace(/\/$/, "").replace(/\/chat\/completions$/, "");
};

const keychainAccount = (provider: ProviderKind) => `vidmark-${provider}`;

const readKey = async (provider: ProviderKind) => {
  const process = Bun.spawn(["/usr/bin/security", "find-generic-password", "-a", keychainAccount(provider), "-s", KEYCHAIN_SERVICE, "-w"], { stdout: "pipe", stderr: "ignore" });
  const value = (await new Response(process.stdout).text()).trim();
  return (await process.exited) === 0 ? value : "";
};

const writeKey = async (provider: ProviderKind, value: string) => {
  const process = Bun.spawn(["/usr/bin/security", "add-generic-password", "-U", "-a", keychainAccount(provider), "-s", KEYCHAIN_SERVICE, "-w", value], { stdout: "ignore", stderr: "pipe" });
  const error = (await new Response(process.stderr).text()).trim();
  if ((await process.exited) !== 0) throw new Error(error || "The API key could not be saved to macOS Keychain.");
};

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return fallback; }
};

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const providerHeaders = async (settings: ProviderSettings) => {
  const apiKey = await readKey(settings.provider);
  if (settings.provider === "openrouter" && !apiKey) throw new Error("Add an OpenRouter API key before connecting.");
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(settings.provider === "openrouter" ? { "HTTP-Referer": "https://vidmark.local", "X-OpenRouter-Title": "Vidmark" } : {}),
  };
};

const parseProviderError = async (response: Response) => {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    return typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? body;
  } catch { return body || `Provider returned HTTP ${response.status}.`; }
};

const listModels = async (settings: ProviderSettings) => {
  const response = await fetch(`${settings.baseUrl}/models`, { headers: await providerHeaders(settings), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await parseProviderError(response));
  const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; model?: string }> };
  const models = payload.data?.map((item) => item.id).filter(Boolean) ?? payload.models?.map((item) => item.name ?? item.model).filter(Boolean) ?? [];
  return [...new Set(models as string[])].sort((left, right) => left.localeCompare(right));
};

const callModel = async (settings: ProviderSettings, messages: ChatMessage[], tools?: unknown[], maxTokens = 4096, toolChoice: "auto" | "required" = "auto") => {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: await providerHeaders(settings),
    body: JSON.stringify({ model: settings.model, messages, temperature: 0.2, max_tokens: maxTokens, ...(tools?.length ? { tools, tool_choice: toolChoice } : {}) }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(await parseProviderError(response));
  const payload = await response.json() as { choices?: Array<{ message?: ChatMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("The selected model returned no assistant message.");
  return message;
};

const updateJob = (job: BuildJob, phase: string, message: string) => {
  Object.assign(job, { phase, message, status: "running" as const, updatedAt: Date.now() });
};

const localTools = [
  { type: "function", function: { name: "get_course", description: "Read the selected course metadata and existing generated artifacts.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "get_transcript", description: "Read timestamped transcript cues in bounded pages.", parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["offset", "limit"], additionalProperties: false } } },
  { type: "function", function: { name: "acquire_course_transcript", description: "Retrieve the selected course video's public YouTube caption track, preserve timestamps, and save it locally. Call this when get_transcript reports zero cues.", parameters: { type: "object", properties: { preferredLanguage: { type: "string", description: "Preferred BCP 47 language code, such as en or es." } }, additionalProperties: false } } },
  { type: "function", function: { name: "fetch_url", description: "Fetch an authoritative HTTP(S) documentation page for verification. Supply the exact primary-source URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "run_subagent", description: "Run an isolated specialist model context for bounded research, chapter, assessment, visual-reference, or QA work.", parameters: { type: "object", properties: { role: { type: "string" }, task: { type: "string" }, context: { type: "string" } }, required: ["role", "task", "context"], additionalProperties: false } } },
  { type: "function", function: { name: "save_course_build", description: "Save reviewed course artifacts to Vidmark's SQLite database. chapters and questions must be non-empty arrays; conceptGraph must contain nodes and edges.", parameters: { type: "object", properties: { studyGuide: { type: "string" }, researchNotes: { type: "string" }, chapters: { type: "array", items: { type: "object" } }, questions: { type: "array", items: { type: "object" } }, conceptGraph: { type: "object", properties: { schemaVersion: { type: "string" }, nodes: { type: "array", items: { type: "object" } }, edges: { type: "array", items: { type: "object" } } }, required: ["nodes", "edges"], additionalProperties: true } }, required: ["studyGuide", "researchNotes", "chapters", "questions", "conceptGraph"], additionalProperties: false } } },
];

const isPrivateAddress = (address: string) => {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const parts = ipv4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
};

const assertPublicResearchUrl = async (url: URL) => {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) documentation URLs can be fetched.");
  if (url.username || url.password) throw new Error("Documentation URLs cannot contain credentials.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("Documentation fetches cannot target local services.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Documentation fetches cannot target private or loopback networks.");
};

const safeFetchUrl = async (rawUrl: string) => {
  let url = new URL(rawUrl);
  let response: Response | null = null;
  for (let redirect = 0; redirect < 4; redirect += 1) {
    await assertPublicResearchUrl(url);
    response = await fetch(url, { headers: { "User-Agent": "Vidmark/1.0 course research" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    url = new URL(location, url);
  }
  if (!response) throw new Error("Documentation fetch failed before a response was received.");
  if (!response.ok) throw new Error(`Documentation fetch returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !/text|json|xml|html/.test(contentType)) throw new Error("Documentation fetch returned an unsupported binary content type.");
  return (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 30_000);
};

const runBuild = async (job: BuildJob, settings: ProviderSettings, databasePath: string, systemPromptsPath: string) => {
  const store = new VidmarkDatabase(databasePath);
  try {
    const storedPrompts = await readSystemPromptOverrides(systemPromptsPath);
    const promptOverrides = storedPrompts.overrides;
    const course = store.getCourse(job.courseId);
    if (!course) throw new Error("The selected course is not available to the local agent.");
    updateJob(job, "Starting coordinator", `Running ${settings.model} with the master and course-specific prompts.${!course.videoUrl ? " The coordinator will read the course source; no transcript is required." : course.transcript?.length ? "" : " The coordinator will acquire public captions before building."}`);
    const messages: ChatMessage[] = [{ role: "user", content: `${composeCourseBuildPrompt(String(course.title), String(course.id), String(course.coursePrompt), String(course.promptCredit), getSystemPrompt("courseBuilderMaster", promptOverrides))}\n\n${getSystemPrompt("coordinatorRuntime", promptOverrides)}` }];
    const tools: unknown[] = [...localTools, ...(settings.provider === "openrouter" && settings.enableWebSearch ? [{ type: "openrouter:web_search", max_total_results: 10, search_context_size: "high" }] : [])];
    let saved = false;

    for (let turn = 0; turn < 40 && !saved; turn += 1) {
      updateJob(job, `Agent turn ${turn + 1}`, "The coordinator is reading evidence or delegating specialist work.");
      const assistant = await callModel(settings, messages, tools, 8192);
      messages.push(assistant);
      const calls = assistant.tool_calls ?? [];
      if (!calls.length) {
        if (assistant.content?.trim()) messages.push({ role: "user", content: getSystemPrompt("coordinatorContinue", promptOverrides) });
        continue;
      }

      for (const call of calls) {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        let result: unknown;
        if (call.function.name === "get_course") {
          result = { id: course.id, title: course.title, sourceUrl: course.sourceUrl, videoUrl: course.videoUrl, coursePrompt: course.coursePrompt, promptCredit: course.promptCredit, transcriptCues: course.transcript.length, existing: { chapters: course.chapters?.length ?? 0, questions: course.questions?.length ?? 0, hasStudyGuide: Boolean(course.studyGuide) } };
        } else if (call.function.name === "get_transcript") {
          const offset = Math.max(0, Number(args.offset ?? 0));
          const limit = Math.min(500, Math.max(1, Number(args.limit ?? 250)));
          result = { offset, total: course.transcript.length, cues: course.transcript.slice(offset, offset + limit) };
        } else if (call.function.name === "acquire_course_transcript") {
          if (!course.videoUrl) { messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Non-video course: read sourceUrl with fetch_url instead. No transcript is required." }) }); continue; }
          updateJob(job, "Acquiring transcript", "Retrieving the video's public timestamped YouTube captions.");
          const acquired = await acquireYouTubeTranscript(String(course.videoUrl ?? course.videoId ?? course.id), String(args.preferredLanguage ?? "en"));
          store.replaceTranscript(String(course.id), acquired.cues);
          course.transcript = acquired.cues;
          result = { saved: true, cues: acquired.cues.length, videoId: acquired.videoId, language: acquired.language, trackName: acquired.trackName, automaticallyGenerated: acquired.automaticallyGenerated, sourceUrl: acquired.sourceUrl, acquiredAt: acquired.acquiredAt };
        } else if (call.function.name === "fetch_url") {
          updateJob(job, "Verifying source", String(args.url ?? "Authoritative documentation"));
          result = { url: args.url, content: await safeFetchUrl(String(args.url ?? "")), accessedAt: new Date().toISOString() };
        } else if (call.function.name === "run_subagent") {
          updateJob(job, `Specialist · ${String(args.role ?? "course work")}`, String(args.task ?? "Working in an isolated context."));
          const specialist = await callModel(settings, [{ role: "system", content: renderSystemPrompt("specialist", promptOverrides, { role: String(args.role) }) }, { role: "user", content: `${String(args.task)}\n\nContext:\n${String(args.context).slice(0, 80_000)}` }], settings.provider === "openrouter" && settings.enableWebSearch ? [{ type: "openrouter:web_search", max_total_results: 8, search_context_size: "high" }] : undefined, 8192);
          result = specialist.content ?? "The specialist returned no text.";
        } else if (call.function.name === "save_course_build") {
          const chapters = Array.isArray(args.chapters) ? args.chapters : [];
          const questions = Array.isArray(args.questions) ? args.questions : [];
          const conceptGraph = args.conceptGraph && typeof args.conceptGraph === "object" && !Array.isArray(args.conceptGraph) ? args.conceptGraph : null;
          if (!chapters.length || !questions.length) throw new Error("The agent tried to save an empty chapter or question collection.");
          if (!conceptGraph) throw new Error("The agent tried to save a course without its concept graph.");
          store.upsertCourse({ id: String(course.id), title: String(course.title), source: String(course.source), videoUrl: String(course.videoUrl), originPrompt: String(course.coursePrompt), promptCredit: String(course.promptCredit), studyGuide: String(args.studyGuide ?? ""), researchNotes: String(args.researchNotes ?? "") });
          store.replaceChapters(String(course.id), chapters);
          store.replaceQuestions(String(course.id), questions);
          store.saveConceptGraph(String(course.id), conceptGraph);
          result = { saved: true, database: databasePath, chapters: chapters.length, questions: questions.length, conceptGraph: store.getConceptGraph(String(course.id))?.revision };
          saved = true;
        } else {
          result = { error: `Unknown tool ${call.function.name}.` };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    if (!saved) throw new Error("The model reached the agent-turn limit without saving a reviewed course.");
    Object.assign(job, { status: "complete" as const, phase: "Course saved", message: "The agent saved the reviewed course artifacts to Vidmark.", updatedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The course build failed.";
    Object.assign(job, { status: "failed" as const, phase: "Build stopped", message, error: message, updatedAt: Date.now() });
  } finally {
    store.close();
  }
};

export function startModelProviderServer(settingsPath: string, databasePath: string, systemPromptsPath = join(dirname(settingsPath), "system-prompts.json"), port = PROVIDER_PORT) {
  const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin");
    const allowed = origin === "http://127.0.0.1:3010" ? origin : "http://localhost:3010";
    return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = corsHeaders(request);
      const host = request.headers.get("host")?.split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return Response.json({ error: "Invalid Host header." }, { status: 403, headers });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      try {
        const settings = await readJson(settingsPath, defaultSettings());
        if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, name: "vidmark-model-provider" }, { headers });
        if (request.method === "GET" && url.pathname === "/settings") return Response.json({ ...settings, hasApiKey: Boolean(await readKey(settings.provider)) }, { headers });
        if (request.method === "PUT" && url.pathname === "/settings") {
          const input = await request.json() as Partial<ProviderSettings> & { apiKey?: string };
          const provider: ProviderKind = input.provider === "openrouter" ? "openrouter" : "local";
          const baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : normalizeBaseUrl(String(input.baseUrl ?? ""));
          const model = String(input.model ?? "").trim();
          if (!model) throw new Error("Choose or enter a model ID.");
          if (input.apiKey?.trim()) await writeKey(provider, input.apiKey.trim());
          if (provider === "openrouter" && !(input.apiKey?.trim() || await readKey(provider))) throw new Error("An OpenRouter API key is required.");
          const next: ProviderSettings = { configured: true, provider, baseUrl, model, enableWebSearch: provider === "openrouter" && Boolean(input.enableWebSearch), updatedAt: Date.now() };
          await writeJson(settingsPath, next);
          return Response.json({ ...next, hasApiKey: Boolean(await readKey(provider)) }, { headers });
        }
        if (request.method === "GET" && url.pathname === "/models") {
          return Response.json({ models: await listModels(settings) }, { headers });
        }
        if (request.method === "POST" && url.pathname === "/test") {
          if (!settings.configured) throw new Error("Save provider settings before testing the connection.");
          const probe = [{ type: "function", function: { name: "confirm_vidmark_connection", description: "Confirm that this model can participate in Vidmark's agent tool loop.", parameters: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false } } }];
          const storedPrompts = await readSystemPromptOverrides(systemPromptsPath);
          const message = await callModel(settings, [{ role: "user", content: getSystemPrompt("connectionProbe", storedPrompts.overrides) }], probe, 512, "required");
          if (!message.tool_calls?.some((call) => call.function.name === "confirm_vidmark_connection")) throw new Error("The host responded, but this model did not complete the required tool-call test. Choose a tool-capable model for course builds.");
          return Response.json({ ok: true, model: settings.model, response: "Connection ready · tool calling verified" }, { headers });
        }
        if (request.method === "POST" && url.pathname === "/build") {
          if (!settings.configured) throw new Error("Configure a model before starting a course build.");
          const { courseId } = await request.json() as { courseId?: string };
          if (!courseId) throw new Error("Choose a course before starting a build.");
          const job: BuildJob = { id: crypto.randomUUID(), courseId, status: "queued", phase: "Queued", message: "Preparing the course coordinator.", startedAt: Date.now(), updatedAt: Date.now() };
          buildJobs.set(job.id, job);
          void runBuild(job, settings, databasePath, systemPromptsPath);
          return Response.json(job, { status: 202, headers });
        }
        if (request.method === "GET" && url.pathname.startsWith("/build/")) {
          const job = buildJobs.get(url.pathname.slice("/build/".length));
          if (!job) return Response.json({ error: "Build job not found." }, { status: 404, headers });
          return Response.json(job, { headers });
        }
        return Response.json({ error: "Not found" }, { status: 404, headers });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Model provider request failed." }, { status: 400, headers });
      }
    },
  });
  console.log(`Vidmark model provider is listening at http://127.0.0.1:${server.port}`);
  return server;
}
