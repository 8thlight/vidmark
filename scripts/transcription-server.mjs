import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const port = Number(process.env.VIDMARK_TRANSCRIPTION_PORT ?? 31415);
const transcriberPath = process.env.VIDMARK_TRANSCRIBER_PATH ?? join(process.cwd(), "build", "VidmarkTranscriber");
const allowedOrigins = new Set(["http://localhost:3010", "http://127.0.0.1:3010"]);

const sendJson = (response, status, payload, origin) => {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "http://localhost:3010",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
};

const runTranscriber = (arguments_) => new Promise((resolve, reject) => {
  const child = spawn(transcriberPath, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("Apple on-device transcription timed out. The recording can still be saved without a transcript."));
  }, 120_000);
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  child.on("error", () => {
    clearTimeout(timeout);
    reject(new Error("Apple on-device transcription is unavailable. The recording can still be saved without a transcript."));
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (code !== 0) return reject(new Error(error.trim() || "Apple on-device transcription failed. The recording can still be saved without a transcript."));
    try { resolve(JSON.parse(output)); }
    catch { reject(new Error("Apple on-device transcription returned an invalid response. The recording can still be saved without a transcript.")); }
  });
});

createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === "OPTIONS") return sendJson(response, 204, {}, origin);
  if (request.method === "GET" && request.url === "/health") {
    try {
      const health = await runTranscriber(["--health", "en_US"]);
      return sendJson(response, 200, health, origin);
    } catch (error) {
      return sendJson(response, 200, { ok: true, available: false, engine: "Apple Speech", mode: "on-device-only", reason: error instanceof Error ? error.message : "Apple on-device transcription is unavailable." }, origin);
    }
  }
  if (request.method !== "POST" || request.url !== "/transcribe") return sendJson(response, 404, { error: "Not found" }, origin);

  let directory;
  try {
    const formData = await new Request(`http://localhost${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: Readable.toWeb(request),
      duplex: "half",
    }).formData();
    const audio = formData.get("audio");
    const locale = String(formData.get("locale") ?? "en_US");
    if (!(audio instanceof File)) return sendJson(response, 400, { error: "Attach a WAV voice note." }, origin);
    const bytes = Buffer.from(await audio.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) return sendJson(response, 413, { error: "Voice notes must be between 1 byte and 20 MB." }, origin);

    directory = await mkdtemp(join(tmpdir(), "vidmark-note-"));
    const audioPath = join(directory, "voice-note.wav");
    await writeFile(audioPath, bytes);
    const result = await runTranscriber([audioPath, locale]);
    if (!result.transcript) throw new Error("Apple on-device transcription did not return text. The recording can still be saved without a transcript.");
    return sendJson(response, 200, result, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local transcription failed.";
    return sendJson(response, 503, {
      error: message,
    }, origin);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Vidmark Apple on-device transcription is listening at http://127.0.0.1:${port}`);
});
