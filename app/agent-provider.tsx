"use client";

import { Bot, CheckCircle2, Copy, KeyRound, LoaderCircle, Server, Settings2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

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

export function AgentProviderDialog({ open, initialView, courseId, courseTitle, transcriptCues, onClose, onCopyHandoff }: {
  open: boolean;
  initialView: "build" | "settings";
  courseId: string;
  courseTitle: string;
  transcriptCues: number;
  onClose: () => void;
  onCopyHandoff: () => Promise<void>;
}) {
  const [view, setView] = useState(initialView);
  const [settings, setSettings] = useState(initialSettings);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [job, setJob] = useState<BuildJob | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await responseJson<ProviderSettings>(await fetch(`${PROVIDER_URL}/settings`));
        if (cancelled) return;
        setSettings(loaded);
        setStatus(loaded.configured ? "" : "Choose a model connection before starting a build.");
        if (loaded.provider === "local" || loaded.configured) {
          const result = await responseJson<{ models: string[] }>(await fetch(`${PROVIDER_URL}/models`));
          if (!cancelled) setModels(result.models);
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "The local model service is unavailable.");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      try { setJob(await responseJson<BuildJob>(await fetch(`${PROVIDER_URL}/build/${job.id}`))); }
      catch (error) { setStatus(error instanceof Error ? error.message : "Build status could not be refreshed."); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job]);

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

  return <dialog open className="modal-backdrop agent-provider-backdrop" aria-label="Course build agent">
    <section className="agent-provider-modal">
      <header className="agent-provider-head"><div><Bot aria-hidden="true" /><div><span>COURSE BUILD AGENT</span><h2>{view === "build" ? "Build with your model" : "Model connection"}</h2></div></div><button type="button" onClick={onClose} aria-label="Close agent settings"><X aria-hidden="true" /></button></header>
      <nav className="agent-provider-tabs" aria-label="Agent configuration"><button className={view === "build" ? "active" : ""} onClick={() => setView("build")}>Build</button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Model connection</button></nav>

      {view === "settings" ? <div className="provider-settings-view">
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
        <div className="build-explainer"><h3>What “Build with agent” does</h3><ol><li><b>Loads both prompt layers.</b><span>Vidmark’s master instructions plus this course’s required prompt.</span></li><li><b>Reads the timestamped transcript.</b><span>The agent cannot invent or scrape captions when none have been imported.</span></li><li><b>Delegates specialist work.</b><span>Independent model contexts handle chapters, research, assessments, visuals, and QA.</span></li><li><b>Saves reviewed artifacts.</b><span>The study guide, research notes, chapters, and questions return to Vidmark.</span></li></ol></div>
        <div className={`build-readiness ${transcriptCues ? "ready" : "blocked"}`}><span>{transcriptCues ? `${transcriptCues.toLocaleString()} transcript cues ready` : "Transcript required"}</span><p>{transcriptCues ? `Starting may make many model calls and can take a while.${settings.provider === "local" ? " Local models can fetch exact source URLs but do not receive OpenRouter web search." : " Grounded web search may add provider charges."}` : "Import a timestamped .VTT transcript before running the in-app agent."}</p></div>
        {job && <div className={`build-job ${job.status}`}><div>{job.status === "running" || job.status === "queued" ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}<span><b>{job.phase}</b><small>{job.message}</small></span></div></div>}
        <div className="build-alternative"><span>Already use Claude Code, Codex, or another MCP client?</span><button type="button" onClick={() => void onCopyHandoff()}><Copy aria-hidden="true" /> Copy MCP handoff</button></div>
        <footer className="agent-provider-actions"><button type="button" className="secondary" onClick={() => setView("settings")}><Settings2 aria-hidden="true" /> Configure model</button><button type="button" disabled={busy || !settings.configured || !transcriptCues || job?.status === "running" || job?.status === "queued"} onClick={() => void startBuild()}>{busy || job?.status === "running" || job?.status === "queued" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />} Start course build</button></footer>
        {status && <p className="agent-provider-status" role="status">{status}</p>}
      </div>}
    </section>
  </dialog>;
}
