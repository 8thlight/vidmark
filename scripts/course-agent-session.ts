import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { VidmarkDatabase } from "./vidmark-db";
import { acquireYouTubeTranscript } from "./transcript-acquisition";
import { buildRequirementsSchema, chapterSchema, agentQuestionReviewSchema, questionSchema, validateQuestion } from "./course-artifacts";
import { composeCourseBuildPrompt } from "../app/course-prompts";
import { getSystemPrompt, type SystemPromptOverrides } from "../app/system-prompts";
import { courseAgentToolNames } from "./course-agent-tools";
import { CourseReviewEvidence } from "./course-review-evidence";
import { courseBuildRevision } from "./course-build-revision";
import { CourseBuildProgress, buildProgressDescription, buildProgressReportSchema } from "./build-progress";
import type { BuildProgress } from "../app/build-progress";

const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// A capability endpoint for one build, not a proxy to the full learner MCP.
// It cannot share/publish, change profiles/settings, or modify another course.
export function createCourseAgentSession(store: VidmarkDatabase, courseId: string, overrides: SystemPromptOverrides, fetchResearch: (url: string) => Promise<unknown>, onTool: (name: string, ok: boolean) => void, signal?: AbortSignal, dependencies = { acquireYouTubeTranscript }, onProgress: (progress: BuildProgress) => void = () => {}) {
  const course = store.getCourse(courseId);
  if (!course) throw new Error("Course not found.");
  const revision = courseBuildRevision(store, courseId);
  const progress = new CourseBuildProgress(onProgress);
  progress.requirements(store.getBuildRequirements(courseId).questionCount);
  let active = true, saved = false;
  const stagedQuestions = new Map<string, ReturnType<typeof validateQuestion>>();
  const evidence = new CourseReviewEvidence(id => store.getTranscript(id, undefined, 100000).cues);
  const token = crypto.randomUUID();
  const ensureActive = () => { signal?.throwIfAborted(); if (!active) throw new Error("This course build has ended."); };
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
    tool("report_build_progress", buildProgressDescription, { ...scope, ...buildProgressReportSchema.shape }, input => { progress.report(input); return { reported: true, savedToLibrary: false }; });
    tool("get_course", "Read this course's identity, requirements and saved artifacts. Transcript is paginated with get_transcript.", scope, () => {
      const current = store.getCourse(courseId)!;
      return { ...current, transcript: undefined, transcriptCues: current.transcript.length, questions: undefined, questionCount: store.listQuestions(courseId).total, buildRequirements: store.getBuildRequirements(courseId) };
    });
    tool("get_transcript", "Read timestamped transcript pages. Continue until offset + cues.length reaches total.", { ...scope, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(250) }, ({ offset, limit }) => {
      const cues = store.getTranscript(courseId, undefined, 100000).cues;
      const page = cues.slice(offset, offset + limit);
      return { total: cues.length, offset, cues: page, evidenceId: evidence.transcript(courseId, cues, offset, page.length) };
    });
    tool("acquire_course_transcript", "Acquire authorized public YouTube captions when the course has no transcript. Never fabricates missing captions.", scope, async () => {
      if (!course.videoUrl) throw new Error("This reading-based course does not need a transcript. Read sourceUrl instead.");
      const transcriptHash = store.transcriptHash(courseId);
      const acquired = await dependencies.acquireYouTubeTranscript(String(course.videoUrl), "en", signal);
      ensureActive(); revision.run(() => store.replaceTranscript(courseId, acquired.cues, transcriptHash));
      return { cues: acquired.cues.length, sourceUrl: acquired.sourceUrl, automaticallyGenerated: acquired.automaticallyGenerated };
    });
    tool("fetch_url", "Read a public source URL. Cite the returned evidenceId for QA. Failed fetches are missing evidence, not evidence of a claim.", { url: z.string().url() }, async ({ url }) => { const result = await fetchResearch(url); ensureActive(); evidence.fetched(url, result); return { ...result as object, evidenceId: url }; });
    tool("set_course_build_requirements", "Record the user's requested question count and chapter coverage before writing. Use an empty object if unspecified. QA remains optional.", { ...scope, requirements: buildRequirementsSchema }, ({ requirements }) => {
      const result = revision.run(() => store.setBuildRequirements(courseId, requirements));
      progress.requirements(requirements.questionCount); return result;
    });
    tool("save_course_build", "Atomically save the complete course: guide, research notes, chapters, question bank and graph. For large banks, stage questions one at a time with upsert_course_question, then omit questions here to commit the staged bank. Database validation still enforces the complete count and coverage. QA is optional.", {
      ...scope, studyGuide: z.string().min(1), researchNotes: z.string().min(1), chapters: z.array(chapterSchema).min(1), questions: z.array(questionSchema).min(1).optional(), conceptGraph: z.record(z.string(), z.unknown()),
    }, input => {
      if (course.videoUrl && !store.getTranscript(courseId).cues.length) throw new Error("Acquire the video transcript before authoring artifacts.");
      const questions = input.questions ?? [...stagedQuestions.values()];
      if (!questions.length) throw new Error("Supply or stage the complete question bank before saving.");
      const result = revision.run(() => store.saveCourseBuild(courseId, { ...input, questions }));
      saved = true; stagedQuestions.clear();
      progress.committed(store.getCourse(courseId)!.chapters.length, store.activeQuestionPayloads(courseId).length); return result;
    });
    tool("get_course_question", "Read a staged question, or a saved question with its content hash and revision. Only saved questions can receive QA.", { ...scope, questionId: z.string().min(1) }, ({ questionId }) => {
      const result = stagedQuestions.has(questionId) ? { staged: true, payload: stagedQuestions.get(questionId) } : evidence.readQuestion(store.getQuestion(courseId, questionId));
      const question = stagedQuestions.get(questionId) ?? store.getQuestion(courseId, questionId)?.payload;
      if (question) progress.question("Reading question", question);
      return result;
    });
    tool("list_course_questions", "Read the saved question bank with QA status in pages.", { ...scope, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }, input => store.listQuestions(courseId, input));
    tool("upsert_course_question", "Before the first complete save, stage one question in this build session without changing the library. Reuse its ID to revise it. Commit all staged questions by omitting questions in save_course_build. After saving, updates require expectedRevision and invalidate previous QA.", { ...scope, question: questionSchema, expectedRevision: z.number().int().min(1).optional() }, ({ question, expectedRevision }) => {
      const validated = validateQuestion(question);
      if (!saved) {
        if (!stagedQuestions.has(validated.id) && stagedQuestions.size >= 1000) throw new Error("A course build can stage at most 1000 questions.");
        stagedQuestions.set(validated.id, validated);
        progress.question("Question staged", validated, stagedQuestions.size);
        return { staged: true, questionId: validated.id, stagedCount: stagedQuestions.size, savedToLibrary: false };
      }
      const current = store.getQuestion(courseId, validated.id);
      if (!current || expectedRevision === undefined || current.revision !== expectedRevision) throw new Error("Question revision conflict. Read the latest question first.");
      // Validate the complete bank without weakening coverage/evidence constraints.
      const questions = store.activeQuestionPayloads(courseId).map(q => q.id === validated.id ? validated : q);
      const result = revision.run(() => store.saveCourseBuild(courseId, { questions }, { id: validated.id, expectedRevision }));
      progress.question("Question saved", validated); return result;
    });
    tool("record_question_review", "Record optional agent QA for an exact saved revision and content hash after checking its evidence. Attribution is agent-supplied; reviewer independence is not authenticated. Identify author self-reviews honestly. This does not certify accuracy.", { ...scope, questionId: z.string().min(1), expectedRevision: z.number().int().min(1), review: agentQuestionReviewSchema }, ({ questionId, expectedRevision, review }) => {
      if (stagedQuestions.has(questionId)) throw new Error("Commit staged questions before recording their QA.");
      const result = revision.run(() => store.reviewQuestion(courseId, questionId, expectedRevision, evidence.validate(questionId, expectedRevision, review), "mcp"));
      progress.question("Question review recorded", store.getQuestion(courseId, questionId)?.payload); return result;
    });
    return server;
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, maxRequestBodySize: 16 * 1024 * 1024, fetch(request) {
    const host = request.headers.get("host")?.split(":")[0];
    if (!active || new URL(request.url).pathname !== `/mcp/${token}` || request.headers.has("origin") || host !== "127.0.0.1") return new Response("Not found", { status: 404 });
    return handler.fetch(request);
  } });
  return { prompt, url: `http://127.0.0.1:${server.port}/mcp/${token}`, get saved() { return saved; }, close() { active = false; server.stop(true); } };
}
