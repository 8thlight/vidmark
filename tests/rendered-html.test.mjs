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
  assert.match(html, /Vidmark — YouTube Study Library/i);
  assert.match(html, /Claude Certified Architect/i);
  assert.match(html, /Video library/i);
  assert.match(visibleHtml, /2\s+courses/i);
  assert.match(html, /exam scenarios/i);
  assert.match(html, /<strong>100<\/strong><span>exam scenarios<\/span>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});
