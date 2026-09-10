import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugLog } from "../scripts/debug-log";

test("debug logging is opt-in, persists, and stops recording when disabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "vidmark-debug-test-"));
  try {
    const debug = new DebugLog(directory);
    debug.record("build.started");
    expect(debug.entries()).toEqual([]);
    debug.setEnabled(true);
    debug.record("model.finished", 2, 123);
    expect(new DebugLog(directory).state.enabled).toBe(true);
    expect(debug.entries().at(-1)).toMatchObject({ event: "model.finished", turn: 2, durationMs: 123 });
    expect(Object.keys(debug.entries().at(-1)).sort()).toEqual(["durationMs", "event", "time", "turn"]);
    debug.outcome("build-123", "fetch_url", false);
    expect(debug.entries().at(-1)).toMatchObject({ event: "tool.outcome", buildId: "build-123", tool: "fetch_url", ok: false });
    debug.outcome("secret token", "run_subagent", true, "a".repeat(64));
    expect(debug.entries().at(-1)).toMatchObject({ buildId: "unknown", contentHash: "a".repeat(64) });
    const before = readFileSync(debug.path, "utf8");
    debug.setEnabled(false);
    debug.record("build.failed");
    debug.outcome("build-123", "save_course_build", false);
    expect(readFileSync(debug.path, "utf8")).toBe(before);
    expect(new DebugLog(directory).state.enabled).toBe(false);
    expect(statSync(debug.path).mode & 0o777).toBe(0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
