import { afterAll, expect, test } from "bun:test";
import { mkdtemp, stat, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticationState, cliEventState, cliSearchDirectories, courseCliArguments, discoverHarness, findCli, readAgentPreferences, resolveAgentModel, runCli, writeAgentPreferences } from "../scripts/agent-harness";
import { createCourseAgentSession } from "../scripts/course-agent-session";
import { VidmarkDatabase, STARTER_COURSE_ID } from "../scripts/vidmark-db";
import { DebugLog } from "../scripts/debug-log";
import { runCliCourseBuild, type BuildJob } from "../scripts/cli-course-build";
import { startModelProviderServer } from "../scripts/model-provider";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentHarnessPicker } from "../app/agent-harness-picker";
import { describeAgentSelection, type AgentPreferences } from "../app/agent-harness";
import { AgentSelectionIndicator } from "../app/agent-selection";
import { courseAgentToolNames } from "../scripts/course-agent-tools";

const root = await mkdtemp(join(tmpdir(), "vidmark-harness-tests-"));
const db = new VidmarkDatabase(join(root, "test.sqlite"));
afterAll(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const preferences: AgentPreferences = { harness: "codex", models: { codex: "account-model", claude: "another-account-model" } };
const ready = { id: "codex" as const, label: "Codex CLI", status: "ready" as const, executable: "/test/codex", models: [], detail: "Installed · signed in" };
const fixture = { ...db.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!.payload, id: "q1", sectionId: "chapter", videoReferences: [], sources: [{ label: "Evidence", url: "https://example.com", accessedAt: "2026-09-10" }] };
const graph = { schemaVersion: "1.0.0", graphId: "test", title: "Test", nodes: [{ id: "topic", label: "Topic", kind: "domain", domainId: "topic", summary: "Test topic" }], edges: [] };
const artifacts = { studyGuide: "Study guide", researchNotes: "Source evidence", chapters: [{ id: "chapter", title: "Chapter", summary: "Summary" }], questions: [fixture], conceptGraph: graph };
const makeCourse = (id: string) => db.upsertCourse({ id, title: "Test course", sourceUrl: "https://example.com", originPrompt: "Build one question.", promptCredit: "QA" });

async function rpc(url: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }) });
  const body = await response.text();
  const message = JSON.parse(body.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? body);
  return message.result ?? message;
}

test("preferences migrate without changing local provider settings and remember each harness model", async () => {
  const file = join(root, "preferences.json");
  expect((await readAgentPreferences(file)).harness).toBe("provider");
  await writeAgentPreferences(file, preferences);
  expect(await readAgentPreferences(file)).toEqual(preferences);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await writeAgentPreferences(file, { ...preferences, harness: "claude" });
  expect((await readAgentPreferences(file)).models).toEqual(preferences.models);
  await expect(writeAgentPreferences(file, { ...preferences, models: { ...preferences.models, codex: "model; touch /tmp/no" } })).rejects.toThrow();
});

test("GUI discovery covers standard and version-managed installations without shell startup files", async () => {
  await mkdir(join(root, ".nvm/versions/node/v22/bin"), { recursive: true });
  const dirs = await cliSearchDirectories(root, "/usr/bin:.:relative/bin");
  expect(dirs).toContain(join(root, ".local/bin"));
  expect(dirs).toContain(join(root, ".nvm/versions/node/v22/bin"));
  expect(dirs).not.toContain(".");
  expect(await findCli("claude", [root])).toBeUndefined();
});

test("authentication distinguishes signed in, signed out and unrecognized output without exposing credentials", () => {
  const result = (code: number, stdout: string, stderr = "") => ({ code, stdout, stderr });
  expect(authenticationState("codex", result(0, "", "Logged in using ChatGPT"))).toBe("ready");
  expect(authenticationState("codex", result(1, "Not logged in"))).toBe("signed_out");
  expect(authenticationState("codex", result(0, "unknown"))).toBe("unavailable");
  expect(authenticationState("claude", result(0, '{"loggedIn":true,"email":"do-not-return@example.com"}'))).toBe("ready");
  expect(authenticationState("claude", result(1, '{"loggedIn":false}'))).toBe("signed_out");
  expect(authenticationState("claude", result(0, "old help"))).toBe("unavailable");
});

test("detection handles missing CLIs, old versions, failed login checks and model discovery failures", async () => {
  const dependencies = { findCli: async () => undefined as string | undefined, runCli: async () => ({ code: 0, stdout: "Logged in", stderr: "" }), readCliModels: async () => [{ id: "from-cli", label: "From CLI" }] };
  expect((await discoverHarness("codex", dependencies)).status).toBe("not_installed");
  dependencies.findCli = async () => "/test/codex";
  expect((await discoverHarness("codex", dependencies)).status).toBe("unavailable");
  dependencies.runCli = async () => ({ code: 0, stdout: "Logged in --ignore-user-config --json --ephemeral", stderr: "" });
  expect((await discoverHarness("codex", dependencies)).models[0]?.id).toBe("from-cli");
  dependencies.readCliModels = async () => { throw new Error("Catalog offline"); };
  expect(await discoverHarness("codex", dependencies)).toMatchObject({ status: "ready", modelError: "Catalog offline" });
  dependencies.runCli = async () => { throw new Error("timeout"); };
  expect((await discoverHarness("codex", dependencies)).status).toBe("unavailable");
});

test("launch arguments isolate config, never bypass permissions, and pass the selected model as a single argument", () => {
  for (const id of ["codex", "claude"] as const) {
    const args = courseCliArguments(id, "chosen-model", "http://127.0.0.1:1234/mcp/run");
    expect(args[args.indexOf("--model") + 1]).toBe("chosen-model");
    expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
    if (id === "codex") expect(args.filter(a => a.endsWith('.approval_mode="approve"')).length).toBe(courseAgentToolNames.length);
    expect(courseCliArguments(id, "", "http://127.0.0.1:1234/mcp/run")).not.toContain("--model");
    expect(() => courseCliArguments(id, "bad\n--flag", "http://127.0.0.1:1234/mcp/run")).toThrow();
    expect(() => courseCliArguments(id, "", "https://example.com/mcp")).toThrow();
  }
});

test("CLI process handles input, split JSON events, failure, cancellation and timeout", async () => {
  const events: string[] = [];
  const result = await runCli(process.execPath, ["-e", 'process.stdin.resume(); process.stdin.on("end",()=>{process.stdout.write("one\\ntwo"); process.exitCode=3;});'], { input: "test", onLine: line => events.push(line) });
  expect(result.code).toBe(3); expect(events).toEqual(["one", "two"]);
  await expect(runCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 })).rejects.toThrow("timed out");
  const controller = new AbortController();
  const pending = runCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow("cancelled");
  expect(cliEventState("codex", '{"type":"turn.completed"}')).toBe("complete");
  expect(cliEventState("codex", '{"type":"turn.failed"}')).toBe("failed");
  expect(cliEventState("claude", '{"type":"result","subtype":"success","is_error":true}')).toBe("failed");
  expect(cliEventState("claude", '{"type":"result","subtype":"error_max_turns"}')).toBe("failed");
  expect(cliEventState("claude", '{"type":"result","subtype":"success"}')).toBe("complete");
});

test("course-scoped MCP rejects other courses, sharing and untrusted origins; validates real SQLite writes", async () => {
  makeCourse("scoped"); makeCourse("other");
  const session = createCourseAgentSession(db, "scoped", {}, async () => ({ ok: true }), () => {});
  try {
    await rpc(session.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const catalog = await rpc(session.url, "tools/list");
    expect(catalog.tools.map((t: { name: string }) => t.name).sort()).toEqual([...courseAgentToolNames].sort());
    expect(catalog.tools.some((t: { name: string }) => /share|publish|profile|settings/.test(t.name))).toBe(false);
    expect((await rpc(session.url, "tools/call", { name: "set_course_build_requirements", arguments: { courseId: "other", requirements: { questionCount: 1 } } })).isError).toBe(true);
    expect((await fetch(session.url, { headers: { Origin: "https://attacker.example" } })).status).toBe(404);
    await rpc(session.url, "tools/call", { name: "set_course_build_requirements", arguments: { courseId: "scoped", requirements: { questionCount: 1 } } });
    const invalid = await rpc(session.url, "tools/call", { name: "save_course_build", arguments: { ...artifacts, courseId: "scoped", questions: [] } });
    expect(invalid.isError).toBe(true); expect(session.saved).toBe(false);
    const saved = await rpc(session.url, "tools/call", { name: "save_course_build", arguments: { ...artifacts, courseId: "scoped" } });
    expect(saved.isError).not.toBe(true); expect(session.saved).toBe(true);
    expect(db.getCourse("scoped")?.questions.length).toBe(1);
    expect(db.getCourse("other")?.questions.length).toBe(0);
    expect(db.getQuestion("scoped", "q1")?.qaReview).toBeNull();
  } finally { session.close(); }
});

test("CLI coordinator requires BOTH a successful process result and a complete MCP save", async () => {
  const debug = new DebugLog(join(root, "Diagnostics")); debug.setEnabled(true);
  for (const mode of ["no-save", "saved", "failed"] as const) {
    makeCourse(mode);
    const job: BuildJob = { id: mode, courseId: mode, status: "queued", phase: "", message: "", startedAt: Date.now(), updatedAt: Date.now() };
    await runCliCourseBuild(job, preferences, db.path, join(root, "prompts.json"), debug, new AbortController().signal, async () => ({ ok: true }), {
      discoverHarness: async () => ready,
      runCli: async (_exe, args, options) => {
        const config = args.find(a => a.startsWith("mcp_servers.vidmark.url="))!;
        const url = JSON.parse(config.slice(config.indexOf("=") + 1));
        if (mode !== "no-save") {
          await rpc(url, "tools/call", { name: "set_course_build_requirements", arguments: { courseId: mode, requirements: { questionCount: 1 } } });
          const result = await rpc(url, "tools/call", { name: "save_course_build", arguments: { ...artifacts, courseId: mode } });
          expect(result.isError).not.toBe(true);
        }
        options?.onLine?.(JSON.stringify({ type: mode === "failed" ? "turn.failed" : "turn.completed" }));
        return { code: mode === "failed" ? 1 : 0, stdout: "", stderr: "secret should never reach logs" };
      },
    });
    expect(job.status).toBe(mode === "saved" ? "complete" : "failed");
  }
  expect(JSON.stringify(debug.entries())).not.toContain("secret");
  expect(debug.entries().some(e => e.event === "build.complete")).toBe(true);
});

test("large CLI banks can be staged incrementally and committed atomically with full validation", async () => {
  makeCourse("staged");
  const session = createCourseAgentSession(db, "staged", {}, async () => ({ ok: true }), () => {});
  const call = (name: string, args: Record<string, unknown>) => rpc(session.url, "tools/call", { name, arguments: { courseId: "staged", ...args } });
  const smallArtifacts = { studyGuide: artifacts.studyGuide, researchNotes: artifacts.researchNotes, chapters: artifacts.chapters, conceptGraph: artifacts.conceptGraph };
  try {
    await call("set_course_build_requirements", { requirements: { questionCount: 2 } });
    expect((await call("upsert_course_question", { question: fixture })).isError).not.toBe(true);
    expect(db.listQuestions("staged").total).toBe(0);
    expect((await call("save_course_build", smallArtifacts)).isError).toBe(true);
    expect(db.getCourse("staged")?.chapters.length).toBe(0);
    expect(session.saved).toBe(false);
    await call("upsert_course_question", { question: { ...fixture, id: "q2", question: "A distinct second question?" } });
    expect((await call("save_course_build", smallArtifacts)).isError).not.toBe(true);
    expect(session.saved).toBe(true);
    expect(db.listQuestions("staged").total).toBe(2);
    expect(db.getQuestion("staged", "q1")?.qaReview).toBeNull();
    expect((await call("upsert_course_question", { question: fixture })).isError).toBe(true);
  } finally { session.close(); }
  makeCourse("cancel-staged");
  const cancelled = createCourseAgentSession(db, "cancel-staged", {}, async () => ({ ok: true }), () => {});
  await rpc(cancelled.url, "tools/call", { name: "upsert_course_question", arguments: { courseId: "cancel-staged", question: fixture } });
  cancelled.close();
  expect(db.listQuestions("cancel-staged").total).toBe(0);
});

test("settings API round trips preferences, rejects foreign origins and recovers active build status", async () => {
  const provider = startModelProviderServer(join(root, "provider.json"), db.path, join(root, "prompts.json"), 0);
  const url = `http://127.0.0.1:${provider.port}`;
  try {
    expect((await (await fetch(`${url}/agent-settings`)).json()).harness).toBe("provider");
    expect(await (await fetch(`${url}/agent-selection`)).json()).toEqual({ harness: "provider", provider: "Local", model: "Not selected", automatic: false, detail: "Configure a connection in Settings" });
    expect((await fetch(`${url}/agent-selection`, { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
    const put = await fetch(`${url}/agent-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
    expect(await put.json()).toEqual(preferences);
    expect(await (await fetch(`${url}/agent-settings`)).json()).toEqual(preferences);
    expect((await fetch(`${url}/agent-settings`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://foreign.example" }, body: JSON.stringify(preferences) })).status).toBe(403);
    expect(await (await fetch(`${url}/build?courseId=unknown`)).json()).toEqual({ job: null });
  } finally { provider.stop(true); }
});

test("shared picker renders account-driven models and truthful install state", () => {
  const html = renderToStaticMarkup(createElement(AgentHarnessPicker, { preferences, harnesses: [{ ...ready, models: [{ id: "account-model", label: "Account model" }] }, { id: "claude", label: "Claude Code CLI", status: "not_installed", detail: "Not found", models: [] }], loading: false, disabled: false, onChange: () => {}, onRefresh: () => {} }));
  expect(html).toContain("<legend>Provider</legend>"); expect(html).not.toContain("Agent harness"); expect(html).toContain("Agent model");
  expect(html).toContain("Account model"); expect(html).toContain("not installed");
  expect(html).toContain("Automatic"); expect(html).toContain("existing CLI login and usage limits");
  expect(html.match(/type="radio"/g)?.length).toBe(3);
  expect(html).toContain("/providers/openai.svg"); expect(html).toContain("/providers/claude.svg");
});

test("automatic model follows fresh provider metadata while explicit choices remain pinned", () => {
  const harness = { ...ready, models: [{ id: "new-recommendation", label: "Latest recommendation", isDefault: true }] };
  expect(resolveAgentModel("", harness)).toBe("new-recommendation");
  expect(resolveAgentModel("pinned", harness)).toBe("pinned");
  expect(resolveAgentModel("", ready)).toBe("");
});

test("sidebar summary reflects saved explicit, automatic, unavailable and in-app selections", () => {
  const local = { provider: "local", model: "local-model", configured: true };
  const harness = { ...ready, models: [{ id: "current", label: "Current model", isDefault: true }] };
  const automatic = describeAgentSelection({ ...preferences, models: { ...preferences.models, codex: "" } }, [harness], local);
  expect(automatic).toMatchObject({ provider: "OpenAI", model: "Current model", automatic: true, detail: "Codex CLI" });
  expect(describeAgentSelection(preferences, [harness], local).model).toBe("account-model");
  expect(describeAgentSelection({ ...preferences, harness: "claude" }, [{ id: "claude", label: "Claude Code CLI", status: "not_installed", detail: "Not found", models: [] }], local)).toMatchObject({ provider: "Claude", model: "another-account-model", detail: "CLI not installed" });
  expect(describeAgentSelection({ ...preferences, harness: "provider" }, [], { ...local, provider: "openrouter" })).toMatchObject({ provider: "OpenRouter", model: "local-model", automatic: false });
  expect(describeAgentSelection({ ...preferences, models: { ...preferences.models, codex: "" } }, [ready], local).model).toBe("Provider default");
  const html = renderToStaticMarkup(createElement(AgentSelectionIndicator, { selection: automatic, onSettings: () => {} }));
  expect(html).toContain("OpenAI"); expect(html).toContain("Current model"); expect(html).toContain("automatic"); expect(html).toContain("Open Settings");
  expect(html).toContain("/providers/openai.svg"); expect(html).not.toContain("/test/codex");
  const failed = renderToStaticMarkup(createElement(AgentSelectionIndicator, { selection: null, onSettings: () => {} }));
  expect(failed).toContain("Unavailable"); expect(failed).not.toContain("Local");
});
