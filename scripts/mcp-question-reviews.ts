import type { SystemPromptOverrides } from "../app/system-prompts";
import { questionReviewSchema } from "./course-artifacts";
import { createQuestionFactCheck } from "./question-fact-check";
import { researchFetchResult } from "./research-fetch-result";
import { safeFetchUrl } from "./research-fetch";
import { VidmarkDatabase } from "./vidmark-db";
import * as z from "zod";

export const mcpQuestionReviewSchema = questionReviewSchema.extend({ notes: z.string().trim().min(20).max(12000), evidence: z.array(z.string().trim().min(1)).min(1).max(30) });

type Entry = {
  courseId: string; questionId: string; revision: number; contentHash: string; reviewer: string; expiresAt: number;
  session: ReturnType<typeof createQuestionFactCheck>; controller: AbortController; timer: ReturnType<typeof setTimeout>;
};

// The full-library MCP is stateless HTTP. Opaque, expiring review capabilities
// bind separate calls to one question snapshot and its retrieved evidence.
export class McpQuestionReviews {
  private entries = new Map<string, Entry>();
  constructor(private store: VidmarkDatabase, private fetchResearch = (url: string, signal: AbortSignal) => researchFetchResult(url, value => safeFetchUrl(value, signal)), private now = Date.now) {}
  private end(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); entry.controller.abort(); entry.session.close(); this.entries.delete(id);
  }
  private get(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= this.now()) { this.end(id); throw new Error("Review session expired or not found. Call start_question_review again."); }
    return entry;
  }
  async start(courseId: string, questionId: string, reviewer: string, overrides: SystemPromptOverrides) {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.end(id);
    if (this.entries.size >= 32) throw new Error("Too many active question reviews. Finish a review or wait for it to expire.");
    const question = this.store.getQuestion(courseId, questionId);
    if (!question || question.archived) throw new Error("Question not found.");
    const controller = new AbortController();
    const session = createQuestionFactCheck(this.store, courseId, questionId, question.contentHash, overrides, url => this.fetchResearch(url, controller.signal), reviewer, "mcp");
    const id = crypto.randomUUID();
    const expiresAt = this.now() + 15 * 60_000;
    const timer = setTimeout(() => this.end(id), 15 * 60_000); timer.unref();
    this.entries.set(id, { courseId, questionId, revision: question.revision, contentHash: question.contentHash, reviewer, expiresAt, controller, session, timer });
    return { reviewSessionId: id, expiresAt, question: await session.invoke("get_course_question", {}), instructions: session.prompt + "\nFor this full-MCP interface, the question snapshot is included here. Use get_question_review_evidence (source.type url or transcript) instead of fetch_url/get_transcript, and record_question_review instead of record_fact_check. Include reviewSessionId on both calls.", next: "Only evidence IDs retrieved by this session can be cited." };
  }
  evidence(id: string, source: { type: "url"; url: string } | { type: "transcript"; offset: number; limit: number }) {
    const entry = this.get(id);
    return source.type === "url" ? entry.session.invoke("fetch_url", { url: source.url }) : entry.session.invoke("get_transcript", { offset: source.offset, limit: source.limit });
  }
  async record(id: string, courseId: string, questionId: string, revision: number, input: unknown) {
    const entry = this.get(id);
    const review = mcpQuestionReviewSchema.parse(input);
    if (entry.courseId !== courseId || entry.questionId !== questionId || entry.revision !== revision || entry.contentHash !== review.contentHash || entry.reviewer !== review.reviewer) throw new Error("Review does not match this session's question, revision, hash or reviewer.");
    const missing = review.outcome === "inconclusive" && review.evidence.length === 1 && review.evidence[0] === "No sufficient source evidence was retrieved.";
    await entry.session.invoke("record_fact_check", { verdict: review.outcome === "reviewed" ? "accurate" : review.outcome === "needs_changes" ? "inaccurate" : "uncertain", reasoning: review.notes, evidenceIds: missing ? [] : review.evidence });
    this.end(id);
    return this.store.getQuestion(courseId, questionId);
  }
  close() { for (const id of this.entries.keys()) this.end(id); }
}
