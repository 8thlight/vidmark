import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildProgressView } from "../app/build-progress-view";
import type { BuildProgress } from "../app/build-progress";
import { CourseBuildProgress, buildProgressReportSchema } from "../scripts/build-progress";
import { cliResultMessage } from "../scripts/agent-harness";
import { createCourseAgentSession } from "../scripts/course-agent-session";
import { runCliCourseBuild, type BuildJob } from "../scripts/cli-course-build";
import { VidmarkDatabase, STARTER_COURSE_ID } from "../scripts/vidmark-db";
import { DebugLog } from "../scripts/debug-log";
import { getSystemPrompt } from "../app/system-prompts";

const root = await mkdtemp(join(tmpdir(), "vidmark-progress-tests-"));
const databasePath = join(root, "test.sqlite"), db = new VidmarkDatabase(databasePath);
afterAll(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const fixture = { ...db.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!.payload, id: "q1", sectionId: "chapter", chapter: "Control flow", videoReferences: [], sources: [{ label: "Evidence", url: "https://example.com", accessedAt: "2026-09-11" }] };
const artifacts = { studyGuide: "Study guide", researchNotes: "Primary evidence", chapters: [{ id: "chapter", title: "Control flow", summary: "Summary" }], conceptGraph: { schemaVersion: "1.0.0", graphId: "test", title: "Test", nodes: [{ id: "topic", label: "Topic", kind: "domain", domainId: "topic", summary: "Test topic" }], edges: [] } };
const report = { message: "Checking the termination condition against the source.", chapter: { title: "Control flow", position: 2, total: 10 }, question: { title: "When should the loop stop?", position: 4, total: 30 } };
function course(id: string) { db.upsertCourse({ id, title: "Test course", sourceUrl: "https://example.com", originPrompt: "One question", promptCredit: "QA" }); }
async function call(url: string, courseId: string, name: string, args: object = {}) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: { courseId, ...args } } }) });
  const body = await response.text(); return JSON.parse(body.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? body).result;
}

test("progress reports are bounded and cannot set observed counters or claim completion", () => {
  let state!: BuildProgress;
  const tracker = new CourseBuildProgress(value => { state = value; });
  tracker.report({ ...report, saved: true, savedQuestions: 30 });
  expect(state.saved).toBe(false); expect(state.savedQuestions).toBe(0);
  expect(state.activity?.chapter).toEqual(report.chapter);
  expect(() => tracker.report({ ...report, chapter: { title: "No", position: 3, total: 2 } })).toThrow();
  expect(() => tracker.report({ message: "x".repeat(1201) })).toThrow();
  expect(buildProgressReportSchema.safeParse({ message: "Working", question: { title: "Question", position: 0 } }).success).toBe(false);
  tracker.report({ message: "Now verifying sources" });
  expect(state.activity?.question).toBeUndefined();
  tracker.report({ message: "http://127.0.0.1:1234/mcp/abcdef sk-secretsecretsecret", question: { title: "Bearer secretsecretsecret" } });
  expect(JSON.stringify(state)).not.toContain("secretsecretsecret"); expect(state.report?.message).toContain("[temporary MCP endpoint]");
});

test("scoped MCP reports are display-only; successful unique staging and atomic saves drive counts", async () => {
  const id = "progress-mcp"; course(id); let state!: BuildProgress;
  const controller = new AbortController();
  const session = createCourseAgentSession(db, id, {}, async () => ({}), () => {}, controller.signal, undefined, value => { state = value; });
  try {
    const before = db.getCourse(id);
    expect((await call(session.url, id, "report_build_progress", report)).isError).not.toBe(true);
    expect(state.report).toEqual(report); expect(db.getCourse(id)).toEqual(before); expect(session.saved).toBe(false);
    const previous = structuredClone(state);
    expect((await call(session.url, "other-course", "report_build_progress", report)).isError).toBe(true);
    expect((await call(session.url, id, "report_build_progress", { ...report, chapter: { title: "Invalid", position: 3, total: 1 } })).isError).toBe(true);
    expect(state).toEqual(previous);
    await call(session.url, id, "set_course_build_requirements", { requirements: { questionCount: 2 } });
    await call(session.url, id, "upsert_course_question", { question: fixture });
    await call(session.url, id, "upsert_course_question", { question: fixture });
    expect(state).toMatchObject({ stagedQuestions: 1, questionTarget: 2, savedQuestions: 0, saved: false });
    expect(db.listQuestions(id).total).toBe(0);
    expect((await call(session.url, id, "save_course_build", artifacts)).isError).toBe(true);
    expect(state.saved).toBe(false); expect(state.stagedQuestions).toBe(1);
    await call(session.url, id, "upsert_course_question", { question: { ...fixture, id: "q2", question: "A different question?" } });
    expect((await call(session.url, id, "save_course_build", artifacts)).isError).not.toBe(true);
    expect(state).toMatchObject({ stagedQuestions: 0, savedQuestions: 2, savedChapters: 1, saved: true });
    expect(db.listQuestions(id).total).toBe(2);
    const saved = structuredClone(state); controller.abort();
    expect((await call(session.url, id, "report_build_progress", report)).isError).toBe(true);
    expect(state).toEqual(saved);
  } finally { session.close(); }
});

test("CLI jobs publish MCP progress while the agent is running, before committing SQLite", async () => {
  const id = "progress-cli"; course(id);
  const job: BuildJob = { id, courseId: id, status: "queued", phase: "", message: "", startedAt: 0, updatedAt: 0 };
  await runCliCourseBuild(job, { harness: "codex", models: { codex: "", claude: "" } }, databasePath, join(root, "prompts.json"), new DebugLog(join(root, "Diagnostics")), new AbortController().signal, async () => ({}), {
    discoverHarness: async () => ({ id: "codex", label: "Codex CLI", status: "ready", executable: "/test/codex", models: [], detail: "Ready" }),
    runCli: async (_executable, args, options) => {
      const url = args.join(" ").match(/http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9-]+/)![0];
      await call(url, id, "set_course_build_requirements", { requirements: { questionCount: 1 } });
      await call(url, id, "report_build_progress", report);
      expect(job.status).toBe("running"); expect(job.progress?.report).toEqual(report);
      await call(url, id, "upsert_course_question", { question: fixture });
      expect(job.progress?.stagedQuestions).toBe(1); expect(db.listQuestions(id).total).toBe(0);
      await call(url, id, "save_course_build", artifacts);
      options?.onLine?.(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Course saved." } }));
      options?.onLine?.('{"type":"turn.completed"}');
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(job.status).toBe("complete"); expect(job.progress?.savedQuestions).toBe(1); expect(job.agentMessage).toBe("Course saved.");
});

test("public CLI text excludes reasoning, tool payloads and child-agent messages", () => {
  const claude = (content: object[], extra: object = {}) => JSON.stringify({ type: "assistant", message: { content }, ...extra });
  expect(cliResultMessage("claude", claude([{ type: "thinking", thinking: "private" }, { type: "tool_use", input: "private" }, { type: "text", text: "Working on chapter 2." }]))).toBe("Working on chapter 2.");
  expect(cliResultMessage("claude", claude([{ type: "text", text: "child output" }], { parent_tool_use_id: "child" }))).toBeUndefined();
  expect(cliResultMessage("codex", JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private" } }))).toBeUndefined();
  expect(cliResultMessage("claude", '{"type":"result","subtype":"success","result":"Done"}')).toBe("Done");
});

test("progress UI distinguishes reported positions, staged drafts and saved counts without invented percentages", () => {
  const progress: BuildProgress = { activity: { label: "Agent-reported work", chapter: report.chapter, question: report.question }, report, stagedQuestions: 3, savedChapters: 0, savedQuestions: 0, questionTarget: 30, saved: false };
  const html = renderToStaticMarkup(<BuildProgressView progress={progress} running agentMessage="Public update" />);
  expect(html).toContain("Chapter 2 of 10"); expect(html).toContain("Question 4 of 30"); expect(html).toContain("3 / 30"); expect(html).toContain("0 / 30"); expect(html).toContain("Latest agent response"); expect(html).not.toContain("%");
  const unknown = renderToStaticMarkup(<BuildProgressView progress={{ ...progress, questionTarget: undefined, activity: undefined, report: undefined }} running={false} />);
  expect(unknown).not.toContain(" / "); expect(unknown).toContain("Staged drafts are not retained");
});

test("progress instructions are visible and overridable for both coordinator types", () => {
  for (const id of ["cliCoordinator", "coordinatorRuntime"] as const) {
    expect(getSystemPrompt(id)).toContain("report_build_progress");
    expect(getSystemPrompt(id, { [id]: "My custom coordinator" })).toBe("My custom coordinator");
  }
});
