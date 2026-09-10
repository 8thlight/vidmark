"use client";

import { Bot, CheckCircle2, Copy, KeyRound, LoaderCircle, RotateCcw, Server, Settings2, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SystemPromptId, SystemPromptOverrides, SystemPromptSetting } from "./system-prompts";
import { getSystemPrompts, saveSystemPrompts } from "./vidmark-client";

const PROVIDER_URL = "http://127.0.0.1:31418";

type ProviderKind = "local" | "openrouter";
type ProviderSettings = {
  configured: boolean;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  enableWebSearch: boolean;
  hasApiKey: boolean;
};
type BuildJob = { id: string; status: "queued" | "running" | "complete" | "failed"; phase: string; message: string; error?: string };

const initialSettings: ProviderSettings = { configured: false, provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "", enableWebSearch: false, hasApiKey: false };

const responseJson = async <T,>(response: Response): Promise<T> => {
  const payload = await response.json() as T & { error?: string };
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

export function AgentProviderDialog({ open, initialView, courseId, courseTitle, transcriptCues, hasVideo = true, onClose, onCopyHandoff, onBuildComplete }: {
  open: boolean;
  initialView: "build" | "settings";
  courseId: string;
  courseTitle: string;
  transcriptCues: number;
  hasVideo?: boolean;
  onClose: () => void;
  onCopyHandoff: () => Promise<void>;
  onBuildComplete: () => Promise<void>;
}) {
  const [view, setView] = useState<"build" | "settings" | "prompts">(initialView);
  const [settings, setSettings] = useState(initialSettings);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [job, setJob] = useState<BuildJob | null>(null);
  const [prompts, setPrompts] = useState<SystemPromptSetting[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<SystemPromptOverrides>({});
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptStatus, setPromptStatus] = useState("");
  const completedJobs = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const [providerResult, promptResult] = await Promise.allSettled([
        fetch(`${PROVIDER_URL}/settings`).then((response) => responseJson<ProviderSettings>(response)),
        getSystemPrompts(),
      ]);
      if (cancelled) return;
      if (providerResult.status === "fulfilled") {
        const loaded = providerResult.value;
        setSettings(loaded);
        setStatus(loaded.configured ? "" : "Choose a model connection before starting a build.");
        if (loaded.provider === "local" || loaded.configured) {
          try {
            const result = await responseJson<{ models: string[] }>(await fetch(`${PROVIDER_URL}/models`));
            if (!cancelled) setModels(result.models);
          } catch (error) { if (!cancelled) setStatus(error instanceof Error ? error.message : "Models could not be loaded."); }
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
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const updated = await responseJson<BuildJob>(await fetch(`${PROVIDER_URL}/build/${job.id}`));
        setJob(updated);
        if (updated.status === "complete" && !completedJobs.current.has(updated.id)) {
          completedJobs.current.add(updated.id);
          await onBuildComplete();
          setStatus("Course refreshed from SQLite and ready to study or share.");
        }
      }
      catch (error) { setStatus(error instanceof Error ? error.message : "Build status could not be refreshed."); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job, onBuildComplete]);

  if (!open) return null;

  const saveAndTest = async () => {
    setBusy(true); setStatus("Saving the connection…");
    try {
      const saved = await responseJson<ProviderSettings>(await fetch(`${PROVIDER_URL}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, apiKey }) }));
      setSettings(saved); setApiKey(""); setStatus("Testing the selected model…");
      const tested = await responseJson<{ response: string }>(await fetch(`${PROVIDER_URL}/test`, { method: "POST" }));
      setStatus(tested.response || "Model connection ready.");
      setModels((await responseJson<{ models: string[] }>(await fetch(`${PROVIDER_URL}/models`))).models);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The model connection failed."); }
    finally { setBusy(false); }
  };

  const startBuild = async () => {
    setBusy(true); setStatus("");
    try { setJob(await responseJson<BuildJob>(await fetch(`${PROVIDER_URL}/build`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }) }))); }
    catch (error) { setStatus(error instanceof Error ? error.message : "The build could not start."); }
    finally { setBusy(false); }
  };

  const selectProvider = (provider: ProviderKind) => {
    setSettings((current) => ({ ...current, provider, configured: false, hasApiKey: false, baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:11434/v1", model: provider === "openrouter" ? "openrouter/auto" : "", enableWebSearch: provider === "openrouter" }));
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
  const copyClaudeSetup = async () => {
    await navigator.clipboard.writeText("claude mcp add --transport http vidmark http://127.0.0.1:31417/mcp");
    setStatus("Claude Code setup command copied. Run it while Vidmark is open, then copy the course task.");
  };

  return <dialog open className="modal-backdrop agent-provider-backdrop" aria-label="Course build agent">
    <section className="agent-provider-modal">
      <header className="agent-provider-head"><div><Bot aria-hidden="true" /><div><span>COURSE BUILD AGENT</span><h2>{view === "build" ? "Build with your model" : view === "settings" ? "Model connection" : "System prompts"}</h2></div></div><button type="button" onClick={onClose} aria-label="Close agent settings"><X aria-hidden="true" /></button></header>
      <nav className="agent-provider-tabs" aria-label="Agent configuration"><button className={view === "build" ? "active" : ""} onClick={() => setView("build")}>Build</button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Model connection</button><button className={view === "prompts" ? "active" : ""} onClick={() => setView("prompts")}>System prompts</button></nav>

      {view === "prompts" ? <SystemPromptEditor prompts={prompts} drafts={promptDrafts} busy={promptBusy} status={promptStatus} onChange={(id, value) => setPromptDrafts((current) => ({ ...current, [id]: value }))} onReset={resetPrompt} onResetAll={resetAllPrompts} onSave={() => void savePromptOverrides()} /> : view === "settings" ? <div className="provider-settings-view">
        <div className="provider-choice" role="group" aria-label="Model provider">
          <button type="button" className={settings.provider === "local" ? "active" : ""} onClick={() => selectProvider("local")}><Server aria-hidden="true" /><span><b>Local or self-hosted</b><small>Ollama, LM Studio, or any OpenAI-compatible host</small></span></button>
          <button type="button" className={settings.provider === "openrouter" ? "active" : ""} onClick={() => selectProvider("openrouter")}><Sparkles aria-hidden="true" /><span><b>OpenRouter</b><small>Cloud models with optional grounded web search</small></span></button>
        </div>
        <div className="provider-form">
          {settings.provider === "local" ? <label><span>OpenAI-compatible host</span><input value={settings.baseUrl} onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:11434/v1" /></label> : <div className="provider-fixed-host"><span>OpenRouter endpoint</span><code>https://openrouter.ai/api/v1</code></div>}
          <label><span>Model ID</span><input list="vidmark-provider-models" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} placeholder={settings.provider === "local" ? "qwen3:27b" : "openrouter/auto"} /><datalist id="vidmark-provider-models">{models.map((model) => <option key={model} value={model} />)}</datalist><small>{models.length ? `${models.length} models discovered. Choose one or enter another model ID.` : "Enter the exact model ID exposed by your provider."}</small></label>
          <label><span>{settings.provider === "openrouter" ? "OpenRouter API key" : "Host API key · optional"}</span><div className="provider-secret"><KeyRound aria-hidden="true" /><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? "Saved in macOS Keychain · enter to replace" : "Paste API key"} /></div><small>Keys are stored in macOS Keychain and are never written to browser storage.</small></label>
          {settings.provider === "openrouter" && <div className="provider-check"><input id="provider-web-research" type="checkbox" checked={settings.enableWebSearch} onChange={(event) => setSettings((current) => ({ ...current, enableWebSearch: event.target.checked }))} /><label htmlFor="provider-web-research"><b>Allow grounded web research</b><small>Uses OpenRouter’s web-search server tool and may add search charges.</small></label></div>}
        </div>
        <footer className="agent-provider-actions"><span role="status">{status}</span><button type="button" disabled={busy || !settings.model.trim() || (settings.provider === "openrouter" && !apiKey.trim() && !settings.hasApiKey)} onClick={() => void saveAndTest()}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />} Save & test</button></footer>
      </div> : <div className="provider-build-view">
        <div className="build-target"><div><span>COURSE</span><h3>{courseTitle}</h3></div><div><span>MODEL</span><strong>{settings.configured ? settings.model : "Not configured"}</strong><small>{settings.provider === "openrouter" ? "OpenRouter" : settings.baseUrl}</small></div></div>
        <div className="build-explainer"><h3>What “Build with agent” does</h3><ol><li><b>Loads both prompt layers.</b><span>Vidmark’s master instructions plus this course’s required prompt.</span></li><li><b>{hasVideo ? "Gets the timestamped transcript." : "Reads the course sources."}</b><span>{hasVideo ? "The agent reads imported cues or acquires an available public YouTube caption track." : "The agent reads the linked material and researches supporting primary resources for lessons and original assessments."}</span></li><li><b>Delegates specialist work.</b><span>Independent model contexts handle chapters, research, assessments, visuals, and QA.</span></li><li><b>Saves reviewed artifacts.</b><span>The study guide, research notes, chapters, and questions return to Vidmark.</span></li></ol></div>
        <div className={`build-readiness ${transcriptCues ? "ready" : "acquire"}`}><span>{!hasVideo ? "Reading-based course · no transcript required" : transcriptCues ? `${transcriptCues.toLocaleString()} transcript cues ready` : "Transcript will be acquired"}</span><p>{!hasVideo ? "The coordinator reads the course source and authorized supporting material. An overview page is not treated as the official curriculum. Optional chapter videos can supplement the readings." : transcriptCues ? `Starting may make many model calls and can take a while.${settings.provider === "local" ? " Local models can fetch exact source URLs but do not receive OpenRouter web search." : " Grounded web search may add provider charges."}` : "The coordinator will retrieve and save an available public YouTube caption track before building. If the video has no accessible captions, the build will stop and ask for a transcript."}</p></div>
        {job && <div className={`build-job ${job.status}`}><div>{job.status === "running" || job.status === "queued" ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}<span><b>{job.phase}</b><small>{job.message}</small></span></div></div>}
        <div className="build-alternative"><span><b>Claude Code</b> · connect once, then give Claude this course task.</span><code>claude mcp add --transport http vidmark http://127.0.0.1:31417/mcp</code><div><button type="button" onClick={() => void copyClaudeSetup()}><Copy aria-hidden="true" /> Copy setup command</button><button type="button" onClick={() => void onCopyHandoff()}><Copy aria-hidden="true" /> Copy course task</button></div></div>
        <footer className="agent-provider-actions"><button type="button" className="secondary" onClick={() => setView("settings")}><Settings2 aria-hidden="true" /> Configure model</button><button type="button" disabled={busy || !settings.configured || job?.status === "running" || job?.status === "queued"} onClick={() => void startBuild()}>{busy || job?.status === "running" || job?.status === "queued" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />} Start course build</button></footer>
        {status && <p className="agent-provider-status" role="status">{status}</p>}
      </div>}
    </section>
  </dialog>;
}
