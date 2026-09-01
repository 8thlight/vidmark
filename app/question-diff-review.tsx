"use client";

import { Check, X } from "lucide-react";
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
const changed = (before: unknown, after: unknown) => JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);

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

export function QuestionDiffReview({ suggestion, current, preferences, loading, onClose, onImport, onPreferencesChange }: { suggestion: QuestionSuggestion; current: StoredQuestion | null; preferences: SyncPreferences; loading: boolean; onClose: () => void; onImport: () => void; onPreferencesChange: (next: SyncPreferences) => void }) {
  const before = payload(current?.payload);
  const incoming = payload(suggestion.proposedPatch);
  const author = suggestion.authorProfile?.name ?? "A Vidmark user";
  const updatePreference = async (checked: boolean) => onPreferencesChange({ ...preferences, autoImportQuestions: checked });
  return <dialog open className="modal-backdrop question-diff-backdrop" aria-label="Review question update">
    <section className="question-diff-modal">
      <header className="question-diff-head"><div><h2>Review question update</h2><p>From {author} · {new Date(suggestion.createdAt).toLocaleString()}</p></div><button type="button" aria-label="Close question review" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="question-diff-grid">
        <QuestionColumn title="Your version" subtitle={current ? `Revision ${current.revision}` : "Not in your library"} value={before} other={incoming} tone="removed" />
        <QuestionColumn title="Incoming version" subtitle={`From ${author}`} value={incoming} other={before} tone="added" />
      </div>
      <label className="auto-import-setting"><span><b>Automatically import shared questions</b><small>Off by default. When enabled, future questions and answers shared directly with you are imported without review.</small></span><input type="checkbox" checked={preferences.autoImportQuestions} onChange={(event) => void updatePreference(event.target.checked)} /><i aria-hidden="true"><Check /></i></label>
      <footer><button type="button" disabled={loading} onClick={onClose}>Not now</button><button className="import-question" type="button" disabled={loading} onClick={onImport}>{loading ? "Importing…" : "Import question"}</button></footer>
    </section>
  </dialog>;
}
