"use client";

import { X } from "lucide-react";
import { applyQuestionPatch, questionPayloadChanges, questionValuesEqual } from "./question-diff";
import type { QuestionSuggestion, StoredQuestion, SyncPreferences } from "./vidmark-client";

type QuestionPayload = {
  scenario?: string;
  question?: string;
  options?: Record<"A" | "B" | "C" | "D", { text?: string; rationale?: string }>;
  correctAnswer?: "A" | "B" | "C" | "D";
  grading?: { principle?: string; hinge?: string };
};

const choices = ["A", "B", "C", "D"] as const;
const payload = (value?: Record<string, unknown>) => (value ?? {}) as QuestionPayload;
const changed = (before: unknown, after: unknown) => !questionValuesEqual(before, after);
const valueLabel = (value: unknown) => value === undefined ? "Not set" : typeof value === "string" ? value || "Empty" : JSON.stringify(value, null, 2);

function QuestionColumn({ title, subtitle, value, other, tone }: { title: string; subtitle: string; value: QuestionPayload; other: QuestionPayload; tone: "removed" | "added" }) {
  const answer = value.correctAnswer;
  return <section className="question-diff-column">
    <header><h3>{title}</h3><p>{subtitle}</p></header>
    <div className={`question-diff-field ${changed(value.question, other.question) ? tone : ""}`}><span>Question</span><p>{value.question || "No existing question"}</p></div>
    {value.scenario ? <div className={`question-diff-field ${changed(value.scenario, other.scenario) ? tone : ""}`}><span>Scenario</span><p>{value.scenario}</p></div> : null}
    <div className="question-diff-options">{choices.map((choice) => {
      const option = value.options?.[choice]?.text ?? "—";
      const otherOption = other.options?.[choice]?.text ?? "—";
      return <div className={changed(option, otherOption) ? tone : ""} key={choice}><b>{choice}</b><p>{option}</p></div>;
    })}</div>
    <div className={`question-diff-field answer ${changed(answer, other.correctAnswer) ? tone : ""}`}><span>Correct answer</span><p>{answer ? `${answer} · ${value.options?.[answer]?.text ?? ""}` : "—"}</p></div>
    <div className={`question-diff-field ${changed(answer ? value.options?.[answer]?.rationale : "", other.correctAnswer ? other.options?.[other.correctAnswer]?.rationale : "") ? tone : ""}`}><span>Answer rationale</span><p>{answer ? value.options?.[answer]?.rationale || "No rationale supplied" : "—"}</p></div>
    <div className={`question-diff-field ${changed(value.grading?.principle, other.grading?.principle) ? tone : ""}`}><span>Decision rule</span><p>{value.grading?.principle || "—"}</p></div>
  </section>;
}

export function QuestionDiffReview({ suggestion, current, preferences, loading, onClose, onDismiss, onImport }: { suggestion: QuestionSuggestion; current: StoredQuestion | null; preferences: SyncPreferences; loading: boolean; onClose: () => void; onDismiss: () => void; onImport: () => void; onPreferencesChange: (next: SyncPreferences) => void }) {
  const before = payload(current?.payload);
  const proposed = payload(suggestion.proposedPatch);
  const incoming = suggestion.kind === "update" && current ? payload(applyQuestionPatch(before as Record<string, unknown>, proposed as Record<string, unknown>)) : proposed;
  const changes = questionPayloadChanges(before as Record<string, unknown>, incoming as Record<string, unknown>);
  const duplicate = Boolean(current) && changes.length === 0;
  const author = suggestion.authorProfile?.name ?? "A Vidmark user";

  return <dialog open className="modal-backdrop question-diff-backdrop" aria-label="Review question update">
    <section className="question-diff-modal">
      <header className="question-diff-head"><div><h2>Review question update</h2><p>From {author} · {new Date(suggestion.createdAt).toLocaleString()}</p></div><button type="button" aria-label="Close question review" onClick={onClose}><X aria-hidden="true" /></button></header>
      {duplicate ? <div className="question-diff-summary duplicate"><b>No changes detected</b><p>The incoming question is identical to your local version. Nothing will be imported.</p></div> : <details className="question-diff-summary" open><summary>{changes.length} changed field{changes.length === 1 ? "" : "s"}</summary><div>{changes.map((change) => <article key={change.path}><b>{change.path || "Question"}</b><span><del>{valueLabel(change.before)}</del><ins>{valueLabel(change.after)}</ins></span></article>)}</div></details>}
      <div className="question-diff-grid">
        <QuestionColumn title="Your version" subtitle={current ? `Revision ${current.revision}` : "Not in your library"} value={before} other={incoming} tone="removed" />
        <QuestionColumn title="Incoming version" subtitle={`From ${author}`} value={incoming} other={before} tone="added" />
      </div>
      <p>Automatic question imports are {preferences.autoImportQuestions ? "on" : "off"}. Change this in Settings → Imports.</p>
      <footer><button type="button" disabled={loading} onClick={duplicate ? onDismiss : onClose}>{duplicate ? "Dismiss duplicate" : "Not now"}</button><button className="import-question" type="button" disabled={loading || duplicate} onClick={onImport}>{duplicate ? "No changes to import" : loading ? "Importing…" : "Import question"}</button></footer>
    </section>
  </dialog>;
}
