import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Vidmark workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  const visibleHtml = html.replace(/<!--.*?-->/gs, "");
  assert.match(html, /Vidmark — Study Library/i);
  assert.match(html, /Claude Certified Architect/i);
  assert.match(html, /Course library/i);
  assert.match(html, /Copy trusted full-MCP task/);
  assert.match(html, /For trusted agents only: grants full-library MCP access/);
  assert.match(visibleHtml, /2\s+courses/i);
  assert.match(html, /exam scenarios/i);
  assert.match(html, /<strong>100<\/strong><span>exam scenarios<\/span>/i);
  assert.match(html, /<svg[^>]*width="20"[^>]*height="20"[^>]*class="[^"]*global-search-icon[^"]*"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(html, /<input[^>]*aria-label="Search concepts, chapters, or captions"/);
  assert.doesNotMatch(html, /⌕/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});
