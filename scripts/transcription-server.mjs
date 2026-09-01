import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const port = Number(process.env.VIDMARK_TRANSCRIPTION_PORT ?? 31415);
const whisperWorker = process.env.VIDMARK_WHISPER_WORKER ?? "http://127.0.0.1:31416";
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

const runTranscription = async (audioPath, locale) => {
  const language = locale.split(/[-_]/)[0] || "en";
  const response = await fetch(`${whisperWorker}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioPath, language }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok || !result.transcript) throw new Error(result.error ?? "Local transcription did not return text.");
  return result.transcript;
};

createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === "OPTIONS") return sendJson(response, 204, {}, origin);
  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, { ok: true, engine: "MLX Whisper Turbo (on-device)" }, origin);
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
    const transcript = await runTranscription(audioPath, locale);
    return sendJson(response, 200, { transcript }, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local transcription failed.";
    return sendJson(response, 500, {
      error: message,
    }, origin);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Vidmark local transcription is listening at http://127.0.0.1:${port}`);
});
