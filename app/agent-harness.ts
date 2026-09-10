export type CliHarness = "codex" | "claude";
export type AgentHarness = CliHarness | "provider";
export type AgentPreferences = { harness: AgentHarness; models: Record<CliHarness, string> };
export type HarnessModel = { id: string; label: string; isDefault?: boolean };
export type HarnessStatus = {
  id: CliHarness;
  label: string;
  status: "ready" | "not_installed" | "signed_out" | "unavailable";
  detail: string;
  executable?: string;
  models: HarnessModel[];
  modelError?: string;
};
export const initialAgentPreferences: AgentPreferences = { harness: "provider", models: { codex: "", claude: "" } };

export type AgentSelection = {
  harness: AgentHarness;
  provider: string;
  model: string;
  automatic: boolean;
  detail: string;
};

// The summary uses saved preferences and the same CLI recommendation as a new run.
// No account credentials, local paths, or hard-coded model catalog are exposed.
export function describeAgentSelection(preferences: AgentPreferences, harnesses: HarnessStatus[], local: { provider: string; model: string; configured: boolean }): AgentSelection {
  if (preferences.harness === "provider") return {
    harness: "provider", provider: local.provider === "openrouter" ? "OpenRouter" : "Local",
    model: local.model || "Not selected", automatic: false,
    detail: local.configured ? "In-app agent" : "Configure a connection in Settings",
  };
  const id = preferences.harness;
  const status = harnesses.find(harness => harness.id === id);
  const explicit = preferences.models[id];
  const selected = explicit ? status?.models.find(model => model.id === explicit) : status?.models.find(model => model.isDefault);
  return {
    harness: id, provider: id === "codex" ? "OpenAI" : "Claude",
    model: selected?.label || explicit || "Provider default", automatic: !explicit,
    detail: status?.status === "ready" ? (id === "codex" ? "Codex CLI" : "Claude Code CLI")
      : status?.status === "signed_out" ? "Sign in required" : status?.status === "not_installed" ? "CLI not installed" : "CLI unavailable",
  };
}
