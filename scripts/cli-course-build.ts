import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarness, AgentPreferences } from "../app/agent-harness";
import { cliEventState, cliResultMessage, courseCliArguments, discoverHarness, resolveAgentModel, runCli } from "./agent-harness";
import { createCourseAgentSession } from "./course-agent-session";
import { VidmarkDatabase } from "./vidmark-db";
import { readSystemPromptOverrides } from "./system-prompt-store";
import { DebugLog } from "./debug-log";
import type { BuildProgress } from "../app/build-progress";

export type BuildJob = { id: string; courseId: string; harness?: AgentHarness; status: "queued" | "running" | "complete" | "failed"; phase: string; message: string; agentMessage?: string; progress?: BuildProgress; startedAt: number; updatedAt: number; error?: string; transcriptCues?: number };

export async function runCliCourseBuild(job: BuildJob, preferences: AgentPreferences, databasePath: string, systemPromptsPath: string, debug: DebugLog, signal: AbortSignal, fetchResearch: (url: string) => Promise<unknown>, dependencies = { discoverHarness, runCli }) {
  const id = preferences.harness;
  if (id === "provider") throw new Error("Expected an installed CLI harness.");
  const update = (phase: string, message: string) => Object.assign(job, { status: "running", phase, message, updatedAt: Date.now() });
  const store = new VidmarkDatabase(databasePath);
  let session: ReturnType<typeof createCourseAgentSession> | undefined;
  let workspace: string | undefined;
  const closeSession = () => session?.close();
  debug.record("build.started");
  try {
    update("Checking provider", "Verifying the installed CLI and its login before starting.");
    const harness = await dependencies.discoverHarness(id, undefined, signal);
    if (signal.aborted) throw new Error("Build cancelled.");
    if (harness.status !== "ready" || !harness.executable) throw new Error(harness.detail);
    const prompts = await readSystemPromptOverrides(systemPromptsPath);
    session = createCourseAgentSession(store, job.courseId, prompts.overrides, fetchResearch, (tool, ok) => {
      debug.record("tool.finished", undefined, undefined, tool);
      if (tool === "save_course_build") debug.outcome(job.id, "save_course_build", ok);
      update(ok ? "Agent working" : "Agent correcting a tool request", `${harness.label} · ${tool.replaceAll("_", " ")}${ok ? "" : " needs attention"}`);
      job.transcriptCues = store.getTranscript(job.courseId, undefined, 100000).cues.length;
    }, signal, undefined, progress => { job.progress = progress; job.updatedAt = Date.now(); });
    signal.addEventListener("abort", closeSession, { once: true });
    if (signal.aborted) throw new Error("Build cancelled.");
    workspace = await mkdtemp(join(tmpdir(), "vidmark-course-agent-"));
    // Empty workspace + no global MCP config. Authentication stays with the CLI.
    let terminal: "complete" | "failed" | undefined;
    update("CLI connected", `${harness.label} is building this course through its temporary MCP connection.`);
    const started = Date.now();
    debug.record("model.started");
    const result = await dependencies.runCli(harness.executable, courseCliArguments(id, resolveAgentModel(preferences.models[id], harness), session.url), {
      cwd: workspace, input: session.prompt, timeoutMs: 45 * 60_000, signal,
      onLine: line => {
        const message = cliResultMessage(id, line);
        if (message) job.agentMessage = message;
        const state = cliEventState(id, line);
        if (state === "complete" || state === "failed") terminal = state;
        if (state) job.updatedAt = Date.now();
      },
    });
    debug.record("model.finished", undefined, Date.now() - started);
    if (result.code !== 0 || terminal !== "complete") throw new Error(`${harness.label} stopped without a successful final result. Check its login, model availability, permissions and usage limit in Terminal. Any artifacts already saved remain in your library.`);
    if (!session.saved) throw new Error("The CLI finished without saving a complete course through MCP. No completed build was confirmed; review the course prompt and retry.");
    const course = store.getCourse(job.courseId)!;
    if (!course.chapters.length || !course.questions.length || !course.conceptGraph || !course.studyGuide) throw new Error("The saved course is missing required artifacts.");
    debug.record("build.complete");
    Object.assign(job, { status: "complete", phase: "Course saved", message: `${course.chapters.length} chapters and ${course.questions.filter(q => !q.archived).length} questions saved through MCP. Questions without agent QA have an asterisk.`, updatedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The CLI course build failed.";
    debug.record(session?.saved ? "build.complete" : "build.failed");
    Object.assign(job, session?.saved
      ? { status: "complete", phase: "Course saved", message: "Course artifacts were saved before the agent stopped. Optional QA may be incomplete; unreviewed questions retain their asterisk.", updatedAt: Date.now() }
      : { status: "failed", phase: signal.aborted ? "Build cancelled" : "Build stopped", message, error: message, updatedAt: Date.now() });
  } finally {
    signal.removeEventListener("abort", closeSession);
    session?.close(); store.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
