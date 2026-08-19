"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Chapter = { title: string; start: number; duration: string; summary: string; tags: string[] };
type Note = { time: number; title: string; text: string; chapter: string; image?: string; kind: "concept" | "lab" | "exam" };
const VIDEO_ID = "reDRM0tqhNs";
type LibraryVideo = { id: string; title: string; source: string };
const starterVideo: LibraryVideo = { id: VIDEO_ID, title: "Claude Certified Architect — Foundations", source: "freeCodeCamp.org" };

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
  const [view, setView] = useState<"guide" | "transcript">("guide");
  const [filter, setFilter] = useState<"all" | Note["kind"]>("all");
  const [imported, setImported] = useState<Array<{ time: number; text: string }>>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryVideo[]>([starterVideo]);
  const [activeVideoId, setActiveVideoId] = useState(VIDEO_ID);
  const [newUrl, setNewUrl] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const activeVideo = library.find((video) => video.id === activeVideoId) ?? starterVideo;
  const isStarter = activeVideo.id === VIDEO_ID;

  useEffect(() => {
    let hydrateTimer: number | undefined;
    try {
      const saved = window.localStorage.getItem("vidmark-library");
      if (saved) hydrateTimer = window.setTimeout(() => setLibrary([starterVideo, ...JSON.parse(saved).filter((video: LibraryVideo) => video.id !== VIDEO_ID)]), 0);
    } catch { /* Keep the starter library when storage is unavailable. */ }
    return () => { if (hydrateTimer) window.clearTimeout(hydrateTimer); };
  }, []);

  const seek = (time: number) => { setActiveTime(time); setPlayerKey((key) => key + 1); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes.filter((note) => (filter === "all" || note.kind === filter) && (!needle || `${note.title} ${note.text} ${note.chapter}`.toLowerCase().includes(needle)));
  }, [filter, query]);
  const filteredTranscript = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = imported.length ? imported : notes.map((note) => ({ time: note.time, text: `${note.title}. ${note.text}` }));
    return source.filter((item) => !needle || item.text.toLowerCase().includes(needle));
  }, [imported, query]);

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
    setImported(parsed); setView("transcript");
  };

  const addVideo = () => {
    const match = newUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
    if (!match) return;
    const video: LibraryVideo = { id: match[1], title: `YouTube notebook · ${match[1]}`, source: "YouTube" };
    const next = [starterVideo, ...library.filter((item) => item.id !== VIDEO_ID && item.id !== video.id), video];
    setLibrary(next);
    setActiveVideoId(video.id);
    setImported([]);
    setView("transcript");
    setActiveTime(0);
    setPlayerKey((key) => key + 1);
    setNewUrl("");
    setLibraryOpen(false);
    window.localStorage.setItem("vidmark-library", JSON.stringify(next.filter((item) => item.id !== VIDEO_ID)));
  };

  const selectVideo = (video: LibraryVideo) => {
    setActiveVideoId(video.id); setImported([]); setActiveTime(video.id === VIDEO_ID ? 857 : 0); setView(video.id === VIDEO_ID ? "guide" : "transcript"); setPlayerKey((key) => key + 1); setLibraryOpen(false);
  };

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-mark">V</div>
        <nav aria-label="Primary">
          <button className="rail-button active" aria-label="Study workspace">⌂</button>
          <button className="rail-button" aria-label="Video library" onClick={() => setLibraryOpen(true)}>▤</button>
          <button className="rail-button" aria-label="Bookmarks">◇</button>
        </nav>
        <div className="rail-bottom"><button className="rail-button" aria-label="Theme">☼</button><div className="avatar">GB</div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="library-trigger" onClick={() => setLibraryOpen(true)}>
            <span className="dot-grid">••<br />••</span><span><b>Video library</b><small>{library.length} {library.length === 1 ? "course" : "courses"} · device library</small></span><span className="chevron">⌄</span>
          </button>
          <label className="global-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search concepts, chapters, or captions…" /><kbd>⌘ K</kbd></label>
          <button className="add-button" onClick={() => setLibraryOpen(true)}>＋ Add video</button>
        </header>

        <div className="content-grid">
          <section className="player-column">
            <div className="crumbs"><span>LIBRARY</span><b>{activeVideo.title}</b></div>
            <div className="player-frame">
              <iframe key={playerKey} src={`https://www.youtube-nocookie.com/embed/${activeVideo.id}?start=${activeTime}&rel=0&modestbranding=1`} title={`${activeVideo.title} video player`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
            </div>
            <div className="video-heading">
              <div><span className="source-pill">{activeVideo.source.toUpperCase()}</span><h1>{activeVideo.title}</h1><p>{isStarter ? "Prepare for and pass the CCA-F exam with a 12-hour architecture deep dive." : "Import a VTT caption file to turn this video into a searchable, timestamped notebook."}</p></div>
              <a className="youtube-link" href={`https://www.youtube.com/watch?v=${activeVideo.id}&t=${activeTime}s`} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
            </div>

            <div className="stat-row"><div><strong>{isStarter ? "12h 38m" : "—"}</strong><span>runtime</span></div><div><strong>{isStarter ? "13" : "—"}</strong><span>chapters</span></div><div><strong>{isStarter ? notes.length : imported.length || "—"}</strong><span>{isStarter ? "study moments" : "caption cues"}</span></div><div><strong>{isStarter ? "6" : "—"}</strong><span>visual references</span></div></div>

            {isStarter ? <section className="chapter-section">
              <div className="section-title"><div><span>COURSE MAP</span><h2>Chapters</h2></div><span>{chapters.length} sections</span></div>
              <div className="chapter-list">
                {chapters.map((chapter, index) => (
                  <button key={chapter.title} className="chapter-row" onClick={() => seek(chapter.start)}>
                    <span className="chapter-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="chapter-copy"><b>{chapter.title}</b><small>{chapter.summary}</small><i>{chapter.tags.map((tag) => `#${tag}`).join("  ")}</i></span>
                    <span className="chapter-time"><b>{formatTime(chapter.start)}</b><small>{chapter.duration}</small></span><span className="play-arrow">▶</span>
                  </button>
                ))}
              </div>
            </section> : <section className="new-notebook"><span>NEW NOTEBOOK</span><h2>Bring this video into focus.</h2><p>Open the Transcript tab, import a WebVTT caption file, then search and click any line to jump back to the exact moment.</p><button onClick={() => { setView("transcript"); uploadRef.current?.click(); }}>Import captions</button></section>}
          </section>

          <aside className="notebook">
            <div className="notebook-head"><div className="tabs" role="tablist"><button className={view === "guide" ? "active" : ""} onClick={() => setView("guide")}>Study guide</button><button className={view === "transcript" ? "active" : ""} onClick={() => setView("transcript")}>Transcript</button></div><button className="icon-button" aria-label="More options">•••</button></div>
            {view === "guide" ? (
              <>
                <div className="guide-intro"><span>{isStarter ? "EXAM COMPANION" : "VIDEO NOTEBOOK"}</span><h2>{isStarter ? "From 12 hours to a focused review." : "Your study guide starts with captions."}</h2><p>{isStarter ? "Search the architecture decisions, jump straight to the explanation, and review the visual evidence in context." : "Import a caption file, then build your own searchable path through the video."}</p></div>
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
            ) : (
              <>
                <div className="transcript-tools"><div><span>CAPTION WORKSPACE</span><h2>{imported.length ? `${imported.length.toLocaleString()} cues imported` : "Searchable guided transcript"}</h2></div><input ref={uploadRef} type="file" accept=".vtt,text/vtt" onChange={importVtt} hidden /><button onClick={() => uploadRef.current?.click()}>Import .VTT</button></div>
                <div className="caption-note">Import caption files you have permission to use. They stay in this browser session and are never uploaded.</div>
                <div className="transcript-feed">{filteredTranscript.slice(0, 500).map((item, index) => <button key={`${item.time}-${index}`} className="transcript-line" onClick={() => seek(item.time)}><time>{formatTime(item.time)}</time><span>{item.text}</span></button>)}{!filteredTranscript.length && <div className="empty-state">No caption lines match “{query}”.</div>}</div>
              </>
            )}
          </aside>
        </div>
      </section>

      {libraryOpen && <dialog open className="modal-backdrop" aria-label="Video library"><section className="library-modal">
        <div className="modal-head"><div><span>YOUR LIBRARY</span><h2>Video notebooks</h2></div><button onClick={() => setLibraryOpen(false)} aria-label="Close">×</button></div>
        <div className="library-stack">{library.map((video) => <article className="library-card" key={video.id}><img src={`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`} alt="YouTube video thumbnail" /><div><span>{video.id === VIDEO_ID ? "STUDY GUIDE READY" : "CAPTIONS NEEDED"}</span><h3>{video.title}</h3><p>{video.id === VIDEO_ID ? "13 chapters · 18 study moments · 6 visual references" : "Personal video notebook"}</p></div><button onClick={() => selectVideo(video)}>{video.id === activeVideoId ? "Current" : "Open"}</button></article>)}</div>
        <div className="add-panel"><b>Add another YouTube video</b><p>Paste a YouTube link, then import captions you have permission to use. Each notebook stays on this device.</p><div><input value={newUrl} onChange={(event) => setNewUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addVideo(); }} placeholder="https://youtube.com/watch?v=…" /><button onClick={addVideo} disabled={!newUrl.trim()}>Add</button></div></div>
      </section></dialog>}
    </main>
  );
}
