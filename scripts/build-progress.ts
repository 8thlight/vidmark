import * as z from "zod";
import { publicAgentMessage, type BuildProgress } from "../app/build-progress";

const itemSchema = z.object({ title: z.string().trim().min(1).max(240), position: z.number().int().min(1).max(1000).optional(), total: z.number().int().min(1).max(1000).optional() })
  .refine(item => item.position === undefined || item.total === undefined || item.position <= item.total, "Position must not exceed total.");
export const buildProgressReportSchema = z.object({ message: z.string().trim().min(1).max(1200), chapter: itemSchema.optional(), question: itemSchema.optional() });
export const buildProgressDescription = "Report a brief public progress update and the chapter/question currently being worked on. Position is one-based, not a completed count. Omit unknown totals. This is display-only: it never saves content, marks QA, or completes the build. Do not include private reasoning, credentials or tool payloads.";

// Counts change only after successful writes; reports cannot claim a saved build.
export class CourseBuildProgress {
  private state: BuildProgress = { stagedQuestions: 0, savedChapters: 0, savedQuestions: 0, saved: false };
  constructor(private readonly publish: (progress: BuildProgress) => void) { this.emit(); }
  private emit() { this.publish(structuredClone(this.state)); }
  requirements(questionTarget?: number) { this.state.questionTarget = questionTarget; this.emit(); }
  report(input: unknown) {
    const report = buildProgressReportSchema.parse(input);
    report.message = publicAgentMessage(report.message, 1200);
    for (const item of [report.chapter, report.question]) if (item) item.title = publicAgentMessage(item.title, 240);
    this.state.report = report;
    this.state.activity = { label: "Agent-reported work", chapter: report.chapter, question: report.question };
    this.emit();
  }
  question(label: string, payload: unknown, stagedCount?: number) {
    if (stagedCount !== undefined) this.state.stagedQuestions = stagedCount;
    const question = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const chapter = question.chapter || question.sectionId;
    this.state.activity = { label, question: typeof question.question === "string" ? { title: publicAgentMessage(question.question, 240) } : undefined, chapter: typeof chapter === "string" ? { title: publicAgentMessage(chapter, 240) } : undefined };
    this.emit();
  }
  committed(chapters: number, questions: number) {
    Object.assign(this.state, { saved: true, savedChapters: chapters, savedQuestions: questions, stagedQuestions: 0, activity: { label: "Course content saved to your library" } });
    this.emit();
  }
}
