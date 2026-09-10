export type QuestionReview = {
  shared?: boolean;
  reviewer: string;
  reviewedAt: number;
  notes: string;
  evidence: string[];
  contentHash: string;
  outcome: "reviewed" | "needs_changes" | "inconclusive";
  via: "mcp" | "local-model";
};

// An active exam freezes question content. Only refresh QA for the exact same
// content hash; a review of a newer revision must never approve the snapshot.
export function mergeQuestionReviewState<T extends { bankId: string; contentHash?: string; qaReview?: QuestionReview | null }>(snapshot: T[], latest: T[]): T[] {
  const byId = new Map(latest.map(question => [question.bankId, question]));
  return snapshot.map(question => {
    const current = byId.get(question.bankId);
    return current && question.contentHash && current.contentHash === question.contentHash
      ? { ...question, qaReview: current.qaReview }
      : question;
  });
}

export function QuestionReviewMarker({ review }: { review?: QuestionReview | null }) {
  if (review?.outcome === "reviewed") return <small className="question-review-status" title={`${review.reviewer} · ${new Date(review.reviewedAt).toLocaleString()} · ${review.notes}`}>{review.shared ? "Agent QA reviewed · shared report" : "Agent QA reviewed"}</small>;
  return <span className="question-review-status unreviewed" title={review?.notes ?? "No model or connected agent has recorded QA for this question version."}><span aria-hidden="true">*</span> {review?.outcome === "needs_changes" ? "Agent QA found issues" : review?.outcome === "inconclusive" ? "Unable to verify" : "Not agent-QA reviewed"}</span>;
}
