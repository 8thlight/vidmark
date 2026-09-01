import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const NOTE_STORAGE_PORT = 31419;

type StoredNote = {
  id: string;
  text: string;
  updatedAt: number;
  source: "text" | "voice";
  courseId: string;
  chapterId: string;
  chapterTitle: string;
  durationSeconds?: number;
  audioFile?: string;
};

const noteIdPattern = /^[A-Za-z0-9_-]{1,100}$/;

const isStoredNote = (value: unknown): value is StoredNote => {
  if (!value || typeof value !== "object") return false;
  const note = value as Partial<StoredNote>;
  const audioFileIsSafe = note.audioFile === undefined || (typeof note.id === "string" && note.audioFile === `${note.id}.wav`);
  return typeof note.id === "string" && noteIdPattern.test(note.id) && typeof note.text === "string" && typeof note.updatedAt === "number" && (note.source === "text" || note.source === "voice") && typeof note.courseId === "string" && typeof note.chapterId === "string" && typeof note.chapterTitle === "string" && audioFileIsSafe;
};

export function startNoteStorageServer(storageRoot: string) {
  const notesPath = join(storageRoot, "notes.json");
  const audioDirectory = join(storageRoot, "audio");
  let writeQueue: Promise<unknown> = Promise.resolve();

  const readNotes = async (): Promise<StoredNote[]> => {
    try {
      const parsed = JSON.parse(await readFile(notesPath, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isStoredNote).sort((a, b) => b.updatedAt - a.updatedAt) : [];
    } catch { return []; }
  };

  const writeNotes = async (notes: StoredNote[]) => {
    await mkdir(storageRoot, { recursive: true });
    const temporaryPath = `${notesPath}.next`;
    await writeFile(temporaryPath, JSON.stringify(notes, null, 2), "utf8");
    await rename(temporaryPath, notesPath);
  };

  const updateNotes = async (update: (notes: StoredNote[]) => Promise<StoredNote[]> | StoredNote[]) => {
    let result: StoredNote[] = [];
    writeQueue = writeQueue.then(async () => { result = await update(await readNotes()); await writeNotes(result); });
    await writeQueue;
    return result;
  };

  const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin");
    const allowedOrigin = origin === "http://127.0.0.1:3010" || origin === "http://localhost:3010" ? origin : "http://127.0.0.1:3010";
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: NOTE_STORAGE_PORT,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = corsHeaders(request);
      const host = request.headers.get("host")?.split(":")[0];
      const origin = request.headers.get("origin");
      if (host !== "127.0.0.1" && host !== "localhost") return Response.json({ error: "Invalid Host header." }, { status: 403, headers });
      if (origin && origin !== "http://127.0.0.1:3010" && origin !== "http://localhost:3010") return Response.json({ error: "Invalid Origin header." }, { status: 403, headers });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (url.pathname === "/health") return Response.json({ ok: true, storageRoot, notesPath, audioDirectory }, { headers });

      if (url.pathname === "/notes" && request.method === "GET") {
        const notes = (await readNotes()).map((note) => ({ ...note, audioUrl: note.audioFile ? `http://127.0.0.1:${NOTE_STORAGE_PORT}/audio/${note.audioFile}` : undefined }));
        return Response.json({ notes }, { headers });
      }

      if (url.pathname === "/notes" && request.method === "POST") {
        try {
          const form = await request.formData();
          const metadata = JSON.parse(String(form.get("metadata") ?? "null")) as unknown;
          if (!isStoredNote(metadata)) return Response.json({ error: "Invalid note metadata." }, { status: 400, headers });
          const audio = form.get("audio");
          const existing = (await readNotes()).find((note) => note.id === metadata.id);
          let audioFile = existing?.audioFile;
          if (audio instanceof File && audio.size > 0) {
            if (audio.size > 100 * 1024 * 1024) return Response.json({ error: "Voice notes must be smaller than 100 MB." }, { status: 413, headers });
            await mkdir(audioDirectory, { recursive: true });
            audioFile = `${metadata.id}.wav`;
            const audioPath = join(audioDirectory, audioFile);
            const temporaryAudioPath = `${audioPath}.next`;
            await Bun.write(temporaryAudioPath, audio);
            await rename(temporaryAudioPath, audioPath);
          }
          const note: StoredNote = { ...metadata, audioFile };
          const notes = await updateNotes((current) => [note, ...current.filter((item) => item.id !== note.id)].sort((a, b) => b.updatedAt - a.updatedAt));
          return Response.json({ ok: true, note: { ...note, audioUrl: audioFile ? `http://127.0.0.1:${NOTE_STORAGE_PORT}/audio/${audioFile}` : undefined }, count: notes.length }, { headers });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Could not save note." }, { status: 500, headers });
        }
      }

      const noteMatch = url.pathname.match(/^\/notes\/([A-Za-z0-9_-]{1,100})$/);
      if (noteMatch && request.method === "DELETE") {
        const noteId = noteMatch[1];
        const existing = (await readNotes()).find((note) => note.id === noteId);
        await updateNotes((current) => current.filter((note) => note.id !== noteId));
        if (existing?.audioFile) await rm(join(audioDirectory, existing.audioFile), { force: true });
        return Response.json({ ok: true, deleted: noteId }, { headers });
      }

      const audioMatch = url.pathname.match(/^\/audio\/([A-Za-z0-9_-]{1,100}\.wav)$/);
      if (audioMatch && request.method === "GET") {
        const audioPath = join(audioDirectory, audioMatch[1]);
        const file = Bun.file(audioPath);
        if (!(await file.exists())) return Response.json({ error: "Audio file not found." }, { status: 404, headers });
        const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
        const audioHeaders = new Headers(headers);
        audioHeaders.set("Accept-Ranges", "bytes");
        audioHeaders.set("Content-Type", "audio/wav");
        audioHeaders.set("Cache-Control", "private, max-age=3600");
        if (!range) {
          audioHeaders.set("Content-Length", String(file.size));
          return new Response(file, { headers: audioHeaders });
        }
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= file.size) return new Response(null, { status: 416, headers: audioHeaders });
        audioHeaders.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
        audioHeaders.set("Content-Length", String(end - start + 1));
        return new Response(file.slice(start, end + 1), { status: 206, headers: audioHeaders });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  });

  console.log(`Vidmark note storage is listening at http://127.0.0.1:${NOTE_STORAGE_PORT}`);
  return server;
}
