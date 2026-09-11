import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VidmarkDatabase, STARTER_COURSE_ID } from "../scripts/vidmark-db";
import { QuestionReviewMarker, mergeQuestionReviewState, type QuestionReview } from "../app/question-review";
import { CourseReviewEvidence } from "../scripts/course-review-evidence";
import { systemPromptDefinitions } from "../app/system-prompts";

const dir = mkdtempSync(join(tmpdir(), "vidmark-quality-"));
const db = new VidmarkDatabase(join(dir, "test.sqlite"));
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const sample = structuredClone(db.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!.payload);
const question = { ...sample, id: "q1", sectionId: "chapter", videoReferences: [], sources: [{ label: "Primary source", url: "https://example.com/docs", accessedAt: "2026-09-10" }] };
const chapter = { id: "chapter", title: "Chapter", summary: "Summary" };
const review = { reviewer: "Connected agent", outcome: "reviewed", notes: "Checked answer and every distractor against the cited source.", evidence: ["https://example.com/docs"] };

test("bulk saves enforce structure, coverage, quantity and atomic rollback without requiring QA", () => {
  db.upsertCourse({ id: "quality", title: "Quality", studyGuide: "Original", sourceUrl: "https://example.com" });
  db.setBuildRequirements("quality", { questionCount: 1, chapterIds: ["chapter"] });
  const build = { studyGuide: "New", chapters: [chapter], questions: [question] };
  expect(() => db.saveCourseBuild("quality", { ...build, conceptGraph: { nodes: [], edges: [{ source: "missing", target: "missing", type: "contains" }] } })).toThrow();
  expect(db.getCourse("quality")?.studyGuide).toBe("Original");
  expect(db.listQuestions("quality").total).toBe(0);
  expect(() => db.saveCourseBuild("quality", { ...build, questions: [] })).toThrow();
  expect(() => db.saveCourseBuild("quality", { ...build, questions: [{ ...question, correctAnswer: "Z" }] })).toThrow();
  expect(() => db.saveCourseBuild("quality", { ...build, questions: [{ ...question, options: { A: { text: "No rationale" } } }] })).toThrow();
  expect(() => db.saveCourseBuild("quality", { ...build, questions: [{ ...question, sectionId: "unknown" }] })).toThrow();
  expect(db.saveCourseBuild("quality", build).unreviewed).toBe(1);
});

test("QA asterisks reflect exact content, persist across restart, and return after edits", () => {
  const first = db.getQuestion("quality", "q1")!;
  expect(renderToStaticMarkup(createElement(QuestionReviewMarker, { review: first.qaReview }))).toContain("Not agent-QA reviewed");
  expect(() => db.reviewQuestion("quality", "q1", first.revision + 1, { ...review, contentHash: first.contentHash }, "mcp")).toThrow();
  expect(() => db.reviewQuestion("quality", "q1", first.revision, { ...review, contentHash: "0".repeat(64) }, "mcp")).toThrow();
  const reviewed = db.reviewQuestion("quality", "q1", first.revision, { ...review, contentHash: first.contentHash }, "mcp")!;
  expect(renderToStaticMarkup(createElement(QuestionReviewMarker, { review: reviewed.qaReview }))).toContain("Agent QA reviewed");
  const reopened = new VidmarkDatabase(db.path);
  expect(reopened.getQuestion("quality", "q1")?.qaReview?.reviewer).toBe("Connected agent");
  reopened.close();
  const peer = new VidmarkDatabase(join(dir, "shared.sqlite"));
  peer.importCourseBundle(db.exportCourseBundle("quality"));
  expect(peer.getQuestion("quality", "q1")?.qaReview?.shared).toBe(true);
  peer.close();
  db.saveCourseBuild("quality", { questions: [question] });
  expect(db.getQuestion("quality", "q1")?.qaReview?.outcome).toBe("reviewed");
  const changed = db.patchQuestion("quality", "q1", { question: "A different question?" }, undefined, true)!;
  expect(changed.qaReview).toBeNull();
  expect(db.getQuestionReviews("quality", "q1")[0]?.question).toEqual(question);
  expect(db.getQuestionReviews("quality", "q1")[0]?.review).toMatchObject({ outcome: "reviewed", reviewer: "Connected agent" });
  expect(() => db.patchQuestion("quality", "q1", { correctAnswer: "Z" }, changed.revision, true)).toThrow();
  expect(db.getQuestion("quality", "q1")?.revision).toBe(changed.revision);
});

test("duplicate question detection normalizes case and whitespace before committing", () => {
  db.upsertCourse({ id: "duplicates", title: "Duplicates", sourceUrl: "https://example.com", studyGuide: "Original" });
  db.setBuildRequirements("duplicates", { questionCount: 2 });
  expect(() => db.saveCourseBuild("duplicates", { studyGuide: "Changed", chapters: [chapter], questions: [
    { ...question, id: "first", question: "What is the purpose?" },
    { ...question, id: "second", question: "WHAT  is\n the purpose?" },
  ] })).toThrow("Duplicate question text");
  expect(db.getCourse("duplicates")?.studyGuide).toBe("Original");
  expect(db.listQuestions("duplicates").total).toBe(0);
});

test("instructions preserve identity, make QA optional, and contain no model catalog", () => {
  const prompts = systemPromptDefinitions.map(p => p.defaultValue).join("\n");
  expect(prompts).toContain("QA is optional");
  expect(prompts).toContain("Preserve the subject");
  expect(prompts).toContain("caption");
  expect(prompts).not.toMatch(/(?:gpt-\d|qwen\d|claude-\d|sonnet|opus|haiku|terra|luna)/i);
});

test("course sharing preserves archived state and readable QA history without duplicate imports", () => {
  const id = "shared-archives";
  db.upsertCourse({ id, title: "Archive sharing", sourceUrl: "https://example.com" });
  db.replaceQuestions(id, [question, { ...question, id: "q2", question: "Second question" }]);
  const saved = db.getQuestion(id, "q1")!;
  db.reviewQuestion(id, "q1", saved.revision, { ...review, contentHash: saved.contentHash }, "mcp");
  db.archiveQuestion(id, "q1");
  const peer = new VidmarkDatabase(join(dir, "archive-import.sqlite"));
  try {
    const bundle = db.exportCourseBundle(id);
    peer.importCourseBundle(bundle);
    expect(peer.listQuestions(id).questions.map(q => q.id)).toEqual(["q2"]);
    expect(peer.getQuestion(id, "q1")?.archived).toBe(true);
    expect(peer.getQuestion(id, "q1")?.qaReview?.shared).toBe(true);
    expect(peer.getQuestionReviews(id, "q1")).toHaveLength(1);
    expect(peer.getQuestionReviews(id, "q1")[0]?.question).toEqual(question);
    peer.importCourseBundle(bundle);
    expect(peer.getQuestionReviews(id, "q1")).toHaveLength(1);
    expect(peer.getQuestion(id, "q1")?.archived).toBe(true);
  } finally { peer.close(); }
});

test("build QA requires reading the exact saved version and retrieving its cited evidence", () => {
  let transcript = [{ time: 0, text: "Original evidence" }, { time: 1, text: "Continuation" }];
  const ledger = new CourseReviewEvidence(() => transcript);
  const saved = db.getQuestion("quality", "q1")!;
  const input = { ...review, contentHash: saved.contentHash };
  expect(() => ledger.validate(saved.id, saved.revision, input)).toThrow("Read this exact");
  ledger.readQuestion(saved);
  expect(() => ledger.validate(saved.id, saved.revision, input)).toThrow("successfully retrieved");
  ledger.fetched(review.evidence[0], { ok: false, content: "Invented" });
  ledger.fetched(review.evidence[0], { ok: true, content: "   " });
  expect(() => ledger.validate(saved.id, saved.revision, input)).toThrow();
  ledger.fetched(review.evidence[0], { ok: true, content: "Actual source" });
  expect(ledger.validate(saved.id, saved.revision, input).outcome).toBe("reviewed");
  expect(() => ledger.validate(saved.id, saved.revision + 1, input)).toThrow();
  expect(() => ledger.validate(saved.id, saved.revision, { ...input, contentHash: "0".repeat(64) })).toThrow();
  const noEvidence = { ...input, outcome: "inconclusive", evidence: ["No sufficient source evidence was retrieved."] };
  expect(ledger.validate(saved.id, saved.revision, noEvidence).outcome).toBe("inconclusive");
  expect(() => ledger.validate(saved.id, saved.revision, { ...noEvidence, outcome: "reviewed" })).toThrow();
  const empty = ledger.transcript("quality", [], 0, 0);
  expect(() => ledger.validate(saved.id, saved.revision, { ...input, evidence: [empty] })).toThrow();
  const evidenceId = ledger.transcript("quality", transcript, 0, 2);
  expect(evidenceId).toMatch(/:[a-f0-9]{64}:0-2$/);
  expect(ledger.validate(saved.id, saved.revision, { ...input, evidence: [evidenceId] }).outcome).toBe("reviewed");
  transcript = [{ time: 0, text: "Replaced evidence" }];
  expect(() => ledger.validate(saved.id, saved.revision, { ...input, evidence: [evidenceId] })).toThrow("Transcript evidence changed");
  const refreshed = ledger.transcript("quality", transcript, 0, 1);
  expect(ledger.validate(saved.id, saved.revision, { ...input, evidence: [refreshed] }).outcome).toBe("reviewed");
  expect(() => ledger.readQuestion({ ...saved, archived: true })).toThrow("Archived");
});

test("complete rebuilds preserve archived rows and history, and discard orphaned current QA", () => {
  const id = "rebuild-archives";
  db.upsertCourse({ id, title: "Rebuild", sourceUrl: "https://example.com" });
  db.setBuildRequirements(id, { questionCount: 1 });
  db.replaceChapters(id, [chapter]);
  const bank = Array.from({ length: 1002 }, (_, index) => ({ ...question, id: `q${index}`, question: `Question ${index}?` }));
  db.replaceQuestions(id, bank);
  for (const questionId of ["q0", "q1", "q1001"]) {
    const q = db.getQuestion(id, questionId)!;
    db.reviewQuestion(id, questionId, q.revision, { ...review, contentHash: q.contentHash }, "mcp");
  }
  db.archiveQuestion(id, "q1001");
  const archived = db.getQuestion(id, "q1001")!;
  const history = db.getQuestionReviews(id, "q1001");
  db.saveCourseBuild(id, { questions: [bank[0]] });
  expect(db.getQuestion(id, "q1001")).toEqual(archived);
  expect(db.getQuestionReviews(id, "q1001")).toEqual(history);
  expect(db.getQuestion(id, "q0")?.qaReview?.outcome).toBe("reviewed");
  expect(db.getQuestion(id, "q1")).toBeNull();
  expect(db.db.query("SELECT * FROM question_reviews WHERE course_id=? AND question_id='q1'").get(id)).toBeNull();
  db.upsertQuestion(id, bank[1]);
  expect(db.getQuestion(id, "q1")?.qaReview).toBeNull();
  expect(db.getQuestionReviews(id, "q1")).toHaveLength(1);
  expect(() => db.saveCourseBuild(id, { questions: [bank[1001]], studyGuide: "Must roll back" })).toThrow("archived");
  expect(db.getCourse(id)?.studyGuide).not.toBe("Must roll back");
  expect(() => db.reviewQuestion(id, archived.id, archived.revision, { ...review, contentHash: archived.contentHash }, "mcp")).toThrow("Archived");
});

test("video reference validation uses the greatest cue time, not transcript order", () => {
  const id = "unordered-transcript";
  db.upsertCourse({ id, title: "Video", videoUrl: "https://youtu.be/o3CX_Y59_74" });
  db.replaceTranscript(id, [{ time: 100, text: "Later cue" }, { time: 0, text: "First cue" }]);
  db.setBuildRequirements(id, { questionCount: 1 });
  const build = { chapters: [chapter], questions: [{ ...question, videoReferences: [{ timestampSeconds: 90, label: "Evidence" }] }] };
  expect(db.saveCourseBuild(id, build).questions).toBe(1);
  expect(() => db.saveCourseBuild(id, { ...build, questions: [{ ...build.questions[0], videoReferences: [{ timestampSeconds: 131, label: "Outside" }] }] })).toThrow("outside");
});

test("exam QA refresh preserves frozen questions and ignores reviews for different content", () => {
  const qaReview: QuestionReview = { ...review, outcome: "reviewed", contentHash: "hash", reviewedAt: 123, via: "mcp" };
  const snapshot = [{ bankId: "q1", contentHash: "hash", question: "Frozen question", correct: "A", qaReview: null as QuestionReview | null }];
  const latest = [{ ...snapshot[0], question: "Must not replace the exam", correct: "B", qaReview }];
  const updated = mergeQuestionReviewState(snapshot, latest);
  expect(updated[0]).toEqual({ ...snapshot[0], qaReview });
  expect(snapshot[0].qaReview).toBeNull();
  expect(mergeQuestionReviewState(snapshot, [{ ...latest[0], contentHash: "different" }])).toEqual(snapshot);
});
