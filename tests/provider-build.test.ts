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

test("in-app update builds can read every existing artifact and the saved question bank in bounded pages", async () => {
  const job = jobFor("read-existing");
  db.setBuildRequirements(job.courseId, { questionCount: 1 });
  db.saveCourseBuild(job.courseId, artifacts);
  const original = db.getCourse(job.courseId)!;
  const results: Array<Record<string, unknown>> = [];
  const names = ["studyGuide", "researchNotes", "chapters", "conceptGraph"] as const;
  let turn = 0;
  await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, new AbortController().signal, {
    fetchResearch,
    callModel: async (_settings, messages, tools) => {
      expect(JSON.stringify(tools)).toContain("get_course_artifact");
      expect(JSON.stringify(tools)).toContain("list_course_questions");
      const last = messages.at(-1);
      if (last?.role === "tool") results.push(JSON.parse(last.content ?? "{}"));
      const calls = [tool("get_course", {}), ...names.map(artifact => tool("get_course_artifact", { artifact })), tool("get_course_artifact", { artifact: "studyGuide", offset: 2, limit: 3 }), tool("list_course_questions", { offset: 0, limit: 1 })];
      if (turn < calls.length) return calls[turn++];
      throw new Error("Inspection done without replacement");
    },
  });
  expect(results[0].readQuestions).toBe("list_course_questions");
  names.forEach((name, index) => expect(JSON.parse(String(results[index + 1].content))).toEqual(original[name]));
  expect(results[5]).toMatchObject({ offset: 2, content: JSON.stringify(original.studyGuide).slice(2, 5), nextOffset: 5 });
  expect(results[6]).toMatchObject({ total: 1, returned: 1, questions: [expect.objectContaining({ payload: fixture })] });
  expect(db.getCourse(job.courseId)).toEqual(original);
});

test("in-app build QA rejects a previously retrieved transcript after replacement", async () => {
  const job = jobFor("provider-transcript-hash");
  db.setBuildRequirements(job.courseId, { questionCount: 1 });
  db.saveCourseBuild(job.courseId, artifacts);
  db.replaceTranscript(job.courseId, [{ time: 0, text: "Original" }]);
  const q = db.getQuestion(job.courseId, "q1")!;
  let turn = 0;
  let evidenceId = "";
  await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, new AbortController().signal, {
    fetchResearch,
    callModel: async (_settings, messages) => {
      if (turn++ === 0) return tool("get_course_question", { questionId: "q1" });
      if (turn === 2) return tool("get_transcript", { offset: 0, limit: 1 });
      const last = JSON.parse(messages.at(-1)?.content ?? "{}");
      if (turn === 3) {
        evidenceId = last.evidenceId;
        db.replaceTranscript(job.courseId, [{ time: 0, text: "Changed" }]);
        return tool("record_question_review", { questionId: "q1", expectedRevision: q.revision, review: { reviewer: "Agent", notes: "Checked", outcome: "reviewed", contentHash: q.contentHash, evidence: [evidenceId] } });
      }
      expect(last.error).toContain("Transcript evidence changed");
      throw new Error("Test complete");
    },
  });
  expect(evidenceId).toMatch(/:[a-f0-9]{64}:0-1$/);
  expect(db.getQuestion(job.courseId, "q1")?.qaReview).toBeNull();
});

test("in-app staged questions remain out of SQLite until an atomic complete save", async () => {
  for (const finish of ["save", "fail", "cancel"] as const) {
    const job = jobFor("staging-" + finish);
    const controller = new AbortController();
    let turn = 0;
    await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, controller.signal, {
      fetchResearch,
      callModel: async () => {
        if (turn++ === 0) return tool("set_course_build_requirements", { questionCount: 2 });
        if (turn === 2) return tool("upsert_course_question", { question: fixture });
        expect(db.getCourse(job.courseId)?.questions.length).toBe(finish === "save" && turn > 4 ? 2 : 0);
        if (finish === "fail") throw new Error("Model stopped");
        if (finish === "cancel") { controller.abort(); return tool("save_course_build", artifacts); }
        if (turn === 3) return tool("upsert_course_question", { question: { ...fixture, id: "q2", question: "A distinct question?" } });
        if (turn === 4) {
          const withoutQuestions = { studyGuide: artifacts.studyGuide, researchNotes: artifacts.researchNotes, chapters: artifacts.chapters, conceptGraph: artifacts.conceptGraph };
          return tool("save_course_build", withoutQuestions);
        }
        return { role: "assistant", content: "Saved" };
      },
    });
    expect(job.status).toBe(finish === "save" ? "complete" : "failed");
    expect(db.getCourse(job.courseId)?.questions.length).toBe(finish === "save" ? 2 : 0);
  }
});

test("in-app builds reject archived edits and video saves without a transcript", async () => {
  const job = jobFor("guarded-build");
  db.upsertCourse({ id: job.courseId, title: "Video", videoUrl: "https://youtu.be/o3CX_Y59_74" });
  db.upsertQuestion(job.courseId, fixture); db.archiveQuestion(job.courseId, "q1");
  const archived = db.getQuestion(job.courseId, "q1")!;
  let turn = 0;
  const errors: string[] = [];
  await runBuild(job, settings, databasePath, join(root, "prompts.json"), debug, new AbortController().signal, {
    fetchResearch,
    callModel: async (_settings, messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") errors.push(JSON.parse(last.content ?? "{}").error);
      if (turn++ === 0) return tool("upsert_course_question", { question: fixture, expectedRevision: archived.revision });
      if (turn === 2) return tool("save_course_build", artifacts);
      throw new Error("End test");
    },
  });
  expect(errors[0]).toContain("Archived");
  expect(errors[1]).toContain("transcript");
  expect(db.getQuestion(job.courseId, "q1")).toEqual(archived);
  expect(db.getCourse(job.courseId)?.studyGuide).toBeFalsy();
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
    const question = db.upsertQuestion(job.courseId, fixture)!;
    const check = await (await fetch(new URL("/fact-check", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: job.courseId, questionId: question.id, contentHash: question.contentHash }) })).json();
    expect(check.id).toBeString();
    expect((await fetch(new URL("/build/" + check.id + "/cancel", server.url), { method: "POST" })).status).toBe(400);
    expect((await fetch(new URL("/fact-check/" + check.id + "/cancel", server.url), { method: "POST" })).status).toBe(200);
  } finally { server.stop(true); model.stop(true); }
});

test("provider CORS follows the configured UI port unless explicitly overridden", async () => {
  const oldPort = process.env.VIDMARK_APP_PORT, oldOrigins = process.env.VIDMARK_ALLOWED_ORIGINS;
  process.env.VIDMARK_APP_PORT = "3011"; delete process.env.VIDMARK_ALLOWED_ORIGINS;
  const server = startModelProviderServer(join(root, "cors-settings.json"), databasePath, join(root, "prompts.json"), 0);
  try {
    expect((await fetch(new URL("/settings", server.url), { headers: { Origin: "http://localhost:3011" } })).status).toBe(200);
    expect((await fetch(new URL("/settings", server.url), { headers: { Origin: "http://localhost:3010" } })).status).toBe(403);
    process.env.VIDMARK_ALLOWED_ORIGINS = "http://localhost:3999";
    expect((await fetch(new URL("/settings", server.url), { headers: { Origin: "http://localhost:3999" } })).status).toBe(200);
    expect((await fetch(new URL("/settings", server.url), { headers: { Origin: "http://localhost:3011" } })).status).toBe(403);
  } finally {
    server.stop(true);
    if (oldPort === undefined) delete process.env.VIDMARK_APP_PORT; else process.env.VIDMARK_APP_PORT = oldPort;
    if (oldOrigins === undefined) delete process.env.VIDMARK_ALLOWED_ORIGINS; else process.env.VIDMARK_ALLOWED_ORIGINS = oldOrigins;
  }
});
