import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "../node_modules/vinext/dist/server/prod-server.js";
import { startVidmarkMcpServer } from "./vidmark-mcp";
import { startModelProviderServer } from "./model-provider";
import { startNoteStorageServer } from "./note-storage";

const APP_PORT = 3010;
const TRANSCRIPTION_PORT = 31415;
const APP_URL = `http://localhost:${APP_PORT}/`;

const executableDir = dirname(process.execPath);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedResources = resolve(executableDir, "../Resources");
const isPackaged = process.execPath.includes(".app/Contents/MacOS/");
const resourcesDir = isPackaged ? packagedResources : sourceRoot;
const transcriberPath = process.env.VIDMARK_TRANSCRIBER_PATH || (isPackaged ? join(executableDir, "VidmarkTranscriber") : join(sourceRoot, "build", "VidmarkTranscriber"));

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
  }
};

async function startTranscriptionBridge() {
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
  await new Promise(() => {});
}

async function main() {
  if (process.argv.includes("--transcription")) return startTranscriptionBridge();
  if (await appIsReady()) { openApp(); return; }

  const logDir = join(process.env.HOME ?? tmpdir(), "Library", "Logs", "Vidmark");
  const dataDirectory = process.env.VIDMARK_DATA_DIR || join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark");
  const databasePath = join(dataDirectory, "vidmark.sqlite");
  const systemPromptsPath = join(dataDirectory, "system-prompts.json");
  const providerSettingsPath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "model-provider.json");
  const noteStoragePath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "notes");
  await mkdir(logDir, { recursive: true });

  const transcription = Bun.spawn([process.execPath, "--transcription"], { stdout: "inherit", stderr: "inherit" });
  const mcp = await startVidmarkMcpServer(databasePath, { systemPromptsPath });
  const provider = startModelProviderServer(providerSettingsPath, databasePath, systemPromptsPath);
  const noteStorage = startNoteStorageServer(noteStoragePath);
  const app = await startProdServer({ port: APP_PORT, host: "127.0.0.1", outDir: join(resourcesDir, "dist") });

  const shutdown = () => {
    transcription.kill("SIGTERM");
    mcp.stop(true);
    provider.stop(true);
    noteStorage.stop(true);
    app.server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", shutdown);

  openApp();
  console.log(`Vidmark is running at ${APP_URL} with Bun ${Bun.version}`);
}

await main();
