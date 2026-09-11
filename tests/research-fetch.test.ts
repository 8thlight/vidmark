import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { isPublicAddress, MAX_RESEARCH_BYTES, requestPinned, safeFetchUrl } from "../scripts/research-fetch";
import { citationUrl } from "../scripts/course-artifacts";

test("citations allow only credential-free HTTP(S)", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///etc/hosts", "https://user:secret@example.com"]) expect(citationUrl.safeParse(url).success).toBe(false);
  expect(citationUrl.safeParse("https://example.com/docs#section").success).toBe(true);
});

test("research rejects local, reserved, mapped and mixed DNS answers before connecting", async () => {
  for (const ip of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "100.64.0.1", "192.168.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fd00::1", "2001:db8::1"]) expect(isPublicAddress(ip)).toBe(false);
  expect(isPublicAddress("93.184.216.34")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
  let connections = 0;
  const dependencies = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    requestPinned: async () => { connections++; return { status: 200, headers: {}, text: "test" }; },
  };
  await expect(safeFetchUrl("https://example.com", undefined, dependencies)).rejects.toThrow("private");
  await expect(safeFetchUrl("https://[::1]", undefined, dependencies)).rejects.toThrow("private");
  await expect(safeFetchUrl("https://user:secret@example.com", undefined, dependencies)).rejects.toThrow("credentials");
  expect(connections).toBe(0);
});

test("research pins the first validated DNS result and validates every redirect", async () => {
  let lookups = 0;
  const destinations: string[] = [];
  const dependencies = {
    lookup: async () => { lookups++; return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]; },
    requestPinned: async (url: URL, address: string) => { destinations.push(address); expect(url.hostname).toBe("example.com"); return { status: 302, headers: { location: "https://example.com/next" }, text: "" }; },
  };
  await expect(safeFetchUrl("https://example.com", undefined, dependencies)).rejects.toThrow("private");
  expect(destinations).toEqual(["93.184.216.34"]);
  expect(lookups).toBe(2);
  lookups = 0;
  const text = await safeFetchUrl("https://example.com", undefined, { ...dependencies, requestPinned: async () => ({ status: 200, headers: {}, text: "<script>bad</script><p>Primary source</p>" }) });
  expect(text).toBe("Primary source");
  expect(lookups).toBe(1);
  await safeFetchUrl("https://example.com", undefined, {
    lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }],
    requestPinned: async (_url, address) => { expect(address).toBe("93.184.216.34"); return { status: 200, headers: {}, text: "Evidence" }; },
  });
});

test("pinned transport enforces declared and streaming byte limits, Host and cancellation", async () => {
  let seenHost = "";
  const server = createServer((request, response) => {
    seenHost = request.headers.host ?? "";
    response.setHeader("Content-Type", "text/plain");
    if (request.url === "/declared") { response.setHeader("Content-Length", MAX_RESEARCH_BYTES + 1); response.flushHeaders(); return; }
    if (request.url === "/stream") { response.end(Buffer.alloc(MAX_RESEARCH_BYTES + 100, "a")); return; }
    if (request.url === "/slow") { response.flushHeaders(); return; }
    response.end("Bounded evidence");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const url = (path: string) => new URL(`http://original.example:${address.port}${path}`);
  try {
    const signal = AbortSignal.timeout(2000);
    expect((await requestPinned(url("/ok"), "127.0.0.1", signal)).text).toBe("Bounded evidence");
    expect(seenHost).toBe(`original.example:${address.port}`);
    await expect(requestPinned(url("/declared"), "127.0.0.1", signal)).rejects.toThrow("byte limit");
    await expect(requestPinned(url("/stream"), "127.0.0.1", signal)).rejects.toThrow("byte limit");
    await expect(requestPinned(url("/slow"), "127.0.0.1", AbortSignal.timeout(30))).rejects.toThrow();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("research cancellation and deadlines stop awaiting stalled DNS, including late rejection", async () => {
  for (const deadline of [false, true]) {
    const controller = new AbortController();
    let rejectLookup!: (error: Error) => void;
    let connections = 0;
    const pending = safeFetchUrl("https://example.com", deadline ? AbortSignal.timeout(20) : controller.signal, {
      lookup: () => new Promise((_resolve, reject) => { rejectLookup = reject; }),
      requestPinned: async () => { connections++; return { status: 200, headers: {}, text: "Must not connect" }; },
    });
    if (!deadline) controller.abort(new Error("Cancelled during DNS"));
    await expect(pending).rejects.toThrow();
    rejectLookup(new Error("Late resolver error"));
    await Promise.resolve();
    expect(connections).toBe(0);
  }
});
