import * as z from "zod";
import { webUrl } from "../app/course-source";

const text = z.string().trim().min(1);
export const citationUrl = z.string().refine(value => Boolean(webUrl(value)), "Citations require HTTP(S) URLs without credentials.");
const choice = z.enum(["A", "B", "C", "D"]);
const option = z.object({ text, rationale: text });
export const questionSchema = z.object({
  id: text, enabled: z.boolean().default(true), sectionId: text, domainId: text,
  chapter: z.string().optional(), domainLabel: z.string().optional(),
  difficulty: z.enum(["foundational", "standard", "advanced"]), mode: z.enum(["standard", "hard"]),
  scenario: text, question: text,
  options: z.object({ A: option, B: option, C: option, D: option }).strict(), correctAnswer: choice,
  grading: z.object({ temptingDistractor: choice, principle: text, missType: z.enum(["judgment", "recall"]), hinge: text }),
  videoReferences: z.array(z.object({ timestampSeconds: z.number().int().min(0), label: text, screenshot: z.string().optional() })).default([]),
  sources: z.array(z.object({ label: text, url: citationUrl, accessedAt: text })).default([]), tags: z.array(text).default([]),
});
export function validateQuestion(input: unknown) {
  const question = questionSchema.parse(input);
  if (question.grading.temptingDistractor === question.correctAnswer) throw new Error("The tempting distractor must differ from the correct answer.");
  if (new Set(Object.values(question.options).map(o => o.text.toLowerCase())).size !== 4) throw new Error("Question options must be distinct.");
  return question;
}
export const chapterSchema = z.object({ id: text, title: text, summary: text, content: z.string().optional(), learningObjectives: z.array(text).optional(), start: z.number().min(0).optional(), videos: z.array(z.object({ title: text, url: z.url(), startSeconds: z.number().min(0).optional() })).optional() }).passthrough();
export const buildRequirementsSchema = z.object({ questionCount: z.number().int().min(1).max(1000).optional(), chapterIds: z.array(text).optional() });
export type BuildRequirements = z.infer<typeof buildRequirementsSchema>;
export const questionReviewSchema = z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/), reviewer: text, notes: text, evidence: z.array(text).min(1), outcome: z.enum(["reviewed", "needs_changes", "inconclusive"]) });
