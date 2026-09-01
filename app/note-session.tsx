"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, FileText, Mic, Save, Share2, Square, Trash2, X } from "lucide-react";
import { DirectoryRecipientPicker } from "./directory-recipient-picker";
import { removeNote, StudyNote, writeNote } from "./notes-store";
import type { DirectoryUser } from "./vidmark-client";
import { VoiceNote } from "./voice-note";

const wavFromChunks = (chunks: Float32Array[], sampleRate: number) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, length * 2, true);
  let offset = 44;
  chunks.forEach((chunk) => chunk.forEach((sample) => { view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true); offset += 2; }));
  return new Blob([buffer], { type: "audio/wav" });
};

export function NoteSession({ open, onClose, notes, courseId, chapterId, chapterTitle, onNotesChanged, onShareNote }: { open: boolean; onClose: () => void; notes: StudyNote[]; courseId: string; chapterId: string; chapterTitle: string; onNotesChanged: () => Promise<void>; onShareNote: (note: StudyNote, recipient: DirectoryUser) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [status, setStatus] = useState("Notes and recordings are saved to this Mac.");
  const [saving, setSaving] = useState(false);
  const [saveSucceeded, setSaveSucceeded] = useState(false);
  const [saveLocation, setSaveLocation] = useState<"disk" | "browser">("disk");
  const [sharingNoteId, setSharingNoteId] = useState<string | null>(null);
  const [hasVoiceTranscript, setHasVoiceTranscript] = useState(false);
  const [voiceAudio, setVoiceAudio] = useState<Blob | null>(null);
  const [voiceDuration, setVoiceDuration] = useState<number | undefined>();
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicrophone, setSelectedMicrophone] = useState("");
  const audioContext = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const source = useRef<MediaStreamAudioSourceNode | null>(null);
  const mutedOutput = useRef<GainNode | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const samples = useRef<Float32Array[]>([]);
  const waveform = useRef<HTMLCanvasElement | null>(null);
  const animationFrame = useRef<number | null>(null);
  const liveTranscriptionTimer = useRef<number | null>(null);
  const liveTranscriptionTask = useRef<Promise<void> | null>(null);
  const voiceDraftStart = useRef(0);
  const voiceSession = useRef(0);
  const saveSuccessTimer = useRef<number | null>(null);

  const refreshMicrophones = async () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    const devices = (await mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    setMicrophones(devices);
    setSelectedMicrophone((current) => current || devices[0]?.deviceId || "");
  };

  const drawWaveform = () => {
    const canvas = waveform.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; context.scale(ratio, ratio); }
    context.clearRect(0, 0, width, height);
    context.fillStyle = document.querySelector(".app-shell")?.getAttribute("data-theme") === "dark" ? "#111d30" : "#f7f8fa"; context.fillRect(0, 0, width, height);
    context.strokeStyle = "#ef6a3b"; context.lineWidth = 1.5; context.beginPath();
    const values = new Uint8Array(analyser.current?.fftSize ?? 1024);
    analyser.current?.getByteTimeDomainData(values);
    for (let index = 0; index < values.length; index += 1) {
      const x = (index / (values.length - 1)) * width;
      const y = analyser.current ? ((values[index] - 128) / 128) * (height * 0.36) + height / 2 : height / 2;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    }
    context.stroke();
    if (analyser.current) animationFrame.current = requestAnimationFrame(drawWaveform);
  };

  useEffect(() => () => { stream.current?.getTracks().forEach((track) => track.stop()); audioContext.current?.close(); if (liveTranscriptionTimer.current) window.clearInterval(liveTranscriptionTimer.current); if (saveSuccessTimer.current) window.clearTimeout(saveSuccessTimer.current); }, []);
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    mediaDevices.addEventListener("devicechange", refreshMicrophones);
    return () => mediaDevices.removeEventListener("devicechange", refreshMicrophones);
  }, []);

  const requestTranscript = async (chunks: Float32Array[], sampleRate: number) => {
    const form = new FormData();
    form.append("audio", new File([wavFromChunks(chunks, sampleRate)], "voice-note.wav", { type: "audio/wav" }));
    form.append("locale", "en_US");
    const response = await fetch("http://127.0.0.1:31415/transcribe", { method: "POST", body: form });
    const result = await response.json() as { transcript?: string; error?: string };
    if (!response.ok || !result.transcript) throw new Error(result.error ?? "No transcript returned.");
    return result.transcript.trim();
  };

  const transcribeLiveChunk = async (session: number, sampleRate: number) => {
    if (session !== voiceSession.current) return;
    const recordingSoFar = samples.current.slice();
    const sampleCount = recordingSoFar.reduce((total, sample) => total + sample.length, 0);
    if (sampleCount < sampleRate * 0.8) return;
    try {
      const transcript = await requestTranscript(recordingSoFar, sampleRate);
      if (session !== voiceSession.current) return;
      setDraft((current) => `${current.slice(0, voiceDraftStart.current)}${voiceDraftStart.current ? "\n\n" : ""}${transcript}`);
      setHasVoiceTranscript(true);
      setStatus("Listening… Whisper Turbo is refining the note live.");
    } catch {
      if (session === voiceSession.current) setStatus("Listening… the current phrase will be completed when you stop recording.");
    }
  };

  const startRecording = async () => {
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices) {
        setStatus("Voice notes require HTTPS when opened from another device.");
        return;
      }
      const input = await mediaDevices.getUserMedia({ audio: { deviceId: selectedMicrophone ? { exact: selectedMicrophone } : undefined, channelCount: 1, noiseSuppression: true, echoCancellation: true } });
      await refreshMicrophones();
      const context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      const inputSource = context.createMediaStreamSource(input);
      const recorder = context.createScriptProcessor(4096, 1, 1);
      const silentGain = context.createGain();
      const waveformAnalyser = context.createAnalyser();
      waveformAnalyser.fftSize = 1024;
      silentGain.gain.value = 0;
      samples.current = [];
      setVoiceAudio(null); setVoiceDuration(undefined);
      voiceDraftStart.current = draft.length;
      const session = voiceSession.current + 1;
      voiceSession.current = session;
      recorder.onaudioprocess = (event) => samples.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      inputSource.connect(recorder); inputSource.connect(waveformAnalyser); recorder.connect(silentGain); silentGain.connect(context.destination);
      audioContext.current = context; stream.current = input; source.current = inputSource; processor.current = recorder; mutedOutput.current = silentGain; analyser.current = waveformAnalyser;
      drawWaveform();
      liveTranscriptionTimer.current = window.setInterval(() => {
        if (!liveTranscriptionTask.current) liveTranscriptionTask.current = transcribeLiveChunk(session, context.sampleRate).finally(() => { liveTranscriptionTask.current = null; });
      }, 800);
      setRecording(true); setStatus("Listening… Whisper Turbo will add your words here live.");
    } catch {
      setStatus("Microphone access is required to record a voice note.");
    }
  };

  const stopAndTranscribe = async () => {
    if (!audioContext.current) return;
    voiceSession.current += 1;
    if (liveTranscriptionTimer.current) window.clearInterval(liveTranscriptionTimer.current);
    liveTranscriptionTimer.current = null;
    setRecording(false); setTranscribing(true); setStatus("Transcribing with Whisper Turbo on this Mac…");
    processor.current?.disconnect(); source.current?.disconnect(); mutedOutput.current?.disconnect(); stream.current?.getTracks().forEach((track) => track.stop());
    analyser.current?.disconnect(); analyser.current = null;
    if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
    const sampleRate = audioContext.current.sampleRate;
    const recordedSamples = samples.current.slice();
    const recordedAudio = wavFromChunks(recordedSamples, sampleRate);
    const recordedDuration = recordedSamples.reduce((total, chunk) => total + chunk.length, 0) / sampleRate;
    setVoiceAudio(recordedAudio); setVoiceDuration(recordedDuration);
    await audioContext.current.close();
    audioContext.current = null; stream.current = null;
    try {
      await liveTranscriptionTask.current;
      const transcript = await requestTranscript(recordedSamples, sampleRate);
      setDraft((current) => `${current.slice(0, voiceDraftStart.current)}${voiceDraftStart.current ? "\n\n" : ""}${transcript}`);
      setHasVoiceTranscript(true);
      setStatus("Transcribed with Whisper Turbo locally. Review, edit, then save.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transcription failed.");
    } finally {
      setTranscribing(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || recording || transcribing || saving) return;
    const note: StudyNote = { id: crypto.randomUUID(), text, updatedAt: Date.now(), source: hasVoiceTranscript ? "voice" : "text", courseId, chapterId, chapterTitle, audio: hasVoiceTranscript ? voiceAudio ?? undefined : undefined, durationSeconds: hasVoiceTranscript ? voiceDuration : undefined };
    setSaving(true);
    try {
      const result = await writeNote(note);
      await onNotesChanged();
      setDraft(""); setHasVoiceTranscript(false); setVoiceAudio(null); setVoiceDuration(undefined); setSaveLocation(result.storage);
      setStatus(result.storage === "disk" ? "Saved to ~/Library/Application Support/Vidmark/notes." : "The disk service was unavailable, so this note was saved in browser storage.");
      setSaveSucceeded(true);
      if (saveSuccessTimer.current) window.clearTimeout(saveSuccessTimer.current);
      saveSuccessTimer.current = window.setTimeout(() => setSaveSucceeded(false), 2200);
    } catch {
      setStatus("Could not save this note on this device. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (id: string) => { await removeNote(id); await onNotesChanged(); };
  const shareNote = async (note: StudyNote, recipient: DirectoryUser) => { setStatus(`Sending an encrypted note to ${recipient.profile.name}…`); try { await onShareNote(note, recipient); setSharingNoteId(null); setStatus(`Note shared securely with ${recipient.profile.name}. It will be delivered when their Vidmark app syncs.`); } catch (error) { setStatus(error instanceof Error ? error.message : "The note could not be shared."); } };
  const closeSession = () => { setStatus("Notes and recordings are saved to this Mac."); onClose(); };

  if (!open) return null;
  return <dialog open className="modal-backdrop note-modal-backdrop" aria-label="Note session"><section className="note-session">
    <header className="note-session-head"><div><span>ALL NOTES · {notes.length}</span><h2>Capture the thought while it is fresh.</h2></div><button type="button" aria-label="Close note session" onClick={closeSession}><X aria-hidden="true" /></button></header>
    <p className="note-chapter-target">Saving new notes to <b>{chapterTitle}</b>.</p>
    <form onSubmit={save} className="note-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type a note, or record a voice note to transcribe locally…" /><div className="recording-tools"><label className="mic-selector"><Mic aria-hidden="true" /><span>Microphone</span><select value={selectedMicrophone} onChange={(event) => setSelectedMicrophone(event.target.value)} disabled={recording || transcribing}><option value="">Default microphone</option>{microphones.map((microphone, index) => <option value={microphone.deviceId} key={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}</select></label><div className={`waveform ${recording ? "live" : ""}`}><canvas ref={waveform} aria-label={recording ? "Live microphone waveform" : "Microphone waveform preview"} /></div></div><div className="note-actions"><button className={`record-button ${recording ? "recording" : ""}`} type="button" disabled={transcribing} onClick={recording ? stopAndTranscribe : startRecording}>{recording ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}{recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : "Record voice note"}</button><motion.button className="save-note" type="submit" disabled={!draft.trim() || recording || transcribing || saving} animate={saveSucceeded ? { backgroundColor: "#258451", scale: [1, 1.05, 1] } : { backgroundColor: "#0c1a31", scale: 1 }} transition={{ duration: 0.3 }}>{saveSucceeded ? <Check aria-hidden="true" /> : <Save aria-hidden="true" />}{saveSucceeded ? "Saved" : saving ? "Saving…" : "Save note"}</motion.button></div></form>
    <p className="note-status" role="status">{status}</p>
    <AnimatePresence>{saveSucceeded && <motion.div className="note-save-toast" role="status" initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }} transition={{ duration: 0.18 }}><Check aria-hidden="true" /> {saveLocation === "disk" ? "Saved to this Mac" : "Saved in browser storage"}</motion.div>}</AnimatePresence>
    <div className="note-list">{notes.length ? notes.map((note) => <div className="note-share-item" key={note.id}><article><div><span>{new Date(note.updatedAt).toLocaleString()} · {note.chapterTitle}{note.sharedFromPeer ? ` · Shared by ${note.authorProfile?.name ?? "a Vidmark user"}` : ""}</span>{note.source === "voice" ? <VoiceNote note={note} /> : <p>{note.text}</p>}</div><div className="note-row-actions" title={note.sharedFromPeer ? "Shared note" : note.source === "voice" ? "Voice note" : "Text note"}>{note.source === "voice" ? <Mic aria-hidden="true" /> : <FileText aria-hidden="true" />}{note.sharedFromPeer ? <Check aria-label="Shared by another user" /> : <><button type="button" aria-label="Share note with a Vidmark user" onClick={() => setSharingNoteId((current) => current === note.id ? null : note.id)}><Share2 aria-hidden="true" /></button><button type="button" aria-label="Delete note" onClick={() => void deleteNote(note.id)}><Trash2 aria-hidden="true" /></button></>}</div></article>{sharingNoteId === note.id ? <div className="note-recipient-picker"><b>Share this note</b><small>Search for a registered user. No email is sent.</small><DirectoryRecipientPicker actionLabel="Share note" onSelect={(recipient) => shareNote(note, recipient)} /></div> : null}</div>) : <p className="note-empty">No saved notes yet.</p>}</div>
  </section></dialog>;
}
