import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import * as z from "zod";
import type { AgentPreferences, CliHarness, HarnessModel, HarnessStatus } from "../app/agent-harness";
import { initialAgentPreferences } from "../app/agent-harness";
import { courseAgentToolNames } from "./course-agent-tools";
import { publicAgentMessage } from "../app/build-progress";

const modelId = z.string().trim().max(160).refine(value => !value || /^[\w./:@+-]+$/.test(value), "Enter a model ID, not command-line options.");
export const agentPreferencesSchema = z.object({ harness: z.enum(["codex", "claude", "provider"]), models: z.object({ codex: modelId, claude: modelId }) });
export async function readAgentPreferences(file: string): Promise<AgentPreferences> {
  try { return agentPreferencesSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { return structuredClone(initialAgentPreferences); }
}
export async function writeAgentPreferences(file: string, input: unknown) {
  const value = agentPreferencesSchema.parse(input);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${crypto.randomUUID()}.next`;
  await writeFile(next, JSON.stringify(value), { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, file);
  return value;
}

// A Finder-launched app normally has a minimal PATH. Search known install roots,
// without sourcing shell profiles or reading either CLI's credential files.
export async function cliSearchDirectories(home = homedir(), inheritedPath = process.env.PATH ?? "") {
  const dirs = [...inheritedPath.split(delimiter).filter(isAbsolute),
    join(home, ".local/bin"), join(home, ".claude/local"), join(home, ".npm-global/bin"),
    join(home, ".bun/bin"), join(home, ".volta/bin"), join(home, ".asdf/shims"),
    join(home, ".local/share/mise/shims"), join(home, "Library/pnpm"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    "/Applications/Codex.app/Contents/Resources", "/Applications/ChatGPT.app/Contents/Resources",
    join(home, "Applications/Codex.app/Contents/Resources"), join(home, "Applications/ChatGPT.app/Contents/Resources")];
  for (const root of [join(home, ".nvm/versions/node"), join(home, ".local/share/mise/installs/node")]) {
    try { for (const version of (await readdir(root)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 30)) dirs.push(join(root, version, "bin")); }
    catch { /* Optional installer. */ }
  }
  return [...new Set(dirs)];
}
export async function findCli(id: CliHarness, dirs?: string[]) {
  for (const dir of dirs ?? await cliSearchDirectories()) {
    const candidate = join(dir, id);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installer. */ }
  }
  return undefined;
}

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandOptions = { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal; onLine?: (line: string) => void };

const children = new Set<ChildProcessWithoutNullStreams>();
function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
}
process.once("exit", () => { for (const child of children) killTree(child, "SIGKILL"); });

export async function startCli(executable: string, args: string[], cwd = tmpdir()) {
  const dirs = await cliSearchDirectories();
  // The CLI authenticates itself. Never copy tokens into Vidmark settings/logs.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(executable), ...dirs].join(delimiter) };
  delete env.CLAUDECODE;
  delete env.VIDMARK_SESSION_TOKEN;
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: "pipe" });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

export async function runCli(executable: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error("Build cancelled.");
  const child = await startCli(executable, args, options.cwd);
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", pending = "", failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message); killTree(child);
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), 1000);
    };
    const abort = () => stop("Build cancelled. Previously saved artifacts are retained.");
    const timer = setTimeout(() => stop("The CLI timed out. Check its login and network connection, then retry."), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      // Keep only a bounded tail; verbose model output is not a diagnostic log.
      stdout = (stdout + text).slice(-128_000);
      if (options.onLine) {
        pending += text;
        if (pending.length > 8_000_000) { stop("The CLI returned an oversized event."); return; }
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try { options.onLine(line); } catch { stop("The CLI returned an invalid event."); }
        }
      }
    });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16_000); });
    child.stdin.on("error", () => { /* Early exit is handled below. */ });
    child.once("error", () => { failure = new Error("Could not start the installed CLI. Check its executable and runtime."); });
    child.once("close", code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      // Clean up children left behind by a CLI that exits before its workers.
      killTree(child, "SIGKILL");
      options.signal?.removeEventListener("abort", abort);
      if (pending.trim() && options.onLine && !failure) {
        try { options.onLine(pending); } catch { failure = new Error("The CLI returned an invalid event."); }
      }
      if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

// Metadata-only handshakes: neither sends a user turn or consumes model tokens.
export async function readCliModels(id: CliHarness, executable: string, signal?: AbortSignal): Promise<HarnessModel[]> {
  signal?.throwIfAborted();
  const args = id === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""];
  const child = await startCli(executable, args);
  return new Promise((resolve, reject) => {
    let buffer = "", done = false;
    const found: HarnessModel[] = [];
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); killTree(child, "SIGKILL");
      if (error) reject(error); else resolve([...new Map(found.map(m => [m.id, m])).values()]);
    };
    const timer = setTimeout(() => finish(new Error("Model discovery timed out. Use the CLI default or enter an exact model ID.")), 20_000);
    const abort = () => finish(new Error("Model discovery cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.once("error", () => finish(new Error("Model discovery could not start.")));
    child.once("close", () => finish(new Error("This CLI did not return a model catalog. Use its default or enter an exact model ID.")));
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 2_000_000) { finish(new Error("Model catalog was too large.")); return; }
      let end: number;
      while (!done && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Json; try { message = JSON.parse(line); } catch { continue; }
        if (id === "codex") {
          if (message.error) { finish(new Error("Model catalog unavailable. Use the CLI default or enter a model ID.")); return; }
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
          } else if (message.id === 2) {
            const result = object(message.result);
            for (const entry of Array.isArray(result.data) ? result.data : []) {
              const m = object(entry);
              if (typeof m.model === "string" && !m.hidden) found.push({ id: m.model, label: String(m.displayName || m.model), isDefault: m.isDefault === true });
            }
            if (typeof result.nextCursor === "string" && found.length < 1000) send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false, cursor: result.nextCursor } });
            else finish();
          }
        } else if (message.type === "control_response") {
          const envelope = object(message.response);
          if (envelope.request_id !== "vidmark-models") continue;
          if (envelope.subtype === "error") { finish(new Error("Model catalog unavailable. Use the CLI default or enter a model ID.")); return; }
          const response = object(envelope.response);
          for (const entry of Array.isArray(response.models) ? response.models : []) {
            const m = object(entry);
            if (typeof m.value === "string") found.push({ id: m.value, label: String(m.displayName || m.value) });
          }
          finish();
        }
      }
    });
    if (signal?.aborted) { abort(); return; }
    if (id === "codex") send({ id: 1, method: "initialize", params: { clientInfo: { name: "vidmark", title: "Vidmark", version: "1.4.0" } } });
    else send({ type: "control_request", request_id: "vidmark-models", request: { subtype: "initialize", hooks: {} } });
  });
}

export function authenticationState(id: CliHarness, result: CommandResult): HarnessStatus["status"] {
  if (id === "claude") {
    try {
      const auth = JSON.parse(result.stdout);
      if (auth.loggedIn === true && result.code === 0) return "ready";
      if (auth.loggedIn === false) return "signed_out";
    } catch { /* Old CLI or unexpected output is not evidence of login. */ }
  } else {
    const text = result.stdout + result.stderr;
    if (/not logged in|logged out/i.test(text)) return "signed_out";
    if (result.code === 0 && /logged in/i.test(text)) return "ready";
  }
  return "unavailable";
}

export const requiredCliFlags = {
  codex: ["--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "--sandbox", "--config", "--model"],
  claude: ["--print", "--output-format", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--settings", "--mcp-config", "--tools", "--allowedTools", "--permission-mode", "--max-turns", "--model"],
};
export async function discoverHarness(id: CliHarness, dependencies = { findCli, runCli, readCliModels }, signal?: AbortSignal): Promise<HarnessStatus> {
  signal?.throwIfAborted();
  const label = id === "codex" ? "Codex CLI" : "Claude Code CLI";
  const executable = await dependencies.findCli(id);
  if (!executable) return { id, label, status: "not_installed", detail: `${label} was not found. Install the CLI, sign in from Terminal, then refresh.`, models: [] };
  const base = { id, label, executable, models: [] as HarnessModel[] };
  try {
    const auth = await dependencies.runCli(executable, id === "codex" ? ["login", "status"] : ["auth", "status"], { signal });
    signal?.throwIfAborted();
    const status = authenticationState(id, auth);
    if (status !== "ready") return { ...base, status, detail: status === "signed_out" ? `Sign in from Terminal with ${id === "codex" ? "codex login" : "claude auth login"}, then refresh.` : "Login could not be verified. Check the CLI in Terminal or update it, then refresh." };
    const help = await dependencies.runCli(executable, id === "codex" ? ["exec", "--help"] : ["--help"], { signal });
    signal?.throwIfAborted();
    const required = requiredCliFlags[id];
    if (help.code !== 0 || required.some(flag => !help.stdout.includes(flag))) return { ...base, status: "unavailable", detail: "Signed in, but this CLI needs an update for isolated course builds." };
    try {
      const models = await dependencies.readCliModels(id, executable, signal);
      signal?.throwIfAborted();
      return { ...base, status: "ready", detail: "Installed · signed in", models, ...(!models.length ? { modelError: "No model catalog returned. Use the CLI default or enter a model ID." } : {}) };
    } catch (error) { signal?.throwIfAborted(); return { ...base, status: "ready", detail: "Installed · signed in", modelError: error instanceof Error ? error.message : "Model catalog unavailable." }; }
  } catch { signal?.throwIfAborted(); return { ...base, status: "unavailable", detail: "The CLI login check timed out or could not run. Check it in Terminal, then refresh." }; }
}

export function resolveAgentModel(explicit: string, harness: HarnessStatus) {
  return modelId.parse(explicit || harness.models.find(model => model.isDefault)?.id || "");
}

export function courseCliArguments(id: CliHarness, model: string, mcpUrl: string, toolNames: readonly string[] = courseAgentToolNames, mode: "build" | "fact-check" = "build") {
  modelId.parse(model);
  const url = new URL(mcpUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Course agents require a loopback MCP endpoint.");
  if (id === "codex") return ["exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only",
    "-c", "approval_policy=\"never\"", "-c", "features.shell_tool=false", "-c", `web_search=${JSON.stringify(mode === "build" ? "live" : "disabled")}`,
    ...(mode === "fact-check" ? ["-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"] : []),
    "-c", `mcp_servers.vidmark.url=${JSON.stringify(mcpUrl)}`, "-c", "mcp_servers.vidmark.required=true",
    ...toolNames.filter(tool => /^[a-z_]+$/.test(tool)).flatMap(tool => ["-c", `mcp_servers.vidmark.tools.${tool}.approval_mode="approve"`]),
    ...(model ? ["--model", model] : []), "-"];
  return ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
    "--mcp-config", JSON.stringify({ mcpServers: { vidmark: { type: "http", url: mcpUrl } } }),
    "--tools", mode === "build" ? "Agent,WebSearch" : "", "--allowedTools", mode === "build" ? "mcp__vidmark__*,Agent,WebSearch" : toolNames.map(tool => `mcp__vidmark__${tool}`).join(","), "--permission-mode", "dontAsk", "--max-turns", "100",
    ...(model ? ["--model", model] : [])];
}

export function cliEventState(id: CliHarness, line: string): "progress" | "complete" | "failed" | undefined {
  let event: Json; try { event = JSON.parse(line); } catch { return; }
  if (id === "codex") {
    if (event.type === "turn.completed") return "complete";
    if (event.type === "turn.failed") return "failed";
    if (["item.started", "item.completed", "turn.started"].includes(String(event.type))) return "progress";
  } else {
    if (event.type === "result") return event.is_error || event.subtype !== "success" ? "failed" : "complete";
    if (["assistant", "system", "tool_progress"].includes(String(event.type))) return "progress";
  }
}

export function cliResultMessage(id: CliHarness, line: string): string | undefined {
  let event: Json; try { event = JSON.parse(line); } catch { return; }
  const item = object(event.item);
  let message = id === "codex" ? event.type === "item.completed" && item.type === "agent_message" ? item.text : event.type === "turn.failed" ? object(event.error).message : undefined : event.type === "result" ? event.result || (Array.isArray(event.errors) ? event.errors.join("\n") : undefined) : undefined;
  // Only top-level, public assistant text. Never show thinking or tool payloads.
  if (id === "claude" && event.type === "assistant" && !event.parent_tool_use_id) {
    const content = object(event.message).content;
    if (Array.isArray(content)) message = content.map(object).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
  }
  if (typeof message !== "string") return;
  // Transient UI feedback only, never a diagnostic payload or prompt instruction.
  return publicAgentMessage(message);
}
