import { DomainId, ExamQuestion, examBank, domains as ccaDomains } from "./exam-data";

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
  durationSeconds?: number;
  questionSnapshot?: ExamQuestion[];
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

export const createExamQuestionIds = (seed = Date.now(), bank: ExamQuestion[] = examBank, courseId = DEFAULT_EXAM_COURSE_ID) => {
  const random = seededRandom(seed);
  if (courseId !== DEFAULT_EXAM_COURSE_ID) return shuffle(bank, random).slice(0, EXAM_QUESTION_COUNT).map((question) => question.id);
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

const courseKey = (key: string, courseId: string) => courseId === DEFAULT_EXAM_COURSE_ID ? key : `${key}:${courseId}`;

export const readActiveExam = (courseId = DEFAULT_EXAM_COURSE_ID): ActiveExam | null => {
  try {
    const raw = window.localStorage.getItem(courseKey(ACTIVE_KEY, courseId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<ActiveExam>;
    if ((stored.courseId ?? DEFAULT_EXAM_COURSE_ID) !== courseId) return null;
    return { ...stored, courseId: stored.courseId ?? DEFAULT_EXAM_COURSE_ID, courseName: stored.courseName ?? DEFAULT_EXAM_COURSE_NAME } as ActiveExam;
  } catch { return null; }
};

export const saveActiveExam = (exam: ActiveExam | null, courseId = exam?.courseId ?? DEFAULT_EXAM_COURSE_ID) => {
  try {
    if (exam) window.localStorage.setItem(courseKey(ACTIVE_KEY, courseId), JSON.stringify(exam));
    else window.localStorage.removeItem(courseKey(ACTIVE_KEY, courseId));
  } catch { /* Exam mode still works for the current session. */ }
};

export const readExamAttempts = (courseId = DEFAULT_EXAM_COURSE_ID): ExamAttempt[] => {
  try {
    const raw = window.localStorage.getItem(courseKey(ATTEMPTS_KEY, courseId));
    if (!raw) return [];
    return (JSON.parse(raw) as Partial<ExamAttempt>[]).map((attempt) => ({ ...attempt, courseId: attempt.courseId ?? DEFAULT_EXAM_COURSE_ID, courseName: attempt.courseName ?? DEFAULT_EXAM_COURSE_NAME } as ExamAttempt)).filter((attempt) => attempt.courseId === courseId);
  } catch { return []; }
};

export const saveExamAttempts = (attempts: ExamAttempt[], courseId = DEFAULT_EXAM_COURSE_ID) => {
  try { window.localStorage.setItem(courseKey(ATTEMPTS_KEY, courseId), JSON.stringify(attempts)); } catch { /* Keep in memory. */ }
};

export const buildAttempt = (exam: ActiveExam, bank: ExamQuestion[] = examBank): ExamAttempt => {
  const questions = exam.questionSnapshot ?? examQuestionsFromIds(exam.questionIds, bank);
  const domainResults = [...new Set(questions.map((question) => question.domain))].map((domain) => {
    const domainQuestionIds = questions.filter((question) => question.domain === domain).map((question) => question.id);
    const matching = exam.responses.filter((response) => domainQuestionIds.includes(response.questionId));
    const correct = questions.filter((question) => question.domain === domain && matching.some((response) => response.questionId === question.id && response.selected === question.correct)).length;
    return { domain, correct, total: domainQuestionIds.length, percent: Math.round((correct / domainQuestionIds.length) * 100) };
  });
  const correct = questions.filter((question) => exam.responses.some((response) => response.questionId === question.id && response.selected === question.correct)).length;
  return {
    id: exam.id,
    courseId: exam.courseId,
    courseName: exam.courseName,
    completedAt: new Date().toISOString(),
    durationSeconds: Math.max(0, (exam.durationSeconds ?? EXAM_DURATION_SECONDS) - exam.remainingSeconds),
    totalQuestions: questions.length,
    correct,
    percent: questions.length ? Math.round((correct / questions.length) * 100) : 0,
    responses: exam.responses,
    questionIds: exam.questionIds,
    domainResults,
  };
};

export function courseDomains(courseId: string, bank: ExamQuestion[]): Record<string, {name: string; short: string; weight: number}> {
  if (courseId === DEFAULT_EXAM_COURSE_ID) return ccaDomains;
  return Object.fromEntries([...new Set(bank.map(q => q.domain))].map(id => {
    const pool = bank.filter(q => q.domain === id);
    const name = pool[0]?.domainLabel || id.replaceAll("-", " ");
    return [id, {name, short: name, weight: Math.round(pool.length / Math.max(1, bank.length) * 100)}];
  }));
}
