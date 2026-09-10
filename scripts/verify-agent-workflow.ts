import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VidmarkDatabase } from "./vidmark-db";

const root = await mkdtemp(join(tmpdir(), "vidmark-agent-workflow-"));
const port = 33427;
const origin = `http://127.0.0.1:${port}`;
process.env.VIDMARK_MCP_PORT = String(port);
process.env.VIDMARK_ALLOWED_ORIGINS = "http://127.0.0.1:3010";

const { startVidmarkMcpServer } = await import("./vidmark-mcp");
const { startModelProviderServer } = await import("./model-provider");
const service = await startVidmarkMcpServer(join(root, "alice.sqlite"));
const fakeModel = Bun.serve({ hostname: "127.0.0.1", port: 33428, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "vidmark-fake-agent" }] });
  if (url.pathname === "/v1/chat/completions") {
    const input = await request.json() as { tools?: Array<{ function?: { name?: string } }> };
    const toolName = input.tools?.find((tool) => tool.function?.name === "save_course_build") ? "save_course_build" : "confirm_vidmark_connection";
    const argumentsJson = toolName === "save_course_build" ? JSON.stringify({
      studyGuide: "The in-app coordinator saved this course directly to SQLite.",
      researchNotes: "Verified with a deterministic OpenAI-compatible model fixture.",
      chapters: [{ id: "workflow", title: "Agent workflow", start: 0, summary: "Create, build, and share a SQLite-backed course.", tags: ["mcp", "sharing"] }],
      questions: [{ id: "workflow-001", sectionId: "workflow", domainId: "tools", difficulty: "foundational", mode: "standard", scenario: "A learner wants Claude to build a course.", question: "Which integration should it use?", options: { A: { text: "Local MCP", rationale: "Correct." }, B: { text: "Relay DB", rationale: "Incorrect." }, C: { text: "Iframe", rationale: "Incorrect." }, D: { text: "Legacy JSON", rationale: "Incorrect." } }, correctAnswer: "A", grading: { temptingDistractor: "B", principle: "Use MCP.", missType: "judgment", hinge: "MCP exposes the tools." }, videoReferences: [], sources: [], tags: ["mcp"] }],
      conceptGraph: { schemaVersion: "1.0.0", graphId: "agent-workflow", title: "Agent workflow graph", nodes: [{ id: "workflow-domain", label: "Agent workflow", kind: "domain", domainId: "workflow", summary: "The workflow." }, { id: "mcp-concept", label: "Local MCP", kind: "concept", domainId: "workflow", summary: "Claude's Vidmark interface." }], edges: [{ source: "workflow-domain", target: "mcp-concept", type: "contains", weight: 1, rationale: "The workflow uses MCP." }] },
    }) : JSON.stringify({ ready: true });
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name: toolName, arguments: argumentsJson } }] } }] });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
} });
const provider = startModelProviderServer(join(root, "provider.json"), join(root, "alice.sqlite"), join(root, "system-prompts.json"));

const request = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}: ${await response.text()}`);
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error(`MCP ${method} returned no JSON-RPC event.`);
  const message = JSON.parse(data) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (message.error) throw new Error(message.error.message ?? `MCP ${method} failed.`);
  return message.result ?? {};
};

const toolText = (result: Record<string, unknown>) => {
  const block = (result.content as Array<{ type?: string; text?: string }> | undefined)?.find((item) => item.type === "text");
  return JSON.parse(block?.text ?? "null") as Record<string, unknown>;
};

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vidmark-agent-verifier", version: "1.0.0" } });
  const tools = await request("tools/list");
  const toolNames = new Set((tools.tools as Array<{ name: string }>).map((tool) => tool.name));
  for (const required of ["upsert_course", "replace_transcript", "acquire_course_transcript", "save_course_build", "share_course_with_user", "review_course_invite"]) {
    if (!toolNames.has(required)) throw new Error(`Required MCP tool ${required} is missing.`);
  }

  const courseId = "agntFlow001";
  const readingInput = { courseId: "reading-acceptance", title: "Reading exam", coursePrompt: "Create an original practice exam.", promptCredit: "Vidmark acceptance verifier" };
  const missingSource = await request("tools/call", { name: "upsert_course", arguments: readingInput });
  if (!missingSource.isError || service.store.getCourse(readingInput.courseId)) throw new Error("MCP accepted a new course without a source.");
  const unsupportedVideo = await request("tools/call", { name: "upsert_course", arguments: { ...readingInput, videoUrl: "https://example.com/video.mp4" } });
  if (!unsupportedVideo.isError) throw new Error("MCP accepted an unsupported primary video.");
  await request("tools/call", { name: "upsert_course", arguments: { ...readingInput, source: "Official resources", sourceUrl: "https://example.com/course" } });
  await request("tools/call", { name: "upsert_course", arguments: { ...readingInput, title: "Updated reading exam" } });
  const readingCourse = service.store.getCourse(readingInput.courseId);
  if (readingCourse?.source !== "Official resources" || readingCourse.sourceUrl !== "https://example.com/course" || readingCourse.videoUrl) throw new Error("Metadata-only MCP update did not preserve reading source fields.");
  await request("tools/call", { name: "upsert_course", arguments: { courseId, title: "Agent workflow acceptance course", source: "YouTube", videoUrl: `https://www.youtube.com/watch?v=${courseId}`, coursePrompt: "Build a concise employee course and delegate bounded chapter, assessment, graph, and QA tasks to subagents.", promptCredit: "Vidmark acceptance verifier" } });
  await request("tools/call", { name: "replace_transcript", arguments: { courseId, cues: [{ time: 0, text: "Vidmark stores each course in local SQLite." }, { time: 12, text: "Claude retrieves the course build prompt and delegates specialist work." }, { time: 26, text: "The completed course can be shared through the encrypted relay." }] } });

  const prompt = await request("prompts/get", { name: "build_vidmark_course", arguments: { courseId } });
  if (!JSON.stringify(prompt).includes("acquire_course_transcript")) throw new Error("The course build prompt did not instruct the agent to acquire a missing transcript.");
  const promptText = String(((prompt.messages as Array<{ content?: { text?: string } }>)[0]?.content?.text ?? ""));
  if (!promptText.includes(courseId) || !promptText.includes("subagents")) throw new Error("The MCP course-build prompt did not combine the selected course metadata and origin prompt.");

  const chapters = [{ id: "workflow", title: "Agent workflow", start: 0, summary: "Create, build, and share a SQLite-backed course.", tags: ["mcp", "sharing"] }];
  const questions = [{ id: "workflow-001", enabled: true, sectionId: "workflow", domainId: "tools", difficulty: "foundational", mode: "standard", scenario: "A learner has Vidmark open and wants Claude Code to build the imported course.", question: "What should Claude connect to?", options: { A: { text: "The local Vidmark MCP endpoint", rationale: "It exposes the course prompt and SQLite-backed tools." }, B: { text: "The public relay database", rationale: "The relay does not expose local course-authoring tools." }, C: { text: "The YouTube player iframe", rationale: "The iframe is not an agent tool." }, D: { text: "The legacy JSON file", rationale: "SQLite is the active data store." } }, correctAnswer: "A", grading: { temptingDistractor: "B", principle: "Use the local MCP boundary for agent actions.", missType: "judgment", hinge: "The course and write tools are local." }, videoReferences: [{ timestampSeconds: 12, label: "Claude orchestration" }], sources: [], tags: ["mcp"] }];
  const graph = { schemaVersion: "1.0.0", graphId: "agent-workflow", title: "Agent workflow graph", nodes: [{ id: "workflow-domain", label: "Agent workflow", kind: "domain", domainId: "workflow", summary: "The end-to-end workflow." }, { id: "mcp-concept", label: "Local MCP", kind: "concept", domainId: "workflow", summary: "Claude's interface to Vidmark." }], edges: [{ source: "workflow-domain", target: "mcp-concept", type: "contains", weight: 1, rationale: "The workflow uses local MCP." }] };
  const saved = toolText(await request("tools/call", { name: "save_course_build", arguments: { courseId, studyGuide: "Open Vidmark, import a transcript, connect Claude Code to local MCP, run the build prompt, then review and share the result.", researchNotes: "Acceptance artifact generated from the imported transcript.", chaptersJson: JSON.stringify(chapters), questionsJson: JSON.stringify(questions), conceptGraphJson: JSON.stringify(graph) } }));
  if (saved.saved !== courseId) throw new Error("The MCP build did not report a successful save.");

  const course = service.store.getCourse(courseId);
  if (!course?.studyGuide || course.chapters.length !== 1 || course.questions.length !== 1 || course.conceptGraph?.graphId !== "agent-workflow") throw new Error("The completed MCP build was not persisted as one complete SQLite course.");

  const providerSettings = await fetch("http://127.0.0.1:31418/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "local", baseUrl: "http://127.0.0.1:33428/v1", model: "vidmark-fake-agent" }) });
  if (!providerSettings.ok) throw new Error(`The in-app provider could not be configured: ${await providerSettings.text()}`);
  const started = await (await fetch("http://127.0.0.1:31418/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }) })).json() as { id: string };
  let job: { status?: string; error?: string } = {};
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = await (await fetch(`http://127.0.0.1:31418/build/${started.id}`)).json() as typeof job;
    if (job.status === "complete" || job.status === "failed") break;
    await Bun.sleep(20);
  }
  if (job.status !== "complete") throw new Error(`The in-app coordinator did not save the course: ${job.error ?? job.status ?? "unknown status"}`);
  const inAppCourse = service.store.getCourse(courseId);
  if (inAppCourse?.studyGuide !== "The in-app coordinator saved this course directly to SQLite." || inAppCourse.conceptGraph?.graphId !== "agent-workflow") throw new Error("The in-app coordinator did not persist its result to the shared SQLite database.");

  const bob = new VidmarkDatabase(join(root, "bob.sqlite"));
  bob.importCourseBundle(service.store.exportCourseBundle(courseId));
  const shared = bob.getCourse(courseId);
  if (!shared?.studyGuide || shared.questions.length !== 1 || shared.conceptGraph?.graphId !== "agent-workflow") throw new Error("The completed course did not survive a full-course share/import bundle.");
  bob.close();

  console.log(JSON.stringify({ ok: true, courseId, mcpTools: toolNames.size, transcriptCues: course.transcript.length, chapters: course.chapters.length, questions: course.questions.length, conceptGraphRevision: course.conceptGraphRevision, inAppCoordinatorSavedToSqlite: true, shareBundleImported: true }, null, 2));
} finally {
  provider.stop(true);
  fakeModel.stop(true);
  service.stop(true);
  await rm(root, { recursive: true, force: true });
}
