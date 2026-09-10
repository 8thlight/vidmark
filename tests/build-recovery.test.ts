import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase } from "../scripts/vidmark-db";
import { researchFetchResult } from "../scripts/research-fetch-result";

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
    db.syncBrowserCourses([{ id: "new", title: "New course", sourceUrl: "https://example.com" }], "new");
    expect(db.listCourses().filter(x => x.active).map(x => x.id)).toEqual(["new"]);
    db.replaceTranscript("video", [{ time: 5, text: "Explicit import" }]);
    db.syncBrowserCourses([{ id: "video", title: "Stale", transcript: [] }]);
    expect(db.getCourse("video")?.transcript).toEqual([{ time: 5, text: "Explicit import" }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a broken research link returns an evidence gap and permits another source", async () => {
  const result = await researchFetchResult("https://example.com/missing", async () => { throw new Error("Documentation fetch returned HTTP 404."); });
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("content");
  expect(result.guidance).toContain("Do not cite it");
  const next = await researchFetchResult("https://example.com/valid", async () => "Verified text");
  expect(next.ok).toBe(true);
  expect(next.content).toBe("Verified text");
});
