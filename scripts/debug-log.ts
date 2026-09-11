import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DebugLog {
  readonly path: string;
  private readonly settingsPath: string;
  private enabled = false;
  constructor(private directory: string) {
    this.path = join(directory, "debug.jsonl");
    this.settingsPath = join(directory, "debug-settings.json");
    try { this.enabled = JSON.parse(readFileSync(this.settingsPath, "utf8")).enabled === true; } catch { /* Opt-in only. */ }
  }
  get state() { return { enabled: this.enabled, logPath: this.path }; }
  setEnabled(enabled: boolean) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.settingsPath, JSON.stringify({ enabled }), { mode: 0o600 });
    this.enabled = enabled;
    this.record("debug.enabled");
    return this.state;
  }
  // No free-form payloads: logs cannot contain prompts, credentials, or model output.
  record(event: "debug.enabled" | "build.started" | "model.started" | "model.finished" | "tool.started" | "tool.finished" | "build.complete" | "build.failed" | "fact-check.started" | "fact-check.complete" | "fact-check.failed", turn?: number, durationMs?: number, tool?: string) {
    if (!this.enabled) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (existsSync(this.path) && statSync(this.path).size > 1_000_000) renameSync(this.path, `${this.path}.previous`);
      const safeTool = tool && ["get_course", "get_transcript", "acquire_course_transcript", "fetch_url", "run_subagent", "report_build_progress", "save_course_build", "set_course_build_requirements", "get_course_question", "upsert_course_question", "record_question_review", "record_fact_check"].includes(tool) ? tool : undefined;
      appendFileSync(this.path, JSON.stringify({ time: new Date().toISOString(), event, ...(turn === undefined ? {} : { turn }), ...(durationMs === undefined ? {} : { durationMs }), ...(safeTool ? { tool: safeTool } : {}) }) + "\n", { mode: 0o600 });
    } catch { /* Diagnostics must not interrupt a course build. */ }
  }
  outcome(buildId: string, tool: "fetch_url" | "run_subagent" | "save_course_build" | "record_fact_check", ok: boolean, digest?: string) {
    if (!this.enabled) return;
    try {
      // Fixed metadata only: no provider payloads, credentials, source URLs or prompt text.
      const entry = { time: new Date().toISOString(), event: "tool.outcome", buildId: /^[a-zA-Z0-9-]{1,80}$/.test(buildId) ? buildId : "unknown", tool, ok, ...(digest && /^[a-f0-9]{64}$/.test(digest) ? { contentHash: digest } : {}) };
      if (existsSync(this.path) && statSync(this.path).size > 1_000_000) renameSync(this.path, `${this.path}.previous`);
      appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch { /* Logging cannot interrupt the build. */ }
  }
  entries() {
    try { return readFileSync(this.path, "utf8").trim().split("\n").filter(Boolean).slice(-100).map(line => JSON.parse(line)); } catch { return []; }
  }
}
