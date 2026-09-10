import { chapterVideos, webUrl, youtubeId } from "./course-source";

export function CourseChapters({ chapters, query, onNotes }: { chapters: Array<Record<string, unknown>>; query: string; onNotes: (id: string) => void }) {
  const visible = chapters.filter((chapter) => JSON.stringify(chapter).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="chapter-section reading-chapters" aria-label="Course chapters">
    <div className="section-title"><div><span>COURSE MAP</span><h2>Chapters</h2></div><span>{chapters.length} sections</span></div>
    {visible.map((chapter, index) => {
      let videos: ReturnType<typeof chapterVideos> = [];
      try { videos = chapterVideos(chapter.videos); } catch { /* Older external bundles may have unsupported media metadata. */ }
      const objectives = Array.isArray(chapter.learningObjectives) ? chapter.learningObjectives : [];
      const source = webUrl(chapter.sourceUrl);
      return <details className="reading-chapter" key={String(chapter.id ?? index)} open={index === 0}>
        <summary>{String(chapter.title ?? `Chapter ${index + 1}`)}</summary>
        <p>{String(chapter.summary ?? "")}</p>
        {objectives.length ? <ul>{objectives.map((objective, i) => <li key={i}>{String(objective)}</li>)}</ul> : null}
        {chapter.content ? <p className="chapter-content">{String(chapter.content)}</p> : null}
        {source ? <a href={source} target="_blank" rel="noreferrer">Read chapter source ↗</a> : null}
        <div><button type="button" className="jump-link" onClick={() => onNotes(String(chapter.id ?? `chapter-${index + 1}`))}>Take notes on this chapter →</button></div>
        {videos.length ? <div className="chapter-videos"><h3>Supporting videos</h3>{videos.map((video, i) => {
          const id = youtubeId(video.url);
          return <details key={`${video.url}-${i}`}><summary>{video.title}</summary>
            {id ? <div className="player-frame"><iframe loading="lazy" src={`https://www.youtube-nocookie.com/embed/${id}?start=${Math.floor(video.startSeconds ?? 0)}`} title={video.title} allowFullScreen /></div> : null}
            <a href={video.url} target="_blank" rel="noreferrer">Open supporting video ↗</a>
          </details>;
        })}</div> : null}
      </details>;
    })}
    {!visible.length ? <p>No chapters match your search.</p> : null}
  </section>;
}
