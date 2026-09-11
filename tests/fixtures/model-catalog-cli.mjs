import assert from "node:assert/strict";
import readline from "node:readline";

const args = process.argv.slice(2);
const codex = args[0] === "app-server";
if (codex) assert.deepEqual(args, ["app-server"]);
else assert.deepEqual(args, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""]);
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let initialized = false;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!codex) {
    assert.deepEqual(message, { type: "control_request", request_id: "vidmark-models", request: { subtype: "initialize", hooks: {} } });
    send({ type: "control_response", response: { subtype: "success", request_id: "unrelated", response: { models: [] } } });
    send({ type: "control_response", response: { subtype: "success", request_id: "vidmark-models", response: { models: [{ value: "fixture-claude", displayName: "Fixture Claude" }] } } });
  } else if (message.method === "initialize") {
    assert.equal(message.id, 1); assert.equal(message.params.clientInfo.name, "vidmark");
    send({ id: 1, result: { userAgent: "fixture" } });
  } else if (message.method === "initialized") initialized = true;
  else {
    assert.equal(initialized, true); assert.equal(message.method, "model/list"); assert.equal(message.id, 2);
    assert.equal(message.params.limit, 100); assert.equal(message.params.includeHidden, false);
    if (!message.params.cursor) send({ id: 2, result: { data: [{ model: "fixture-default", displayName: "Fixture Default", isDefault: true }, { model: "hidden", hidden: true }], nextCursor: "page-two" } });
    else {
      assert.equal(message.params.cursor, "page-two");
      const response = JSON.stringify({ id: 2, result: { data: [{ model: "fixture-other", displayName: "Fixture Other", isDefault: false }] } }) + "\n";
      process.stdout.write(response.slice(0, 10)); setTimeout(() => process.stdout.write(response.slice(10)), 5);
    }
  }
});
