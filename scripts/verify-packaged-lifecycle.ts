import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";

const ports = [3010, 31415, 31417, 31418, 31419];
const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = (result: boolean) => { socket.destroy(); resolve(result); };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.setTimeout(300, () => finish(false));
});
for (const port of ports) {
  if (await listening(port)) throw new Error(`Quit Vidmark before testing: port ${port} is already in use.`);
}
const root = await mkdtemp(join(tmpdir(), "vidmark-lifecycle-"));
const executable = resolve("build/Vidmark.app/Contents/MacOS/VidmarkServer");
try {
  for (let cycle = 0; cycle < 2; cycle++) {
    const server = Bun.spawn([executable], {
      env: { ...process.env, HOME: root, VIDMARK_DATA_DIR: root, VIDMARK_NATIVE_SHELL: "1", VIDMARK_RELAY_URL: "ws://127.0.0.1:1/ws" },
      stdout: "ignore", stderr: "inherit",
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!(await Promise.all(ports.map(listening))).every(Boolean)) {
        if (server.exitCode !== null || Date.now() > deadline) throw new Error("Packaged services did not start.");
        await Bun.sleep(100);
      }
      server.kill("SIGTERM");
      const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!stopped) throw new Error("Packaged server did not exit after SIGTERM.");
      await Bun.sleep(200);
      for (const port of ports) {
        if (await listening(port)) throw new Error(`Service ${port} survived shutdown.`);
      }
    } finally {
      if (server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    }
  }
  console.log("Packaged lifecycle passed: all five services start and stop across two reopen cycles.");
} finally {
  await rm(root, { recursive: true, force: true });
}
