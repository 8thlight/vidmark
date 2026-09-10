import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase, STARTER_COURSE_ID } from "../scripts/vidmark-db";
import { runBuild, startModelProviderServer } from "../scripts/model-provider";
import { type BuildJob } from "../scripts/cli-course-build";
import { DebugLog } from "../scripts/debug-log";
import { researchFetchResult } from "../scripts/research-fetch-result";

const root = await mkdtemp(join(tmpdir(), "vidmark-provider-build-"));
const databasePath = join(root, "test.sqlite");
const db = new VidmarkDatabase(databasePath);
afterAll(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const fixture: Record<string, unknown> = { ...db.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!.payload, id: "q1", sectionId: "chapter", videoReferences: [], sources: [{ label: "Evidence", url: "https://example.com", accessedAt: "2026-09-10" }] };
const artifacts = { studyGuide: "Study guide", researchNotes: "Primary evidence", chapters: [{ id: "chapter", title: "Chapter", summary: "Summary" }], questions: [fixture], conceptGraph: { schemaVersion: "1.0.0", graphId: "test", title: "Test", nodes: [{ id: "topic", label: "Topic", kind: "domain", domainId: "topic", summary: "Test topic" }], edges: [] } };
const settings = { configured: true, provider: "local" as const, baseUrl: "http://127.0.0.1:1/v1", model: "test-model", enableWebSearch: false, updatedAt: 0 };
const debug = new DebugLog(join(root, "Diagnostics"));
debug.setEnabled(true);
const jobFor = (id: string): BuildJob => {
  db.upsertCourse({ id, title: "Test course", sourceUrl: "https://example.com", originPrompt: "One question", promptCredit: "QA" });
  return { id, courseId: id, harness: "provider", status: "queued", phase: "", message: "", startedAt: Date.now(), updatedAt: Date.now() };
};
const tool = (name: string, args: unknown) => ({ role: "assistant" as const, content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const fetchResearch = (url: string) => researchFetchResult(url, async () => "Actual primary evidence");

test("in-app QA validates reads and retrieved evidence, returns tool errors, and reads fresh saved counts", async () => {
  const job = jobFor("provider-qa");
  const results: unknown[] = [];
  let turn = 0;
  await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, new AbortController().signal, {
    fetchResearch,
    callModel: async (_settings, messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") results.push(JSON.parse(last.content ?? "{}"));
      const current = db.getQuestion(job.courseId, "q1");
      const review = { reviewer: "Test agent", outcome: "reviewed", notes: "Verified with source", evidence: ["https://example.com"], contentHash: current?.contentHash };
      const operations = [
        () => tool("set_course_build_requirements", { questionCount: 1 }),
        () => tool("save_course_build", artifacts),
        () => tool("get_course", {}),
        () => tool("upsert_course_question", { question: { ...fixture, question: "Should not overwrite without revision" } }),
        () => tool("record_question_review", { questionId: "q1", expectedRevision: current?.revision, review }),
        () => tool("get_course_question", { questionId: "q1" }),
        () => tool("record_question_review", { questionId: "q1", expectedRevision: current?.revision, review }),
        () => tool("fetch_url", { url: "https://example.com" }),
        () => tool("record_question_review", { questionId: "q1", expectedRevision: current?.revision, review }),
      ];
      return operations[turn++]?.() ?? { role: "assistant", content: "Done" };
    },
  });
  expect(job.status).toBe("complete");
  expect(results[2]).toMatchObject({ existing: { chapters: 1, questions: 1, hasStudyGuide: true } });
  expect(results[3]).toMatchObject({ error: expect.stringContaining("expectedRevision") });
  expect(results[4]).toMatchObject({ error: expect.stringContaining("Read this exact") });
  expect(results[6]).toMatchObject({ error: expect.stringContaining("successfully retrieved") });
  expect(db.getQuestion(job.courseId, "q1")?.payload.question).toBe(fixture.question);
  expect(db.getQuestion(job.courseId, "q1")?.qaReview?.outcome).toBe("reviewed");
});

test("model failure during optional QA does not mark persisted artifacts as a failed build", async () => {
  const job = jobFor("provider-saved");
  let turn = 0;
  await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, new AbortController().signal, {
    fetchResearch,
    callModel: async () => {
      if (turn++ === 0) return tool("set_course_build_requirements", { questionCount: 1 });
      if (turn === 2) return tool("save_course_build", artifacts);
      throw new Error("Provider disconnected after save");
    },
  });
  expect(job.status).toBe("complete");
  expect(job.message).toContain("Optional QA may be incomplete");
  expect(db.getCourse(job.courseId)?.questions.length).toBe(1);
});

test("cancellation reaches coordinators and specialists and prevents subsequent tool writes", async () => {
  for (const specialist of [false, true]) {
    const job = jobFor("cancel-" + specialist);
    const controller = new AbortController();
    let calls = 0;
    await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, controller.signal, {
      fetchResearch,
      callModel: async (_settings, _messages, _tools, _tokens, _choice, signal) => {
        expect(signal).toBe(controller.signal);
        calls++;
        if (specialist && calls === 1) return tool("run_subagent", { role: "Research", task: "Check evidence", context: "Course" });
        controller.abort();
        return tool("upsert_course_question", { question: fixture });
      },
    });
    expect(job.phase).toBe("Build cancelled");
    expect(db.getCourse(job.courseId)?.questions.length).toBe(0);
    expect(calls).toBe(specialist ? 2 : 1);
  }
});

test("the build API exposes cancellation for the in-app provider and stops its HTTP model call", async () => {
  const job = jobFor("api-cancel");
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    received();
    return new Promise<Response>(resolve => {
      const finish = () => resolve(new Response(null, { status: 499 }));
      if (request.signal.aborted) finish(); else request.signal.addEventListener("abort", finish, { once: true });
    });
  } });
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ ...settings, baseUrl: model.url.toString() + "v1" }));
  const server = startModelProviderServer(settingsPath, databasePath, join(root, "prompts.json"), 0);
  try {
    const result = await fetch(new URL("/build", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: job.courseId, agent: { harness: "provider", models: { codex: "", claude: "" } } }) });
    expect(result.status).toBe(202);
    const launched = await result.json();
    await started;
    expect((await fetch(new URL("/build/" + launched.id + "/cancel", server.url), { method: "POST" })).status).toBe(200);
    let stopped = launched;
    for (let attempt = 0; attempt < 50; attempt++) {
      stopped = await (await fetch(new URL("/build/" + launched.id, server.url))).json();
      if (stopped.status === "failed") break;
      await Bun.sleep(10);
    }
    expect(stopped.phase).toBe("Build cancelled");
    expect(db.getCourse(job.courseId)?.questions.length).toBe(0);
  } finally { server.stop(true); model.stop(true); }
});
