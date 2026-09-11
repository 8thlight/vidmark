import { createHash } from "node:crypto";
import * as z from "zod";
import { questionSchema, chapterSchema, questionReviewSchema, buildRequirementsSchema, validateQuestion } from "./course-artifacts";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { safeFetchUrl } from "./research-fetch";
import { CourseReviewEvidence } from "./course-review-evidence";
import { dirname, join } from "node:path";
import { composeCourseBuildPrompt } from "../app/course-prompts";
import { getSystemPrompt, renderSystemPrompt } from "../app/system-prompts";
import { readSystemPromptOverrides } from "./system-prompt-store";
import { acquireYouTubeTranscript } from "./transcript-acquisition";
import { VidmarkDatabase } from "./vidmark-db";
import { DebugLog } from "./debug-log";
import { researchFetchResult } from "./research-fetch-result";
import { agentPreferencesSchema, discoverHarness, readAgentPreferences, writeAgentPreferences } from "./agent-harness";
import { describeAgentSelection } from "../app/agent-harness";
import { runCliCourseBuild, type BuildJob } from "./cli-course-build";
import { runQuestionFactCheck, type FactCheckJob } from "./question-fact-check";

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

const defaultSettings = (): ProviderSettings => ({ configured: false, provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "", enableWebSearch: false, updatedAt: Date.now() });

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

const callModel = async (settings: ProviderSettings, messages: ChatMessage[], tools?: unknown[], maxTokens = 4096, toolChoice: "auto" | "required" = "auto", signal?: AbortSignal) => {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: await providerHeaders(settings),
    body: JSON.stringify({ model: settings.model, messages, temperature: 0.2, max_tokens: maxTokens, ...(tools?.length ? { tools, tool_choice: toolChoice } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
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

const artifactPageSchema = z.object({ artifact: z.enum(["studyGuide", "researchNotes", "chapters", "conceptGraph"]), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12000).default(12000) });
const questionPageSchema = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) });

const localTools = [
  { type: "function", function: { name: "set_course_build_requirements", description: "Record the user's requested quantity and chapter coverage before authoring. Omit quantity only when none was requested.", parameters: z.toJSONSchema(buildRequirementsSchema) } },
  { type: "function", function: { name: "get_course_question", description: "Read a saved question and its current revision before QA.", parameters: { type: "object", properties: { questionId: { type: "string" } }, required: ["questionId"] } } },
  { type: "function", function: { name: "upsert_course_question", description: "Before the first complete save, stage questions without changing the library. Commit staged questions by omitting questions in save_course_build. After saving, only exact-revision edits of active questions are allowed. Save a single schema-valid question incrementally. Does not mark the whole build complete.", parameters: { type: "object", properties: { question: z.toJSONSchema(questionSchema), expectedRevision: { type: "integer" } }, required: ["question"] } } },
  { type: "function", function: { name: "record_question_review", description: "Optionally record QA of an exact saved question revision after inspecting original evidence. Not required to save.", parameters: { type: "object", properties: { questionId: { type: "string" }, expectedRevision: { type: "integer" }, review: z.toJSONSchema(questionReviewSchema) }, required: ["questionId", "expectedRevision", "review"] } } },
  { type: "function", function: { name: "get_course", description: "Read the selected course metadata and existing generated artifacts.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "get_course_artifact", description: "Read a saved artifact as paginated JSON text before updating a course. Concatenate content pages until nextOffset is null, then parse JSON. The revision identifies changes between pages; restart reading if it changes.", parameters: z.toJSONSchema(artifactPageSchema) } },
  { type: "function", function: { name: "list_course_questions", description: "Read the active saved question bank in pages before updating a course. Use get_course_question for an exact question read before QA.", parameters: z.toJSONSchema(questionPageSchema) } },
  { type: "function", function: { name: "get_transcript", description: "Read timestamped transcript cues in bounded pages.", parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["offset", "limit"], additionalProperties: false } } },
  { type: "function", function: { name: "acquire_course_transcript", description: "Retrieve the selected course video's public YouTube caption track, preserve timestamps, and save it locally. Call this when get_transcript reports zero cues.", parameters: { type: "object", properties: { preferredLanguage: { type: "string", description: "Preferred BCP 47 language code, such as en or es." } }, additionalProperties: false } } },
  { type: "function", function: { name: "fetch_url", description: "Fetch an authoritative HTTP(S) documentation page for verification. Supply the exact primary-source URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "run_subagent", description: "Run an isolated specialist model context for bounded research, chapter, assessment, visual-reference, or QA work.", parameters: { type: "object", properties: { role: { type: "string" }, task: { type: "string" }, context: { type: "string" } }, required: ["role", "task", "context"], additionalProperties: false } } },
  { type: "function", function: { name: "save_course_build", description: "Save schema-valid course artifacts; questions without QA remain unreviewed. Save course artifacts to Vidmark's SQLite database. Stage questions with upsert_course_question, then omit questions here to commit the staged bank atomically. Supplied chapters/questions must be non-empty; conceptGraph must contain nodes and edges.", parameters: { type: "object", properties: { studyGuide: { type: "string" }, researchNotes: { type: "string" }, chapters: { type: "array", items: z.toJSONSchema(chapterSchema) }, questions: { type: "array", items: z.toJSONSchema(questionSchema) }, conceptGraph: { type: "object", properties: { schemaVersion: { type: "string" }, nodes: { type: "array", items: { type: "object" } }, edges: { type: "array", items: { type: "object" } } }, required: ["nodes", "edges"], additionalProperties: true } }, required: ["studyGuide", "researchNotes", "chapters", "conceptGraph"], additionalProperties: false } } },
];


export const runBuild = async (job: BuildJob, settings: ProviderSettings, databasePath: string, systemPromptsPath: string, debug: DebugLog, signal: AbortSignal, dependencies = { callModel, fetchResearch: (url: string, signal: AbortSignal) => researchFetchResult(url, value => safeFetchUrl(value, signal)) }) => {
  debug.record("build.started");
  const store = new VidmarkDatabase(databasePath);
  const reviewEvidence = new CourseReviewEvidence(id => store.getTranscript(id, undefined, 100000).cues);
  const stagedQuestions = new Map<string, ReturnType<typeof validateQuestion>>();
  let saved = false;
  try {
    const storedPrompts = await readSystemPromptOverrides(systemPromptsPath);
    const promptOverrides = storedPrompts.overrides;
    const artifactContract = getSystemPrompt("artifactContract", promptOverrides);
    const course = store.getCourse(job.courseId);
    if (!course) throw new Error("The selected course is not available to the local agent.");
    updateJob(job, "Starting coordinator", `Running ${settings.model} with the master and course-specific prompts.${!course.videoUrl ? " The coordinator will read the course source; no transcript is required." : course.transcript?.length ? "" : " The coordinator will acquire public captions before building."}`);
    const messages: ChatMessage[] = [{ role: "user", content: `${composeCourseBuildPrompt(String(course.title), String(course.id), String(course.coursePrompt), String(course.promptCredit), getSystemPrompt("courseBuilderMaster", promptOverrides))}\n\n${getSystemPrompt("coordinatorRuntime", promptOverrides)}` }];
    const tools: unknown[] = [...localTools, ...(settings.provider === "openrouter" && settings.enableWebSearch ? [{ type: "openrouter:web_search", max_total_results: 10, search_context_size: "high" }] : [])];
    job.transcriptCues = course.transcript.length;
    const sourceEvidence: Array<{ url: string; ok: boolean; accessedAt: string; contentHash?: string }> = [];
    const sourceTexts: string[] = [];
    messages.unshift({ role: "system", content: `Current date: ${new Date().toISOString().slice(0, 10)}. ${artifactContract}` });

    for (let turn = 0; turn < 40; turn += 1) {
      signal.throwIfAborted();
      updateJob(job, `Agent turn ${turn + 1}`, "The coordinator is reading evidence or delegating specialist work.");
      const modelStarted = Date.now();
      debug.record("model.started", turn + 1);
      const assistant = await dependencies.callModel(settings, messages, tools, 8192, "auto", signal);
      signal.throwIfAborted();
      debug.record("model.finished", turn + 1, Date.now() - modelStarted);
      messages.push(assistant);
      const calls = assistant.tool_calls ?? [];
      if (!calls.length) {
        if (saved) break;
        if (assistant.content?.trim()) messages.push({ role: "user", content: getSystemPrompt("coordinatorContinue", promptOverrides) });
        continue;
      }

      for (const call of calls) {
        const toolStarted = Date.now();
        debug.record("tool.started", turn + 1, undefined, call.function.name);
        let result: unknown;
        try {
          signal.throwIfAborted();
          const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          if (call.function.name === "set_course_build_requirements") {
            result = store.setBuildRequirements(String(course.id), buildRequirementsSchema.parse(args));
          } else if (call.function.name === "get_course_question") {
            const id = String(args.questionId);
            result = stagedQuestions.has(id) ? { staged: true, payload: stagedQuestions.get(id) } : reviewEvidence.readQuestion(store.getQuestion(String(course.id), id));
          } else if (call.function.name === "upsert_course_question") {
            const question = validateQuestion(args.question);
            const expectedRevision = args.expectedRevision === undefined ? undefined : z.number().int().min(1).parse(args.expectedRevision);
            const current = store.getQuestion(String(course.id), question.id);
            if (current?.archived) throw new Error("Archived questions cannot be edited by a build.");
            if (current && expectedRevision === undefined) throw new Error("Read the existing question and supply expectedRevision before editing it.");
            if (current && current.revision !== expectedRevision) throw new Error("Question revision conflict. Read the latest question first.");
            if (!saved) {
              if (!stagedQuestions.has(question.id) && stagedQuestions.size >= 1000) throw new Error("A build can stage at most 1000 questions.");
              stagedQuestions.set(question.id, question);
              result = { staged: true, savedToLibrary: false, stagedCount: stagedQuestions.size };
            } else {
              const questions = store.listQuestions(String(course.id), { limit: 1000 }).questions.map(q => q.id === question.id ? question : q.payload);
              if (!current || expectedRevision === undefined) throw new Error("After saving, only existing questions can be edited. Start a new complete build to add questions.");
              result = store.saveCourseBuild(String(course.id), { questions }, { id: question.id, expectedRevision });
            }
          } else if (call.function.name === "record_question_review") {
            const questionId = String(args.questionId);
            if (stagedQuestions.has(questionId)) throw new Error("Commit staged questions before recording their QA.");
            const revision = z.number().int().min(1).parse(args.expectedRevision);
            result = store.reviewQuestion(String(course.id), questionId, revision, reviewEvidence.validate(questionId, revision, args.review), "local-model");
          } else if (call.function.name === "get_course") {
            Object.assign(course, store.getCourse(job.courseId));
            result = { id: course.id, title: course.title, sourceUrl: course.sourceUrl, videoUrl: course.videoUrl, coursePrompt: course.coursePrompt, promptCredit: course.promptCredit, transcriptCues: course.transcript.length, buildRequirements: store.getBuildRequirements(String(course.id)), existing: { chapters: course.chapters?.length ?? 0, questions: store.listQuestions(job.courseId).total, hasStudyGuide: Boolean(course.studyGuide) }, readArtifacts: { tool: "get_course_artifact", artifacts: artifactPageSchema.shape.artifact.options }, readQuestions: "list_course_questions" };
          } else if (call.function.name === "get_course_artifact") {
            const { artifact, offset, limit } = artifactPageSchema.parse(args);
            const current = store.getCourse(job.courseId)!;
            const content = JSON.stringify(current[artifact]);
            const page = content.slice(offset, offset + limit);
            result = { artifact, revision: current.revision, encoding: "json", offset, total: content.length, content: page, nextOffset: offset + page.length < content.length ? offset + page.length : null };
          } else if (call.function.name === "list_course_questions") {
            result = store.listQuestions(job.courseId, questionPageSchema.parse(args));
          } else if (call.function.name === "get_transcript") {
            const offset = Math.max(0, Number(args.offset ?? 0));
            const limit = Math.min(500, Math.max(1, Number(args.limit ?? 250)));
            const transcript = store.getCourse(job.courseId)?.transcript ?? [];
            const cues = transcript.slice(offset, offset + limit);
            result = { offset, total: transcript.length, cues, evidenceId: reviewEvidence.transcript(job.courseId, transcript, offset, cues.length) };
          } else if (call.function.name === "acquire_course_transcript") {
            if (!course.videoUrl) { messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Non-video course: read sourceUrl with fetch_url instead. No transcript is required." }) }); continue; }
            updateJob(job, "Acquiring transcript", "Retrieving the video's public timestamped YouTube captions.");
            const acquired = await acquireYouTubeTranscript(String(course.videoUrl ?? course.videoId ?? course.id), String(args.preferredLanguage ?? "en"), signal);
            signal.throwIfAborted();
            store.replaceTranscript(String(course.id), acquired.cues);
            course.transcript = acquired.cues;
            job.transcriptCues = acquired.cues.length;
            result = { saved: true, cues: acquired.cues.length, videoId: acquired.videoId, language: acquired.language, trackName: acquired.trackName, automaticallyGenerated: acquired.automaticallyGenerated, sourceUrl: acquired.sourceUrl, acquiredAt: acquired.acquiredAt };
          } else if (call.function.name === "fetch_url") {
            updateJob(job, "Verifying source", String(args.url ?? "Authoritative documentation"));
            const fetched = await dependencies.fetchResearch(String(args.url ?? ""), signal);
            signal.throwIfAborted();
            reviewEvidence.fetched(String(args.url ?? ""), fetched);
            result = { ...fetched, evidenceId: String(args.url ?? "") };
            let sourceUrl = "invalid-url";
            try { const u = new URL(String(args.url)); sourceUrl = u.origin + u.pathname; } catch { /* No raw credentials or query strings. */ }
            const evidence = { url: sourceUrl, ok: fetched.ok, accessedAt: new Date().toISOString(), ...(fetched.ok ? { contentHash: createHash("sha256").update(fetched.content).digest("hex") } : {}) };
            sourceEvidence.push(evidence);
            if (fetched.ok) sourceTexts.push(`SOURCE ${sourceUrl}:\n${fetched.content.slice(0, 15000)}`);
            debug.outcome(job.id, "fetch_url", fetched.ok, evidence.contentHash);
          } else if (call.function.name === "run_subagent") {
            updateJob(job, `Specialist · ${String(args.role ?? "course work")}`, String(args.task ?? "Working in an isolated context."));
            const specialist = await dependencies.callModel(settings, [{ role: "system", content: renderSystemPrompt("specialist", promptOverrides, { role: String(args.role) }) + "\n" + artifactContract + `\nCourse identity: ${course.title}. Source: ${course.sourceUrl || course.videoUrl}. Current date: ${new Date().toISOString().slice(0, 10)}.` }, { role: "user", content: `${String(args.task)}\n\nContext:\n${String(args.context).slice(0, 40_000)}\n\nOriginal transcript (may include caption errors):\n${JSON.stringify(course.transcript).slice(0, 60000)}\n\nRetrieved primary evidence (not proof that a generated claim follows):\n${sourceTexts.join("\n").slice(0, 60000)}` }], settings.provider === "openrouter" && settings.enableWebSearch ? [{ type: "openrouter:web_search", max_total_results: 8, search_context_size: "high" }] : undefined, 8192, "auto", signal);
            signal.throwIfAborted();
            result = specialist.content ?? "The specialist returned no text.";
            debug.outcome(job.id, "run_subagent", Boolean(specialist.content), createHash("sha256").update(String(result)).digest("hex"));
          } else if (call.function.name === "save_course_build") {
            const chapters = Array.isArray(args.chapters) ? args.chapters : [];
            const questions = args.questions === undefined ? [...stagedQuestions.values()] : Array.isArray(args.questions) ? args.questions : [];
            if (course.videoUrl && !store.getTranscript(String(course.id)).cues.length) throw new Error("Acquire the video transcript before authoring artifacts.");
            const conceptGraph = args.conceptGraph && typeof args.conceptGraph === "object" && !Array.isArray(args.conceptGraph) ? args.conceptGraph : null;
            if (!chapters.length || !questions.length) throw new Error("The agent tried to save an empty chapter or question collection.");
            if (!conceptGraph) throw new Error("The agent tried to save a course without its concept graph.");
            try {
              result = store.saveCourseBuild(String(course.id), { studyGuide: String(args.studyGuide ?? ""), researchNotes: String(args.researchNotes ?? "") + "\n\nRetrieval manifest (fetch success is not factual QA):\n" + JSON.stringify(sourceEvidence, null, 2), chapters, questions, conceptGraph });
            } catch (error) {
              result = { saved: false, validationError: error instanceof Error ? error.message : "Invalid artifacts", guidance: "Nothing was saved. Correct the JSON to match the tool schema and recorded requirements; do not fabricate evidence." };
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
              debug.outcome(job.id, "save_course_build", false);
              continue;
            }
            debug.outcome(job.id, "save_course_build", true);
            saved = true;
            stagedQuestions.clear();
            result = { ...result as Record<string, unknown>, next: "Course saved. Optionally record_question_review for exact saved revisions, or return a final summary. Unreviewed questions remain marked with an asterisk." };
          } else {
            result = { error: `Unknown tool ${call.function.name}.` };
          }
        } catch (error) {
          if (signal.aborted) throw error;
          result = { error: error instanceof Error ? error.message : "Tool failed. Correct the request and retry." };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        debug.record("tool.finished", turn + 1, Date.now() - toolStarted, call.function.name);
      }
    }

    if (!saved) throw new Error("The model reached the agent-turn limit without saving a valid course.");
    debug.record("build.complete");
    Object.assign(job, { status: "complete" as const, phase: "Course saved", message: "Course artifacts saved. Questions without a recorded agent QA review are marked with an asterisk.", updatedAt: Date.now() });
  } catch (error) {
    debug.record(saved ? "build.complete" : "build.failed");
    const message = error instanceof Error ? error.message : "The course build failed.";
    Object.assign(job, saved
      ? { status: "complete" as const, phase: "Course saved", message: "Course artifacts were saved before the agent stopped. Optional QA may be incomplete; unreviewed questions retain their asterisk.", updatedAt: Date.now() }
      : { status: "failed" as const, phase: signal.aborted ? "Build cancelled" : "Build stopped", message, error: message, updatedAt: Date.now() });
  } finally {
    store.close();
  }
};

export function startModelProviderServer(settingsPath: string, databasePath: string, systemPromptsPath = join(dirname(settingsPath), "system-prompts.json"), port = PROVIDER_PORT) {
  const debug = new DebugLog(join(dirname(settingsPath), "Diagnostics"));
  const agentSettingsPath = join(dirname(settingsPath), "agent-settings.json");
  const buildJobs = new Map<string, BuildJob>();
  const factChecks = new Map<string, FactCheckJob>();
  const cancellations = new Map<string, AbortController>();
  let discovery: Promise<Awaited<ReturnType<typeof discoverHarness>>[]> | undefined;
  let discoveredAt = 0;
  const harnesses = (refresh: boolean) => {
    if (!discovery || (Date.now() - discoveredAt > (refresh ? 3000 : 30_000))) {
      discoveredAt = Date.now();
      discovery = Promise.all([discoverHarness("codex"), discoverHarness("claude")]);
    }
    return discovery;
  };
  const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin");
    const appPort = Number(process.env.VIDMARK_APP_PORT ?? 3010);
    const allowedOrigins = (process.env.VIDMARK_ALLOWED_ORIGINS ?? `http://127.0.0.1:${appPort},http://localhost:${appPort}`).split(",");
    const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = corsHeaders(request);
      const host = request.headers.get("host")?.split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return Response.json({ error: "Invalid Host header." }, { status: 403, headers });
      const origin = request.headers.get("origin");
      if (origin && origin !== headers["Access-Control-Allow-Origin"]) return Response.json({ error: "Origin not allowed." }, { status: 403 });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      try {
        if (request.method === "GET" && url.pathname === "/harnesses") return Response.json({ harnesses: await harnesses(url.searchParams.get("refresh") === "true") }, { headers });
        if (request.method === "GET" && url.pathname === "/agent-settings") return Response.json(await readAgentPreferences(agentSettingsPath), { headers });
        if (request.method === "GET" && url.pathname === "/agent-selection") {
          const [preferences, local] = await Promise.all([readAgentPreferences(agentSettingsPath), readJson(settingsPath, defaultSettings())]);
          return Response.json(describeAgentSelection(preferences, preferences.harness === "provider" ? [] : await harnesses(false), local), { headers });
        }
        if (request.method === "PUT" && url.pathname === "/agent-settings") return Response.json(await writeAgentPreferences(agentSettingsPath, await request.json()), { headers });
        if (url.pathname === "/diagnostics" && request.method === "GET") return Response.json({ ...debug.state, entries: debug.entries() }, { headers });
        if (url.pathname === "/diagnostics" && request.method === "PUT") {
          const input = await request.json() as { enabled?: unknown };
          if (typeof input.enabled !== "boolean") throw new Error("Debug mode must be a boolean.");
          return Response.json({ ...debug.setEnabled(input.enabled), entries: debug.entries() }, { headers });
        }
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
          const input = await request.json() as { courseId?: string; agent?: unknown };
          const courseId = input.courseId;
          if (typeof courseId !== "string" || !courseId) throw new Error("Choose a course before starting a build.");
          const agent = input.agent === undefined ? await readAgentPreferences(agentSettingsPath) : agentPreferencesSchema.parse(input.agent);
          if (agent.harness === "provider" && !settings.configured) throw new Error("Configure a model before starting a course build.");
          const store = new VidmarkDatabase(databasePath);
          try { if (!store.getCourse(courseId)) throw new Error("Course not found."); } finally { store.close(); }
          const active = [...buildJobs.values(), ...factChecks.values()].filter(job => job.status === "queued" || job.status === "running");
          if (active.some(job => job.courseId === courseId)) throw new Error("This course already has a build running. Wait for it or cancel it before starting another.");
          if (active.length >= 2) throw new Error("Two course builds are already running. Wait for one to finish.");
          for (const [id, job] of buildJobs) if (buildJobs.size >= 50 && job.status !== "queued" && job.status !== "running") buildJobs.delete(id);
          const job: BuildJob = { id: crypto.randomUUID(), courseId, harness: agent.harness, status: "queued", phase: "Queued", message: "Preparing the course coordinator.", startedAt: Date.now(), updatedAt: Date.now() };
          buildJobs.set(job.id, job);
          try { await writeAgentPreferences(agentSettingsPath, agent); } catch (error) { buildJobs.delete(job.id); throw error; }
          const controller = new AbortController(); cancellations.set(job.id, controller);
          const timeout = setTimeout(() => controller.abort(), 45 * 60_000);
          const pending = agent.harness === "provider"
            ? runBuild(job, settings, databasePath, systemPromptsPath, debug, controller.signal)
            : runCliCourseBuild(job, agent, databasePath, systemPromptsPath, debug, controller.signal, url => researchFetchResult(url, value => safeFetchUrl(value, controller.signal)));
          void pending.finally(() => { clearTimeout(timeout); cancellations.delete(job.id); });
          return Response.json(job, { status: 202, headers });
        }
        if (request.method === "GET" && url.pathname === "/build") {
          const job = [...buildJobs.values()].reverse().find(job => job.courseId === url.searchParams.get("courseId"));
          return Response.json({ job: job ?? null }, { headers });
        }
        if (request.method === "POST" && /^\/build\/[^/]+\/cancel$/.test(url.pathname)) {
          const id = url.pathname.split("/")[2];
          const controller = cancellations.get(id);
          if (!buildJobs.has(id) || !controller) throw new Error("No running build was found.");
          controller.abort();
          return Response.json({ ok: true }, { headers });
        }
        if (request.method === "GET" && url.pathname.startsWith("/build/")) {
          const job = buildJobs.get(url.pathname.slice("/build/".length));
          if (!job) return Response.json({ error: "Build job not found." }, { status: 404, headers });
          return Response.json(job, { headers });
        }
        if (request.method === "POST" && url.pathname === "/fact-check") {
          const input = z.object({ courseId: z.string().min(1), questionId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await request.json());
          const agent = await readAgentPreferences(agentSettingsPath);
          if (agent.harness === "provider" && !settings.configured) throw new Error("Choose and configure a provider in Settings first.");
          const store = new VidmarkDatabase(databasePath);
          try {
            const question = store.getQuestion(input.courseId, input.questionId);
            if (!question || question.archived) throw new Error("Question not found.");
            if (question.contentHash !== input.contentHash) throw new Error("Question changed. Refresh the question before checking it.");
          } finally { store.close(); }
          const running = (job: BuildJob) => job.status === "running" || job.status === "queued";
          if ([...factChecks.values()].some(job => running(job) && job.courseId === input.courseId && job.questionId === input.questionId)) throw new Error("A fact check is already running for this question.");
          if ([...buildJobs.values()].some(job => running(job) && job.courseId === input.courseId)) throw new Error("Wait for this course build to finish before checking its questions.");
          if ([...buildJobs.values(), ...factChecks.values()].filter(running).length >= 2) throw new Error("Two agent tasks are already running. Wait for one to finish.");
          for (const [id, job] of factChecks) if (factChecks.size >= 50 && !running(job)) factChecks.delete(id);
          const job: FactCheckJob = { ...input, id: crypto.randomUUID(), harness: agent.harness, status: "queued", phase: "Queued", message: "Preparing fact check.", startedAt: Date.now(), updatedAt: Date.now() };
          factChecks.set(job.id, job);
          const controller = new AbortController(); cancellations.set(job.id, controller);
          const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
          void runQuestionFactCheck(job, agent, databasePath, systemPromptsPath, debug, controller.signal, url => researchFetchResult(url, value => safeFetchUrl(value, controller.signal)), { model: settings.model, call: (messages, tools, signal) => callModel(settings, messages, tools, 4096, "required", signal) }).finally(() => { clearTimeout(timeout); cancellations.delete(job.id); });
          return Response.json(job, { status: 202, headers });
        }
        if (request.method === "GET" && url.pathname === "/fact-check") {
          const job = [...factChecks.values()].reverse().find(job => job.courseId === url.searchParams.get("courseId") && job.questionId === url.searchParams.get("questionId") && job.contentHash === url.searchParams.get("contentHash"));
          return Response.json({ job: job ?? null }, { headers });
        }
        if (request.method === "POST" && /^\/fact-check\/[^/]+\/cancel$/.test(url.pathname)) {
          const id = url.pathname.split("/")[2];
          if (!factChecks.has(id) || !cancellations.has(id)) throw new Error("No running fact check found.");
          cancellations.get(id)!.abort(); return Response.json({ ok: true }, { headers });
        }
        if (request.method === "GET" && url.pathname.startsWith("/fact-check/")) {
          const job = factChecks.get(url.pathname.slice("/fact-check/".length));
          return Response.json(job ?? { error: "Fact check not found." }, { status: job ? 200 : 404, headers });
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
