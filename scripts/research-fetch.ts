import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { webUrl } from "../app/course-source";

export const MAX_RESEARCH_BYTES = 2 * 1024 * 1024;
export function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Global-unicast IPv6 only; reject mapped IPv4, local/link-local, multicast,
  // transition tunnels and documentation ranges rather than decoding aliases.
  const ip = address.toLowerCase();
  const [prefix, subnet] = ip.split(":");
  const special2001 = prefix === "2001" && (Number.parseInt(subnet || "0", 16) < 0x200 || Number.parseInt(subnet, 16) === 0xdb8);
  return isIP(ip) === 6 && /^[23]/.test(ip) && !special2001 && prefix !== "2002" && prefix !== "3fff";
}

type Page = { status: number; headers: IncomingHttpHeaders; text: string };
// Connect to the validated numeric address, not the hostname. Host and TLS SNI
// retain the original name; certificate verification is never disabled.
export function requestPinned(url: URL, address: string, signal: AbortSignal): Promise<Page> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = send({ protocol: url.protocol, hostname: address, port: url.port || undefined, servername: isIP(hostname) ? undefined : hostname, path: url.pathname + url.search, method: "GET", agent: false, signal,
      headers: { Host: url.host, "User-Agent": "Vidmark course research", "Accept-Encoding": "identity" },
    }, response => {
      const status = response.statusCode ?? 0;
      let failed = false;
      const finish = (error: Error) => { failed = true; reject(error); response.destroy(); request.destroy(); };
      response.on("error", reject);
      if (status >= 300 && status < 400) { resolve({ status, headers: response.headers, text: "" }); response.destroy(); return; }
      if (status < 200 || status >= 300) { finish(new Error(`Documentation fetch returned HTTP ${status}.`)); return; }
      if (Number(response.headers["content-length"] ?? 0) > MAX_RESEARCH_BYTES) { finish(new Error("Documentation response exceeds the byte limit.")); return; }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") { finish(new Error("Compressed documentation responses are not supported.")); return; }
      const type = String(response.headers["content-type"] ?? "").toLowerCase();
      if (type && !/text|json|xml|html/.test(type)) { finish(new Error("Documentation fetch returned an unsupported binary content type.")); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > MAX_RESEARCH_BYTES) { finish(new Error("Documentation response exceeds the byte limit.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => { if (!failed) resolve({ status, headers: response.headers, text: Buffer.concat(chunks, bytes).toString("utf8") }); });
      response.on("aborted", () => reject(new Error("Documentation response was interrupted.")));
    });
    request.on("error", reject);
    request.end();
  });
}

// node:dns lookup itself is not abortable. Stop awaiting it immediately on
// cancellation, and handle late completion/rejection without leaking listeners.
function abortableLookup<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function safeFetchUrl(rawUrl: string, signal?: AbortSignal, dependencies = { lookup: (hostname: string) => lookup(hostname, { all: true }), requestPinned }) {
  const timed = AbortSignal.timeout(20_000);
  const active = signal ? AbortSignal.any([signal, timed]) : timed;
  let url = new URL(rawUrl);
  for (let redirect = 0; redirect < 4; redirect++) {
    active.throwIfAborted();
    if (!webUrl(url.href)) throw new Error("Documentation URLs must use HTTP(S) without credentials.");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Documentation fetches cannot target local services.");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortableLookup(dependencies.lookup(hostname), active);
    active.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("Documentation fetches cannot target private or reserved networks.");
    // Prefer IPv4 on dual-stack hosts: many desktop networks publish AAAA
    // records but have no usable IPv6 route. Both families were checked above.
    const address = addresses.find(candidate => candidate.family === 4) ?? addresses[0];
    const response = await dependencies.requestPinned(url, address.address, active);
    if (response.status >= 300 && response.status < 400) {
      if (!response.headers.location) throw new Error("Documentation redirect has no destination.");
      url = new URL(response.headers.location, url);
      continue;
    }
    return response.text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 30_000).trim();
  }
  throw new Error("Too many documentation redirects.");
}
