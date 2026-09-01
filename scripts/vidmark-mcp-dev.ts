import { homedir } from "node:os";
import { join } from "node:path";
import { startVidmarkMcpServer } from "./vidmark-mcp";

const dataDirectory = process.env.VIDMARK_DATA_DIR || join(homedir(), "Library", "Application Support", "Vidmark");
const service = await startVidmarkMcpServer(join(dataDirectory, "vidmark.sqlite"), { legacyStatePath: join(dataDirectory, "mcp-state.json") });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  service.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
