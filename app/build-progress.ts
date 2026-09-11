export type BuildItem = { title: string; position?: number; total?: number };
export type BuildProgressReport = { message: string; chapter?: BuildItem; question?: BuildItem };
export type BuildProgress = {
  report?: BuildProgressReport;
  activity?: { label: string; chapter?: BuildItem; question?: BuildItem };
  stagedQuestions: number;
  savedChapters: number;
  savedQuestions: number;
  questionTarget?: number;
  saved: boolean;
};

// Public status text only. Never feed this back into the agent as instructions.
export function publicAgentMessage(message: string, limit = 6000) {
  return message.replace(/http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-zA-Z0-9-]+/g, "[temporary MCP endpoint]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, limit);
}
