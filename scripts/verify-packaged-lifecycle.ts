import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";

const ports = [3010, 31415, 31417, 31418, 31419];
const sessionToken = crypto.randomUUID();
const ready = (output: string) => output.split("\n").slice(0, -1).includes(`VIDMARK_READY ${sessionToken}`);
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
    const server = Bun.spawn([host, executable, sessionToken], {
      env: environment, stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    let startupOutput = "";
    const output = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of server.stdout) startupOutput += decoder.decode(chunk, { stream: true });
      return startupOutput;
    })();
    try {
      const deadline = Date.now() + 15_000;
      while (!(await Promise.all(ports.map(listening))).every(Boolean) || !ready(startupOutput)) {
        if (server.exitCode !== null || Date.now() > deadline) throw new Error("Packaged services did not start.");
        await Bun.sleep(100);
      }
      if (mode === "crash") server.kill("SIGKILL");
      else { server.stdin.write(`${mode}\n`); server.stdin.flush(); }
      const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!stopped) throw new Error("Packaged server did not exit after SIGTERM.");
      if (!ready(await output)) throw new Error("Server did not emit the exact native session readiness handshake.");
      await Bun.sleep(700);
      for (const port of ports) {
        if (await listening(port)) throw new Error(`Service ${port} survived shutdown.`);
      }
    } finally {
      if (server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    }
  }
  for (const occupiedPort of ports) {
    const unrelated = Bun.serve({ hostname: "127.0.0.1", port: occupiedPort, fetch: () => new Response("unrelated application") });
    const server = Bun.spawn([host, executable, sessionToken], { env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const output = new Response(server.stdout).text();
    try {
      const code = await Promise.race([server.exited, Bun.sleep(7000).then(() => null)]);
      if (code === null || code === 0) throw new Error(`Port conflict ${occupiedPort} did not abort startup.`);
      if ((await output).includes("VIDMARK_READY ")) throw new Error(`Port conflict ${occupiedPort} was reported as ready.`);
      await Bun.sleep(700);
      for (const port of ports.filter((port) => port !== occupiedPort)) {
        if (await listening(port)) throw new Error(`Port ${port} survived failed startup.`);
      }
    } finally {
      if (server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
      unrelated.stop(true);
    }
  }
  console.log("Packaged lifecycle passed: direct/forged launches rejected; all five services close on stop, lease loss, and parent crash; every port conflict aborts without a readiness signal.");
} finally {
  await rm(root, { recursive: true, force: true });
}
