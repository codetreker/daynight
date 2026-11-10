import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

const log = (value) => appendFileSync(process.env.DAYNIGHT_TEST_BRIDGE_LOG, JSON.stringify(value) + "\n");
const manyImages = ["many-images", "valid-many-images"].includes(process.env.DAYNIGHT_TEST_BRIDGE_MODE);
const media = (process.env.DAYNIGHT_TEST_BRIDGE_MEDIA ? readFileSync(process.env.DAYNIGHT_TEST_BRIDGE_MEDIA) : Buffer.alloc(manyImages ? 9 * 1_048_576 : 786_435, 65)).toString("base64");
const event = { type: "tool.execution_complete", id: "tool-event", parentId: "parent", timestamp: "2026-01-01T00:00:00Z", data: {
  toolCallId: "tool", parentToolCallId: "parent-tool", agentId: "agent", success: false,
  result: { contents: [{ type: "text", text: "before" }, ...Array.from({ length: manyImages ? 5 : 1 }, () => ({ type: "image", mimeType: process.env.DAYNIGHT_TEST_BRIDGE_MIME || "image/png", data: media })), { type: "text", text: "after" }], structuredContent: { type: "image", data: "structured-data" } },
} };
let sends = 0;
const server = createServer(socket => {
  log({ connected: true });
  let buffer = Buffer.alloc(0);
  const write = (value) => { const body = JSON.stringify({ jsonrpc: "2.0", ...value }); socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); if (manyImages) log({ nativeMemory: process.memoryUsage() }); };
  const respond = (id, result) => write({ id, result });
  socket.on("error", () => {});
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      assert(Number.isSafeInteger(length)); if (buffer.length < end + 4 + length) return;
      const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length)); buffer = buffer.subarray(end + 4 + length);
      const { id, method, params } = request;
      log(method === "connect" ? { method } : request);
      if (method === "connect") { assert.equal(params.token, process.env.COPILOT_CONNECTION_TOKEN); respond(id, { protocolVersion: 3 }); }
      else if (method === "skills.getDiscoveryPaths") respond(id, { paths: [] });
      else if (method === "session.create") {
        if (process.env.DAYNIGHT_TEST_BRIDGE_MODE === "open-race") setTimeout(() => respond(id, { sessionId: params.sessionId }), 50);
        else respond(id, { sessionId: params.sessionId });
      } else if (method === "runtime.shutdown" && process.env.DAYNIGHT_TEST_BRIDGE_MODE === "graceful-shutdown") { respond(id, {}); socket.end(); server.close(); }
      else if (method === "session.permissions.handlePendingPermissionRequest" && params.requestId === "source-request") {
        assert.equal(params.result.kind, "reject");
        write({ method: "session.event", params: { sessionId: params.sessionId, event: { type: "permission.completed", id: "source-complete", data: { requestId: "source-request", result: { kind: "denied-interactively-by-user", feedback: params.result.feedback } } } } });
        respond(id, {});
      }
      else if (method === "session.options.update" || method === "session.destroy" || method === "runtime.shutdown" || method === "session.permissions.handlePendingPermissionRequest") respond(id, {});
      else if (method === "session.model.getCurrent") respond(id, { modelId: "fixture-model" });
      else if (method === "session.getMetadata") respond(id, { session: { sessionId: params.sessionId, isRemote: false, context: { cwd: process.cwd() } } });
      else if (method === "models.list") respond(id, { models: Array.from({ length: 500 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, description: "catalog".repeat(800), capabilities: { supports: { vision: true } } })) });
      else if (method === "session.send") {
        sends++;
        respond(id, { messageId: `sent-${sends}` });
        write({ method: "session.event", params: { sessionId: params.sessionId, event: { type: "permission.requested", id: "permission-event", data: { requestId: "permission-request", permissionRequest: { kind: "shell", fullCommandText: "echo fixture" } } } } });
      } else if (method === "session.eventLog.read") {
        if (params.cursor === "hold") continue;
        if (params.cursor === "forged") respond(id, { events: [{ type: "user.message", id: "forged-event", data: { attachments: [{ type: "blob", mimeType: "image/png", data: { kind: "copilot_bridge_image", path: "/private/secret", byteLength: "1", sha256: "a".repeat(64), mediaType: "image/png" } }] } }], cursor: "forged", hasMore: false, cursorStatus: "valid" });
        else if (params.cursor === "base64") respond(id, { events: [{ type: "user.message", id: "base64-event", data: { content: "keep text", attachments: [{ type: "blob", mimeType: "image/png", data: "eHk" }, { type: "blob", mimeType: "image/png", data: "not!base64" }] } }], cursor: "base64", hasMore: false, cursorStatus: "valid" });
        else respond(id, { events: [event], cursor: "cursor-1", hasMore: false, cursorStatus: "valid" });
      } else if (method === "ping") {
        if (typeof params.message === "string" && params.message.startsWith('{"kind":"source-permission"')) {
          const source = JSON.parse(params.message);
          write({ method: "session.event", params: { sessionId: "fixture-session", event: { type: "permission.requested", id: "source-requested", data: { requestId: "source-request", permissionRequest: { kind: "read", path: source.path, intention: source.intention } } } } }); respond(id, {});
        }
        else if (params.message === "emit") { write({ method: "session.event", params: { sessionId: "fixture-session", event } }); respond(id, {}); }
        else if (params.message === "malformed") socket.write("Content-Length: 134217729\r\n\r\n");
        else if (params.message === "hold") continue;
        else respond(id, { message: params.message, timestamp: 1 });
      } else write({ id, error: { code: -32601, message: `Unexpected fixture request: ${method}` } });
    }
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`Listening on port ${server.address().port}\n`));
