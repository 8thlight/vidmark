"use client";

import { useEffect, useState } from "react";
import { getSyncPreferences, saveSyncPreferences } from "./vidmark-client";

type Diagnostics = { enabled: boolean; logPath: string; entries: Array<{ time: string; event: string; turn?: number; durationMs?: number }> };
const endpoint = `${import.meta.env.VITE_VIDMARK_PROVIDER_ORIGIN || "http://127.0.0.1:31418"}/diagnostics`;
async function diagnostics(enabled?: boolean): Promise<Diagnostics> {
  const response = await fetch(endpoint, enabled === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
  if (!response.ok) throw new Error("Diagnostics are unavailable. Run the updated Vidmark local service.");
  return response.json();
}

export function AppPreferences({ section }: { section: "imports" | "debug" }) {
  const [autoImport, setAutoImport] = useState<boolean | null>(null);
  const [debug, setDebug] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    const load = section === "imports" ? getSyncPreferences().then(value => { if (active) setAutoImport(value.autoImportQuestions); }) : diagnostics().then(value => { if (active) setDebug(value); });
    void load.catch(error => { if (active) setStatus(error.message); });
    return () => { active = false; };
  }, [section]);
  const save = async (checked: boolean) => {
    setBusy(true); setStatus("");
    try {
      if (section === "imports") { const saved = await saveSyncPreferences({ autoImportQuestions: checked }); setAutoImport(saved.autoImportQuestions); }
      else setDebug(await diagnostics(checked));
      setStatus("Saved on this Mac.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  };
  return <div className="provider-settings-view">
    {section === "imports" ? <><h3>Shared question imports</h3><label className="settings-toggle" htmlFor="settings-auto-accept" aria-label="Auto-accept shared questions"><span><b>Auto-accept shared questions</b><small>Off by default. Automatically import future questions and answers shared directly with you without reviewing the diff. This does not approve model tool calls or course invitations.</small></span><input id="settings-auto-accept" type="checkbox" checked={autoImport ?? false} disabled={busy || autoImport === null} onChange={event => void save(event.target.checked)} /></label></> : <><h3>Local diagnostics</h3><label className="settings-toggle" htmlFor="settings-debug" aria-label="Debug mode"><span><b>Debug mode</b><small>Off by default. Record build stages and timings locally. No prompts, transcripts, API keys, or model responses are logged. Disabling stops new events; existing logs remain on this Mac.</small></span><input id="settings-debug" type="checkbox" checked={debug?.enabled ?? false} disabled={busy || !debug} onChange={event => void save(event.target.checked)} /></label>{debug ? <><p>Log file: <code>{debug.logPath}</code></p><button type="button" disabled={busy} onClick={() => { setBusy(true); void diagnostics().then(setDebug).catch(error => setStatus(error.message)).finally(() => setBusy(false)); }}>Refresh logs</button><pre className="debug-log-view" aria-label="Debug log">{debug.entries.map(entry => JSON.stringify(entry)).join("\n") || "No debug events recorded."}</pre></> : null}</>}
    <p role="status">{status}</p>
  </div>;
}
