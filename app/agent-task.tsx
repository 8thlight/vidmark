"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, SearchCheck } from "lucide-react";
import type { QuestionReview } from "./question-review";
import { QuestionReviewMarker } from "./question-review";

const PROVIDER_URL = import.meta.env.VITE_VIDMARK_PROVIDER_ORIGIN || "http://127.0.0.1:31418";
type AgentJob = { id: string; status: "queued" | "running" | "complete" | "failed"; harness?: string; phase: string; message: string; agentMessage?: string; review?: QuestionReview };
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
  useEffect(() => { completion.current = onComplete; }, [onComplete]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await request<{ job: AgentJob | null }>(`/${kind}?${query}`);
        if (!active) return;
        setJob(result.job);
        if (result.job?.status === "complete" && !completed.current.has(result.job.id)) {
          completed.current.add(result.job.id);
          await completion.current?.();
        }
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : "Agent status unavailable."); }
      if (active) timer = setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [kind, query]);
  const start = async (input: Record<string, unknown>) => {
    setBusy(true); setStatus("");
    try { setJob(await request<AgentJob>(`/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Agent could not start. Check Settings."); }
    finally { setBusy(false); }
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
    {job && <div className={`build-job ${job.status}`} role="status"><div>{(job.status === "running" || job.status === "queued") && <LoaderCircle className="spin" aria-hidden="true" />}<span><b>{job.phase}</b><small>{job.message}</small></span></div></div>}
    {job?.status === "failed" && job.agentMessage && <details className="agent-result-message"><summary>Agent’s last response</summary><p>{job.agentMessage}</p></details>}
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
