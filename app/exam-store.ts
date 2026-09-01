import { DomainId, ExamQuestion, examBank } from "./exam-data";

export type ExamChoice = "A" | "B" | "C" | "D";

export type ExamResponse = {
  questionId: number;
  selected: ExamChoice;
  correct: boolean;
};

export type DomainAttemptResult = {
  domain: DomainId;
  correct: number;
  total: number;
  percent: number;
};

export type ExamAttempt = {
  id: string;
  courseId: string;
  courseName: string;
  completedAt: string;
  durationSeconds: number;
  totalQuestions: number;
  correct: number;
  percent: number;
  responses: ExamResponse[];
  questionIds: number[];
  domainResults: DomainAttemptResult[];
};

export type ActiveExam = {
  id: string;
  courseId: string;
  courseName: string;
  questionIds: number[];
  currentIndex: number;
  responses: ExamResponse[];
  flaggedIds: number[];
  remainingSeconds: number;
  paused: boolean;
  startedAt: string;
  lastTickAt: string;
};

export const EXAM_QUESTION_COUNT = 60;
export const EXAM_DURATION_SECONDS = 120 * 60;
export const DEFAULT_EXAM_COURSE_ID = "reDRM0tqhNs";
export const DEFAULT_EXAM_COURSE_NAME = "Claude Certified Architect — Foundations";

const ACTIVE_KEY = "vidmark-active-exam-v1";
const ATTEMPTS_KEY = "vidmark-exam-attempts-v1";

const domainCounts: Record<DomainId, number> = {
  architecture: 16,
  tools: 11,
  code: 12,
  prompting: 12,
  context: 9,
};

const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffle = <T,>(values: T[], random: () => number) => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
};

export const createExamQuestionIds = (seed = Date.now(), bank: ExamQuestion[] = examBank) => {
  const random = seededRandom(seed);
  const selected = (Object.entries(domainCounts) as [DomainId, number][]).flatMap(([domain, count]) => {
    const pool = bank.filter((question) => question.domain === domain);
    const byDifficulty = {
      foundational: shuffle(pool.filter((question) => question.difficulty === "foundational"), random),
      standard: shuffle(pool.filter((question) => question.difficulty === "standard"), random),
      advanced: shuffle(pool.filter((question) => question.difficulty === "advanced"), random),
    };
    const target = {
      foundational: Math.max(1, Math.round(count * 0.2)),
      advanced: Math.max(1, Math.round(count * 0.25)),
    };
    const chosen = [
      ...byDifficulty.foundational.slice(0, target.foundational),
      ...byDifficulty.advanced.slice(0, target.advanced),
    ];
    const remaining = shuffle(pool.filter((question) => !chosen.some((item) => item.id === question.id)), random);
    return [...chosen, ...remaining].slice(0, count);
  });
  return shuffle(selected, random).map((question) => question.id);
};

export const examQuestionsFromIds = (ids: number[], bank: ExamQuestion[] = examBank): ExamQuestion[] =>
  ids.map((id) => bank.find((question) => question.id === id)).filter((question): question is ExamQuestion => Boolean(question));

export const readActiveExam = (): ActiveExam | null => {
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<ActiveExam>;
    return { ...stored, courseId: stored.courseId ?? DEFAULT_EXAM_COURSE_ID, courseName: stored.courseName ?? DEFAULT_EXAM_COURSE_NAME } as ActiveExam;
  } catch { return null; }
};

export const saveActiveExam = (exam: ActiveExam | null) => {
  try {
    if (exam) window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(exam));
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch { /* Exam mode still works for the current session. */ }
};

export const readExamAttempts = (): ExamAttempt[] => {
  try {
    const raw = window.localStorage.getItem(ATTEMPTS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Partial<ExamAttempt>[]).map((attempt) => ({ ...attempt, courseId: attempt.courseId ?? DEFAULT_EXAM_COURSE_ID, courseName: attempt.courseName ?? DEFAULT_EXAM_COURSE_NAME } as ExamAttempt));
  } catch { return []; }
};

export const saveExamAttempts = (attempts: ExamAttempt[]) => {
  try { window.localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts)); } catch { /* Keep in memory. */ }
};

export const buildAttempt = (exam: ActiveExam): ExamAttempt => {
  const questions = examQuestionsFromIds(exam.questionIds);
  const domainResults = (Object.keys(domainCounts) as DomainId[]).map((domain) => {
    const domainQuestionIds = questions.filter((question) => question.domain === domain).map((question) => question.id);
    const matching = exam.responses.filter((response) => domainQuestionIds.includes(response.questionId));
    const correct = matching.filter((response) => response.correct).length;
    return { domain, correct, total: domainQuestionIds.length, percent: Math.round((correct / domainQuestionIds.length) * 100) };
  });
  const correct = exam.responses.filter((response) => response.correct).length;
  return {
    id: exam.id,
    courseId: exam.courseId,
    courseName: exam.courseName,
    completedAt: new Date().toISOString(),
    durationSeconds: EXAM_DURATION_SECONDS - exam.remainingSeconds,
    totalQuestions: questions.length,
    correct,
    percent: Math.round((correct / questions.length) * 100),
    responses: exam.responses,
    questionIds: exam.questionIds,
    domainResults,
  };
};
