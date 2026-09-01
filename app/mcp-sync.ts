export type TranscriptCue = { time: number; text: string };

export type McpCourseSnapshot = {
  id: string;
  title: string;
  source: string;
  videoUrl: string;
  originPrompt: string;
  promptCredit: string;
  transcript: TranscriptCue[];
};

export type McpNoteSnapshot = {
  id: string;
  courseId: string;
  chapterId: string;
  chapterTitle: string;
  text: string;
  source: "text" | "voice";
  updatedAt: number;
  hasAudio: boolean;
};

const MCP_ORIGIN = import.meta.env.VITE_VIDMARK_LOCAL_ORIGIN || "http://127.0.0.1:31417";

export const syncMcpState = async (courses: McpCourseSnapshot[], notes: McpNoteSnapshot[], activeCourseId: string) => {
  try {
    await fetch(`${MCP_ORIGIN}/state/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courses, notes, activeCourseId }),
    });
  } catch {
    // The browser UI remains fully local and usable when the MCP process is not running.
  }
};

export const VIDMARK_MCP_URL = `${MCP_ORIGIN}/mcp`;
