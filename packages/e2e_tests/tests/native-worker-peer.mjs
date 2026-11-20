#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Task Sessions use the read-authority profile pinned to 0.167.0. Hosted Bots
// require the verified 0.169.0 legacy rollout profile, whose recovery point is
// captured from the rollout file named by the native thread.
const botId = process.env.DAYNIGHT_BOT_ID ?? null, bot = botId !== null;
const version = bot ? "0.169.0" : "0.167.0";
if (process.argv.includes("--version")) { console.log(`codex-cli ${version}`); process.exit(0); }
if (process.argv.includes("--help")) { console.log("app-server --stdio"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const cwd = process.cwd();
let threadId = null, rollout = null;
const settings = { cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null, model: "local-worker-peer", effort: "medium" };
const record = (type, payload) => { if (rollout !== null) appendFileSync(rollout, JSON.stringify({ type, payload }) + "\n"); };
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === undefined || method === "initialized") continue;
  if (method === "initialize") send({ id, result: { userAgent: `daynight/${version} (Linux)` } });
  else if (method === "remoteControl/status/read") send({ id, result: { status: "disabled", environmentId: null } });
  else if (method === "thread/start" || method === "thread/resume") {
    threadId = method === "thread/start" ? randomUUID() : params.threadId;
    if (bot) {
      const sessions = path.join(path.dirname(process.env.DAYNIGHT_WORKER_PEER_LOG), "bot-sessions");
      mkdirSync(sessions, { recursive: true });
      rollout = params.path ?? path.join(realpathSync(sessions), `${threadId}.jsonl`);
    }
    appendFileSync(process.env.DAYNIGHT_WORKER_PEER_LOG, JSON.stringify({ method, threadId, botId }) + "\n");
    const thread = { id: threadId, sessionId: threadId, cwd, turns: [], environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }],
      ...(bot ? { path: rollout, historyMode: "legacy" } : {}) };
    send({ id, result: { ...settings, sandbox: settings.sandboxPolicy, runtimeWorkspaceRoots: [cwd], thread } });
    send({ method: "thread/started", params: { thread } });
  } else if (method === "thread/name/set") {
    // Naming materializes the empty legacy rollout with its Session metadata.
    if (rollout !== null && !existsSync(rollout)) writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd, cli_version: version } }) + "\n");
    send({ id, result: {} });
    send({ method: "thread/name/updated", params: { threadId, threadName: params.name } });
  } else if (method === "config/read") send({ id, result: { config: {} } });
  else if (method === "thread/read") send({ id, result: { thread: { id: threadId, cwd, turns: [] } } });
  else if (method === "model/list") send({ id, result: { data: [{ id: settings.model, model: settings.model }], nextCursor: null } });
  else if (method === "configRequirements/read") send({ id, result: { requirements: null } });
  else if (method === "skills/list") send({ id, result: { data: [] } });
  else if (method === "hooks/list") send({ id, result: { data: [{ cwd, hooks: [], warnings: [], errors: [] }] } });
  else if (method === "thread/items/list" || method === "thread/turns/list") send({ id, result: { data: [], nextCursor: null } });
  else if (method === "turn/start" && (threadId === null || params.threadId !== threadId)) {
    // A real app-server addresses turns by thread; a misaddressed turn must not appear delivered.
    send({ id, error: { code: -32602, message: `Unknown native fixture thread: ${params.threadId}` } });
  } else if (method === "turn/start") {
    const turnId = randomUUID(), turn = { id: turnId, status: "inProgress" };
    const item = { id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input };
    appendFileSync(process.env.DAYNIGHT_WORKER_PEER_LOG, JSON.stringify({ method, threadId, botId, text: params.input.map(part => part.text ?? "").join("\n") }) + "\n");
    record("event_msg", { type: "task_started", turn_id: turnId });
    send({ method: "turn/started", params: { threadId, turn } });
    send({ method: "item/completed", params: { threadId, turnId, item } });
    // The rollout covers the turn before its completion becomes observable.
    record("event_msg", { type: "task_complete", turn_id: turnId });
    send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed", items: [item], itemsView: "full" } } });
    send({ id, result: { turn } });
  } else send({ id, error: { code: -32601, message: `Unsupported native fixture method: ${method}` } });
}
