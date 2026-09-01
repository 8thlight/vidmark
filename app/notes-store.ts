export type StudyNote = {
  id: string;
  text: string;
  updatedAt: number;
  source: "text" | "voice";
  courseId: string;
  chapterId: string;
  chapterTitle: string;
  audio?: Blob;
  audioUrl?: string;
  durationSeconds?: number;
  sharedFromPeer?: boolean;
  readOnly?: boolean;
  authorProfile?: { id: string; name: string; email: string; avatarStyle: string; avatarSeed: string };
  authorDeviceId?: string;
  originalSource?: string;
};

const databaseName = "vidmark-note-session";
const storeName = "notes";
const noteStorageOrigin = "http://127.0.0.1:31419";

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const normalize = (note: Partial<StudyNote> & { id: string; text: string; createdAt?: number }): StudyNote => ({
  id: note.id,
  text: note.text,
  updatedAt: note.updatedAt ?? note.createdAt ?? Date.now(),
  source: note.source === "voice" ? "voice" : "text",
  courseId: note.courseId ?? "reDRM0tqhNs",
  chapterId: note.chapterId ?? "unsorted",
  chapterTitle: note.chapterTitle ?? "Unsorted notes",
  audio: note.audio instanceof Blob ? note.audio : undefined,
  audioUrl: typeof note.audioUrl === "string" ? note.audioUrl : undefined,
  durationSeconds: typeof note.durationSeconds === "number" ? note.durationSeconds : undefined,
});

const readBrowserNotes = async () => {
  const database = await openDatabase();
  return new Promise<StudyNote[]>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => { database.close(); resolve(request.result.map(normalize).sort((a, b) => b.updatedAt - a.updatedAt)); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
};

const writeBrowserNote = async (note: StudyNote) => {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(note);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
};

const removeBrowserNote = async (id: string) => {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).delete(id);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
};

const readDiskNotes = async () => {
  const response = await fetch(`${noteStorageOrigin}/notes`);
  if (!response.ok) throw new Error("The local note store is unavailable.");
  const result = await response.json() as { notes?: StudyNote[] };
  return (result.notes ?? []).map((note) => normalize(note)).sort((a, b) => b.updatedAt - a.updatedAt);
};

const writeDiskNote = async (note: StudyNote) => {
  const form = new FormData();
  const metadata = {
    id: note.id,
    text: note.text,
    updatedAt: note.updatedAt,
    source: note.source,
    courseId: note.courseId,
    chapterId: note.chapterId,
    chapterTitle: note.chapterTitle,
    durationSeconds: note.durationSeconds,
  };
  form.append("metadata", JSON.stringify(metadata));
  if (note.audio) form.append("audio", new File([note.audio], `${note.id}.wav`, { type: "audio/wav" }));
  const response = await fetch(`${noteStorageOrigin}/notes`, { method: "POST", body: form });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "The note could not be written to disk.");
  }
};

export const readNotes = async () => {
  const browserNotes = await readBrowserNotes().catch(() => [] as StudyNote[]);
  try {
    let diskNotes = await readDiskNotes();
    const diskIds = new Set(diskNotes.map((note) => note.id));
    let migrated = false;
    for (const note of browserNotes) {
      if (diskIds.has(note.id)) continue;
      await writeDiskNote(note);
      migrated = true;
    }
    if (migrated) diskNotes = await readDiskNotes();
    return diskNotes;
  } catch {
    return browserNotes;
  }
};

export const writeNote = async (note: StudyNote): Promise<{ storage: "disk" | "browser" }> => {
  try {
    await writeDiskNote(note);
    return { storage: "disk" };
  } catch {
    await writeBrowserNote(note);
    return { storage: "browser" };
  }
};

export const removeNote = async (id: string) => {
  let deletedFromDisk = false;
  let deletedFromBrowser = false;
  try {
    const response = await fetch(`${noteStorageOrigin}/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    deletedFromDisk = response.ok;
  } catch { /* The browser fallback can still be removed. */ }
  try { await removeBrowserNote(id); deletedFromBrowser = true; } catch { /* The disk copy may already be gone. */ }
  if (!deletedFromDisk && !deletedFromBrowser) throw new Error("The note could not be deleted.");
};
