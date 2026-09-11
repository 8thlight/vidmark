import { agentQuestionReviewSchema } from "./course-artifacts";
import type { QuestionRecord } from "./vidmark-db";
import { createHash } from "node:crypto";

const transcriptHash = (cues: unknown[]) => createHash("sha256").update(JSON.stringify(cues)).digest("hex");

export class CourseReviewEvidence {
  private questions = new Map<string, { revision: number; contentHash: string }>();
  private sources = new Set<string>();
  private transcripts = new Map<string, { courseId: string; hash: string }>();
  constructor(private currentTranscript: (courseId: string) => unknown[]) {}
  readQuestion(question: QuestionRecord | null) {
    if (question?.archived) throw new Error("Archived questions cannot receive new QA reviews.");
    if (question) this.questions.set(question.id, { revision: question.revision, contentHash: question.contentHash });
    return question;
  }
  fetched(url: string, result: unknown) {
    const value = result as { ok?: boolean; content?: unknown } | null;
    if (value?.ok === true && typeof value.content === "string" && value.content.trim()) this.sources.add(url);
  }
  transcript(courseId: string, cues: unknown[], offset: number, count: number) {
    const hash = transcriptHash(cues);
    const evidenceId = `transcript:${courseId}:${hash}:${offset}-${offset + count}`;
    if (count) { this.sources.add(evidenceId); this.transcripts.set(evidenceId, { courseId, hash }); }
    return evidenceId;
  }
  validate(questionId: string, revision: number, input: unknown) {
    const review = agentQuestionReviewSchema.parse(input);
    const read = this.questions.get(questionId);
    if (!read || read.revision !== revision || read.contentHash !== review.contentHash) throw new Error("Read this exact saved question version with get_course_question before recording QA.");
    const noEvidence = review.outcome === "inconclusive" && review.evidence.length === 1 && review.evidence[0] === "No sufficient source evidence was retrieved.";
    if (!noEvidence && review.evidence.some(id => !this.sources.has(id))) throw new Error("Cite only evidence IDs successfully retrieved in this build with fetch_url or get_transcript. For an inconclusive review without evidence, use: No sufficient source evidence was retrieved.");
    for (const id of review.evidence) {
      const snapshot = this.transcripts.get(id);
      if (snapshot && snapshot.hash !== transcriptHash(this.currentTranscript(snapshot.courseId))) throw new Error("Transcript evidence changed. Read the current transcript again before recording QA.");
    }
    return review;
  }
}
