import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase } from "../scripts/vidmark-db";
import { researchFetchResult } from "../scripts/research-fetch-result";
import { startVidmarkMcpServer } from "../scripts/vidmark-mcp";
import { createAgentTaskPoller } from "../app/agent-task-polling";

test("stale browser snapshots cannot erase acquired transcripts or newer course content", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidmark-sync-test-"));
  const db = new VidmarkDatabase(join(dir, "test.sqlite"));
  try {
    db.upsertCourse({ id: "video", title: "Updated by agent", videoUrl: "https://youtu.be/o3CX_Y59_74", studyGuide: "Agent guide" });
    db.replaceTranscript("video", [{ time: 0, text: "Acquired cue" }]);
    const before = db.getCourse("video");
    for (let i = 0; i < 3; i++) db.syncBrowserCourses([{ id: "video", title: "Stale title", transcript: [], studyGuide: "Stale guide" }], "video");
    expect(db.getCourse("video")?.transcript).toEqual(before?.transcript);
    expect(db.getCourse("video")?.title).toBe("Updated by agent");
    expect(db.getCourse("video")?.studyGuide).toBe("Agent guide");
    expect(db.getCourse("video")?.revision).toBe(before?.revision);
    db.syncBrowserCourses([{ id: "new", title: "New course", sourceUrl: "https://example.com", transcript: [{ time: 5, text: "Browser seed caption" }] }], "new");
    expect(db.getTranscript("new").cues).toEqual([{ time: 5, text: "Browser seed caption" }]);
    expect(db.listCourses().filter(x => x.active).map(x => x.id)).toEqual(["new"]);
    db.replaceTranscript("video", [{ time: 5, text: "Explicit import" }]);
    db.syncBrowserCourses([{ id: "video", title: "Stale", transcript: [] }]);
    expect(db.getCourse("video")?.transcript).toEqual([{ time: 5, text: "Explicit import" }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("transcript writes validate imported cues and compare the pre-acquisition hash atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidmark-transcript-guards-"));
  const db = new VidmarkDatabase(join(dir, "test.sqlite"));
  try {
    db.upsertCourse({ id: "guarded", title: "Original", sourceUrl: "https://example.com" });
    const oldHash = db.transcriptHash("guarded");
    db.replaceTranscript("guarded", [{ time: 10, text: "Manual transcript" }]);
    const before = db.getCourse("guarded");
    expect(() => db.replaceTranscript("guarded", [{ time: 0, text: "Late captions" }], oldHash)).toThrow("Transcript changed");
    for (const transcript of [[{ time: -1, text: "Invalid" }], [{ time: Infinity, text: "Invalid" }], [{ time: NaN, text: "Invalid" }], [{ time: 1, text: "   " }], Array(100001).fill({ time: 0, text: "Too many" })]) {
      expect(() => db.importCourseBundle({ course: { id: "guarded", title: "Invalid overwrite", sourceUrl: "https://example.com", transcript } })).toThrow();
      expect(db.getCourse("guarded")).toEqual(before);
    }
    db.replaceTranscript("guarded", [{ time: 11, text: "Current captions" }], db.transcriptHash("guarded"));
    expect(db.getTranscript("guarded").cues).toEqual([{ time: 11, text: "Current captions" }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("full local MCP rejects foreign and opaque browser Origins before all route dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vidmark-origins-"));
  const priorPort = process.env.VIDMARK_APP_PORT, priorOrigins = process.env.VIDMARK_ALLOWED_ORIGINS;
  process.env.VIDMARK_APP_PORT = "3099"; delete process.env.VIDMARK_ALLOWED_ORIGINS;
  const service = await startVidmarkMcpServer(join(dir, "test.sqlite"), { port: 0 });
  try {
    for (const origin of ["https://attacker.example", "null", ""]) {
      for (const path of ["/state/sync", "/api/profile", "/mcp"]) {
        const response = await fetch(new URL(path, service.server.url), { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: JSON.stringify({ courses: [{ id: "attack", title: "Attack" }], name: "Attacker" }) });
        expect(response.status).toBe(403);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
      expect((await fetch(new URL("/state/sync", service.server.url), { method: "OPTIONS", headers: { Origin: origin } })).status).toBe(403);
    }
    expect(service.store.getCourse("attack")).toBeNull();
    expect(service.store.getProfile()).toBeNull();
    for (const origin of [undefined, "http://localhost:3099"]) {
      const response = await fetch(new URL("/state/sync", service.server.url), { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ courses: [{ id: "allowed", title: "Allowed", sourceUrl: "https://example.com" }] }) });
      expect(response.status).toBe(200);
    }
    expect(service.store.getCourse("allowed")?.title).toBe("Allowed");
  } finally {
    service.stop(true); rmSync(dir, { recursive: true, force: true });
    if (priorPort === undefined) delete process.env.VIDMARK_APP_PORT; else process.env.VIDMARK_APP_PORT = priorPort;
    if (priorOrigins === undefined) delete process.env.VIDMARK_ALLOWED_ORIGINS; else process.env.VIDMARK_ALLOWED_ORIGINS = priorOrigins;
  }
});

test("task polling stops on terminal or empty jobs, restarts, and ignores stale in-flight results", async () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 12));
  for (const terminal of [null, { status: "complete" as const }, { status: "failed" as const }]) {
    let calls = 0;
    let next: { status: "running" | "complete" | "failed" } | null = terminal;
    const poller = createAgentTaskPoller(async () => { calls++; return next; }, () => {}, () => {}, 2);
    poller.restart(); await pause(); expect(calls).toBe(1);
    next = { status: "running" }; poller.restart(); await pause(); expect(calls).toBeGreaterThan(2);
    next = { status: "complete" }; await pause(); const stopped = calls; await pause(); expect(calls).toBe(stopped);
    poller.stop();
  }
  const pending: Array<(value: { status: "complete" }) => void> = [];
  let applied = 0;
  const poller = createAgentTaskPoller(() => new Promise<{ status: "complete" }>(resolve => pending.push(resolve)), () => { applied++; }, () => {}, 2);
  poller.restart(); poller.restart(); pending[0]({ status: "complete" }); await pause(); expect(applied).toBe(0);
  pending[1]({ status: "complete" }); await pause(); expect(applied).toBe(1);
  poller.restart(); poller.stop(); pending[2]({ status: "complete" }); await pause(); expect(applied).toBe(1);
});

test("general MCP caption acquisition also guards concurrent imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vidmark-full-mcp-caption-race-"));
  const manual = [{ time: 5, text: "User import" }];
  const service = await startVidmarkMcpServer(join(dir, "test.sqlite"), { port: 0, acquireTranscript: async () => {
    service.store.replaceTranscript("race", manual);
    return { videoId: "o3CX_Y59_74", language: "en", trackName: "Test", automaticallyGenerated: true, sourceUrl: "https://youtube.com", acquiredAt: new Date().toISOString(), cues: [{ time: 0, text: "Late automatic captions" }] };
  } });
  try {
    service.store.upsertCourse({ id: "race", title: "Race", videoUrl: "https://youtu.be/o3CX_Y59_74" });
    const response = await fetch(new URL("/mcp", service.server.url), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "acquire_course_transcript", arguments: { courseId: "race" } } }) });
    const text = await response.text();
    const result = JSON.parse(text.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? text).result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Transcript changed during acquisition");
    expect(service.store.getTranscript("race").cues).toEqual(manual);
  } finally { service.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a broken research link returns an evidence gap and permits another source", async () => {
  const result = await researchFetchResult("https://example.com/missing", async () => { throw new Error("Documentation fetch returned HTTP 404."); });
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("content");
  expect(result.guidance).toContain("Do not cite it");
  const next = await researchFetchResult("https://example.com/valid", async () => "Verified text");
  expect(next.ok).toBe(true);
  expect(next.content).toBe("Verified text");
  const blank = await researchFetchResult("https://example.com/blank", async () => " \n\t");
  expect(blank.ok).toBe(false);
  expect(blank).not.toHaveProperty("content");
});
