"use client";

import { useState } from "react";
import { Server } from "lucide-react";
import type { AgentPreferences, CliHarness, HarnessStatus } from "./agent-harness";

function CliModelPicker({ harness, model, disabled, onChange }: { harness: HarnessStatus; model: string; disabled: boolean; onChange: (model: string) => void }) {
  const [custom, setCustom] = useState(false);
  const isCustom = custom || Boolean(model && !harness.models.some(m => m.id === model));
  return <label className="harness-model"><span>Model</span>
    <select aria-label="Agent model" disabled={disabled} value={isCustom ? "__custom__" : model} onChange={event => {
      const value = event.target.value;
      setCustom(value === "__custom__");
      onChange(value === "__custom__" ? "" : value);
    }}>
      <option value="">Automatic · {harness.models.find(m => m.isDefault)?.label ?? "current provider default"}</option>
      {harness.models.map(m => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? " · recommended by CLI" : ""}</option>)}
      <option value="__custom__">Enter a model ID…</option>
    </select>
    {isCustom && <input aria-label="Custom agent model ID" disabled={disabled} value={model} onChange={event => onChange(event.target.value)} placeholder="Exact model ID · blank follows provider default" spellCheck={false} />}
    <small>{harness.modelError || "Automatic follows the provider’s current recommended model at each run. Choose a model to pin it. Availability depends on your account."}</small>
  </label>;
}

export function AgentHarnessPicker({ preferences, harnesses, loading, disabled, onChange, onRefresh }: {
  preferences: AgentPreferences; harnesses: HarnessStatus[]; loading: boolean; disabled: boolean;
  onChange: (preferences: AgentPreferences) => void; onRefresh: () => void;
}) {
  const selected = harnesses.find(h => h.id === preferences.harness);
  const cli = preferences.harness !== "provider" ? preferences.harness as CliHarness : null;
  return <div className="agent-harness-picker">
    <div className="harness-picker-heading"><b>Course agent</b><button type="button" onClick={onRefresh} disabled={loading || disabled}>{loading ? "Checking CLIs…" : "Refresh detection"}</button></div>
    <fieldset className="agent-provider-radios" disabled={disabled}><legend>Provider</legend>
      {(["codex", "claude", "provider"] as const).map(id => {
        const status = harnesses.find(h => h.id === id);
        const label = id === "codex" ? "OpenAI" : id === "claude" ? "Anthropic / Claude" : "In-app agent";
        const state = status?.status === "ready" ? "signed in" : status?.status === "signed_out" ? "sign in required" : status?.status === "not_installed" ? "not installed" : status?.status === "unavailable" ? "needs attention" : "checking";
        return <label key={id} className={`agent-provider-radio ${preferences.harness === id ? "selected" : ""}`}>
          <input type="radio" name="course-agent-provider" value={id} checked={preferences.harness === id} onChange={() => onChange({ ...preferences, harness: id })} />
          {id === "provider" ? <Server aria-hidden="true" /> : <img src={`/providers/${id === "codex" ? "openai" : "claude"}.svg`} alt="" />}
          <span><b>{label}</b><small>{id === "provider" ? "Local / OpenRouter" : `${id === "codex" ? "Codex CLI" : "Claude Code CLI"} · ${state}`}</small></span>
        </label>;
      })}
    </fieldset>
    {cli && selected ? <>
      <p className={`harness-detection ${selected.status}`} role="status">{selected.detail}</p>
      {selected.executable && <small className="harness-path">{selected.executable}</small>}
      <CliModelPicker key={cli} harness={selected} model={preferences.models[cli]} disabled={disabled || selected.status !== "ready"} onChange={model => onChange({ ...preferences, models: { ...preferences.models, [cli]: model } })} />
    </> : cli ? <p role="status">{loading ? "Looking for installed, signed-in CLIs…" : "Could not check this CLI. Refresh detection to retry."}</p> : <p>Use the optional in-app coordinator with your configured local host or OpenRouter connection.</p>}
    {cli && <p className="harness-privacy">Uses your existing CLI login and usage limits. Builds and fact checks send the selected material to this provider. Each run receives only its scoped MCP tools; global CLI settings are unchanged.</p>}
    <small>Choose Save preferences to apply these settings to builds and fact checks. Model choices are remembered per provider.</small>
  </div>;
}
