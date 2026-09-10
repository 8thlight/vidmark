// This allowlist is only for the per-build, course-scoped MCP server.
// Never apply it to the full learner MCP endpoint.
export const courseAgentToolNames = ["get_course", "get_transcript", "acquire_course_transcript", "fetch_url", "set_course_build_requirements", "save_course_build", "get_course_question", "list_course_questions", "upsert_course_question", "record_question_review"] as const;
