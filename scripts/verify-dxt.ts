import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "vidmark-dxt-verify-"));
const port = 33437;
process.env.VIDMARK_MCP_PORT = String(port);
const { startVidmarkMcpServer } = await import("./vidmark-mcp");
const service = await startVidmarkMcpServer(join(root, "vidmark.sqlite"));
const bridge = Bun.spawn([process.execPath, "dxt/server/index.mjs"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, VIDMARK_MCP_URL: `http://127.0.0.1:${port}/mcp` },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const reader = bridge.stdout.getReader();
const decoder = new TextDecoder();
let pending = "";

const send = async (message: Record<string, unknown>) => {
  bridge.stdin.write(`${JSON.stringify(message)}\n`);
  bridge.stdin.flush();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const newline = pending.indexOf("\n");
    if (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      return JSON.parse(line) as Record<string, unknown>;
    }
    const result = await reader.read();
    if (result.done) throw new Error("The DXT bridge exited before returning an MCP response.");
    pending += decoder.decode(result.value, { stream: true });
  }
  throw new Error("The DXT bridge timed out.");
};

try {
  const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vidmark-dxt-verifier", version: "1.0.0" } } });
  const serverInfo = (initialized.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
  if (serverInfo?.name !== "vidmark-local") throw new Error("The DXT bridge did not initialize the Vidmark MCP server.");

  const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (listed.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
  for (const required of ["list_courses", "acquire_course_transcript", "save_course_build", "share_course_with_user"]) {
    if (!tools.some((tool) => tool.name === required)) throw new Error(`The DXT bridge did not expose ${required}.`);
  }

  const prompts = await send({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
  const promptNames = ((prompts.result as { prompts?: Array<{ name?: string }> } | undefined)?.prompts ?? []).map((prompt) => prompt.name);
  if (!promptNames.includes("build_vidmark_course")) throw new Error("The DXT bridge did not expose build_vidmark_course.");

  console.log(JSON.stringify({ ok: true, server: serverInfo.name, tools: tools.length, prompt: "build_vidmark_course", transport: "Claude Desktop stdio → Vidmark Streamable HTTP" }, null, 2));
} finally {
  bridge.stdin.end();
  bridge.kill("SIGTERM");
  service.stop(true);
  await rm(root, { recursive: true, force: true });
}
