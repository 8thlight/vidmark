#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const endpoint = process.env.VIDMARK_MCP_URL || "http://127.0.0.1:31417/mcp";
const appName = process.env.VIDMARK_APP_NAME || "Vidmark";
const healthUrl = new URL("/health", endpoint).toString();
let protocolVersion = "2025-06-18";
let sessionId = "";
let readyPromise;

const log = (message) => process.stderr.write(`[vidmark-dxt] ${message}\n`);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isReady = async () => {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
};

const ensureVidmark = async () => {
  if (await isReady()) return;
  log(`Starting ${appName}…`);
  try {
    const child = spawn("/usr/bin/open", ["-a", appName], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    throw new Error(`Could not launch ${appName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isReady()) return;
    await pause(250);
  }
  throw new Error(`${appName} is not ready. Open Vidmark in Applications and unlock it with Mac authentication or your PIN, then retry the connection.`);
};

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const responseMessages = async (response) => {
  if (response.status === 202 || response.status === 204) return [];
  const body = await response.text();
  if (!body.trim()) return [];
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return body.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") return [];
      return [JSON.parse(data)];
    });
  }
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
};

const forward = async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON received by the Vidmark extension." } });
    return;
  }

  if (request?.method === "initialize" && typeof request.params?.protocolVersion === "string") protocolVersion = request.params.protocolVersion;

  try {
    readyPromise ??= ensureVidmark();
    await readyPromise;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocolVersion,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    const messages = await responseMessages(response);
    if (!response.ok) throw new Error(messages[0]?.error?.message || `Vidmark MCP returned HTTP ${response.status}.`);
    messages.forEach(writeMessage);
  } catch (error) {
    readyPromise = undefined;
    log(error instanceof Error ? error.message : String(error));
    if (request?.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "Vidmark MCP request failed." } });
  }
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();
input.on("line", (line) => {
  requestQueue = requestQueue.then(() => forward(line)).catch((error) => log(error instanceof Error ? error.stack || error.message : String(error)));
});
input.on("close", () => {
  void requestQueue.finally(() => process.exit(0));
});
