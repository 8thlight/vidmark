import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "../node_modules/vinext/dist/server/prod-server.js";
import { startVidmarkMcpServer } from "./vidmark-mcp";
import { startModelProviderServer } from "./model-provider";
import { startNoteStorageServer } from "./note-storage";
import { requireNativeServiceLease } from "./native-service-lease";

const APP_PORT = 3010;
const TRANSCRIPTION_PORT = 31415;
const APP_URL = `http://localhost:${APP_PORT}/`;

const executableDir = dirname(process.execPath);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedResources = resolve(executableDir, "../Resources");
const isPackaged = process.execPath.includes(".app/Contents/MacOS/");
const resourcesDir = isPackaged ? packagedResources : sourceRoot;
const transcriberPath = process.env.VIDMARK_TRANSCRIBER_PATH || (isPackaged ? join(executableDir, "VidmarkTranscriber") : join(sourceRoot, "build", "VidmarkTranscriber"));
const activeTranscribers = new Set<() => void>();
process.once("exit", () => { for (const stop of activeTranscribers) stop(); });

const appIsReady = async () => {
  try { return (await fetch(APP_URL, { signal: AbortSignal.timeout(800) })).ok; }
  catch { return false; }
};

const openApp = () => {
  if (process.env.VIDMARK_NATIVE_SHELL === "1") return;
  Bun.spawn(["/usr/bin/open", APP_URL], { stdout: "ignore", stderr: "ignore" });
};

const runTranscriber = async (arguments_: string[]) => {
  if (!(await Bun.file(transcriberPath).exists())) throw new Error("Apple on-device transcription is unavailable. The recording can still be saved without a transcript.");
  const child = Bun.spawn([transcriberPath, ...arguments_], { stdout: "pipe", stderr: "pipe" });
  const stop = () => child.kill("SIGTERM");
  activeTranscribers.add(stop);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Apple on-device transcription timed out. The recording can still be saved without a transcript.")); }, 120_000);
      }),
    ]);
    const output = await new Response(child.stdout).text();
    const error = (await new Response(child.stderr).text()).trim();
    if (exitCode !== 0) throw new Error(error || "Apple on-device transcription failed. The recording can still be saved without a transcript.");
    return JSON.parse(output) as { ok?: boolean; available?: boolean; transcript?: string; engine?: string; mode?: string; reason?: string };
  } finally {
    if (timeout) clearTimeout(timeout);
    activeTranscribers.delete(stop);
  }
};

async function startTranscriptionBridge() {
  process.once("SIGTERM", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));
  Bun.serve({
    hostname: "127.0.0.1",
    port: TRANSCRIPTION_PORT,
    idleTimeout: 125,
    async fetch(request) {
      const headers = {
        "Access-Control-Allow-Origin": request.headers.get("origin") === "http://127.0.0.1:3010" ? "http://127.0.0.1:3010" : "http://localhost:3010",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        try {
          const health = await runTranscriber(["--health", "en_US"]);
          return Response.json({ ...health, runtime: "Bun" }, { headers });
        } catch (error) {
          return Response.json({ ok: true, available: false, engine: "Apple Speech", mode: "on-device-only", reason: error instanceof Error ? error.message : "Apple on-device transcription is unavailable.", runtime: "Bun" }, { headers });
        }
      }
      if (request.method !== "POST" || new URL(request.url).pathname !== "/transcribe") {
        return Response.json({ error: "Not found" }, { status: 404, headers });
      }

      let workDir = "";
      try {
        const formData = await request.formData();
        const audio = formData.get("audio");
        const locale = String(formData.get("locale") ?? "en_US");
        if (!(audio instanceof File)) return Response.json({ error: "Attach a WAV voice note." }, { status: 400, headers });
        if (!audio.size || audio.size > 20 * 1024 * 1024) return Response.json({ error: "Voice notes must be between 1 byte and 20 MB." }, { status: 413, headers });

        workDir = await mkdtemp(join(tmpdir(), "vidmark-note-"));
        const audioPath = join(workDir, "voice-note.wav");
        await Bun.write(audioPath, audio);
        const result = await runTranscriber([audioPath, locale]);
        if (!result.transcript) throw new Error("Apple on-device transcription did not return text. The recording can still be saved without a transcript.");
        return Response.json({ transcript: result.transcript, engine: result.engine, mode: result.mode }, { headers });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Apple on-device transcription failed. The recording can still be saved without a transcript." }, { status: 503, headers });
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true });
      }
    },
  });
  console.log(`Vidmark Bun transcription bridge is listening at http://127.0.0.1:${TRANSCRIPTION_PORT}`);
  console.log(`VIDMARK_TRANSCRIPTION_READY ${process.env.VIDMARK_SESSION_TOKEN ?? "development"}`);
  await new Promise(() => {});
}

async function main() {
  if (isPackaged) {
    await requireNativeServiceLease(join(executableDir, process.argv.includes("--transcription") ? "VidmarkServer" : "Vidmark"));
  }
  if (process.argv.includes("--transcription")) return startTranscriptionBridge();
  if (await appIsReady()) {
    if (isPackaged) throw new Error("Another service is already using Vidmark's workspace port. Quit it before unlocking Vidmark.");
    openApp(); return;
  }

  const logDir = join(process.env.HOME ?? tmpdir(), "Library", "Logs", "Vidmark");
  const dataDirectory = process.env.VIDMARK_DATA_DIR || join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark");
  const databasePath = join(dataDirectory, "vidmark.sqlite");
  const systemPromptsPath = join(dataDirectory, "system-prompts.json");
  const providerSettingsPath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "model-provider.json");
  const noteStoragePath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "notes");
  await mkdir(logDir, { recursive: true });

  let shuttingDown = false;
  const cleanups: Array<() => void> = [];
  process.once("exit", () => {
    shuttingDown = true;
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* Continue closing the other services. */ } }
  });
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  const transcription = Bun.spawn([process.execPath, "--transcription"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  cleanups.push(() => transcription.kill("SIGTERM"));
  void transcription.exited.then(() => {
    if (!shuttingDown) {
      console.error("Vidmark transcription service stopped. Closing the workspace to prevent use of an unrelated listener.");
      process.exit(1);
    }
  });
  if (isPackaged) {
    transcription.stdin.write(`${process.env.VIDMARK_SESSION_TOKEN}\n`);
    transcription.stdin.flush();
  }
  const reader = transcription.stdout.getReader();
  let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let output = "";
        const marker = `VIDMARK_TRANSCRIPTION_READY ${process.env.VIDMARK_SESSION_TOKEN ?? "development"}`;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Transcription stopped before binding its port.");
          output += decoder.decode(chunk.value, { stream: true });
          if (output.split("\n").includes(marker)) return;
          if (output.length > 16384) throw new Error("Unexpected transcription startup output.");
        }
      })(),
      new Promise<never>((_, reject) => { readinessTimeout = setTimeout(() => reject(new Error("Transcription startup timed out.")), 5000); }),
    ]);
  } finally {
    if (readinessTimeout) clearTimeout(readinessTimeout);
    reader.releaseLock();
  }
  const mcp = await startVidmarkMcpServer(databasePath, { systemPromptsPath });
  cleanups.push(() => mcp.stop(true));
  const provider = startModelProviderServer(providerSettingsPath, databasePath, systemPromptsPath);
  cleanups.push(() => provider.stop(true));
  const noteStorage = startNoteStorageServer(noteStoragePath);
  cleanups.push(() => noteStorage.stop(true));
  const app = await startProdServer({ port: APP_PORT, host: "127.0.0.1", outDir: join(resourcesDir, "dist") });
  cleanups.push(() => { app.server.closeAllConnections(); app.server.close(); });

  if (isPackaged) console.log(`VIDMARK_READY ${process.env.VIDMARK_SESSION_TOKEN}`);

  openApp();
  console.log(`Vidmark is running at ${APP_URL} with Bun ${Bun.version}`);
}

await main();
