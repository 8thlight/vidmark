"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, Copy, Ellipsis, Eye, EyeOff, FileText, LibraryBig, Mic, Moon, NotebookPen, PanelLeft, Settings2, SunMedium } from "lucide-react";
import { AgentProviderDialog } from "./agent-provider";
import { ccaFoundationsOriginPrompt, ccaFoundationsPromptCredit, composeCourseBuildPrompt, kubernetesCourseOriginPrompt, kubernetesCoursePromptCredit, vidmarkMasterCourseBuildPrompt } from "./course-prompts";
import { domains, examBank } from "./exam-data";
import { ExamMode } from "./exam-mode";
import { syncMcpState, TranscriptCue, VIDMARK_MCP_URL } from "./mcp-sync";
import { NoteSession } from "./note-session";
import { readNotes, StudyNote } from "./notes-store";
import { VoiceNote, VoiceNotePlaylist } from "./voice-note";

type Chapter = { title: string; start: number; duration: string; summary: string; tags: string[] };
type Note = { time: number; title: string; text: string; chapter: string; image?: string; kind: "concept" | "lab" | "exam" };
const VIDEO_ID = "reDRM0tqhNs";
const KUBERNETES_VIDEO_ID = "_4uQI4ihGVU";
type LibraryVideo = { id: string; title: string; source: string; originPrompt: string; promptCredit: string; transcript: TranscriptCue[] };
type Choice = "A" | "B" | "C" | "D";
type Answer = { questionId: number; selected: Choice; correct: boolean };
const starterVideo: LibraryVideo = { id: VIDEO_ID, title: "Claude Certified Architect — Foundations", source: "freeCodeCamp.org", originPrompt: ccaFoundationsOriginPrompt, promptCredit: ccaFoundationsPromptCredit, transcript: [] };
const kubernetesStarterVideo: LibraryVideo = { id: KUBERNETES_VIDEO_ID, title: "Learn Kubernetes in 6 Hours – Full Course with Real-World Project", source: "freeCodeCamp.org", originPrompt: kubernetesCourseOriginPrompt, promptCredit: kubernetesCoursePromptCredit, transcript: [] };
const bundledVideos = [starterVideo, kubernetesStarterVideo];
const bundledVideoIds = new Set(bundledVideos.map((video) => video.id));

const chapters: Chapter[] = [
  { title: "Introduction", start: 47, duration: "9m", summary: "Exam orientation, domains, scoring context, and how the hands-on course is structured.", tags: ["exam", "roadmap"] },
  { title: "SDK environment setup", start: 617, duration: "37m", summary: "Configure the Anthropic SDK, environment variables, clients, messages, and a repeatable local lab setup.", tags: ["sdk", "setup"] },
  { title: "Agentic loop foundations", start: 2856, duration: "1h 05m", summary: "Build the observe–decide–act loop, define tools, route tool results, and control termination.", tags: ["agents", "tools"] },
  { title: "Multi-agent orchestration", start: 6773, duration: "2h 23m", summary: "Compare coordinator, specialist, handoff, parallel, and hierarchical agent architectures.", tags: ["orchestration", "multi-agent"] },
  { title: "Advanced agent patterns", start: 15346, duration: "2h 32m", summary: "Apply planning, reflection, routing, evaluator loops, retries, and human checkpoints.", tags: ["patterns", "evaluation"] },
  { title: "Sessions, context & state", start: 24472, duration: "44m", summary: "Manage session identity, context windows, summaries, persistence boundaries, and state recovery.", tags: ["context", "state"] },
  { title: "Configuration, permissions & safety", start: 27110, duration: "1h 27m", summary: "Scope settings, permissions, guardrails, hooks, and least-privilege access for Claude Code.", tags: ["safety", "permissions"] },
  { title: "Built-in tooling", start: 32332, duration: "40m", summary: "Choose, compose, and constrain built-in tools while keeping the agent’s working set clear.", tags: ["tools", "claude-code"] },
  { title: "Reliability & output quality", start: 34743, duration: "1h 05m", summary: "Use structured outputs, validation, evaluation sets, observability, and repair loops.", tags: ["reliability", "evals"] },
  { title: "Scaling context", start: 38639, duration: "46m", summary: "Design for real-world token, latency, cost, concurrency, and context constraints.", tags: ["scale", "constraints"] },
  { title: "MCP ecosystem integration", start: 41391, duration: "11m", summary: "Understand MCP servers, tools, resources, transports, trust boundaries, and integration choices.", tags: ["mcp", "integration"] },
  { title: "Claude Code in CI/CD", start: 42079, duration: "33m", summary: "Place agentic work safely in automated pipelines with bounded permissions and verifiable outputs.", tags: ["ci/cd", "automation"] },
  { title: "Scenario-based architecture", start: 44097, duration: "39m", summary: "Synthesize the course through exam-style architecture scenarios and trade-off analysis.", tags: ["architecture", "exam"] },
];

const chapterSectionIds = [
  "introduction",
  "sdk-environment-setup",
  "agentic-loop-foundations",
  "multi-agent-orchestration",
  "advanced-agent-patterns",
  "sessions-context-state",
  "configuration-permissions-safety",
  "built-in-tooling",
  "reliability-output-quality",
  "scaling-context",
  "mcp-ecosystem-integration",
  "claude-code-ci-cd",
  "scenario-based-architecture",
] as const;
type PracticeScope = "full" | (typeof chapterSectionIds)[number];
const sectionQuestionCounts = chapterSectionIds.map((sectionId) => examBank.filter((question) => question.sectionId === sectionId).length);

const notes: Note[] = [
  { time: 47, title: "How to use the course", chapter: "Introduction", kind: "exam", text: "Treat each domain as an architecture decision space. The exam rewards practical judgment more than memorized product trivia." },
  { time: 857, title: "Start from the task boundary", chapter: "SDK environment setup", kind: "concept", text: "Separate the system instruction, user request, model response, and tool exchange. Clear boundaries make later orchestration easier to reason about." },
  { time: 2856, title: "The agentic loop", chapter: "Agentic loop foundations", kind: "concept", image: "/screenshots/agentic-loop.jpg", text: "An agent repeatedly gathers context, chooses an action, executes a tool, observes the result, and decides whether to continue or stop." },
  { time: 3520, title: "Tool contracts are architecture", chapter: "Agentic loop foundations", kind: "exam", text: "Precise names, descriptions, schemas, and error shapes reduce ambiguity. Prefer narrow tools that expose the minimum capability required." },
  { time: 6773, title: "Coordinator and specialists", chapter: "Multi-agent orchestration", kind: "concept", image: "/screenshots/orchestration.jpg", text: "A coordinator owns the goal and delegates bounded work to specialists. Use this when tasks can be separated cleanly and merged predictably." },
  { time: 10140, title: "Parallelism needs a merge plan", chapter: "Multi-agent orchestration", kind: "exam", text: "Parallel agents help when tasks are independent. Shared mutable state and overlapping responsibilities can erase the latency benefit." },
  { time: 15346, title: "Evaluator–optimizer loop", chapter: "Advanced agent patterns", kind: "concept", image: "/screenshots/advanced-patterns.jpg", text: "One pass generates; another scores against explicit criteria; the loop repairs only the gaps. Cap retries and define a deterministic stop condition." },
  { time: 18920, title: "Human checkpoints", chapter: "Advanced agent patterns", kind: "lab", text: "Place approval at consequential boundaries: before external writes, high-cost actions, irreversible changes, or when confidence falls below policy." },
  { time: 24472, title: "State is not the transcript", chapter: "Sessions, context & state", kind: "concept", text: "Store durable facts and task state separately from conversation history. Summaries preserve intent while limiting context growth." },
  { time: 27110, title: "Settings scope", chapter: "Configuration, permissions & safety", kind: "concept", image: "/screenshots/permissions-safety.jpg", text: "Configuration can exist at user, project, and local levels. Put shared policy in the project and keep personal or machine-specific choices local." },
  { time: 28480, title: "Least privilege by default", chapter: "Configuration, permissions & safety", kind: "exam", text: "Grant only the tools, paths, and commands needed for the current responsibility. Escalation should be explicit, observable, and short-lived." },
  { time: 32332, title: "Choose tools intentionally", chapter: "Built-in tooling", kind: "lab", text: "Use the most specific tool that can complete the action and inspect the result before chaining the next step." },
  { time: 34743, title: "Reliability is a system property", chapter: "Reliability & output quality", kind: "concept", image: "/screenshots/reliability.jpg", text: "Combine constraints, structured outputs, validation, retries, test cases, and monitoring. Prompt quality alone is not a reliability strategy." },
  { time: 36860, title: "Build evaluation sets", chapter: "Reliability & output quality", kind: "exam", text: "Use representative normal, edge, and adversarial cases. Score the behavior that matters to users instead of judging outputs by feel." },
  { time: 38639, title: "Budget the whole workflow", chapter: "Scaling context", kind: "concept", text: "Model calls, tool latency, retry depth, parallel fan-out, and context size all contribute to cost and response time." },
  { time: 41391, title: "MCP as an integration boundary", chapter: "MCP ecosystem integration", kind: "concept", image: "/screenshots/mcp-integration.jpg", text: "MCP standardizes how models discover and invoke tools or read resources. The server remains a trust boundary that needs authentication and scoped access." },
  { time: 42079, title: "Agents in CI/CD", chapter: "Claude Code in CI/CD", kind: "lab", text: "Automated agents should run with bounded credentials, explicit inputs, reproducible checks, and artifacts that reviewers can inspect." },
  { time: 44097, title: "Answer scenarios with trade-offs", chapter: "Scenario-based architecture", kind: "exam", text: "Identify requirements and constraints first, then choose a pattern and explain why alternatives are less suitable for this situation." },
];

const formatTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
};
const parseTimestamp = (value: string) => value.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
const stripVtt = (value: string) => value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").trim();

export default function Home() {
  const [activeTime, setActiveTime] = useState(857);
  const [playerKey, setPlayerKey] = useState(0);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"guide" | "transcript" | "notes" | "practice">("guide");
  const [filter, setFilter] = useState<"all" | Note["kind"]>("all");
  const [imported, setImported] = useState<TranscriptCue[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryVideo[]>(bundledVideos);
  const [activeVideoId, setActiveVideoId] = useState(VIDEO_ID);
  const [newUrl, setNewUrl] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newPromptCredit, setNewPromptCredit] = useState("");
  const [setupStatus, setSetupStatus] = useState("");
  const [buildPromptOpen, setBuildPromptOpen] = useState(false);
  const [promptCopyStatus, setPromptCopyStatus] = useState("");
  const [agentDialog, setAgentDialog] = useState<"build" | "settings" | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [practiceScope, setPracticeScope] = useState<PracticeScope>("full");
  const [selectedChoice, setSelectedChoice] = useState<Choice | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [practiceComplete, setPracticeComplete] = useState(false);
  const [helpMode, setHelpMode] = useState(false);
  const [highlightCorrectAnswer, setHighlightCorrectAnswer] = useState(true);
  const [helpedIds, setHelpedIds] = useState<number[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [savedNotes, setSavedNotes] = useState<StudyNote[]>([]);
  const [mainMode, setMainMode] = useState<"course" | "notes" | "exam">("course");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const uploadRef = useRef<HTMLInputElement>(null);
  const notebookRef = useRef<HTMLElement>(null);
  const activeVideo = library.find((video) => video.id === activeVideoId) ?? starterVideo;
  const isStarter = activeVideo.id === VIDEO_ID;
  const isBundledCourse = bundledVideoIds.has(activeVideo.id);

  useEffect(() => {
    const hydrateTimer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem("vidmark-library");
        if (saved) {
        const parsed = (JSON.parse(saved) as Partial<LibraryVideo>[]).filter((video) => video.id);
        const storedById = new Map(parsed.map((video) => [String(video.id), video]));
        const bundled = bundledVideos.map((video) => ({ ...video, transcript: Array.isArray(storedById.get(video.id)?.transcript) ? storedById.get(video.id)!.transcript as TranscriptCue[] : [] }));
        const stored = parsed.filter((video) => !bundledVideoIds.has(String(video.id))).map((video) => ({
          id: String(video.id), title: video.title ?? `YouTube notebook · ${video.id}`, source: video.source ?? "YouTube",
          originPrompt: video.originPrompt ?? "Build a well-researched course from this video.", promptCredit: video.promptCredit ?? "Course creator", transcript: Array.isArray(video.transcript) ? video.transcript : [],
        }));
        setLibrary([...bundled, ...stored]);
        }
        if (window.localStorage.getItem("vidmark-theme") === "dark") setTheme("dark");
      } catch { /* Keep the bundled library and light theme when storage is unavailable. */ }
    }, 0);
    return () => window.clearTimeout(hydrateTimer);
  }, []);

  const refreshSavedNotes = async () => {
    try { setSavedNotes(await readNotes()); } catch { setSavedNotes([]); }
  };

  useEffect(() => {
    let active = true;
    void readNotes().then((storedNotes) => { if (active) setSavedNotes(storedNotes); }).catch(() => { if (active) setSavedNotes([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void syncMcpState(
        library.map((video) => ({ ...video, videoUrl: `https://www.youtube.com/watch?v=${video.id}` })),
        savedNotes.map((note) => ({ id: note.id, courseId: note.courseId, chapterId: note.chapterId, chapterTitle: note.chapterTitle, text: note.text, source: note.source, updatedAt: note.updatedAt, hasAudio: Boolean(note.audio || note.audioUrl) })),
        activeVideoId,
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeVideoId, library, savedNotes]);

  useEffect(() => {
    notebookRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [view, questionIndex, practiceComplete]);

  const seek = (time: number) => { setActiveTime(time); setPlayerKey((key) => key + 1); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes.filter((note) => (filter === "all" || note.kind === filter) && (!needle || `${note.title} ${note.text} ${note.chapter}`.toLowerCase().includes(needle)));
  }, [filter, query]);
  const filteredTranscript = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = imported.length ? imported : isStarter ? notes.map((note) => ({ time: note.time, text: `${note.title}. ${note.text}` })) : [];
    return source.filter((item) => !needle || item.text.toLowerCase().includes(needle));
  }, [imported, isStarter, query]);
  const practiceQuestions = practiceScope === "full" ? examBank : examBank.filter((question) => question.sectionId === practiceScope);
  const activeQuestion = practiceQuestions[questionIndex];
  const activeChapterIndex = chapterSectionIds.indexOf(activeQuestion.sectionId as (typeof chapterSectionIds)[number]);
  const currentSection = chapters[activeChapterIndex] ?? chapters[0];
  const currentChapterId = chapterSectionIds[activeChapterIndex] ?? chapterSectionIds[0];
  const courseNotes = savedNotes.filter((note) => note.courseId === activeVideoId);
  const courseVoiceNotes = courseNotes.filter((note) => note.source === "voice");
  const noteGroups = chapters.map((chapter, index) => ({ chapter, notes: courseNotes.filter((note) => note.chapterId === chapterSectionIds[index]) })).filter((group) => group.notes.length);
  const unsortedNotes = courseNotes.filter((note) => note.chapterId === "unsorted");
  const scopedAnswers = answers.filter((answer) => practiceQuestions.some((question) => question.id === answer.questionId));
  const correctCount = scopedAnswers.filter((answer) => answer.correct).length;
  const scoredCount = scopedAnswers.length;
  const domainResults = Object.entries(domains).map(([id, domain]) => {
    const domainQuestions = practiceQuestions.filter((question) => question.domain === id);
    const domainAnswers = scopedAnswers.filter((answer) => domainQuestions.some((question) => question.id === answer.questionId));
    return { id, ...domain, correct: domainAnswers.filter((answer) => answer.correct).length, answered: domainAnswers.length, total: domainQuestions.length };
  });
  const displayedDomainResults = practiceScope === "full" ? domainResults : domainResults.filter((result) => result.total > 0);

  const answerQuestion = (choice: Choice) => {
    if (selectedChoice || practiceComplete) return;
    setSelectedChoice(choice);
    setAnswers((current) => [...current, { questionId: activeQuestion.id, selected: choice, correct: choice === activeQuestion.correct }]);
  };

  const showQuestion = (index: number) => {
    const savedAnswer = answers.find((answer) => answer.questionId === practiceQuestions[index].id);
    setQuestionIndex(index);
    setSelectedChoice(savedAnswer?.selected ?? null);
    setHelpMode(helpedIds.includes(practiceQuestions[index].id));
    setPracticeComplete(false);
    setView("practice");
  };

  const startFullBank = () => {
    const savedAnswer = answers.find((answer) => answer.questionId === examBank[0].id);
    setPracticeScope("full");
    setQuestionIndex(0);
    setSelectedChoice(savedAnswer?.selected ?? null);
    setHelpMode(helpedIds.includes(examBank[0].id));
    setPracticeComplete(false);
    setView("practice");
    setMoreOpen(false);
  };

  const openChapter = (index: number) => {
    seek(chapters[index].start);
    const sectionId = chapterSectionIds[index];
    const sectionQuestions = examBank.filter((question) => question.sectionId === sectionId);
    if (!sectionQuestions.length) { startFullBank(); return; }
    const savedAnswer = answers.find((answer) => answer.questionId === sectionQuestions[0].id);
    setPracticeScope(sectionId);
    setQuestionIndex(0);
    setSelectedChoice(savedAnswer?.selected ?? null);
    setHelpMode(helpedIds.includes(sectionQuestions[0].id));
    setPracticeComplete(false);
    setView("practice");
  };

  const nextQuestion = () => {
    if (!selectedChoice && !helpMode) return;
    if (questionIndex === practiceQuestions.length - 1) { setPracticeComplete(true); return; }
    showQuestion(questionIndex + 1);
  };

  const resetPractice = () => {
    setPracticeScope("full"); setQuestionIndex(0); setSelectedChoice(null); setAnswers([]); setPracticeComplete(false); setView("practice");
    setHelpMode(false); setHelpedIds([]);
    setMoreOpen(false);
  };

  // Help me reveals every option's explanation. A revealed question is not scored,
  // because a score you can look up is not a measurement.
  const revealAnswers = () => {
    if (selectedChoice || helpMode) return;
    setHelpMode(true);
    setHelpedIds((current) => (current.includes(activeQuestion.id) ? current : [...current, activeQuestion.id]));
  };

  const persistLibrary = (next: LibraryVideo[]) => {
    setLibrary(next);
    window.localStorage.setItem("vidmark-library", JSON.stringify(next));
  };

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      window.localStorage.setItem("vidmark-theme", next);
      return next;
    });
  };

  const importVtt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const lines = (await file.text()).split(/\r?\n/);
    const parsed: Array<{ time: number; text: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(" --> ")) continue;
      const cueTime = parseTimestamp(lines[index].split(" --> ")[0].replace(",", "."));
      const cueLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index].trim()) { cueLines.push(stripVtt(lines[index])); index += 1; }
      const cueText = cueLines.join(" ").replace(/\s+/g, " ").trim();
      if (cueText && parsed.at(-1)?.text !== cueText) parsed.push({ time: cueTime, text: cueText });
    }
    setImported(parsed);
    persistLibrary(library.map((video) => video.id === activeVideoId ? { ...video, transcript: parsed } : video));
    setView("transcript");
  };

  const addVideo = () => {
    const match = newUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
    if (!match || !newPrompt.trim() || !newPromptCredit.trim()) return;
    const bundled = library.find((item) => item.id === match[1] && bundledVideoIds.has(item.id));
    if (bundled) {
      setActiveVideoId(bundled.id); setImported(bundled.transcript); setView("guide"); setActiveTime(0); setPlayerKey((key) => key + 1);
      setNewUrl(""); setNewPrompt(""); setNewPromptCredit(""); setLibraryOpen(false);
      return;
    }
    const video: LibraryVideo = { id: match[1], title: `YouTube notebook · ${match[1]}`, source: "YouTube", originPrompt: newPrompt.trim(), promptCredit: newPromptCredit.trim(), transcript: [] };
    const next = [...library.filter((item) => item.id !== video.id), video];
    persistLibrary(next);
    setActiveVideoId(video.id);
    setImported([]);
    setView("transcript");
    setActiveTime(0);
    setPlayerKey((key) => key + 1);
    setNewUrl(""); setNewPrompt(""); setNewPromptCredit("");
    setLibraryOpen(false);
  };

  const selectVideo = (video: LibraryVideo) => {
    setActiveVideoId(video.id); setImported(video.transcript); setActiveTime(video.id === VIDEO_ID ? 857 : 0); setView(video.id === VIDEO_ID ? "guide" : "transcript"); setPlayerKey((key) => key + 1); setSetupStatus(""); setBuildPromptOpen(false); setLibraryOpen(false);
  };

  const copyAgentBuildInstruction = async () => {
    const instruction = `Connect to the local Vidmark MCP server at ${VIDMARK_MCP_URL}. Get the MCP prompt “build_vidmark_course” with courseId “${activeVideo.id}”. It combines Vidmark’s master course-builder prompt with this course’s required credited prompt. Follow both layers and save the reviewed course artifacts back to Vidmark.`;
    try {
      await navigator.clipboard.writeText(instruction);
      setSetupStatus("MCP handoff copied. Paste it into Claude Code, Codex, or another MCP-capable agent.");
    } catch {
      setSetupStatus(`Copy this MCP address into your agent: ${VIDMARK_MCP_URL}`);
    }
  };

  const viewBuildPrompt = () => { setPromptCopyStatus(""); setBuildPromptOpen(true); };

  const copyBuildPrompt = async () => {
    try {
      await navigator.clipboard.writeText(composeCourseBuildPrompt(activeVideo.title, activeVideo.id, activeVideo.originPrompt, activeVideo.promptCredit));
      setPromptCopyStatus("Complete two-layer prompt copied.");
    } catch {
      setPromptCopyStatus("Copy failed. Select the prompt text manually.");
    }
  };

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="rail">
        <div className="brand-mark" role="img" aria-label="Vidmark">V</div>
        <nav aria-label="Primary">
          <button className={`rail-button ${mainMode === "course" ? "active" : ""}`} aria-label="Study workspace" onClick={() => setMainMode("course")}>
            <PanelLeft className="rail-icon" aria-hidden="true" />
          </button>
          <button className={`rail-button ${mainMode === "exam" ? "active" : ""}`} aria-label="Exam mode" onClick={() => setMainMode("exam")}>
            <ClipboardCheck className="rail-icon" aria-hidden="true" />
          </button>
          <button className="rail-button" aria-label="Video library" onClick={() => setLibraryOpen(true)}>
            <LibraryBig className="rail-icon" aria-hidden="true" />
          </button>
          <button className={`rail-button ${mainMode === "notes" ? "active" : ""}`} aria-label="Course notes" onClick={() => setMainMode("notes")}>
            <NotebookPen className="rail-icon" aria-hidden="true" />
          </button>
        </nav>
        <div className="rail-bottom">
          <button className="rail-button" aria-label="Model settings" title="Model settings" onClick={() => setAgentDialog("settings")}><Settings2 className="rail-icon" aria-hidden="true" /></button>
          <button className="rail-button" aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} onClick={toggleTheme}>
            {theme === "light" ? <Moon className="rail-icon" aria-hidden="true" /> : <SunMedium className="rail-icon" aria-hidden="true" />}
          </button>
          <div className="avatar">GB</div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="library-trigger" onClick={() => setLibraryOpen(true)}>
            <span className="dot-grid">••<br />••</span><span><b>Video library</b><small>{library.length} {library.length === 1 ? "course" : "courses"} · device library</small></span><span className="chevron">⌄</span>
          </button>
          <label className="global-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search concepts, chapters, or captions…" /><kbd>⌘ K</kbd></label>
          <button className="add-button" onClick={() => setLibraryOpen(true)}>＋ Add video</button>
        </header>

        <div className={`content-grid ${mainMode === "exam" ? "exam-layout" : ""}`}>
          {mainMode === "course" ? <section className="player-column">
            <div className="crumbs"><span>LIBRARY</span><b>{isBundledCourse ? "BUNDLED COURSE" : "VIDEO NOTEBOOK"}</b></div>
            <div className="course-video-heading"><span className="source-pill">{activeVideo.source.toUpperCase()} · COURSE VIDEO</span><h1>{activeVideo.title}</h1></div>
            <div className="player-frame">
              <iframe key={playerKey} src={`https://www.youtube-nocookie.com/embed/${activeVideo.id}?start=${activeTime}&rel=0&modestbranding=1`} title={`${activeVideo.title} video player`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
            </div>
            <div className="video-heading">
              <div><span className="source-pill">{isStarter ? "CURRENT COURSE SECTION" : activeVideo.source.toUpperCase()}</span><h1>{isStarter ? currentSection.title : activeVideo.title}</h1><p>{isStarter ? currentSection.summary : activeVideo.id === KUBERNETES_VIDEO_ID ? "Connect an MCP-capable agent to build the course, or import an existing transcript manually." : "Import a transcript to turn this video into a searchable, timestamped notebook."}</p></div>
              <a className="youtube-link" href={`https://www.youtube.com/watch?v=${activeVideo.id}&t=${activeTime}s`} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
            </div>

            <div className="stat-row"><div><strong>{isStarter ? "12h 38m" : "—"}</strong><span>runtime</span></div><div><strong>{isStarter ? "13" : "—"}</strong><span>chapters</span></div><div><strong>{isStarter ? examBank.length : imported.length || "—"}</strong><span>{isStarter ? "exam scenarios" : "caption cues"}</span></div><div><strong>{isStarter ? "6" : "—"}</strong><span>visual references</span></div></div>

            {isStarter ? <section className="chapter-section">
              <div className="section-title"><div><span>COURSE MAP</span><h2>Chapters</h2></div><span>{chapters.length} sections</span></div>
              <div className="chapter-list">
                {chapters.map((chapter, index) => (
                  <button key={chapter.title} className={`chapter-row ${view === "practice" && activeChapterIndex === index ? "active" : ""}`} onClick={() => openChapter(index)}>
                    <span className="chapter-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="chapter-copy"><b>{chapter.title}</b><small>{chapter.summary}</small><i>{chapter.tags.map((tag) => `#${tag}`).join("  ")} <em>{sectionQuestionCounts[index] ? `${sectionQuestionCounts[index]} QUESTIONS` : "BANK START"}</em></i></span>
                    <span className="chapter-time"><b>{formatTime(chapter.start)}</b><small>{chapter.duration}</small></span><span className="play-arrow">▶</span>
                  </button>
                ))}
              </div>
            </section> : activeVideo.id === KUBERNETES_VIDEO_ID ? <section className="new-notebook course-setup"><span>COURSE SETUP REQUIRED</span><h2>This course has not been built yet.</h2><p>The video and its credited build instructions are ready. Choose a local or OpenRouter model, import a timestamped transcript, then let Vidmark coordinate the course build.</p><div className="course-setup-actions"><button onClick={() => setAgentDialog("build")}>Build with agent</button><button className="secondary-action" onClick={viewBuildPrompt}>View build prompt</button><button className="secondary-action" onClick={() => { setView("transcript"); uploadRef.current?.click(); }}>Import transcript</button></div>{setupStatus ? <p className="course-setup-status" role="status">{setupStatus}</p> : <p className="course-setup-help">Review the selected model, transcript readiness, agent tools, and cost implications before starting.</p>}</section> : <section className="new-notebook"><span>TRANSCRIPT NEEDED</span><h2>Add searchable captions.</h2><p>Import a WebVTT transcript you have permission to use. You can then search it and jump to exact moments in the video.</p><button onClick={() => { setView("transcript"); uploadRef.current?.click(); }}>Import transcript</button></section>}
          </section> : mainMode === "notes" ? <section className="notes-index-main">
            <header className="notes-index-head"><div><span>COURSE JOURNAL · {courseNotes.length}</span><h1>Notes by chapter</h1><p>Your complete local note index, grouped by chapter and ordered by last modified.</p></div><button type="button" onClick={() => setNotesOpen(true)}><NotebookPen aria-hidden="true" /> Add note</button></header>
            <VoiceNotePlaylist notes={courseVoiceNotes} />
            {noteGroups.length || unsortedNotes.length ? <div className="notes-index-groups">{noteGroups.map((group) => <section key={group.chapter.title}><header><h2>{group.chapter.title}</h2><span>{group.notes.length} note{group.notes.length === 1 ? "" : "s"}</span></header>{group.notes.map((note) => <article key={note.id}><div className={`note-kind ${note.source}`} title={note.source === "voice" ? "Voice note" : "Text note"}>{note.source === "voice" ? <Mic aria-hidden="true" /> : <FileText aria-hidden="true" />}</div><div><span>Last modified {new Date(note.updatedAt).toLocaleString()}</span>{note.source === "voice" ? <VoiceNote note={note} compact /> : <p>{note.text}</p>}</div></article>)}</section>)}{unsortedNotes.length > 0 && <section><header><h2>Unsorted notes</h2><span>{unsortedNotes.length} note{unsortedNotes.length === 1 ? "" : "s"}</span></header>{unsortedNotes.map((note) => <article key={note.id}><div className={`note-kind ${note.source}`}>{note.source === "voice" ? <Mic aria-hidden="true" /> : <FileText aria-hidden="true" />}</div><div><span>Last modified {new Date(note.updatedAt).toLocaleString()}</span>{note.source === "voice" ? <VoiceNote note={note} compact /> : <p>{note.text}</p>}</div></article>)}</section>}</div> : <div className="notes-index-empty">No notes yet. Use <b>Add note</b> to capture a text or voice note for the current chapter.</div>}
          </section> : <ExamMode />}

          {mainMode !== "exam" && <aside className="notebook" ref={notebookRef}>
            <div className="notebook-head"><div className="tabs" role="tablist"><button className={view === "guide" ? "active" : ""} onClick={() => setView("guide")}>Study guide</button><button className={view === "practice" ? "active" : ""} onClick={() => setView("practice")}>Practice</button><button className={view === "transcript" ? "active" : ""} onClick={() => setView("transcript")}>Transcript</button><button className={view === "notes" ? "active" : ""} onClick={() => setView("notes")}>Notes</button></div><div className="notebook-menu"><button className="icon-button" type="button" aria-label="More practice options" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><Ellipsis aria-hidden="true" /></button>{moreOpen && <div className="more-menu" role="menu"><button type="button" role="menuitem" onClick={startFullBank}>Start full {examBank.length}-question bank</button><button type="button" role="menuitem" onClick={resetPractice}>Reset all practice progress</button></div>}</div></div>
            {view === "guide" ? (
              <>
                <div className="guide-intro"><span>{isStarter ? "EXAM COMPANION" : "VIDEO NOTEBOOK"}</span><h2>{isStarter ? "From 12 hours to a focused review." : "Your study guide starts with captions."}</h2><p>{isStarter ? "Search the architecture decisions, jump straight to the explanation, and review the visual evidence in context." : "Import a caption file, then build your own searchable path through the video."}</p>{isStarter && <button className="practice-cta" onClick={startFullBank}>Start {examBank.length}-question bank →</button>}</div>
                <div className="filter-row">{(["all", "concept", "lab", "exam"] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={filter === item ? "active" : ""}>{item}</button>)}</div>
                <div className="note-feed">
                  {isStarter && filteredNotes.map((note) => (
                    <article className="note-card" key={`${note.time}-${note.title}`}>
                      {note.image && <button className="shot" onClick={() => seek(note.time)}><img src={note.image} alt={`Video frame at ${formatTime(note.time)} for ${note.title}`} /><span>▶ {formatTime(note.time)}</span></button>}
                      <div className="note-meta"><button onClick={() => seek(note.time)}>{formatTime(note.time)}</button><span>{note.kind}</span></div><h3>{note.title}</h3><p>{note.text}</p><button className="jump-link" onClick={() => seek(note.time)}>Watch this moment →</button>
                    </article>
                  ))}
                  {(!isStarter || !filteredNotes.length) && <div className="empty-state">{isStarter ? `No study moments match “${query}”.` : "Import captions to begin this notebook."}</div>}
                </div>
              </>
            ) : view === "notes" ? (
              <section className="chapter-notes-panel">
                <header><div><span>ALL COURSE NOTES · {courseNotes.length}</span><h2>Notes by chapter</h2></div><button type="button" onClick={() => setNotesOpen(true)}><NotebookPen aria-hidden="true" /> Add note</button></header>
                <VoiceNotePlaylist notes={courseVoiceNotes} />
                {noteGroups.length || unsortedNotes.length ? <div className="course-note-groups">{noteGroups.map((group) => <section key={group.chapter.title}><h3>{group.chapter.title}<small>{group.notes.length}</small></h3><div className="chapter-note-list">{group.notes.map((note) => <article key={note.id}><div className={`note-kind ${note.source}`} title={note.source === "voice" ? "Voice note" : "Text note"}>{note.source === "voice" ? <Mic aria-hidden="true" /> : <FileText aria-hidden="true" />}</div><div><span>Last modified {new Date(note.updatedAt).toLocaleString()}</span>{note.source === "voice" ? <VoiceNote note={note} compact /> : <p>{note.text}</p>}</div></article>)}</div></section>)}{unsortedNotes.length > 0 && <section><h3>Unsorted notes<small>{unsortedNotes.length}</small></h3><div className="chapter-note-list">{unsortedNotes.map((note) => <article key={note.id}><div className={`note-kind ${note.source}`}>{note.source === "voice" ? <Mic aria-hidden="true" /> : <FileText aria-hidden="true" />}</div><div><span>Last modified {new Date(note.updatedAt).toLocaleString()}</span>{note.source === "voice" ? <VoiceNote note={note} compact /> : <p>{note.text}</p>}</div></article>)}</div></section>}</div> : <div className="empty-state">No notes yet. Capture one from the journal icon or add one here.</div>}
              </section>
            ) : view === "transcript" ? (
              <>
                <div className="transcript-tools"><div><span>CAPTION WORKSPACE</span><h2>{imported.length ? `${imported.length.toLocaleString()} cues imported` : "Searchable guided transcript"}</h2></div><input ref={uploadRef} type="file" accept=".vtt,text/vtt" onChange={importVtt} hidden /><button onClick={() => uploadRef.current?.click()}>Import .VTT</button></div>
                <div className="caption-note">Import caption files you have permission to use. They stay on this device, are attached to this course, and are available to the local MCP server.</div>
                <div className="transcript-feed">{filteredTranscript.slice(0, 500).map((item, index) => <button key={`${item.time}-${index}`} className="transcript-line" onClick={() => seek(item.time)}><time>{formatTime(item.time)}</time><span>{item.text}</span></button>)}{!filteredTranscript.length && <div className="empty-state">{query ? `No transcript lines match “${query}”.` : "No transcript imported yet."}</div>}</div>
              </>
            ) : !isStarter ? (
              <div className="empty-state">Practice examples are available for the Claude Certified Architect course.</div>
            ) : practiceComplete ? (
              <section className="results-panel">
                <span className="eyebrow">{practiceScope === "full" ? "BLOCK COMPLETE" : "SECTION COMPLETE"}</span>
                <div className="score-ring"><strong>{correctCount}/{scoredCount || practiceQuestions.length}</strong><small>{Math.round((correctCount / (scoredCount || practiceQuestions.length)) * 100)}%</small></div>
                <h2>{practiceScope === "full" ? "Weighted practice result" : `${currentSection.title} result`}</h2>
                <p>{practiceScope === "full" ? "This measures this published-blueprint practice block, not readiness against a live question bank." : `You answered ${correctCount} of ${scoredCount || practiceQuestions.length} questions correctly in this section. Blueprint weights apply to the full bank, not this focused drill.`}</p>
                {helpedIds.length > 0 && <p className="help-note">{helpedIds.length} question{helpedIds.length === 1 ? " was" : "s were"} revealed with Help me and left out of the score.</p>}
                <div className="domain-results">
                  {displayedDomainResults.map((result) => <div key={result.id}><span><b>{result.short}</b><small>{practiceScope === "full" ? `${result.weight}% blueprint weight` : `${result.total} question${result.total === 1 ? "" : "s"} in this section`}</small></span><strong>{result.correct}/{result.total}</strong></div>)}
                </div>
                <div className="diagnostic">
                  <b>Miss pattern</b>
                  <p>{scopedAnswers.every((answer) => answer.correct) ? "No misses in this set. Repeat performance on another weighted block before treating the result as stable." : `${scopedAnswers.filter((answer) => !answer.correct && examBank.find((question) => question.id === answer.questionId)?.missType === "judgment").length} judgment miss(es) and ${scopedAnswers.filter((answer) => !answer.correct && examBank.find((question) => question.id === answer.questionId)?.missType === "recall").length} documentation-recall miss(es). Drill the lowest-scoring domains next.`}</p>
                </div>
                <button className="primary-action" onClick={resetPractice}>Run the block again</button>
              </section>
            ) : (
              <section className="practice-panel">
                <div className="practice-header">
                  <div><span className="eyebrow">QUESTION {questionIndex + 1} OF {practiceQuestions.length}{practiceScope !== "full" ? " · SECTION PRACTICE" : ""}</span><h2>{activeQuestion.chapter}</h2></div>
                  <div className="practice-actions">
                    <strong aria-label={`${correctCount} correct, ${scoredCount} answered`}>{correctCount} correct · {scoredCount} answered</strong>
                    <button
                      className={`answer-highlight-toggle ${highlightCorrectAnswer ? "active" : ""}`}
                      type="button"
                      aria-pressed={highlightCorrectAnswer}
                      title={highlightCorrectAnswer ? "Hide correct-answer highlighting" : "Show correct-answer highlighting"}
                      onClick={() => setHighlightCorrectAnswer((current) => !current)}
                    >
                      {highlightCorrectAnswer ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                      {highlightCorrectAnswer ? "Highlight on" : "Highlight off"}
                    </button>
                    <button className="reset-practice" type="button" onClick={resetPractice}>Reset progress</button>
                  </div>
                </div>
                <div className="progress-track"><span style={{ width: `${((questionIndex + (selectedChoice ? 1 : 0)) / practiceQuestions.length) * 100}%` }} /></div>
                <div className="domain-chip">{domains[activeQuestion.domain].name} · {domains[activeQuestion.domain].weight}%</div>
                <p className="scenario">{activeQuestion.scenario}</p>
                <div className="answer-list">
                  {(Object.entries(activeQuestion.options) as [Choice, string][]).map(([letter, option]) => {
                    const revealed = Boolean(selectedChoice) || helpMode;
                    const isCorrect = revealed && letter === activeQuestion.correct;
                    const isWrong = selectedChoice === letter && letter !== activeQuestion.correct;
                    const isTempting = helpMode && !selectedChoice && letter === activeQuestion.tempting;
                    return (
                      <button
                        key={letter}
                        disabled={revealed}
                        className={`${isCorrect && highlightCorrectAnswer ? "correct" : ""} ${selectedChoice === letter ? "selected-answer" : ""} ${isWrong ? "wrong" : ""} ${isTempting ? "tempting" : ""} ${helpMode ? "revealed" : ""}`}
                        onClick={() => answerQuestion(letter)}
                      >
                        <b>{letter}</b>
                        <span>
                          {option}
                          {helpMode && (
                            <small className="option-rationale">
                              <em>{isCorrect ? "Correct." : isTempting ? "Tempting, but no." : "No."}</em> {activeQuestion.rationales[letter]}
                            </small>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {!selectedChoice && !helpMode && (
                  <button className="help-toggle" onClick={revealAnswers}>
                    ？ Help me · show every answer with its explanation
                  </button>
                )}
                {helpMode && !selectedChoice && <div className="grading-card help">
                  <span>REVEALED · ANSWER {activeQuestion.correct} · NOT SCORED</span>
                  <h3>What decides it</h3><p>{activeQuestion.hinge}</p>
                  <div className="principle"><b>Decision rule</b><p>{activeQuestion.principle}</p></div>
                  <div className="miss-label">Tests {activeQuestion.missType === "recall" ? "documentation recall" : "architecture judgment"} · {activeQuestion.mode === "hard" ? "hard mode" : "standard"} · {activeQuestion.difficulty}</div>
                  <a href={activeQuestion.sourceUrl} target="_blank" rel="noreferrer">{activeQuestion.sourceLabel} ↗</a>
                </div>}
                {selectedChoice && <div className={`grading-card ${selectedChoice === activeQuestion.correct ? "correct" : "wrong"}`}>
                  <span>{selectedChoice === activeQuestion.correct ? "CORRECT" : `NOT QUITE · ANSWER ${activeQuestion.correct}`}</span>
                  <h3>Why {activeQuestion.correct} is correct</h3><p>{activeQuestion.rationales[activeQuestion.correct]}</p>
                  <h3>Why {activeQuestion.tempting} is tempting</h3><p>{activeQuestion.rationales[activeQuestion.tempting]}</p>
                  <h3>What decides it</h3><p>{activeQuestion.hinge}</p>
                  <div className="principle"><b>Decision rule</b><p>{activeQuestion.principle}</p></div>
                  {selectedChoice !== activeQuestion.correct && <div className="miss-label">Miss type: {activeQuestion.missType === "recall" ? "documentation recall" : "architecture judgment"}</div>}
                  <a href={activeQuestion.sourceUrl} target="_blank" rel="noreferrer">{activeQuestion.sourceLabel} ↗</a>
                </div>}
                <button className="primary-action" disabled={!selectedChoice && !helpMode} onClick={nextQuestion}>{questionIndex === practiceQuestions.length - 1 ? "See final breakdown" : "Next question"}</button>
              </section>
            )}
          </aside>}
        </div>
      </section>

      {buildPromptOpen && <dialog open className="modal-backdrop" aria-label="Course build prompt"><section className="build-prompt-modal">
        <div className="modal-head"><div><span>COURSE BUILD PROMPT</span><h2>{activeVideo.title}</h2></div><button onClick={() => setBuildPromptOpen(false)} aria-label="Close build prompt">×</button></div>
        <div className="build-prompt-meta"><span>Course prompt credit</span><b>{activeVideo.promptCredit}</b><span>Used by</span><b>Vidmark MCP · build_vidmark_course</b></div>
        <p className="build-prompt-intro">The agent receives both layers below. Vidmark supplies the master instructions; every imported course must supply its own course-specific context.</p>
        <div className="build-prompt-layers">
          <details open><summary><span>1</span><b>Vidmark master prompt</b><small>Built in · applies to every course</small></summary><pre className="build-prompt-copy">{vidmarkMasterCourseBuildPrompt}</pre></details>
          <details open><summary><span>2</span><b>Required course-specific prompt</b><small>Credit · {activeVideo.promptCredit}</small></summary><pre className="build-prompt-copy">{activeVideo.originPrompt}</pre></details>
        </div>
        <footer className="build-prompt-actions"><span role="status">{promptCopyStatus}</span><button type="button" onClick={() => void copyBuildPrompt()}><Copy aria-hidden="true" /> Copy complete prompt</button></footer>
      </section></dialog>}

      {libraryOpen && <dialog open className="modal-backdrop" aria-label="Video library"><section className="library-modal">
        <div className="modal-head"><div><span>YOUR LIBRARY</span><h2>Video notebooks</h2></div><button onClick={() => setLibraryOpen(false)} aria-label="Close">×</button></div>
        <div className="library-stack">{library.map((video) => <article className="library-card" key={video.id}><img src={`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`} alt={`${video.title} thumbnail`} /><div><span>{video.id === VIDEO_ID ? "STUDY GUIDE READY" : video.id === KUBERNETES_VIDEO_ID ? "AGENT BUILD READY" : video.transcript.length ? `${video.transcript.length} CAPTION CUES` : "TRANSCRIPT NEEDED"}</span><h3>{video.title}</h3><p>{video.id === VIDEO_ID ? "13 chapters · 18 study moments · 6 visual references" : video.id === KUBERNETES_VIDEO_ID ? "Bundled freeCodeCamp course · coordinated agent build brief" : "Personal video notebook"}</p><details className="course-origin"><summary>Required course prompt · {video.promptCredit}</summary><pre>{video.originPrompt}</pre></details></div><button onClick={() => selectVideo(video)}>{video.id === activeVideoId ? "Current" : "Open"}</button></article>)}</div>
        <div className="mcp-panel"><div><b>Vidmark MCP server</b><p>Agents can build courses and inspect local prompts, notes, and transcripts.</p><code>{VIDMARK_MCP_URL}</code></div><button type="button" onClick={() => void navigator.clipboard.writeText(VIDMARK_MCP_URL)}><Copy aria-hidden="true" /> Copy URL</button></div>
        <div className="add-panel"><b>Add another YouTube video</b><p>Vidmark automatically applies its master course-builder prompt. You must add course-specific context so the agent knows the audience, goals, emphasis, and assessment requirements.</p><label><span>YouTube URL · required</span><input required value={newUrl} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://youtube.com/watch?v=…" /></label><label><span>Course-specific prompt · required</span><textarea required value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder="Who is this course for? What should the agent emphasize, research, verify, create, or avoid?" /><small>This is layered after the built-in master prompt and cannot be blank.</small></label><div className="add-prompt-footer"><label><span>Prompt credit · required</span><input required value={newPromptCredit} onChange={(event) => setNewPromptCredit(event.target.value)} placeholder="Originator or organization" /></label><button onClick={addVideo} disabled={!newUrl.trim() || !newPrompt.trim() || !newPromptCredit.trim()}>Add course</button></div></div>
      </section></dialog>}
      {agentDialog && <AgentProviderDialog key={agentDialog} open initialView={agentDialog} courseId={activeVideo.id} courseTitle={activeVideo.title} transcriptCues={activeVideo.transcript.length} onClose={() => setAgentDialog(null)} onCopyHandoff={copyAgentBuildInstruction} />}
      <NoteSession open={notesOpen} onClose={() => setNotesOpen(false)} notes={courseNotes} courseId={activeVideoId} chapterId={currentChapterId} chapterTitle={currentSection.title} onNotesChanged={refreshSavedNotes} />
    </main>
  );
}
