import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { composeCourseBuildPrompt } from "../app/course-prompts";

const MCP_PORT = 31417;

type TranscriptCue = { time: number; text: string };
type CourseRecord = {
  id: string;
  title: string;
  source: string;
  videoUrl: string;
  originPrompt: string;
  promptCredit: string;
  transcript: TranscriptCue[];
  studyGuide?: string;
  chapters?: unknown[];
  questions?: unknown[];
  researchNotes?: string;
  updatedAt: number;
};
type NoteRecord = { id: string; courseId: string; chapterId: string; chapterTitle: string; text: string; source: "text" | "voice"; updatedAt: number; hasAudio: boolean };
type VidmarkState = { activeCourseId: string; courses: CourseRecord[]; notes: NoteRecord[]; updatedAt: number };

const emptyState = (): VidmarkState => ({ activeCourseId: "", courses: [], notes: [], updatedAt: Date.now() });

export function startVidmarkMcpServer(statePath: string) {
  let updateQueue: Promise<unknown> = Promise.resolve();

  const readState = async (): Promise<VidmarkState> => {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<VidmarkState>;
      return { activeCourseId: parsed.activeCourseId ?? "", courses: Array.isArray(parsed.courses) ? parsed.courses : [], notes: Array.isArray(parsed.notes) ? parsed.notes : [], updatedAt: parsed.updatedAt ?? Date.now() };
    } catch { return emptyState(); }
  };

  const writeState = async (state: VidmarkState) => {
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.next`;
    await writeFile(temporaryPath, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf8");
    await rename(temporaryPath, statePath);
  };

  const updateState = async (update: (current: VidmarkState) => VidmarkState | Promise<VidmarkState>) => {
    let result = emptyState();
    updateQueue = updateQueue.then(async () => { result = await update(await readState()); await writeState(result); });
    await updateQueue;
    return result;
  };

  const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "vidmark-local", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.registerTool("list_courses", { description: "List every local Vidmark course, including its required course-prompt credit and artifact counts.", inputSchema: z.object({}) }, async () => {
      const state = await readState();
      return textResult(state.courses.map(({ transcript, chapters, questions, originPrompt, ...course }) => ({ ...course, promptExcerpt: originPrompt.slice(0, 240), transcriptCues: transcript.length, chapters: chapters?.length ?? 0, questions: questions?.length ?? 0, active: course.id === state.activeCourseId })));
    });

    server.registerTool("get_course", { description: "Read one course, its credited course-specific prompt, and generated artifacts. The build_vidmark_course MCP prompt combines this with Vidmark’s master instructions.", inputSchema: z.object({ courseId: z.string().min(1) }) }, async ({ courseId }) => {
      const course = (await readState()).courses.find((item) => item.id === courseId);
      if (!course) return textResult({ error: `Course ${courseId} was not found.` });
      const { originPrompt, ...details } = course;
      return textResult({ ...details, coursePrompt: originPrompt });
    });

    server.registerPrompt("build_vidmark_course", {
      title: "Build a Vidmark course",
      description: "Combine Vidmark’s master course-building prompt with the course’s required custom prompt.",
      argsSchema: z.object({ courseId: z.string().min(1).describe("Vidmark course ID from list_courses") }),
    }, async ({ courseId }) => {
      const course = (await readState()).courses.find((item) => item.id === courseId);
      const instruction = course
        ? composeCourseBuildPrompt(course.title, course.id, course.originPrompt, course.promptCredit)
        : `Course ${courseId} was not found. Call list_courses and choose a valid course ID before continuing.`;
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: instruction } }] };
    });

    server.registerTool("upsert_course", { description: "Create or update a course and its required credited course-specific prompt. Vidmark adds the master prompt automatically.", inputSchema: z.object({ courseId: z.string().min(1), title: z.string().min(1), source: z.string().default("YouTube"), videoUrl: z.string().url(), coursePrompt: z.string().min(1), promptCredit: z.string().min(1) }) }, async (input) => {
      const state = await updateState((current) => {
        const existing = current.courses.find((item) => item.id === input.courseId);
        const course: CourseRecord = { ...existing, id: input.courseId, title: input.title, source: input.source, videoUrl: input.videoUrl, originPrompt: input.coursePrompt, promptCredit: input.promptCredit, transcript: existing?.transcript ?? [], updatedAt: Date.now() };
        return { ...current, activeCourseId: current.activeCourseId || input.courseId, courses: [...current.courses.filter((item) => item.id !== input.courseId), course] };
      });
      return textResult({ saved: input.courseId, courses: state.courses.length });
    });

    server.registerTool("save_course_build", { description: "Save agent-researched course artifacts. chaptersJson and questionsJson must be JSON arrays; source citations belong inside each artifact.", inputSchema: z.object({ courseId: z.string().min(1), studyGuide: z.string().optional(), researchNotes: z.string().optional(), chaptersJson: z.string().optional(), questionsJson: z.string().optional() }) }, async ({ courseId, studyGuide, researchNotes, chaptersJson, questionsJson }) => {
      const parseArray = (value: string | undefined, label: string) => {
        if (!value) return undefined;
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
        return parsed;
      };
      const chapters = parseArray(chaptersJson, "chaptersJson");
      const questions = parseArray(questionsJson, "questionsJson");
      let found = false;
      await updateState((current) => ({ ...current, courses: current.courses.map((course) => {
        if (course.id !== courseId) return course;
        found = true;
        return { ...course, studyGuide: studyGuide ?? course.studyGuide, researchNotes: researchNotes ?? course.researchNotes, chapters: chapters ?? course.chapters, questions: questions ?? course.questions, updatedAt: Date.now() };
      }) }));
      return textResult(found ? { saved: courseId, chapters: chapters?.length, questions: questions?.length } : { error: `Course ${courseId} was not found.` });
    });

    server.registerTool("get_transcript", { description: "Read or search a course transcript with timestamps.", inputSchema: z.object({ courseId: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(1000).default(250) }) }, async ({ courseId, query, limit }) => {
      const course = (await readState()).courses.find((item) => item.id === courseId);
      if (!course) return textResult({ error: `Course ${courseId} was not found.` });
      const needle = query?.trim().toLowerCase();
      const cues = (needle ? course.transcript.filter((cue) => cue.text.toLowerCase().includes(needle)) : course.transcript).slice(0, limit);
      return textResult({ courseId, totalCues: course.transcript.length, returned: cues.length, cues });
    });

    server.registerTool("replace_transcript", { description: "Replace a course transcript with timestamped cues after authorized extraction or import.", inputSchema: z.object({ courseId: z.string().min(1), cues: z.array(z.object({ time: z.number().min(0), text: z.string().min(1) })).max(100000) }) }, async ({ courseId, cues }) => {
      let found = false;
      await updateState((current) => ({ ...current, courses: current.courses.map((course) => {
        if (course.id !== courseId) return course;
        found = true;
        return { ...course, transcript: cues, updatedAt: Date.now() };
      }) }));
      return textResult(found ? { saved: courseId, cues: cues.length } : { error: `Course ${courseId} was not found.` });
    });

    server.registerTool("list_notes", { description: "List text and voice-note transcripts, optionally filtered by course.", inputSchema: z.object({ courseId: z.string().optional(), query: z.string().optional() }) }, async ({ courseId, query }) => {
      const state = await readState();
      const needle = query?.trim().toLowerCase();
      const notes = state.notes.filter((note) => (!courseId || note.courseId === courseId) && (!needle || `${note.chapterTitle} ${note.text}`.toLowerCase().includes(needle)));
      return textResult({ count: notes.length, notes });
    });

    return server;
  });

  const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin");
    const allowed = origin === "http://127.0.0.1:3010" || origin === "http://localhost:3010" ? origin : "http://127.0.0.1:3010";
    return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name", "Access-Control-Expose-Headers": "Mcp-Session-Id" };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", port: MCP_PORT, idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = corsHeaders(request);
      const host = request.headers.get("host")?.split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return Response.json({ error: "Invalid Host header." }, { status: 403, headers });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (url.pathname === "/health") return Response.json({ ok: true, name: "vidmark-local", mcp: `http://127.0.0.1:${MCP_PORT}/mcp`, statePath }, { headers });
      if (url.pathname === "/state" && request.method === "GET") return Response.json(await readState(), { headers });
      if (url.pathname === "/state/sync" && request.method === "POST") {
        const incoming = await request.json() as Pick<VidmarkState, "activeCourseId" | "courses" | "notes">;
        const state = await updateState((current) => {
          const courses = (Array.isArray(incoming.courses) ? incoming.courses : []).map((course) => {
            const existing = current.courses.find((item) => item.id === course.id);
            return { ...existing, ...course, studyGuide: existing?.studyGuide, chapters: existing?.chapters, questions: existing?.questions, researchNotes: existing?.researchNotes, updatedAt: Date.now() };
          });
          return { ...current, activeCourseId: incoming.activeCourseId || current.activeCourseId, courses, notes: Array.isArray(incoming.notes) ? incoming.notes : current.notes };
        });
        return Response.json({ ok: true, courses: state.courses.length, notes: state.notes.length }, { headers });
      }
      if (url.pathname === "/mcp") {
        const response = await handler.fetch(request);
        const outgoing = new Headers(response.headers);
        Object.entries(headers).forEach(([key, value]) => outgoing.set(key, value));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
      }
      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  });

  console.log(`Vidmark MCP server is listening at http://127.0.0.1:${MCP_PORT}/mcp`);
  return server;
}
