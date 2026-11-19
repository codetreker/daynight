import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
if (process.argv.includes("--version")) { process.stdout.write("2.1.247 (controlled fixture)\n"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
appendFileSync(process.env.DAYNIGHT_TEST_CLAUDE_RECOVERY_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { commands: [], models: [], account: {} } } }); return;
  }
  if (request.type !== "user") return;
  const entries = [{ type: "user", uuid: request.uuid, sessionId: request.session_id, message: request.message },
    { type: "assistant", uuid: randomUUID(), sessionId: request.session_id, message: { role: "assistant", content: "😀".repeat(60_000) } }];
  send({ type: "transcript_mirror", filePath: path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "fixture", `${request.session_id}.jsonl`), entries });
  send({ type: "result", subtype: "success", uuid: randomUUID(), session_id: request.session_id, parent_tool_use_id: null, user_message_uuid: request.uuid,
    is_error: false, result: "Controlled reply", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
});
