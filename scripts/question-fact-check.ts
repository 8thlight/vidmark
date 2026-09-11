import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPreferences } from "../app/agent-harness";
import type { QuestionReview } from "../app/question-review";
import { getSystemPrompt, type SystemPromptOverrides } from "../app/system-prompts";
import { contentHash, VidmarkDatabase } from "./vidmark-db";
import { cliEventState, cliResultMessage, courseCliArguments, discoverHarness, resolveAgentModel, runCli } from "./agent-harness";
import { readSystemPromptOverrides } from "./system-prompt-store";
import { DebugLog } from "./debug-log";
import type { BuildJob } from "./cli-course-build";

export type FactCheckJob = BuildJob & { questionId: string; contentHash: string; review?: QuestionReview };
type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
export type FactCheckModel = (messages: Message[], tools: unknown[], signal: AbortSignal) => Promise<Message>;
export const factCheckToolNames = ["get_course_question", "get_transcript", "fetch_url", "record_fact_check"] as const;

// One immutable question snapshot. Both CLI and in-app agents use this exact capability set.
export function createQuestionFactCheck(store: VidmarkDatabase, courseId: string, questionId: string, expectedHash: string, overrides: SystemPromptOverrides, fetchResearch: (url: string) => Promise<unknown>, reviewer: string, via: QuestionReview["via"], onTool: (name: string, ok: boolean) => void = () => {}) {
  const question = store.getQuestion(courseId, questionId);
  const course = store.getCourse(courseId);
  if (!question || question.archived || !course) throw new Error("Question not found.");
  if (question.contentHash !== expectedHash) throw new Error("This question changed. Refresh it before starting a fact check.");
  const transcript = course.transcript;
  const transcriptHash = createHash("sha256").update(JSON.stringify(transcript)).digest("hex");
  let active = true, read = false, review: QuestionReview | undefined;
  const evidence = new Set<string>();
  const ensureActive = () => { if (!active) throw new Error("This fact check has ended."); };
  const prompt = `${getSystemPrompt("questionFactCheck", overrides)}\n\nCurrent date: ${new Date().toISOString().slice(0, 10)}. Course ID: ${courseId}. Question ID: ${questionId}. Only this question is in scope. Record reasoning in the same language as the question.`;
  const descriptors = [
    { name: "get_course_question", description: "Read the selected question snapshot, including all answers and rationales, and course source links.", schema: z.object({}).strict() },
    { name: "get_transcript", description: "Read original transcript evidence in pages. Cite the returned evidenceId. Captions can contain errors.", schema: z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(250) }).strict() },
    { name: "fetch_url", description: "Retrieve public primary source evidence. Only successful nonempty results can be cited in a factual verdict.", schema: z.object({ url: z.string().url() }).strict() },
    { name: "record_fact_check", description: "Save an accuracy report for this exact question. Never modifies question content. Use uncertain when evidence is insufficient.", schema: z.object({ verdict: z.enum(["accurate", "inaccurate", "uncertain"]), reasoning: z.string().trim().min(20).max(12000), evidenceIds: z.array(z.string()).max(30) }).strict() },
  ];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    try {
      ensureActive();
      const descriptor = descriptors.find(tool => tool.name === name);
      if (!descriptor) throw new Error("Tool not available in a fact check. Content editing is disabled.");
      const args = descriptor.schema.parse(input) as Record<string, unknown>;
      let result: unknown;
      if (name === "get_course_question") {
        read = true;
        result = { ...question, qaReview: undefined, course: { title: course.title, sourceUrl: course.sourceUrl, videoUrl: course.videoUrl } };
      } else if (name === "get_transcript") {
        const cues = transcript;
        const offset = args.offset as number, page = cues.slice(offset, offset + (args.limit as number));
        const evidenceId = `transcript:${courseId}:${transcriptHash}:${offset}-${offset + page.length}`;
        if (page.length) evidence.add(evidenceId);
        result = { evidenceId, total: cues.length, offset, cues: page };
      } else if (name === "fetch_url") {
        const url = args.url as string;
        const fetched = await fetchResearch(url) as { ok?: boolean; content?: unknown };
        ensureActive();
        if (fetched?.ok === true && typeof fetched.content === "string" && fetched.content.trim()) evidence.add(url);
        result = { ...fetched, evidenceId: url };
      } else {
        if (!read) throw new Error("Read the question before reviewing it.");
        if (review) throw new Error("The report has already been recorded.");
        const ids = args.evidenceIds as string[];
        if (ids.some(id => !evidence.has(id))) throw new Error("Cite only evidence successfully retrieved in this fact check.");
        if (args.verdict !== "uncertain" && !ids.length) throw new Error("An accuracy verdict requires retrieved evidence. Use uncertain when evidence is missing.");
        review = store.reviewQuestion(courseId, questionId, question.revision, {
          contentHash: question.contentHash, reviewer, notes: args.reasoning,
          evidence: ids.length ? ids : ["No sufficient source evidence was retrieved."],
          outcome: args.verdict === "accurate" ? "reviewed" : args.verdict === "inaccurate" ? "needs_changes" : "inconclusive",
        }, via, ids.some(id => id.startsWith(`transcript:${courseId}:`)) ? contentHash({ cues: transcript }) : undefined)!.qaReview!;
        result = { saved: true, review, contentUnchanged: true };
      }
      ensureActive(); onTool(name, true); return result;
    } catch (error) { if (active) onTool(name, false); throw error; }
  };
  return { prompt, descriptors, invoke, get review() { return review; }, close() { active = false; } };
}

export function serveQuestionFactCheck(session: ReturnType<typeof createQuestionFactCheck>) {
  let active = true;
  const token = crypto.randomUUID();
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "vidmark-fact-check", version: "1.0.0" });
    for (const tool of session.descriptors) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async input => {
      try { return { content: [{ type: "text", text: JSON.stringify(await session.invoke(tool.name, input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "Fact check failed." }) }] }; }
    });
    return mcp;
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, maxRequestBodySize: 1024 * 1024, fetch(request) {
    if (!active || new URL(request.url).pathname !== `/mcp/${token}` || request.headers.has("origin") || request.headers.get("host")?.split(":")[0] !== "127.0.0.1") return new Response("Not found", { status: 404 });
    return handler.fetch(request);
  } });
  return { url: `http://127.0.0.1:${server.port}/mcp/${token}`, close() { active = false; session.close(); server.stop(true); } };
}

export async function runQuestionFactCheck(job: FactCheckJob, preferences: AgentPreferences, databasePath: string, promptsPath: string, debug: DebugLog, signal: AbortSignal, fetchResearch: (url: string) => Promise<unknown>, local?: { model: string; call: FactCheckModel }, dependencies = { discoverHarness, runCli }) {
  const store = new VidmarkDatabase(databasePath);
  let session: ReturnType<typeof createQuestionFactCheck> | undefined, server: ReturnType<typeof serveQuestionFactCheck> | undefined, workspace: string | undefined;
  const close = () => { session?.close(); server?.close(); };
  const update = (phase: string, message: string) => Object.assign(job, { status: "running", phase, message, updatedAt: Date.now() });
  debug.record("fact-check.started");
  try {
    update("Checking provider", "Preparing a factual review. Question content will not be edited.");
    const id = preferences.harness;
    const harness = id !== "provider" ? await dependencies.discoverHarness(id, undefined, signal) : null;
    signal.throwIfAborted();
    if (harness && (harness.status !== "ready" || !harness.executable)) throw new Error(harness.detail);
    if (id === "provider" && !local) throw new Error("Configure an agent in Settings first.");
    const model = id === "provider" ? local!.model : resolveAgentModel(preferences.models[id], harness!);
    const overrides = (await readSystemPromptOverrides(promptsPath)).overrides;
    session = createQuestionFactCheck(store, job.courseId, job.questionId, job.contentHash, overrides, fetchResearch, `${harness?.label ?? "In-app agent"} · ${model || "provider default"}`, id === "provider" ? "local-model" : "mcp", (name, ok) => {
      debug.record("tool.finished", undefined, undefined, name);
      if (name === "record_fact_check") debug.outcome(job.id, "record_fact_check", ok, job.contentHash);
      update("Checking facts", `${name.replaceAll("_", " ")}${ok ? "" : " · needs attention"}`);
    });
    signal.addEventListener("abort", close, { once: true });
    signal.throwIfAborted();
    if (id !== "provider") {
      server = serveQuestionFactCheck(session);
      workspace = await mkdtemp(join(tmpdir(), "vidmark-fact-check-"));
      let terminal: string | undefined;
      const result = await dependencies.runCli(harness!.executable!, courseCliArguments(id, model, server.url, factCheckToolNames, "fact-check"), { cwd: workspace, input: session.prompt, timeoutMs: 15 * 60_000, signal, onLine: line => {
        const state = cliEventState(id, line);
        if (state === "complete" || state === "failed") terminal = state;
        const message = cliResultMessage(id, line); if (message) job.agentMessage = message;
      } });
      // The persisted, exact-version report is authoritative even if the final chat turn fails.
      if (!session.review && (result.code !== 0 || terminal !== "complete")) throw new Error("The agent stopped before recording a fact check. Check its login, model availability and usage limits.");
    } else {
      const messages: Message[] = [{ role: "system", content: session.prompt }];
      const tools = session.descriptors.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema) } }));
      for (let turn = 0; turn < 12 && !session.review; turn++) {
        signal.throwIfAborted();
        debug.record("model.started", turn);
        const assistant = await local!.call(messages, tools, signal);
        debug.record("model.finished", turn);
        messages.push(assistant);
        if (!assistant.tool_calls?.length) throw new Error("The model replied without recording a fact check. No accuracy verdict was saved.");
        for (const call of assistant.tool_calls) {
          signal.throwIfAborted();
          let result: unknown;
          try { result = await session.invoke(call.function.name, JSON.parse(call.function.arguments)); }
          catch (error) { result = { error: error instanceof Error ? error.message : "Tool request failed." }; }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    }
    if (!session.review) throw new Error("No fact-check report was recorded. The question is unchanged.");
    job.review = session.review;
    Object.assign(job, { status: "complete", phase: "Fact check saved", message: "Report saved for this question version. Content was not edited.", updatedAt: Date.now() });
    debug.record("fact-check.complete");
  } catch (error) {
    if (session?.review) {
      Object.assign(job, { review: session.review, status: "complete", phase: "Fact check saved", message: "The report was saved before the agent stopped. Question content is unchanged.", updatedAt: Date.now() });
      debug.record("fact-check.complete");
    } else {
      const message = signal.aborted ? "Fact check cancelled. Question content is unchanged." : error instanceof Error ? error.message : "Fact check failed.";
      Object.assign(job, { status: "failed", phase: "Fact check stopped", message, error: message, updatedAt: Date.now() });
      debug.record("fact-check.failed");
    }
  } finally {
    signal.removeEventListener("abort", close); close(); store.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
