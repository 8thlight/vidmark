import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
const appContents = join(root, "Vidmark.app", "Contents");
const executable = join(appContents, "MacOS", "VidmarkServer");
const host = join(appContents, "MacOS", "Vidmark");
const environment = { ...process.env, HOME: root, VIDMARK_DATA_DIR: root, VIDMARK_NATIVE_SHELL: "1", VIDMARK_RELAY_URL: "ws://127.0.0.1:1/ws", VIDMARK_MCP_PORT: "31417", VIDMARK_TRANSCRIPTION_PORT: "31415" };
try {
  await mkdir(join(appContents, "MacOS"), { recursive: true });
  await copyFile(resolve("build/Vidmark.app/Contents/MacOS/VidmarkServer"), executable);
  await symlink(resolve("build/Vidmark.app/Contents/Resources"), join(appContents, "Resources"));
  const compiler = Bun.spawn(["xcrun", "swiftc", "-parse-as-library", "tests/native-service-host.swift", "-o", host], { stdout: "inherit", stderr: "inherit" });
  if (await compiler.exited !== 0) throw new Error("Could not compile native service test host.");
  for (const token of ["", crypto.randomUUID()]) {
    const direct = Bun.spawn([executable], { env: { ...environment, VIDMARK_SESSION_TOKEN: token }, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    direct.stdin.write(`${token}\n`);
    direct.stdin.end();
    if (await direct.exited === 0) throw new Error("Direct server launch unexpectedly succeeded.");
    if ((await Promise.all(ports.map(listening))).some(Boolean)) throw new Error("Direct server launch opened a service.");
  }
  for (const mode of ["stop", "close", "crash"]) {
    const server = Bun.spawn([host, executable], {
      env: environment, stdin: "pipe", stdout: "ignore", stderr: "inherit",
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!(await Promise.all(ports.map(listening))).every(Boolean)) {
        if (server.exitCode !== null || Date.now() > deadline) throw new Error("Packaged services did not start.");
        await Bun.sleep(100);
      }
      if (mode === "crash") server.kill("SIGKILL");
      else { server.stdin.write(`${mode}\n`); server.stdin.flush(); }
      const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!stopped) throw new Error("Packaged server did not exit after SIGTERM.");
      await Bun.sleep(700);
      for (const port of ports) {
        if (await listening(port)) throw new Error(`Service ${port} survived shutdown.`);
      }
    } finally {
      if (server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    }
  }
  console.log("Packaged lifecycle passed: direct/forged launches rejected; all five services close on graceful stop, lease loss, and native-parent crash.");
} finally {
  await rm(root, { recursive: true, force: true });
}
