import type { BuildItem, BuildProgress } from "./build-progress";

function Item({ label, item }: { label: string; item: BuildItem }) {
  return <div><dt>{label}{item.position ? ` ${item.position}${item.total ? ` of ${item.total}` : ""}` : ""}</dt><dd>{item.title}</dd></div>;
}

export function BuildProgressView({ progress, running, agentMessage }: { progress: BuildProgress; running: boolean; agentMessage?: string }) {
  // Keep reported positions with their reported titles, even when a later tool
  // reads/stages a different item. Never carry an old position onto a new item.
  const activity = progress.activity?.label === "Agent-reported work" ? undefined : progress.activity;
  return <section className="build-progress" aria-label="Course build progress" aria-live="polite">
    {progress.report && <div className="build-progress-update"><b>Latest agent update</b><p>{progress.report.message}</p>
      {(progress.report.chapter || progress.report.question) && <dl className="build-progress-current">{progress.report.chapter && <Item label="Chapter" item={progress.report.chapter} />}{progress.report.question && <Item label="Question" item={progress.report.question} />}</dl>}
    </div>}
    {activity && <><p className="build-progress-label">{running ? activity.label : `Last activity · ${activity.label}`}</p>
      {(activity.chapter || activity.question) && <dl className="build-progress-current">{activity.chapter && <Item label="Chapter" item={activity.chapter} />}{activity.question && <Item label="Question" item={activity.question} />}</dl>}</>}
    <dl className="build-progress-counts">
      <div><dt>Questions staged</dt><dd>{progress.stagedQuestions}{!progress.saved && progress.questionTarget ? ` / ${progress.questionTarget}` : ""}</dd></div>
      <div><dt>Chapters saved</dt><dd>{progress.savedChapters}</dd></div>
      <div><dt>Questions saved</dt><dd>{progress.savedQuestions}{progress.questionTarget ? ` / ${progress.questionTarget}` : ""}</dd></div>
    </dl>
    <p className="build-progress-note">{progress.saved ? "Saved counts reflect successful writes in this build." : running ? "Staged questions stay out of your library until a successful course save." : "No completed course was saved by this build. Staged drafts are not retained after it ends."}</p>
    {agentMessage && <details className="agent-result-message"><summary>Latest agent response</summary><p>{agentMessage}</p></details>}
  </section>;
}
