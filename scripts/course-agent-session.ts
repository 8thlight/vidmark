import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { VidmarkDatabase } from "./vidmark-db";
import { acquireYouTubeTranscript } from "./transcript-acquisition";
import { buildRequirementsSchema, chapterSchema, questionReviewSchema, questionSchema, validateQuestion } from "./course-artifacts";
import { composeCourseBuildPrompt } from "../app/course-prompts";
import { getSystemPrompt, type SystemPromptOverrides } from "../app/system-prompts";
import { courseAgentToolNames } from "./course-agent-tools";

const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// A capability endpoint for one build, not a proxy to the full learner MCP.
// It cannot share/publish, change profiles/settings, or modify another course.
export function createCourseAgentSession(store: VidmarkDatabase, courseId: string, overrides: SystemPromptOverrides, fetchResearch: (url: string) => Promise<unknown>, onTool: (name: string, ok: boolean) => void) {
  const course = store.getCourse(courseId);
  if (!course) throw new Error("Course not found.");
  let active = true, saved = false;
  const token = crypto.randomUUID();
  const ensureActive = () => { if (!active) throw new Error("This course build has ended."); };
  const prompt = `Current date: ${new Date().toISOString().slice(0, 10)}.\n\n${composeCourseBuildPrompt(String(course.title), courseId, String(course.coursePrompt), String(course.promptCredit), getSystemPrompt("courseBuilderMaster", overrides))}\n\n${getSystemPrompt("artifactContract", overrides)}\n\n${getSystemPrompt("cliCoordinator", overrides)}`;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "vidmark-course-build", version: "1.0.0" });
    const scope = { courseId: z.literal(courseId) };
    const tool = <T extends z.ZodRawShape>(name: typeof courseAgentToolNames[number], description: string, shape: T, action: (input: z.infer<z.ZodObject<T>>) => unknown | Promise<unknown>) => {
      server.registerTool(name, { description, inputSchema: z.object(shape) }, async input => {
        try { ensureActive(); const result = await action(input); ensureActive(); onTool(name, true); return textResult(result); }
        catch (error) { if (active) onTool(name, false); return { ...textResult({ error: error instanceof Error ? error.message : "Course operation failed." }), isError: true }; }
      });
    };
    tool("get_course", "Read this course's identity, requirements and saved artifacts. Transcript is paginated with get_transcript.", scope, () => {
      const current = store.getCourse(courseId)!;
      return { ...current, transcript: undefined, transcriptCues: current.transcript.length, questions: undefined, questionCount: current.questions.length, buildRequirements: store.getBuildRequirements(courseId) };
    });
    tool("get_transcript", "Read timestamped transcript pages. Continue until offset + cues.length reaches total.", { ...scope, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(250) }, ({ offset, limit }) => {
      const cues = store.getTranscript(courseId, undefined, 100000).cues;
      return { total: cues.length, offset, cues: cues.slice(offset, offset + limit) };
    });
    tool("acquire_course_transcript", "Acquire authorized public YouTube captions when the course has no transcript. Never fabricates missing captions.", scope, async () => {
      if (!course.videoUrl) throw new Error("This reading-based course does not need a transcript. Read sourceUrl instead.");
      const acquired = await acquireYouTubeTranscript(String(course.videoUrl));
      ensureActive(); store.replaceTranscript(courseId, acquired.cues);
      return { cues: acquired.cues.length, sourceUrl: acquired.sourceUrl, automaticallyGenerated: acquired.automaticallyGenerated };
    });
    tool("fetch_url", "Read a public source URL. Failed fetches are missing evidence, not evidence of a claim.", { url: z.string().url() }, async ({ url }) => { const result = await fetchResearch(url); ensureActive(); return result; });
    tool("set_course_build_requirements", "Record the user's requested question count and chapter coverage before writing. Use an empty object if unspecified. QA remains optional.", { ...scope, requirements: buildRequirementsSchema }, ({ requirements }) => store.setBuildRequirements(courseId, requirements));
    tool("save_course_build", "Atomically save the complete course: guide, research notes, chapters, question bank and graph. Use the exact question schema, including option rationales. Database validation rejects incomplete or inconsistent builds. QA is optional.", {
      ...scope, studyGuide: z.string().min(1), researchNotes: z.string().min(1), chapters: z.array(chapterSchema).min(1), questions: z.array(questionSchema).min(1), conceptGraph: z.record(z.string(), z.unknown()),
    }, input => {
      if (course.videoUrl && !store.getTranscript(courseId).cues.length) throw new Error("Acquire the video transcript before authoring artifacts.");
      const result = store.saveCourseBuild(courseId, input); saved = true; return result;
    });
    tool("get_course_question", "Read a saved question, content hash and current revision before review or editing.", { ...scope, questionId: z.string().min(1) }, ({ questionId }) => store.getQuestion(courseId, questionId));
    tool("list_course_questions", "Read the saved question bank with QA status in pages.", { ...scope, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }, input => store.listQuestions(courseId, input));
    tool("upsert_course_question", "Update a saved question after a complete build. Edits invalidate previous QA; expectedRevision prevents stale writes.", { ...scope, question: questionSchema, expectedRevision: z.number().int().min(1) }, ({ question, expectedRevision }) => {
      if (!saved) throw new Error("Save the complete course before revising individual questions.");
      const validated = validateQuestion(question);
      const current = store.getQuestion(courseId, validated.id);
      if (!current || current.revision !== expectedRevision) throw new Error("Question revision conflict. Read the latest question first.");
      // Validate the complete bank without weakening coverage/evidence constraints.
      const questions = store.listQuestions(courseId, { limit: 1000 }).questions.map(q => q.id === validated.id ? validated : q.payload);
      return store.saveCourseBuild(courseId, { questions });
    });
    tool("record_question_review", "Record optional agent QA for an exact saved revision and content hash after checking its evidence. This does not certify accuracy.", { ...scope, questionId: z.string().min(1), expectedRevision: z.number().int().min(1), review: questionReviewSchema }, ({ questionId, expectedRevision, review }) => store.reviewQuestion(courseId, questionId, expectedRevision, review, "mcp"));
    return server;
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, maxRequestBodySize: 16 * 1024 * 1024, fetch(request) {
    const host = request.headers.get("host")?.split(":")[0];
    if (!active || new URL(request.url).pathname !== `/mcp/${token}` || request.headers.has("origin") || host !== "127.0.0.1") return new Response("Not found", { status: 404 });
    return handler.fetch(request);
  } });
  return { prompt, url: `http://127.0.0.1:${server.port}/mcp/${token}`, get saved() { return saved; }, close() { active = false; server.stop(true); } };
}
