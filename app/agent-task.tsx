"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, SearchCheck } from "lucide-react";
import type { QuestionReview } from "./question-review";
import { QuestionReviewMarker } from "./question-review";
import { createAgentTaskPoller } from "./agent-task-polling";
import type { BuildProgress } from "./build-progress";
import { BuildProgressView } from "./build-progress-view";

const PROVIDER_URL = import.meta.env.VITE_VIDMARK_PROVIDER_ORIGIN || "http://127.0.0.1:31418";
type AgentJob = { id: string; status: "queued" | "running" | "complete" | "failed"; harness?: string; phase: string; message: string; agentMessage?: string; review?: QuestionReview; progress?: BuildProgress };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PROVIDER_URL}${path}`, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status}).`);
  return value;
}

// Poll sequentially, retain server-owned tasks across navigation, and ignore old-course responses.
function useAgentTask(kind: "build" | "fact-check", query: string, onComplete?: () => void | Promise<void>) {
  const [job, setJob] = useState<AgentJob | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const completed = useRef(new Set<string>());
  const completion = useRef(onComplete);
  const polling = useRef<ReturnType<typeof createAgentTaskPoller<AgentJob>> | null>(null);
  useEffect(() => { completion.current = onComplete; }, [onComplete]);
  useEffect(() => {
    const poller = createAgentTaskPoller(async () => (await request<{ job: AgentJob | null }>(`/${kind}?${query}`)).job, async job => {
      setJob(job);
      if (job?.status === "complete" && !completed.current.has(job.id)) {
        completed.current.add(job.id);
        await completion.current?.();
      }
    }, error => setStatus(error instanceof Error ? error.message : "Agent status unavailable."));
    polling.current = poller;
    poller.restart();
    return () => { poller.stop(); if (polling.current === poller) polling.current = null; };
  }, [kind, query]);
  const start = async (input: Record<string, unknown>) => {
    const poller = polling.current;
    setBusy(true); setStatus("");
    try {
      const started = await request<AgentJob>(`/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (poller && polling.current === poller) { setJob(started); poller.restart(); }
    }
    catch (error) { if (polling.current === poller) setStatus(error instanceof Error ? error.message : "Agent could not start. Check Settings."); }
    finally { if (polling.current === poller) setBusy(false); }
  };
  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try { await request(`/${kind}/${job.id}/cancel`, { method: "POST" }); setStatus("Stopping the agent…"); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not stop the agent."); }
    finally { setBusy(false); }
  };
  return { job, status, busy, start, cancel, running: job?.status === "queued" || job?.status === "running" };
}

function TaskStatus({ job, status }: { job: AgentJob | null; status: string }) {
  return <>
    {job && <div className={`build-job ${job.status}`}><div className="build-job-heading" role="status">{(job.status === "running" || job.status === "queued") && <LoaderCircle className="spin" aria-hidden="true" />}<span><b>{job.phase}</b><small>{job.message}</small></span></div>
      {job.progress && <BuildProgressView progress={job.progress} running={job.status === "running" || job.status === "queued"} agentMessage={job.agentMessage} />}
    </div>}
    {job?.status === "failed" && job.agentMessage && !job.progress && <details className="agent-result-message"><summary>Agent’s last response</summary><p>{job.agentMessage}</p></details>}
    {status && <p role="status">{status}</p>}
  </>;
}

export function CourseAgentBuild({ courseId, built, children, onComplete }: { courseId: string; built: boolean; children?: ReactNode; onComplete: () => Promise<void> }) {
  const task = useAgentTask("build", new URLSearchParams({ courseId }).toString(), onComplete);
  return <section className="course-agent-build" aria-label="Course agent build">
    <div className="course-agent-actions"><button type="button" disabled={task.busy || task.running} onClick={() => void task.start({ courseId })}>{task.running && <LoaderCircle className="spin" aria-hidden="true" />}{built ? "Update with agent" : "Build with agent"}</button>{children}{task.running && <button type="button" onClick={() => void task.cancel()} disabled={task.busy}>Cancel build</button>}</div>
    {built && <p>A new build may replace existing course content.</p>}
    <TaskStatus job={task.job} status={task.status} />
  </section>;
}

export function QuestionFactCheck({ courseId, questionId, contentHash, review, onComplete }: { courseId: string; questionId: string; contentHash: string; review?: QuestionReview | null; onComplete?: () => void | Promise<void> }) {
  const task = useAgentTask("fact-check", new URLSearchParams({ courseId, questionId, contentHash }).toString(), onComplete);
  const report = task.job?.review ?? review;
  const [showReport, setShowReport] = useState(false);
  return <section className="question-fact-check" aria-label="Question fact check">
    <div className="fact-check-actions"><button type="button" disabled={task.busy || task.running || !contentHash} onClick={() => { setShowReport(true); void task.start({ courseId, questionId, contentHash }); }}>{task.running ? <LoaderCircle className="spin" aria-hidden="true" /> : <SearchCheck aria-hidden="true" />} Fact Check</button>{task.running && <button type="button" onClick={() => void task.cancel()} disabled={task.busy}>Cancel</button>}<QuestionReviewMarker review={report} /></div>
    <small>{contentHash ? "Checks factual accuracy only. The explanation may reveal answers; content is never edited." : "Refresh this question to load its saved version before checking it."}</small>
    {task.job?.status !== "complete" && <TaskStatus job={task.job} status={task.status} />}
    {task.job?.status === "complete" && task.status && <p role="status">{task.status}</p>}
    {report && <details open={showReport} onToggle={event => setShowReport(event.currentTarget.open)} className={`fact-check-report ${report.outcome}`}><summary>{report.outcome === "reviewed" ? "No factual inaccuracies found" : report.outcome === "needs_changes" ? "Potential factual inaccuracies" : "Unable to verify"}</summary><p>{report.notes}</p><ul>{report.evidence.map((source, i) => <li key={`${source}-${i}`}>{/^https?:\/\//i.test(source) ? <a href={source} target="_blank" rel="noreferrer">{source}</a> : source}</li>)}</ul><small>{report.reviewer} · {new Date(report.reviewedAt).toLocaleString()} · This is an agent assessment, not a guarantee of accuracy.</small></details>}
  </section>;
}
