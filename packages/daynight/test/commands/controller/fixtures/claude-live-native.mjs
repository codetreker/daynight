import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
if (process.argv.includes("--version")) { process.stdout.write("2.1.247 (controlled fixture)\n"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const log = value => { if (process.env.DAYNIGHT_TEST_CLAUDE_LIVE_LOG) appendFileSync(process.env.DAYNIGHT_TEST_CLAUDE_LIVE_LOG, JSON.stringify(value) + "\n"); };
log({ event: "spawn", pid: process.pid });
if (process.env.DAYNIGHT_TEST_CLAUDE_HOLD_ON_EOF === "1") setInterval(() => {}, 1000);
process.on("SIGTERM", () => { log({ event: "stop", pid: process.pid }); process.exit(0); });
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "control_request") {
    const subtype = request.request.subtype;
    const response = subtype === "initialize" ? { commands: [], models: [{ value: "claude-sonnet-5-5", displayName: "Controlled vision", description: "Fixture", resolvedModel: "claude-sonnet-5-5" }], account: {} }
      : subtype === "get_settings" ? { applied: { model: "claude-sonnet-5-5", effort: null } } : {};
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } }); return;
  }
  if (request.type !== "user") return;
  const blocks = typeof request.message.content === "string" ? [{ type: "text", text: request.message.content }] : request.message.content;
  log({ event: "input", uuid: request.uuid, blocks: blocks.map(part => part.type === "image" ? { type: "image", sha256: createHash("sha256").update(Buffer.from(part.source.data, "base64")).digest("hex") } : part) });
  send({ type: "system", subtype: "init", session_id: request.session_id, model: "claude-sonnet-5-5", permissionMode: "default", capabilities: ["msg_lifecycle_v1", "interrupt_cancel_queued_v1"] });
  if (process.env.DAYNIGHT_TEST_CLAUDE_RESULT_ONLY) {
    const blocked = process.env.DAYNIGHT_TEST_CLAUDE_RESULT_ONLY === "blocked";
    send({ type: "result", subtype: blocked ? "error_during_execution" : "success", uuid: randomUUID(), session_id: request.session_id, parent_tool_use_id: null, user_message_uuid: request.uuid, is_error: blocked, num_turns: 0, ...(blocked ? { errors: ["UserPromptSubmit hook blocked this request"] } : { result: "" }) }); return;
  }
  if (process.env.DAYNIGHT_TEST_CLAUDE_LIVE_STRESS) {
    const oversized = process.env.DAYNIGHT_TEST_CLAUDE_LIVE_STRESS === "oversized", count = oversized ? 1 : 4, size = (oversized ? 25 : 9) * 1024 * 1024;
    const content = [{ type: "text", text: "before" }];
    for (let index = 0; index < count; index++) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(size, index + 1).toString("base64") } });
    content.push({ type: "text", text: "after" });
    const frame = JSON.stringify({ type: "assistant", uuid: randomUUID(), session_id: request.session_id, parent_tool_use_id: null, user_message_uuid: request.uuid, message: { id: "large-output", role: "assistant", content } });
    log({ event: "stress", frameBytes: Buffer.byteLength(frame), count, rawBytes: size * count });
    process.stdout.write(frame + "\n"); return;
  }
  send(request);
  send({ type: "assistant", uuid: randomUUID(), session_id: request.session_id, parent_tool_use_id: null, user_message_uuid: request.uuid, message: { id: "fixture-answer", role: "assistant", content: [{ type: "text", text: "Controlled reply" }] } });
  send({ type: "result", subtype: "success", uuid: randomUUID(), session_id: request.session_id, parent_tool_use_id: null, user_message_uuid: request.uuid, is_error: false, result: "Controlled reply", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
});
