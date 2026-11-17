#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) { console.log("codex-cli 0.167.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("app-server --stdio"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const cwd = process.cwd();
let threadId = null;
const settings = { cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null, model: "local-worker-peer", effort: "medium" };
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === undefined || method === "initialized") continue;
  if (method === "initialize") send({ id, result: { userAgent: "daynight/0.167.0 (Linux)" } });
  else if (method === "remoteControl/status/read") send({ id, result: { status: "disabled", environmentId: null } });
  else if (method === "thread/start" || method === "thread/resume") {
    threadId = method === "thread/start" ? randomUUID() : params.threadId;
    appendFileSync(process.env.DAYNIGHT_WORKER_PEER_LOG, JSON.stringify({ method, threadId }) + "\n");
    const thread = { id: threadId, sessionId: threadId, cwd, turns: [], environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }] };
    send({ id, result: { ...settings, sandbox: settings.sandboxPolicy, runtimeWorkspaceRoots: [cwd], thread } });
    send({ method: "thread/started", params: { thread } });
  } else if (method === "config/read") send({ id, result: { config: {} } });
  else if (method === "thread/read") send({ id, result: { thread: { id: threadId, cwd, turns: [] } } });
  else if (method === "model/list") send({ id, result: { data: [{ id: settings.model, model: settings.model }], nextCursor: null } });
  else if (method === "configRequirements/read") send({ id, result: { requirements: null } });
  else if (method === "skills/list") send({ id, result: { data: [] } });
  else if (method === "hooks/list") send({ id, result: { data: [{ cwd, hooks: [], warnings: [], errors: [] }] } });
  else if (method === "thread/items/list" || method === "thread/turns/list") send({ id, result: { data: [], nextCursor: null } });
  else if (method === "turn/start") {
    const turnId = randomUUID(), turn = { id: turnId, status: "inProgress" };
    const item = { id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input };
    appendFileSync(process.env.DAYNIGHT_WORKER_PEER_LOG, JSON.stringify({ method, threadId, text: params.input.map(part => part.text ?? "").join("\n") }) + "\n");
    send({ method: "turn/started", params: { threadId, turn } });
    send({ method: "item/completed", params: { threadId, turnId, item } });
    send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed", items: [item], itemsView: "full" } } });
    send({ id, result: { turn } });
  } else send({ id, error: { code: -32601, message: `Unsupported native fixture method: ${method}` } });
}
