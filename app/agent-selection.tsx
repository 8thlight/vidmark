"use client";

import { useEffect, useState } from "react";
import { Server, Settings2 } from "lucide-react";
import type { AgentSelection } from "./agent-harness";

const PROVIDER_URL = import.meta.env.VITE_VIDMARK_PROVIDER_ORIGIN || "http://127.0.0.1:31418";
export const AGENT_SETTINGS_CHANGED = "vidmark:agent-settings-changed";

export function AgentSelectionIndicator({ selection, loading = false, onSettings }: { selection: AgentSelection | null; loading?: boolean; onSettings: () => void }) {
  const provider = selection?.provider ?? "Agent";
  const model = selection?.model ?? (loading ? "Loading…" : "Unavailable");
  const description = selection ? `${provider} · ${model}${selection.automatic ? " · automatic" : ""} · ${selection.detail}` : loading ? "Loading saved agent preferences" : "Agent preferences unavailable. Open Settings to retry.";
  return <button type="button" className="rail-agent" onClick={onSettings} aria-label={`Selected agent: ${description}. Open Settings`}>
    {selection?.harness === "codex" || selection?.harness === "claude" ? <img src={`/providers/${selection.harness === "codex" ? "openai" : "claude"}.svg`} alt="" /> : selection ? <Server aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
    <span className="rail-agent-provider">{provider}</span>
    <span className="rail-agent-model">{model}</span>
    <span className="rail-agent-detail" aria-hidden="true"><b>{provider}</b><span>{model}{selection?.automatic ? " · automatic" : ""}</span><small>{selection?.detail ?? (loading ? "Loading saved preferences…" : "Open Settings to retry")}</small></span>
  </button>;
}

export function SidebarAgentSelection({ onSettings }: { onSettings: () => void }) {
  const [selection, setSelection] = useState<AgentSelection | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const response = await fetch(`${PROVIDER_URL}/agent-selection`, { signal: current.signal });
        if (!response.ok) throw new Error("Agent preferences unavailable");
        const value = await response.json() as AgentSelection;
        if (active && !current.signal.aborted) setSelection(value);
      } catch {
        if (active && !current.signal.aborted) setSelection(null);
      } finally {
        if (active && !current.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    window.addEventListener(AGENT_SETTINGS_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => { active = false; controller?.abort(); window.removeEventListener(AGENT_SETTINGS_CHANGED, refresh); window.removeEventListener("focus", refresh); };
  }, []);
  return <AgentSelectionIndicator selection={selection} loading={loading} onSettings={onSettings} />;
}
