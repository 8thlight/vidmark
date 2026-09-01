import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "../node_modules/vinext/dist/server/prod-server.js";
import { startVidmarkMcpServer } from "./vidmark-mcp";
import { startModelProviderServer } from "./model-provider";
import { startNoteStorageServer } from "./note-storage";

const APP_PORT = 3010;
const TRANSCRIPTION_PORT = 31415;
const WHISPER_PORT = 31416;
const APP_URL = `http://localhost:${APP_PORT}/`;

const executableDir = dirname(process.execPath);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedResources = resolve(executableDir, "../Resources");
const isPackaged = process.execPath.includes(".app/Contents/MacOS/");
const resourcesDir = isPackaged ? packagedResources : sourceRoot;

const readProjectRoot = async () => {
  if (process.env.VIDMARK_PROJECT_DIR) return process.env.VIDMARK_PROJECT_DIR;
  if (!isPackaged) return sourceRoot;
  try { return (await readFile(join(resourcesDir, "vidmark-project-path"), "utf8")).trim(); }
  catch { return ""; }
};

const appIsReady = async () => {
  try { return (await fetch(APP_URL, { signal: AbortSignal.timeout(800) })).ok; }
  catch { return false; }
};

const openApp = () => {
  if (process.env.VIDMARK_NATIVE_SHELL === "1") return;
  Bun.spawn(["/usr/bin/open", APP_URL], { stdout: "ignore", stderr: "ignore" });
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
        return Response.json({ ok: true, engine: "MLX Whisper Turbo (on-device)", runtime: "Bun" }, { headers });
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
        const language = locale.split(/[-_]/)[0] || "en";
        const workerResponse = await fetch(`http://127.0.0.1:${WHISPER_PORT}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioPath, language }),
          signal: AbortSignal.timeout(120_000),
        });
        const result = await workerResponse.json() as { transcript?: string; error?: string };
        if (!workerResponse.ok || !result.transcript) throw new Error(result.error ?? "Local transcription did not return text.");
        return Response.json({ transcript: result.transcript }, { headers });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Local transcription failed." }, { status: 500, headers });
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

  const projectRoot = await readProjectRoot();
  const python = join(projectRoot, ".venv", "bin", "python");
  const whisperScript = join(resourcesDir, "whisper-worker.py");
  const logDir = join(process.env.HOME ?? tmpdir(), "Library", "Logs", "Vidmark");
  const mcpStatePath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "mcp-state.json");
  const providerSettingsPath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "model-provider.json");
  const noteStoragePath = join(process.env.HOME ?? tmpdir(), "Library", "Application Support", "Vidmark", "notes");
  await mkdir(logDir, { recursive: true });

  const worker = Bun.spawn([python, whisperScript], {
    cwd: projectRoot || resourcesDir,
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`, HF_HUB_OFFLINE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const transcription = Bun.spawn([process.execPath, "--transcription"], { stdout: "inherit", stderr: "inherit" });
  const mcp = startVidmarkMcpServer(mcpStatePath);
  const provider = startModelProviderServer(providerSettingsPath, mcpStatePath);
  const noteStorage = startNoteStorageServer(noteStoragePath);
  const app = await startProdServer({ port: APP_PORT, host: "127.0.0.1", outDir: join(resourcesDir, "dist") });

  const shutdown = () => {
    worker.kill("SIGTERM");
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
