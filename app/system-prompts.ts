import { vidmarkMasterCourseBuildPrompt } from "./course-prompts";

export const systemPromptIds = [
  "courseBuilderMaster",
  "coordinatorRuntime",
  "coordinatorContinue",
  "specialist",
  "connectionProbe",
] as const;

export type SystemPromptId = (typeof systemPromptIds)[number];
export type SystemPromptOverrides = Partial<Record<SystemPromptId, string>>;
export type SystemPromptSetting = {
  id: SystemPromptId;
  title: string;
  description: string;
  defaultValue: string;
  effectiveValue: string;
  overridden: boolean;
  variables: string[];
};

type SystemPromptDefinition = Omit<SystemPromptSetting, "effectiveValue" | "overridden">;

export const systemPromptDefinitions: readonly SystemPromptDefinition[] = [
  {
    id: "courseBuilderMaster",
    title: "Course-builder master",
    description: "Global evidence, assessment, delegation, and honesty requirements used by in-app builds and the build_vidmark_course MCP prompt.",
    defaultValue: vidmarkMasterCourseBuildPrompt,
    variables: [],
  },
  {
    id: "coordinatorRuntime",
    title: "In-app coordinator runtime",
    description: "Additional instructions appended when Vidmark runs the course-building coordinator through the configured model provider.",
    defaultValue: "You are running inside Vidmark. Check the transcript first. If it has no cues, call acquire_course_transcript to retrieve and save the video's public timestamped captions before delegating course work. Then use the supplied tools to inspect the transcript, delegate bounded work, verify sources, and save the completed course. Do not stop at a plan: call save_course_build after independent QA.",
    variables: [],
  },
  {
    id: "coordinatorContinue",
    title: "Coordinator continuation",
    description: "Sent when the coordinator replies without using a tool before the course build has been saved.",
    defaultValue: "Continue the build. If the transcript is still missing, call acquire_course_transcript before creating course artifacts. Use the available tools and call save_course_build only after the artifacts pass QA.",
    variables: [],
  },
  {
    id: "specialist",
    title: "Specialist system prompt",
    description: "System instruction for each bounded specialist model context. Keep the {{role}} placeholder so Vidmark can identify its assigned specialty.",
    defaultValue: "You are the {{role}} specialist in a Vidmark course build. Work only on the bounded task. Return evidence-rich work for the coordinator; never claim actions you did not perform.",
    variables: ["role"],
  },
  {
    id: "connectionProbe",
    title: "Model connection probe",
    description: "Instruction used by Save & test to verify that the selected model supports required tool calls.",
    defaultValue: "Call confirm_vidmark_connection with ready=true. Do not answer in prose.",
    variables: [],
  },
] as const;

const promptDefinitionById = new Map(systemPromptDefinitions.map((definition) => [definition.id, definition]));

export const normalizeSystemPromptOverrides = (value: unknown): SystemPromptOverrides => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const overrides: SystemPromptOverrides = {};
  for (const id of systemPromptIds) {
    const prompt = input[id];
    if (typeof prompt === "string" && prompt.trim()) overrides[id] = prompt.trim();
  }
  return overrides;
};

export const listSystemPromptSettings = (overrides: SystemPromptOverrides = {}): SystemPromptSetting[] => systemPromptDefinitions.map((definition) => ({
  ...definition,
  effectiveValue: overrides[definition.id] ?? definition.defaultValue,
  overridden: Boolean(overrides[definition.id]),
}));

export const getSystemPrompt = (id: SystemPromptId, overrides: SystemPromptOverrides = {}) => overrides[id] ?? promptDefinitionById.get(id)?.defaultValue ?? "";

export const renderSystemPrompt = (id: SystemPromptId, overrides: SystemPromptOverrides = {}, variables: Record<string, string> = {}) => {
  let prompt = getSystemPrompt(id, overrides);
  for (const [name, replacement] of Object.entries(variables)) prompt = prompt.replaceAll(`{{${name}}}`, replacement);
  return prompt;
};
