import { ChevronDown } from "lucide-react";
import type { ExamQuestion } from "./exam-data";
import { chapterVideos, webUrl, youtubeId } from "./course-source";

export function CourseChapters({ chapters, query, onNotes, onPractice, questionBank = [] }: { chapters: Array<Record<string, unknown>>; query: string; onNotes: (id: string) => void; onPractice?: (id: string) => void; questionBank?: ExamQuestion[] }) {
  const search = query.trim().toLowerCase();
  const visible = chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => JSON.stringify(chapter).toLowerCase().includes(search));
  return <section className="chapter-section reading-chapters" aria-label="Course chapters">
    <div className="section-title"><div><span>COURSE MAP</span><h2>Chapters</h2></div><span>{search ? `${visible.length} of ${chapters.length}` : chapters.length} {chapters.length === 1 ? "section" : "sections"}</span></div>
    <div className="chapter-list">
    {visible.map(({ chapter, index }, visibleIndex) => {
      let videos: ReturnType<typeof chapterVideos> = [];
      try { videos = chapterVideos(chapter.videos); } catch { /* Older external bundles may have unsupported media metadata. */ }
      const objectives = Array.isArray(chapter.learningObjectives) ? chapter.learningObjectives : [];
      const source = webUrl(chapter.sourceUrl);
      const questionCount = questionBank.filter(q => q.sectionId === String(chapter.id)).length;
      return <details className="reading-chapter" key={String(chapter.id ?? index)} open={visibleIndex === 0}>
        <summary className="chapter-row reading-chapter-row">
          <span className="chapter-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="chapter-copy"><b>{String(chapter.title ?? `Chapter ${index + 1}`)}</b>{chapter.summary ? <small>{String(chapter.summary)}</small> : null}{questionCount > 0 && <em className="chapter-question-count">{questionCount} {questionCount === 1 ? "question" : "questions"}</em>}</span>
          <ChevronDown className="chapter-chevron" aria-hidden="true" />
        </summary>
        <div className="reading-chapter-body">
        {objectives.length ? <ul>{objectives.map((objective, i) => <li key={i}>{String(objective)}</li>)}</ul> : null}
        {chapter.content ? <p className="chapter-content">{String(chapter.content)}</p> : null}
        <div className="reading-chapter-actions">
          <button type="button" onClick={() => onNotes(String(chapter.id ?? `chapter-${index + 1}`))}>Take notes</button>
          {onPractice && questionCount > 0 ? <button type="button" onClick={() => onPractice(String(chapter.id))}>Practice {questionCount} {questionCount === 1 ? "question" : "questions"}</button> : null}
          {source ? <a href={source} target="_blank" rel="noreferrer">Read chapter source ↗</a> : null}
        </div>
        {videos.length ? <div className="chapter-videos"><h3>Supporting videos</h3>{videos.map((video, i) => {
          const id = youtubeId(video.url);
          return <details key={`${video.url}-${i}`}><summary>{video.title}</summary>
            {id ? <div className="player-frame"><iframe loading="lazy" src={`https://www.youtube-nocookie.com/embed/${id}?start=${Math.floor(video.startSeconds ?? 0)}`} title={video.title} allowFullScreen /></div> : null}
            <a href={video.url} target="_blank" rel="noreferrer">Open supporting video ↗</a>
          </details>;
        })}</div> : null}
        </div>
      </details>;
    })}
    </div>
    {!visible.length ? <p>No chapters match your search.</p> : null}
  </section>;
}
