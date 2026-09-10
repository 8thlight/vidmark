import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase } from "../scripts/vidmark-db";
import { chapterVideos, webUrl, youtubeId } from "../app/course-source";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExamMode } from "../app/exam-mode";

const root = await mkdtemp(join(tmpdir(), "vidmark-reading-test-"));
const db = new VidmarkDatabase(join(root, "alice.sqlite"));
const peer = new VidmarkDatabase(join(root, "bob.sqlite"));
afterAll(async () => { db.close(); peer.close(); await rm(root, { recursive: true, force: true }); });

test("non-video courses persist their source without fabricating a YouTube URL", () => {
  db.upsertCourse({ id: "reading-course", title: "Reading course", source: "Web", sourceUrl: "https://example.com/course" });
  expect(db.getCourse("reading-course")?.videoUrl).toBe("");
  expect(db.listCourses().find((course) => course.id === "reading-course")?.sourceUrl).toBe("https://example.com/course");
  db.upsertCourse({ id: "reading-course", title: "Updated" });
  expect(db.getCourse("reading-course")?.sourceUrl).toBe("https://example.com/course");
});

test("chapters preserve multiple optional videos through sharing", () => {
  db.replaceChapters("reading-course", [{ id: "intro", title: "Introduction", videos: [
    { title: "One", url: "https://www.youtube.com/watch?v=reDRM0tqhNs", startSeconds: 47 },
    { title: "Two", url: "https://example.com/lesson.mp4" },
  ] }, { id: "practice", title: "Reading and practice" }]);
  const imported = peer.importCourseBundle(db.exportCourseBundle("reading-course"));
  expect(imported?.videoUrl).toBe("");
  expect(imported?.sourceUrl).toBe("https://example.com/course");
  expect(imported?.chapters[0].videos).toEqual(db.listChapters("reading-course")[0].videos);
  expect(imported?.chapters[1].videos).toEqual([]);
});

test("invalid media is rejected before replacing existing chapters", () => {
  const before = db.listChapters("reading-course");
  expect(() => db.replaceChapters("reading-course", [{ id: "bad", videos: [{ title: "Bad", url: "javascript:alert(1)" }] }])).toThrow("HTTP(S)");
  expect(db.listChapters("reading-course")).toEqual(before);
  expect(() => chapterVideos([{ title: "Invalid time", url: "https://example.com/video", startSeconds: -1 }])).toThrow("non-negative");
});

test("YouTube source detection rejects lookalike hosts and malformed IDs", () => {
  expect(youtubeId("https://notyoutube.com/watch?v=reDRM0tqhNs")).toBe("");
  expect(youtubeId("https://www.youtube.com/watch?v=bad")).toBe("");
  expect(youtubeId("https://youtu.be/reDRM0tqhNs")).toBe("reDRM0tqhNs");
  expect(webUrl("file:///etc/passwd")).toBe("");
});

test("existing video courses retain their video and source on import", () => {
  db.upsertCourse({ id: "reDRM0tqhNs", title: "Existing", videoUrl: "https://www.youtube.com/watch?v=reDRM0tqhNs" });
  const imported = peer.importCourseBundle(db.exportCourseBundle("reDRM0tqhNs"));
  expect(imported?.videoUrl).toBe("https://www.youtube.com/watch?v=reDRM0tqhNs");
  expect(imported?.sourceUrl).toBe(imported?.videoUrl);
});

test("source URL migration does not fork an unchanged locked global course", () => {
  db.upsertCourse({ id: "legacy", title: "Legacy", videoUrl: "https://www.youtube.com/watch?v=reDRM0tqhNs" });
  db.db.query("UPDATE courses SET source_url='' WHERE id='legacy'").run();
  db.setCourseCollaboration("legacy", { visibility: "public", globalVersion: 1, globalLocked: true });
  db.upsertCourse({ id: "legacy", title: "Legacy" });
  expect(db.getCourse("legacy")?.globalLocked).toBe(true);
  expect(db.getCourse("legacy")?.visibility).toBe("public");
});

test("metadata edits preserve the selected course when active is omitted", () => {
  db.upsertCourse({ id: "selected", title: "Selected", sourceUrl: "https://example.com/selected", active: true });
  db.upsertCourse({ id: "selected", title: "Selected updated" });
  expect(db.getCourse("selected")?.active).toBe(true);
});

test("selecting a course clears other active courses in the same transaction", () => {
  db.upsertCourse({ id: "first-active", title: "First", active: true });
  db.upsertCourse({ id: "second-active", title: "Second", active: true });
  expect(db.listCourses().filter(course => course.active).map(course => course.id)).toEqual(["second-active"]);
});

test("rejected imports and course writes do not change metadata or selected course", () => {
  const before = db.getCourse("reading-course");
  const selected = db.listCourses().filter(course => course.active).map(course => course.id);
  const invalid = { id: "reading-course", title: "Should not persist", active: true, chapters: [{ id: "bad", videos: [{ title: "Bad", url: "javascript:alert(1)" }] }] };
  expect(() => db.upsertCourse(invalid)).toThrow();
  expect(db.getCourse("reading-course")).toEqual(before);
  expect(() => db.importCourseBundle(invalid)).toThrow();
  expect(db.getCourse("reading-course")).toEqual(before);
  expect(db.listCourses().filter(course => course.active).map(course => course.id)).toEqual(selected);
});

test("reading courses do not inherit the CCA exam or its start controls", () => {
  const html = renderToStaticMarkup(createElement(ExamMode, { questionBank: [], courseId: "reading-course" }));
  expect(html).toContain("No certification exam format has been configured");
  expect(html).not.toContain("CCA-F");
  expect(html).not.toContain("Start timed exam");
});

test("source-only imports never interpret an eleven-character course ID as a video", () => {
  const imported = peer.importCourseBundle({ course: { id: "readingtest", title: "Reading", sourceUrl: "https://example.com/reading" } });
  expect(imported?.videoUrl).toBe("");
  expect(imported?.sourceUrl).toBe("https://example.com/reading");
});
