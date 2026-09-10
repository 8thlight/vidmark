import { afterEach, expect, test } from "bun:test";
import { buildAttempt, courseDomains, createExamQuestionIds, DEFAULT_EXAM_COURSE_ID, readActiveExam, readExamAttempts, saveActiveExam, saveExamAttempts, type ActiveExam } from "../app/exam-store";
import { examBank, type ExamQuestion } from "../app/exam-data";

const bank: ExamQuestion[] = Array.from({ length: 60 }, (_, i) => ({ ...examBank[0], id: i + 1, bankId: `reading-${i}`, domain: `topic-${i % 10}`, domainLabel: `Topic ${i % 10}`, correct: "D" }));
const session = (courseId: string): ActiveExam => ({ id: "attempt", courseId, courseName: "Reading exam", questionIds: [1, 2], questionSnapshot: bank.slice(0, 2), responses: [{ questionId: 1, selected: "D", correct: false }], currentIndex: 0, flaggedIds: [], paused: true, remainingSeconds: 180, durationSeconds: 240, startedAt: new Date().toISOString(), lastTickAt: new Date().toISOString() });
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); });
function localStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } } });
  return values;
}

test("a source-only bank supplies all timed exam questions without CCA domain selection", () => {
  const ids = createExamQuestionIds(10, bank, "reading");
  expect(ids).toHaveLength(60);
  expect(new Set(ids).size).toBe(60);
  expect(ids).toEqual(createExamQuestionIds(10, bank, "reading"));
  expect(createExamQuestionIds(10, bank.slice(0, 6), "reading")).toHaveLength(6);
  expect(createExamQuestionIds(10)).toHaveLength(60);
});

test("domain labels and weights come from this course's bank", () => {
  const domains = courseDomains("reading", bank);
  expect(Object.keys(domains)).toHaveLength(10);
  expect(domains["topic-0"]).toEqual({ name: "Topic 0", short: "Topic 0", weight: 10 });
  expect(domains.architecture).toBeUndefined();
});

test("scoring uses the saved questions rather than another or revised bank", () => {
  const attempt = buildAttempt(session("reading"), examBank);
  expect(attempt.correct).toBe(1);
  expect(attempt.percent).toBe(50);
  expect(attempt.durationSeconds).toBe(60);
  expect(attempt.domainResults.map(row => row.domain)).toEqual(["topic-0", "topic-1"]);
});

test("sessions and scores are course-scoped while legacy CCA data remains readable", () => {
  const values = localStorage();
  saveActiveExam(session(DEFAULT_EXAM_COURSE_ID));
  saveActiveExam(session("reading"));
  expect(readActiveExam()?.courseId).toBe(DEFAULT_EXAM_COURSE_ID);
  expect(readActiveExam("reading")?.courseId).toBe("reading");
  expect(readActiveExam("another")).toBeNull();
  expect(values.has("vidmark-active-exam-v1")).toBe(true);
  saveExamAttempts([buildAttempt(session("reading"))], "reading");
  expect(readExamAttempts("reading")).toHaveLength(1);
  expect(readExamAttempts()).toHaveLength(0);
  saveActiveExam(null, "reading");
  expect(readActiveExam("reading")).toBeNull();
  expect(readActiveExam()).not.toBeNull();
});
