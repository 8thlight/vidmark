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

export function QuestionReviewMarker({ review }: { review?: QuestionReview | null }) {
  if (review?.outcome === "reviewed") return <small className="question-review-status" title={`${review.reviewer} · ${new Date(review.reviewedAt).toLocaleString()} · ${review.notes}`}>{review.shared ? "Agent QA reviewed · shared report" : "Agent QA reviewed"}</small>;
  return <span className="question-review-status unreviewed" title={review?.notes ?? "No model or connected agent has recorded QA for this question version."}><span aria-hidden="true">*</span> {review?.outcome === "needs_changes" ? "Agent QA found issues" : review?.outcome === "inconclusive" ? "Unable to verify" : "Not agent-QA reviewed"}</span>;
}
