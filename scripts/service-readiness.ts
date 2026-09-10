export async function waitForServiceReadiness(stream: ReadableStream<Uint8Array>, marker: string, timeoutMs = 5000) {
  const reader = stream.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  try {
    await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let output = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Service stopped before reporting readiness.");
          output += decoder.decode(chunk.value, { stream: true });
          if (output.split("\n").slice(0, -1).includes(marker)) return;
          if (output.length > 16384) throw new Error("Unexpected service startup output.");
        }
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Service startup timed out.")), timeoutMs); }),
    ]);
    ready = true;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!ready) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
