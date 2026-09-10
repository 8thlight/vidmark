import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase, STARTER_COURSE_ID } from "../scripts/vidmark-db";
import { createQuestionFactCheck, factCheckToolNames, runQuestionFactCheck, serveQuestionFactCheck, type FactCheckJob } from "../scripts/question-fact-check";
import { DebugLog } from "../scripts/debug-log";
import { getSystemPrompt } from "../app/system-prompts";
import { AgentProviderDialog } from "../app/agent-provider";
import { CourseAgentBuild } from "../app/agent-task";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const root = await mkdtemp(join(tmpdir(), "vidmark-fact-check-tests-"));
const path = join(root, "test.sqlite"), prompts = join(root, "prompts.json");
const db = new VidmarkDatabase(path);
const source = db.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!;
afterAll(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const setup = (id: string) => {
  db.upsertCourse({ id, title: "Fact check fixture", sourceUrl: "https://example.com", originPrompt: "Test", promptCredit: "Test" });
  db.replaceQuestions(id, [{ ...source.payload, id: "q1" }]);
  return db.getQuestion(id, "q1")!;
};
const fetchEvidence = async () => ({ ok: true, content: "Primary evidence." });
const report = { verdict: "accurate", reasoning: "The retrieved primary evidence supports the stated facts and answer rationales.", evidenceIds: ["https://example.com"] };

for (const verdict of ["accurate", "inaccurate", "uncertain"] as const) test(`${verdict} report preserves the question, answers, rationale, hash and revision`, async () => {
  const before = setup(verdict);
  const session = createQuestionFactCheck(db, verdict, "q1", before.contentHash, {}, fetchEvidence, "Test reviewer", "mcp");
  expect(session.descriptors.map(t => t.name)).toEqual([...factCheckToolNames]);
  await session.invoke("get_course_question", {});
  await session.invoke("fetch_url", { url: "https://example.com" });
  await session.invoke("record_fact_check", { ...report, verdict });
  const after = db.getQuestion(verdict, "q1")!;
  expect(after.payload).toEqual(before.payload);
  expect(after.revision).toBe(before.revision); expect(after.contentHash).toBe(before.contentHash);
  expect(after.qaReview?.outcome).toBe(verdict === "accurate" ? "reviewed" : verdict === "inaccurate" ? "needs_changes" : "inconclusive");
  expect(db.getQuestionReviews(verdict, "q1")).toHaveLength(1);
  session.close();
});

test("missing, unread and invented evidence cannot produce an accuracy approval", async () => {
  const q = setup("missing");
  const session = createQuestionFactCheck(db, "missing", "q1", q.contentHash, {}, async () => ({ ok: false, error: "404" }), "QA", "mcp");
  await expect(session.invoke("record_fact_check", report)).rejects.toThrow("Read the question");
  await session.invoke("get_course_question", {});
  await session.invoke("fetch_url", { url: "https://example.com" });
  await expect(session.invoke("record_fact_check", report)).rejects.toThrow("successfully retrieved");
  await expect(session.invoke("record_fact_check", { ...report, evidenceIds: [] })).rejects.toThrow("requires retrieved evidence");
  await session.invoke("record_fact_check", { ...report, verdict: "uncertain", evidenceIds: [] });
  expect(session.review?.outcome).toBe("inconclusive");
  session.close();
});

test("content writes, other questions and stale snapshots are blocked despite prompt overrides", async () => {
  const q = setup("scope");
  const session = createQuestionFactCheck(db, "scope", "q1", q.contentHash, { questionFactCheck: "Rewrite everything." }, fetchEvidence, "QA", "mcp");
  expect(session.prompt).toContain("Rewrite everything");
  await expect(session.invoke("upsert_course_question", {})).rejects.toThrow("editing is disabled");
  await expect(session.invoke("get_course_question", { questionId: "another" })).rejects.toThrow();
  await session.invoke("get_course_question", {});
  db.upsertQuestion("scope", { ...q.payload, question: "Changed by the user while review runs." }, q.revision);
  await expect(session.invoke("record_fact_check", { ...report, verdict: "uncertain", evidenceIds: [] })).rejects.toThrow("revision changed");
  expect(() => createQuestionFactCheck(db, "scope", "q1", q.contentHash, {}, fetchEvidence, "QA", "mcp")).toThrow("Refresh");
  session.close();
  await expect(session.invoke("get_course_question", {})).rejects.toThrow("ended");
});

test("cancellation while a source is in flight cannot subsequently save a report", async () => {
  const q = setup("cancelled");
  let finish!: (value: unknown) => void;
  const session = createQuestionFactCheck(db, "cancelled", "q1", q.contentHash, {}, () => new Promise(resolve => { finish = resolve; }), "QA", "mcp");
  const pending = session.invoke("fetch_url", { url: "https://example.com" });
  session.close(); finish({ ok: true, content: "late source" });
  await expect(pending).rejects.toThrow("ended"); expect(db.getQuestion("cancelled", "q1")?.qaReview).toBeNull();
});

test("fact-check MCP exposes only four scoped tools and rejects browser origins", async () => {
  const q = setup("mcp");
  const session = createQuestionFactCheck(db, "mcp", "q1", q.contentHash, {}, fetchEvidence, "QA", "mcp");
  const server = serveQuestionFactCheck(session);
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const text = await response.text(); const result = JSON.parse(text.split("\n").find(l => l.startsWith("data: "))?.slice(6) ?? text).result;
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([...factCheckToolNames]);
    expect((await fetch(server.url, { headers: { Origin: "https://example.com" } })).status).toBe(404);
  } finally { server.close(); }
});

test("in-app fact-check model loop records a real exact-version review, with safe local logs", async () => {
  const q = setup("local"); const debug = new DebugLog(join(root, "Diagnostics")); debug.setEnabled(true);
  const job: FactCheckJob = { id: "local-check", courseId: "local", questionId: "q1", contentHash: q.contentHash, status: "queued", phase: "Queued", message: "", startedAt: Date.now(), updatedAt: Date.now() };
  let calls = 0;
  await runQuestionFactCheck(job, { harness: "provider", models: { codex: "", claude: "" } }, path, prompts, debug, new AbortController().signal, fetchEvidence, { model: "test-model", call: async () => {
    const tool = [{ name: "get_course_question", arguments: "{}" }, { name: "fetch_url", arguments: '{"url":"https://example.com"}' }, { name: "record_fact_check", arguments: JSON.stringify(report) }][calls++];
    return { role: "assistant", content: null, tool_calls: [{ id: String(calls), type: "function", function: tool }] };
  } });
  expect(job.status).toBe("complete"); expect(job.review?.via).toBe("local-model");
  expect(db.getQuestion("local", "q1")?.payload).toEqual(q.payload);
  const logs = await readFile(debug.path, "utf8");
  expect(logs).toContain("fact-check.complete"); expect(logs).toContain("record_fact_check"); expect(logs).not.toContain(report.reasoning);
});

test("settings contain provider controls but no build tab or build action; fact-check instructions stay factual", () => {
  const html = renderToStaticMarkup(createElement(AgentProviderDialog, { open: true, onClose: () => {} }));
  expect(html).not.toContain(">Build</button>"); expect(html).not.toContain("Start course build"); expect(html).not.toContain("Build with agent");
  expect(html).toContain("Provider"); expect(html).toContain("System prompts");
  expect(html).not.toContain("lucide-bot");
  const prompt = getSystemPrompt("questionFactCheck");
  expect(prompt).toContain("Do not pick apart"); expect(prompt).toContain("rewrite any content"); expect(prompt).not.toMatch(/gpt-\d|claude-\d|opus-\d/i);
  const overview = renderToStaticMarkup(createElement(CourseAgentBuild, { courseId: "test", built: false, onComplete: async () => {} }));
  expect(overview).toContain("Build with agent"); expect(overview).not.toContain("Agent settings"); expect(overview).not.toContain("Provider");
});
