import { realpath } from "node:fs/promises";

// Packaged services are owned by a specific native parent and an anonymous pipe.
// This protects the supported launch path, not against a user modifying the app.
export async function requireNativeServiceLease(expectedParent: string) {
  const token = process.env.VIDMARK_SESSION_TOKEN;
  if (!token || !/^[a-f0-9-]{36}$/i.test(token)) throw new Error("Open and unlock Vidmark to start its local services.");
  const parent = Bun.spawn(["/bin/ps", "-ww", "-p", String(process.ppid), "-o", "comm="], { stdout: "pipe", stderr: "pipe" });
  const parentPath = (await new Response(parent.stdout).text()).trim();
  if (await parent.exited !== 0 || await realpath(parentPath) !== await realpath(expectedParent)) {
    throw new Error("Vidmark services must be launched by their native app parent.");
  }

  await new Promise<void>((resolve, reject) => {
    let received = "";
    let authorized = false;
    const timeout = setTimeout(() => reject(new Error("Vidmark unlock handshake timed out.")), 5000);
    const lost = () => {
      clearTimeout(timeout);
      if (!authorized) reject(new Error("Vidmark closed before unlocking its services."));
      else process.exit(0);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("end", lost);
    process.stdin.on("error", lost);
    process.stdin.on("data", (chunk: string) => {
      if (authorized) return;
      received += chunk;
      if (received.length > 128 || (received.includes("\n") && received !== `${token}\n`)) {
        clearTimeout(timeout);
        reject(new Error("Invalid Vidmark unlock handshake."));
        return;
      }
      if (received === `${token}\n`) {
        authorized = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}
