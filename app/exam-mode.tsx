"use client";

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { BarChart3, Check, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Clock3, Eye, Flag, ListChecks, Network, RotateCcw, TimerReset, Trophy } from "lucide-react";
import { domains, type ExamQuestion } from "./exam-data";
import bundledConceptGraph from "../data/concept-graph.json";
import type { ConceptGraph } from "./concept-graph-types";
import { getCourseConceptGraph } from "./vidmark-client";
import {
  ActiveExam,
  buildAttempt,
  createExamQuestionIds,
  DEFAULT_EXAM_COURSE_ID,
  DEFAULT_EXAM_COURSE_NAME,
  EXAM_DURATION_SECONDS,
  ExamAttempt,
  ExamChoice,
  examQuestionsFromIds,
  readActiveExam,
  readExamAttempts,
  saveActiveExam,
  saveExamAttempts,
} from "./exam-store";

const ConceptGraph3D = lazy(() => import("./concept-graph-3d").then((module) => ({ default: module.ConceptGraph3D })));
type ExamTab = "session" | "results" | "concepts";
type StudyAid = "correct" | "all";

const formatClock = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
};

const domainOrder = ["architecture", "tools", "code", "prompting", "context"] as const;
const attemptColors = ["#ff624b", "#4b86ca", "#2d9c98", "#e4a229", "#9878cf"];

export function ExamMode({ questionBank, courseId }: { questionBank: ExamQuestion[]; courseId: string }) {
  const timedExamAvailable = courseId === DEFAULT_EXAM_COURSE_ID;
  const [tab, setTab] = useState<ExamTab>("session");
  const [exam, setExam] = useState<ActiveExam | null>(null);
  const [attempts, setAttempts] = useState<ExamAttempt[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [studyAids, setStudyAids] = useState<Record<number, StudyAid>>({});
  const [conceptGraphResult, setConceptGraphResult] = useState<{ courseId: string; graph: ConceptGraph | null } | null>(null);
  const conceptGraphLoaded = conceptGraphResult?.courseId === courseId;
  const conceptGraph = conceptGraphLoaded ? conceptGraphResult.graph : null;

  useEffect(() => {
    let active = true;
    void getCourseConceptGraph(courseId).then((stored) => {
      if (active) setConceptGraphResult({ courseId, graph: stored?.graph ?? null });
    }).catch(() => {
      if (active) setConceptGraphResult({ courseId, graph: courseId === "reDRM0tqhNs" ? bundledConceptGraph as ConceptGraph : null });
    });
    return () => { active = false; };
  }, [courseId]);

  useEffect(() => {
    if (!timedExamAvailable) return;
    const timer = window.setTimeout(() => {
      const stored = readActiveExam();
      if (stored && !stored.paused) {
        const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(stored.lastTickAt ?? stored.startedAt)) / 1000));
        stored.remainingSeconds = Math.max(0, stored.remainingSeconds - elapsed);
        stored.lastTickAt = new Date().toISOString();
      }
      setExam(stored);
      setAttempts(readExamAttempts());
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [timedExamAvailable]);

  useEffect(() => {
    if (hydrated && timedExamAvailable) saveActiveExam(exam);
  }, [exam, hydrated, timedExamAvailable]);

  const activeExamId = exam?.id;
  const examPaused = exam?.paused;
  useEffect(() => {
    if (!timedExamAvailable || !activeExamId || examPaused) return;
    const interval = window.setInterval(() => {
      setExam((current) => current ? { ...current, remainingSeconds: Math.max(0, current.remainingSeconds - 1), lastTickAt: new Date().toISOString() } : null);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [activeExamId, examPaused, timedExamAvailable]);

  const questionIds = exam?.questionIds;
  const questions = useMemo(() => questionIds ? examQuestionsFromIds(questionIds, questionBank) : [], [questionBank, questionIds]);
  const activeQuestion = exam ? questions[exam.currentIndex] : null;
  const response = activeQuestion ? exam?.responses.find((item) => item.questionId === activeQuestion.id) : null;
  const answeredCount = exam?.responses.length ?? 0;
  const activeStudyAid = activeQuestion ? studyAids[activeQuestion.id] : undefined;

  const startExam = () => {
    if (!timedExamAvailable || !questionBank.length) return;
    const now = Date.now();
    setExam({
      id: `exam-${now}`,
      courseId: DEFAULT_EXAM_COURSE_ID,
      courseName: DEFAULT_EXAM_COURSE_NAME,
      questionIds: createExamQuestionIds(now, questionBank),
      currentIndex: 0,
      responses: [],
      flaggedIds: [],
      remainingSeconds: EXAM_DURATION_SECONDS,
      paused: false,
      startedAt: new Date(now).toISOString(),
      lastTickAt: new Date(now).toISOString(),
    });
    setShowSubmit(false);
    setStudyAids({});
    setTab("session");
  };

  const toggleStudyAid = (mode: StudyAid) => {
    if (!activeQuestion) return;
    setStudyAids((current) => {
      const next = { ...current };
      if (next[activeQuestion.id] === mode) delete next[activeQuestion.id];
      else next[activeQuestion.id] = mode;
      return next;
    });
  };

  const submitExam = () => {
    if (!exam) return;
    const attempt = buildAttempt(exam);
    const next = [attempt, ...attempts].slice(0, 24);
    setAttempts(next);
    saveExamAttempts(next);
    setExam(null);
    setShowSubmit(false);
    setTab("results");
  };

  useEffect(() => {
    if (exam?.remainingSeconds !== 0) return;
    const timer = window.setTimeout(submitExam, 0);
    return () => window.clearTimeout(timer);
    // submitExam intentionally reads the current persisted attempt snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam?.remainingSeconds]);

  const selectChoice = (choice: ExamChoice) => {
    if (!exam || !activeQuestion || exam.paused) return;
    const nextResponse = { questionId: activeQuestion.id, selected: choice, correct: choice === activeQuestion.correct };
    setExam({ ...exam, responses: [...exam.responses.filter((item) => item.questionId !== activeQuestion.id), nextResponse] });
  };

  const goTo = (index: number) => {
    if (!exam || index < 0 || index >= questions.length) return;
    setExam({ ...exam, currentIndex: index });
  };

  const saveAndNext = () => {
    if (!exam) return;
    if (exam.currentIndex === questions.length - 1) setShowSubmit(true);
    else goTo(exam.currentIndex + 1);
  };

  const toggleFlag = () => {
    if (!exam || !activeQuestion) return;
    const flagged = exam.flaggedIds.includes(activeQuestion.id);
    setExam({ ...exam, flaggedIds: flagged ? exam.flaggedIds.filter((id) => id !== activeQuestion.id) : [...exam.flaggedIds, activeQuestion.id] });
  };

  if (!timedExamAvailable) return <section className="exam-mode"><div className="concept-view"><header><span>COURSE STUDY MAP</span><h1>Explore this course’s concepts</h1><p>Use Practice in the study workspace for this course’s questions. No certification exam format has been configured for this course.</p></header>{!conceptGraphLoaded ? <div className="graph-loading">Loading this course’s local concept graph…</div> : conceptGraph ? <Suspense fallback={<div className="graph-loading">Loading the local 3D graph…</div>}><ConceptGraph3D key={`${courseId}-${conceptGraph.graphId ?? "graph"}`} graph={conceptGraph} /></Suspense> : <div className="graph-loading">This course does not have a concept graph yet.</div>}</div></section>;

  return (
    <section className="exam-mode">
      <header className="exam-mode-tabs">
        <nav aria-label="Exam mode views">
          <button className={tab === "session" ? "active" : ""} onClick={() => setTab("session")}>Exam session</button>
          <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>Results <span>{attempts.length}</span></button>
          <button className={tab === "concepts" ? "active" : ""} onClick={() => setTab("concepts")}>Concept map</button>
        </nav>
        {tab !== "session" && <button className="start-exam-compact" type="button" onClick={startExam}><TimerReset aria-hidden="true" /> Start another exam</button>}
      </header>

      {tab === "session" && (!hydrated ? <div className="exam-loading">Loading your local exam session…</div> : !exam || !activeQuestion ? (
        <ExamStart attempts={attempts} onStart={startExam} onOpenResults={() => setTab("results")} onOpenConcepts={() => setTab("concepts")} />
      ) : (
        <div className="exam-taking">
          <section className="exam-question-area">
            <header className="exam-title-row">
              <div><span>CCA-F SIMULATION</span><h1>Foundations exam</h1></div>
              <div className="exam-clock"><span>Time remaining</span><strong>{formatClock(exam.remainingSeconds)}</strong><button type="button" onClick={() => setExam({ ...exam, paused: !exam.paused, lastTickAt: new Date().toISOString() })}>{exam.paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}{exam.paused ? "Resume" : "Pause"}</button></div>
            </header>
            <div className="exam-question-meta"><b>Question {exam.currentIndex + 1} of {questions.length}</b><div><span>{domains[activeQuestion.domain].name} · {domains[activeQuestion.domain].weight}%</span><em>{activeQuestion.difficulty}</em></div></div>
            <div className="exam-study-aids" aria-label="Answer display options">
              <span>Study aids</span>
              <button type="button" className={activeStudyAid === "correct" ? "active" : ""} aria-pressed={activeStudyAid === "correct"} onClick={() => toggleStudyAid("correct")}><Eye aria-hidden="true" /> Highlight correct answer</button>
              <button type="button" className={activeStudyAid === "all" ? "active" : ""} aria-pressed={activeStudyAid === "all"} onClick={() => toggleStudyAid("all")}><ListChecks aria-hidden="true" /> Highlight all answers</button>
              {activeStudyAid && <small>Revealed for this question · coached attempt</small>}
            </div>
            <p className="exam-scenario">{activeQuestion.scenario}</p>
            <div className="exam-answers">
              {(Object.entries(activeQuestion.options) as [ExamChoice, string][]).map(([choice, text]) => {
                const showCorrect = Boolean(activeStudyAid) && choice === activeQuestion.correct;
                const showTempting = activeStudyAid === "all" && choice === activeQuestion.tempting;
                return <button key={choice} type="button" className={`${response?.selected === choice ? "selected" : ""} ${activeStudyAid === "all" ? "answer-explained" : ""} ${showCorrect ? "answer-correct" : ""} ${showTempting ? "answer-tempting" : ""}`} onClick={() => selectChoice(choice)}><i>{response?.selected === choice ? <Check aria-hidden="true" /> : null}</i><b>{choice}</b><span>{text}{activeStudyAid === "all" && <small className="exam-option-rationale"><em>{showCorrect ? "Correct" : showTempting ? "Tempting, but not best" : "Not the best answer"}</em>{activeQuestion.rationales[choice]}</small>}</span></button>;
              })}
            </div>
            <footer className="exam-question-controls">
              <button type="button" onClick={() => goTo(exam.currentIndex - 1)} disabled={exam.currentIndex === 0}><ChevronLeft aria-hidden="true" /> Back</button>
              <button type="button" className={exam.flaggedIds.includes(activeQuestion.id) ? "flagged" : ""} onClick={toggleFlag}><Flag aria-hidden="true" />{exam.flaggedIds.includes(activeQuestion.id) ? "Flagged" : "Flag for review"}</button>
              <button type="button" className="next" onClick={saveAndNext}>{exam.currentIndex === questions.length - 1 ? "Review & submit" : "Save & next"}<ChevronRight aria-hidden="true" /></button>
            </footer>
          </section>
          <aside className="exam-navigator">
            <section><h2>Question navigator</h2><div className="navigator-legend"><span><i className="answered" />Answered</span><span><i className="current" />Current</span><span><Flag aria-hidden="true" />Flagged</span></div><div className="question-grid">{questions.map((question, index) => <button type="button" key={question.id} onClick={() => goTo(index)} className={`${exam.currentIndex === index ? "current" : ""} ${exam.responses.some((item) => item.questionId === question.id) ? "answered" : ""} ${exam.flaggedIds.includes(question.id) ? "flagged" : ""}`}>{index + 1}</button>)}</div></section>
            <section className="exam-distribution"><h2>Domain distribution</h2>{domainOrder.map((domain) => <div key={domain}><span><b>{domains[domain].short}</b><strong>{domains[domain].weight}%</strong></span><i><em style={{ width: `${domains[domain].weight * 3.2}%` }} /></i></div>)}<p>60 questions selected by published blueprint weight. This local bank uses single-answer scenarios.</p></section>
            <button className="submit-link" type="button" onClick={() => setShowSubmit(true)}>Finish and score exam</button>
          </aside>
          {exam.paused && <div className="exam-paused"><section><CirclePause aria-hidden="true" /><span>EXAM PAUSED</span><h2>Your timer is stopped.</h2><p>Your answers and remaining time are saved on this device.</p><button type="button" onClick={() => setExam({ ...exam, paused: false, lastTickAt: new Date().toISOString() })}><CirclePlay aria-hidden="true" /> Resume exam</button></section></div>}
          {showSubmit && <div className="exam-submit-modal"><section><span>READY TO FINISH?</span><h2>Submit this exam</h2><p>You answered {answeredCount} of {questions.length} questions. Unanswered questions will be scored incorrect.</p><div><button type="button" onClick={() => setShowSubmit(false)}>Keep reviewing</button><button type="button" onClick={submitExam}>Submit and score</button></div></section></div>}
        </div>
      ))}

      {tab === "results" && <ExamResults attempts={attempts} onStart={startExam} />}
      {tab === "concepts" && <div className="concept-view"><header><span>CONCEPT RELATIONSHIPS</span><h1>Traverse the architecture</h1><p>Orbit, zoom, and select a node to explore how mechanisms and decision rules reinforce one another across domains.</p></header>{!conceptGraphLoaded ? <div className="graph-loading">Loading this course’s local concept graph…</div> : conceptGraph ? <Suspense fallback={<div className="graph-loading">Loading the local 3D graph…</div>}><ConceptGraph3D key={`${courseId}-${conceptGraph.graphId ?? "graph"}`} graph={conceptGraph} /></Suspense> : <div className="graph-loading">This course does not have a concept graph yet. An agent can add one through Vidmark MCP.</div>}</div>}
    </section>
  );
}

function ExamStart({ attempts, onStart, onOpenResults, onOpenConcepts }: { attempts: ExamAttempt[]; onStart: () => void; onOpenResults: () => void; onOpenConcepts: () => void }) {
  return <div className="exam-start">
    <section className="exam-start-hero"><span>CCA-F · FULL-LENGTH SIMULATION</span><h1>Rehearse the decisions,<br />not just the definitions.</h1><p>A 60-question, 120-minute sitting sampled from your local bank in the published 27/18/20/20/15 domain ratio. Pause is available as a study convenience; the live exam timer does not pause.</p><button type="button" onClick={onStart}><Clock3 aria-hidden="true" /> Start timed exam</button><small>Scenario-based · one correct answer · saved only on this device</small></section>
    <aside className="exam-start-details"><div><TimerReset aria-hidden="true" /><span><b>120 minutes</b><small>Two minutes per question</small></span></div><div><BarChart3 aria-hidden="true" /><span><b>Blueprint-weighted</b><small>All five domains represented</small></span></div><div><RotateCcw aria-hidden="true" /><span><b>Retained attempts</b><small>Compare progress over time</small></span></div><div><Network aria-hidden="true" /><span><b>Concept graph</b><small>40 concepts, 83 connections</small></span></div>{attempts.length > 0 && <div className="prior-result"><span>Latest result</span><strong>{attempts[0].percent}%</strong><button onClick={onOpenResults}>View comparison →</button></div>}<button className="explore-concepts" onClick={onOpenConcepts}>Explore concept map</button></aside>
  </div>;
}

function ExamResults({ attempts, onStart }: { attempts: ExamAttempt[]; onStart: () => void }) {
  if (!attempts.length) return <div className="empty-results"><Trophy aria-hidden="true" /><h1>No completed exams yet</h1><p>Complete a timed simulation to begin comparing strengths, weaknesses, and pacing across attempts.</p><button type="button" onClick={onStart}>Start your first exam</button></div>;
  const chronological = [...attempts].reverse().slice(-8);
  const latest = attempts[0];
  const best = Math.max(...attempts.map((attempt) => attempt.percent));
  const averagePace = Math.round(attempts.reduce((sum, attempt) => sum + attempt.durationSeconds / attempt.totalQuestions, 0) / attempts.length);
  const points = chronological.map((attempt, index) => ({ x: chronological.length === 1 ? 50 : 8 + (index / (chronological.length - 1)) * 84, y: 91 - attempt.percent * 0.72, attempt }));
  return <div className="exam-results">
    <header><div><span>LOCAL EXAM HISTORY</span><h1>Exam performance</h1><div className="results-course-name"><small>Course</small><strong>{latest.courseName}</strong></div><p>Compare completed simulations and identify persistent domain patterns.</p></div><button type="button" onClick={onStart}><TimerReset aria-hidden="true" /> Start another exam</button></header>
    <div className="result-metrics"><article><span>Latest score</span><strong>{latest.percent}%</strong><small>{new Date(latest.completedAt).toLocaleDateString()}</small></article><article><span>Personal best</span><strong>{best}%</strong><small>Across {attempts.length} attempt{attempts.length === 1 ? "" : "s"}</small></article><article><span>Attempts</span><strong>{attempts.length}</strong><small>Stored on this device</small></article><article><span>Average pace</span><strong>{formatDuration(averagePace)}</strong><small>Per question</small></article></div>
    <div className="analytics-grid"><section className="score-chart"><header><h2>Score over time</h2><span>Most recent {chronological.length} attempts</span></header><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Exam score trend"><g className="chart-grid"><line x1="8" y1="19" x2="92" y2="19"/><line x1="8" y1="55" x2="92" y2="55"/><line x1="8" y1="91" x2="92" y2="91"/></g>{points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} />}{points.map((point) => <g key={point.attempt.id}><circle cx={point.x} cy={point.y} r="1.8"/><text x={point.x} y={point.y - 5}>{point.attempt.percent}%</text></g>)}</svg><div className="chart-labels">{chronological.map((attempt, index) => <span key={attempt.id}>#{attempts.length - chronological.length + index + 1}<small>{new Date(attempt.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>)}</div></section>
      <section className="domain-chart"><header><h2>Performance by domain</h2><span>Last {Math.min(attempts.length, 5)} attempts</span></header><div className="domain-bars">{domainOrder.map((domain) => <div key={domain}><span>{domains[domain].short}</span><div>{attempts.slice(0, 5).reverse().map((attempt, index) => { const result = attempt.domainResults.find((item) => item.domain === domain); return <i key={attempt.id} title={`Attempt ${attempts.length - index}: ${result?.percent ?? 0}%`} style={{ height: `${Math.max(4, (result?.percent ?? 0) * .85)}%`, background: attemptColors[index] }} />; })}</div><b>{latest.domainResults.find((item) => item.domain === domain)?.percent ?? 0}%</b></div>)}</div><div className="strength-read"><b>Current pattern</b><p>Strongest: {domains[[...latest.domainResults].sort((a,b) => b.percent-a.percent)[0].domain].short}. Weakest: {domains[[...latest.domainResults].sort((a,b) => a.percent-b.percent)[0].domain].short}. Compare another full sitting before treating a one-exam swing as stable.</p></div></section></div>
    <section className="attempt-history"><header><h2>Saved exam attempts</h2><span>{attempts.length} retained locally</span></header>{attempts.map((attempt, index) => <article key={attempt.id}><i style={{ background: attemptColors[index % attemptColors.length] }} /><div><b>Attempt {attempts.length - index}{index === 0 ? " · latest" : ""}</b><small>{attempt.courseName}</small></div><strong>{attempt.percent}%</strong><span>{attempt.correct}/{attempt.totalQuestions} correct</span><span>{formatDuration(attempt.durationSeconds)}</span><time>{new Date(attempt.completedAt).toLocaleString()}</time></article>)}</section>
  </div>;
}
