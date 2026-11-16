#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const cwd = process.cwd(), threadId = randomUUID(), turnId = randomUUID();
const settings = { cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null, model: "local-image-peer", effort: "medium" };
const image = readFileSync("plot.png").toString("base64");
const items = [];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === undefined || method === "initialized") continue;
  if (method === "initialize") send({ id, result: { userAgent: "daynight/0.167.0 (Linux)" } });
  else if (method === "remoteControl/status/read") {
    if (process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== "1") throw new Error("Native remote control was not disabled.");
    send({ id, result: { status: "disabled", environmentId: null } });
  } else if (method === "thread/start") {
    const thread = { id: threadId, sessionId: threadId, cwd, turns: [], environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }] };
    send({ id, result: { ...settings, sandbox: settings.sandboxPolicy, runtimeWorkspaceRoots: [cwd], thread } });
    send({ method: "thread/started", params: { thread } });
  } else if (method === "config/read") send({ id, result: { config: {} } });
  else if (method === "thread/read") send({ id, result: { thread: { id: threadId, cwd, turns: [] } } });
  else if (method === "model/list") send({ id, result: { data: [{ id: settings.model, model: settings.model }], nextCursor: null } });
  else if (method === "configRequirements/read") send({ id, result: { requirements: null } });
  else if (method === "skills/list") send({ id, result: { data: [] } });
  else if (method === "hooks/list") send({ id, result: { data: [{ cwd, hooks: [], warnings: [], errors: [] }] } });
  else if (method === "thread/items/list") send({ id, result: { data: items.map(item => ({ turnId, item, completedAtMs: 1 })), nextCursor: null } });
  else if (method === "turn/start") {
    const turn = { id: turnId, status: "inProgress" };
    send({ method: "turn/started", params: { threadId, turn } });
    items.push({ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input });
    items.push({ id: randomUUID(), type: "mcpToolCall", server: "local", tool: "render_plot", arguments: {}, status: "completed", result: { content: [{ type: "image", mimeType: "image/png", data: image }] } });
    items.push({ id: randomUUID(), type: "agentMessage", text: "Saved plot: ![Markdown plot](plot.png)" });
    for (const item of items) send({ method: "item/completed", params: { threadId, turnId, item } });
    send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed", items, itemsView: "full" } } });
    send({ id, result: { turn } });
  } else send({ id, error: { code: -32601, message: `Unsupported native fixture method: ${method}` } });
}
