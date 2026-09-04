"use client";

/* Locally generated transcripts are rendered directly below each player when available. */
/* eslint-disable jsx-a11y/media-has-caption */

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Music2, Pause, Play } from "lucide-react";
import { StudyNote } from "./notes-store";

const formatAudioTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

export function VoiceNote({ note, compact = false }: { note: StudyNote; compact?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [blobAudioUrl] = useState(() => note.audio ? URL.createObjectURL(note.audio) : "");
  const audioUrl = note.audioUrl || blobAudioUrl;
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(note.durationSeconds ?? 0);

  useEffect(() => () => { if (blobAudioUrl) URL.revokeObjectURL(blobAudioUrl); }, [blobAudioUrl]);

  const togglePlayback = async () => {
    const player = audio.current;
    if (!player || !audioUrl) return;
    if (!player.paused) { player.pause(); return; }
    document.querySelectorAll<HTMLAudioElement>(".voice-note-track audio").forEach((candidate) => { if (candidate !== player) candidate.pause(); });
    try { await player.play(); } catch { setPlaying(false); }
  };

  const seek = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (audio.current && Number.isFinite(next)) audio.current.currentTime = next;
    setCurrentTime(next);
  };

  return <div className={`voice-note-content ${compact ? "compact" : ""}`}>
    <div className={`voice-note-track ${playing ? "playing" : ""}`}>
      <audio ref={audio} preload="metadata" src={audioUrl || undefined} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} />
      <button type="button" className="voice-play-button" onClick={togglePlayback} disabled={!audioUrl} aria-label={`${playing ? "Pause" : "Play"} voice note from ${note.chapterTitle}`}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>
      <div className="voice-track-copy"><b>{note.chapterTitle}</b><span><Music2 aria-hidden="true" /> {new Date(note.updatedAt).toLocaleString()}</span></div>
      <div className="voice-track-timeline"><input type="range" min="0" max={Math.max(duration, 0)} step="0.05" value={Math.min(currentTime, duration || 0)} onChange={seek} disabled={!audioUrl || !duration} aria-label={`Seek ${note.chapterTitle} voice note`} /><span>{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</span></div>
    </div>
    {!audioUrl && <p className="voice-audio-missing">Audio was not retained for this older voice note.</p>}
    <details open={!compact}><summary><FileText aria-hidden="true" /> {note.text ? "Transcript" : "Transcript unavailable"} <ChevronDown aria-hidden="true" /></summary><p>{note.text || "This recording was saved without a transcript because Apple on-device speech recognition was unavailable or did not detect speech."}</p></details>
  </div>;
}

export function VoiceNotePlaylist({ notes }: { notes: StudyNote[] }) {
  if (!notes.length) return null;
  return <section className="voice-note-playlist" aria-label="Voice note recordings">
    <header><div><span>VOICE NOTES</span><h2>Recordings</h2></div><strong>{notes.length} track{notes.length === 1 ? "" : "s"}</strong></header>
    <div className="voice-note-playlist-tracks">{notes.map((note) => <VoiceNote note={note} compact key={note.id} />)}</div>
  </section>;
}
