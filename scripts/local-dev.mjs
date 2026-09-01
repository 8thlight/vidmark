import { spawn } from "node:child_process";
import { join } from "node:path";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const worker = spawn(join(process.cwd(), ".venv", "bin", "python"), ["scripts/whisper-worker.py"], {
  stdio: "inherit",
  env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}`, HF_HUB_OFFLINE: "1" },
});
const transcription = spawn(process.execPath, ["scripts/transcription-server.mjs"], { stdio: "inherit" });
const noteStorage = spawn(join(process.cwd(), ".tools", "bun", "bin", "bun"), ["scripts/note-storage-dev.ts"], { stdio: "inherit" });
const app = spawn(command, ["exec", "vinext", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

const stop = () => {
  worker.kill("SIGTERM");
  transcription.kill("SIGTERM");
  noteStorage.kill("SIGTERM");
  app.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => { worker.kill("SIGTERM"); transcription.kill("SIGTERM"); noteStorage.kill("SIGTERM"); process.exit(code ?? 0); });
