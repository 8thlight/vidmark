import { homedir } from "node:os";
import { join } from "node:path";
import { startNoteStorageServer } from "./note-storage";

startNoteStorageServer(join(homedir(), "Library", "Application Support", "Vidmark", "notes"));
await new Promise(() => {});
