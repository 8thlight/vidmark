"use client";

import { CheckCircle2, KeyRound, LoaderCircle, RotateCcw, Server, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SystemPromptId, SystemPromptOverrides, SystemPromptSetting } from "./system-prompts";
import { getSystemPrompts, saveSystemPrompts } from "./vidmark-client";
import { AppPreferences } from "./app-preferences";
import { AgentHarnessPicker } from "./agent-harness-picker";
import { initialAgentPreferences, type AgentPreferences, type HarnessStatus } from "./agent-harness";
import { AGENT_SETTINGS_CHANGED } from "./agent-selection";

const PROVIDER_URL = import.meta.env.VITE_VIDMARK_PROVIDER_ORIGIN || "http://127.0.0.1:31418";

type ProviderKind = "local" | "openrouter";
type ProviderSettings = {
  configured: boolean;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  enableWebSearch: boolean;
  hasApiKey: boolean;
};

const initialSettings: ProviderSettings = { configured: false, provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "", enableWebSearch: false, hasApiKey: false };

const responseJson = async <T,>(response: Response): Promise<T> => {
  const payload = await response.json() as T & { error?: string; transcriptCues?: number };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with HTTP ${response.status}.`);
  return payload;
};

function SystemPromptEditor({ prompts, drafts, busy, status, onChange, onReset, onResetAll, onSave }: {
  prompts: SystemPromptSetting[];
  drafts: SystemPromptOverrides;
  busy: boolean;
  status: string;
  onChange: (id: SystemPromptId, value: string) => void;
  onReset: (prompt: SystemPromptSetting) => void;
  onResetAll: () => void;
  onSave: () => void;
}) {
  const hasBlankPrompt = prompts.some((prompt) => !(drafts[prompt.id] ?? "").trim());
  return <div className="system-prompts-view">
    <div className="system-prompts-intro"><SlidersHorizontal aria-hidden="true" /><div><h3>Local system prompt overrides</h3><p>These instructions affect only this Vidmark installation. They are not included in courses, shared with other users, or published to the global course.</p></div></div>
    <div className="system-prompt-list">
      {prompts.map((prompt, index) => {
        const value = drafts[prompt.id] ?? prompt.effectiveValue;
        const changed = value.trim() !== prompt.defaultValue.trim();
        return <details key={prompt.id} open={index === 0} className="system-prompt-card">
          <summary><span><b>{prompt.title}</b><small>{prompt.description}</small></span><em className={changed ? "overridden" : "default"}>{changed ? "Local override" : "Default"}</em></summary>
          <div className="system-prompt-editor">
            <textarea aria-label={`${prompt.title} prompt`} value={value} onChange={(event) => onChange(prompt.id, event.target.value)} spellCheck="false" />
            <div><small>{prompt.variables.length ? `Available template variables: ${prompt.variables.map((name) => `{{${name}}}`).join(", ")}` : "No template variables."}</small><button type="button" onClick={() => onReset(prompt)} disabled={!changed || busy}><RotateCcw aria-hidden="true" /> Reset prompt</button></div>
          </div>
        </details>;
      })}
    </div>
    <footer className="agent-provider-actions system-prompt-actions"><span role="status">{status}</span><div><button type="button" className="secondary" onClick={onResetAll} disabled={busy}><RotateCcw aria-hidden="true" /> Reset all</button><button type="button" onClick={onSave} disabled={busy || hasBlankPrompt}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />} Save local overrides</button></div></footer>
  </div>;
}

export function AgentProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<"settings" | "prompts" | "imports" | "debug">("settings");
  const [settings, setSettings] = useState(initialSettings);
  const [agent, setAgent] = useState(initialAgentPreferences);
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [prompts, setPrompts] = useState<SystemPromptSetting[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<SystemPromptOverrides>({});
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptStatus, setPromptStatus] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const [providerResult, promptResult, agentResult] = await Promise.allSettled([
        fetch(`${PROVIDER_URL}/settings`).then((response) => responseJson<ProviderSettings>(response)),
        getSystemPrompts(),
        fetch(`${PROVIDER_URL}/agent-settings`).then((response) => responseJson<AgentPreferences>(response)),
      ]);
      if (cancelled) return;
      if (agentResult.status === "fulfilled") { setAgent(agentResult.value); setPreferencesReady(true); }
      else { setPreferencesReady(false); setStatus("Agent preferences could not be loaded. Reopen Settings to retry."); }
      if (providerResult.status === "fulfilled") {
        const loaded = providerResult.value;
        setSettings(loaded);
        if (agentResult.status === "fulfilled") setStatus("");
        if (loaded.provider === "local" || loaded.configured) {
          try {
            const result = await responseJson<{ models: string[] }>(await fetch(`${PROVIDER_URL}/models`));
            if (!cancelled) setModels(result.models);
          } catch { /* A stopped optional local host must not block CLI builds. */ }
        }
      } else setStatus(providerResult.reason instanceof Error ? providerResult.reason.message : "The local model service is unavailable.");
      if (promptResult.status === "fulfilled") {
        setPrompts(promptResult.value.prompts);
        setPromptDrafts(Object.fromEntries(promptResult.value.prompts.map((prompt) => [prompt.id, prompt.effectiveValue])) as SystemPromptOverrides);
        setPromptStatus("");
      } else setPromptStatus(promptResult.reason instanceof Error ? promptResult.reason.message : "System prompts could not be loaded.");
    };
    void load();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(`${PROVIDER_URL}/harnesses`, { signal: controller.signal }).then(response => responseJson<{ harnesses: HarnessStatus[] }>(response)).then(result => { if (!controller.signal.aborted) setHarnesses(result.harnesses); }).catch(() => { if (!controller.signal.aborted) setStatus("CLI detection failed. Use Refresh detection to retry."); }).finally(() => { if (!controller.signal.aborted) setDiscovering(false); });
    return () => controller.abort();
  }, [open]);

  if (!open) return null;

  const refreshHarnesses = async () => {
    setDiscovering(true);
    try { setHarnesses((await responseJson<{ harnesses: HarnessStatus[] }>(await fetch(`${PROVIDER_URL}/harnesses?refresh=true`))).harnesses); }
    catch { setStatus("CLI detection failed. Check the local service and retry."); }
    finally { setDiscovering(false); window.dispatchEvent(new Event(AGENT_SETTINGS_CHANGED)); }
  };
  const saveAgent = async () => {
    const saved = await responseJson<AgentPreferences>(await fetch(`${PROVIDER_URL}/agent-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(agent) }));
    setAgent(saved); window.dispatchEvent(new Event(AGENT_SETTINGS_CHANGED)); return saved;
  };
  const saveAgentPreferences = async () => {
    setBusy(true);
    try { await saveAgent(); setStatus("Course agent preferences saved on this Mac."); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Preferences could not be saved."); }
    finally { setBusy(false); }
  };

  const saveAndTest = async () => {
    setBusy(true); setStatus("Saving the connection…");
    try {
      await saveAgent();
      const saved = await responseJson<ProviderSettings>(await fetch(`${PROVIDER_URL}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, apiKey }) }));
      setSettings(saved); window.dispatchEvent(new Event(AGENT_SETTINGS_CHANGED)); setApiKey(""); setStatus("Testing the selected model…");
      const tested = await responseJson<{ response: string }>(await fetch(`${PROVIDER_URL}/test`, { method: "POST" }));
      setStatus(tested.response || "Model connection ready.");
      setModels((await responseJson<{ models: string[] }>(await fetch(`${PROVIDER_URL}/models`))).models);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The model connection failed."); }
    finally { setBusy(false); }
  };

  const selectProvider = (provider: ProviderKind) => {
    setSettings((current) => ({ ...current, provider, configured: false, hasApiKey: false, baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:11434/v1", model: "", enableWebSearch: provider === "openrouter" }));
    setModels([]); setApiKey(""); setStatus("");
  };

  const savePromptOverrides = async () => {
    setPromptBusy(true); setPromptStatus("Saving local overrides…");
    try {
      const overrides = Object.fromEntries(prompts.flatMap((prompt) => {
        const value = promptDrafts[prompt.id]?.trim() ?? "";
        return value && value !== prompt.defaultValue.trim() ? [[prompt.id, value]] : [];
      })) as SystemPromptOverrides;
      const saved = await saveSystemPrompts(overrides);
      setPrompts(saved.prompts);
      setPromptDrafts(Object.fromEntries(saved.prompts.map((prompt) => [prompt.id, prompt.effectiveValue])) as SystemPromptOverrides);
      setPromptStatus("Saved on this Mac. New model and MCP runs use these prompts immediately.");
    } catch (error) { setPromptStatus(error instanceof Error ? error.message : "System prompts could not be saved."); }
    finally { setPromptBusy(false); }
  };

  const resetPrompt = (prompt: SystemPromptSetting) => setPromptDrafts((current) => ({ ...current, [prompt.id]: prompt.defaultValue }));
  const resetAllPrompts = () => setPromptDrafts(Object.fromEntries(prompts.map((prompt) => [prompt.id, prompt.defaultValue])) as SystemPromptOverrides);
  const harnessPicker = <AgentHarnessPicker preferences={agent} harnesses={harnesses} loading={discovering} disabled={busy || !preferencesReady} onChange={setAgent} onRefresh={() => void refreshHarnesses()} />;

  return <dialog open className="modal-backdrop agent-provider-backdrop" aria-label="Settings">
    <section className="agent-provider-modal">
      <header className="agent-provider-head"><div><span>VIDMARK</span><h2>Settings</h2></div><button type="button" onClick={onClose} aria-label="Close agent settings"><X aria-hidden="true" /></button></header>
      <nav className="agent-provider-tabs" aria-label="Agent configuration"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Course agent</button><button className={view === "imports" ? "active" : ""} onClick={() => setView("imports")}>Imports</button><button className={view === "debug" ? "active" : ""} onClick={() => setView("debug")}>Debug</button><button className={view === "prompts" ? "active" : ""} onClick={() => setView("prompts")}>System prompts</button></nav>

      {view === "imports" || view === "debug" ? <AppPreferences key={view} section={view} /> : view === "prompts" ? <SystemPromptEditor prompts={prompts} drafts={promptDrafts} busy={promptBusy} status={promptStatus} onChange={(id, value) => setPromptDrafts((current) => ({ ...current, [id]: value }))} onReset={resetPrompt} onResetAll={resetAllPrompts} onSave={() => void savePromptOverrides()} /> : <div className="provider-settings-view">
        {harnessPicker}
        <footer className="agent-provider-actions"><span role="status">{status}</span><button type="button" disabled={busy || !preferencesReady} onClick={() => void saveAgentPreferences()}>Save preferences</button></footer>
        {agent.harness === "provider" && <><div className="provider-choice" role="group" aria-label="Model provider">
          <button type="button" className={settings.provider === "local" ? "active" : ""} onClick={() => selectProvider("local")}><Server aria-hidden="true" /><span><b>Local or self-hosted</b><small>Ollama, LM Studio, or any OpenAI-compatible host</small></span></button>
          <button type="button" className={settings.provider === "openrouter" ? "active" : ""} onClick={() => selectProvider("openrouter")}><Sparkles aria-hidden="true" /><span><b>OpenRouter</b><small>Cloud models with optional grounded web search</small></span></button>
        </div>
        <div className="provider-form">
          {settings.provider === "local" ? <label><span>OpenAI-compatible host</span><input value={settings.baseUrl} onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:11434/v1" /></label> : <div className="provider-fixed-host"><span>OpenRouter endpoint</span><code>https://openrouter.ai/api/v1</code></div>}
          <label><span>Model ID</span><input list="vidmark-provider-models" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} placeholder="Exact model ID from your provider" /><datalist id="vidmark-provider-models">{models.map((model) => <option key={model} value={model} />)}</datalist><small>{models.length ? `${models.length} models discovered. Choose one or enter another model ID.` : "Enter the exact model ID exposed by your provider."}</small></label>
          <label><span>{settings.provider === "openrouter" ? "OpenRouter API key" : "Host API key · optional"}</span><div className="provider-secret"><KeyRound aria-hidden="true" /><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? "Saved in macOS Keychain · enter to replace" : "Paste API key"} /></div><small>Keys are stored in macOS Keychain and are never written to browser storage.</small></label>
          {settings.provider === "openrouter" && <div className="provider-check"><input id="provider-web-research" type="checkbox" checked={settings.enableWebSearch} onChange={(event) => setSettings((current) => ({ ...current, enableWebSearch: event.target.checked }))} /><label htmlFor="provider-web-research"><b>Allow grounded web research</b><small>Uses OpenRouter’s web-search server tool and may add search charges.</small></label></div>}
        </div>
        <footer className="agent-provider-actions"><span>Provider connection</span><button type="button" disabled={busy || !settings.model.trim() || (settings.provider === "openrouter" && !apiKey.trim() && !settings.hasApiKey)} onClick={() => void saveAndTest()}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />} Save & test</button></footer></>}
      </div>}
    </section>
  </dialog>;
}
