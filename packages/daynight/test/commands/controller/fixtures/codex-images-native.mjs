import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const mode = process.env.CODEX_IMAGES_MODE ?? "normal";
let last = null;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line), { id, method, params } = request;
  if (process.env.CODEX_IMAGES_LOG) appendFileSync(process.env.CODEX_IMAGES_LOG, line + "\n");
  if (method === "initialize") out({ id, result: process.env.CODEX_IMAGES_COMPATIBLE === "1" ? { userAgent: "daynight/0.167.0 (Mac OS)", platformOs: "macos" } : { userAgent: "controlled-fixture", platformOs: process.platform } });
  if (method === "thread/start" || method === "thread/resume") out({ id, result: { model: "fixture-vision", modelProvider: "controlled", thread: { id: "images-thread", cwd: process.cwd() } } });
  if (method === "thread/read") out({ id, result: { thread: { id: "images-thread", cwd: process.cwd() } } });
  if (method === "model/list") out({ id, result: { data: [{ id: "fixture-vision", model: "fixture-vision", inputModalities: mode === "no-modality" ? ["text"] : ["text", "image"] }], nextCursor: null } });
  if (method === "skills/list") out({ id, result: { data: [] } });
  if (method === "configRequirements/read") out({ id, result: { requirements: null } });
  if (method === "thread/turns/list") out({ id, result: { data: [{ id: "history-turn", status: "completed", itemsView: "notLoaded" }], nextCursor: null } });
  if (method === "thread/items/list") {
    const items = JSON.parse(process.env.CODEX_IMAGES_HISTORY ?? "[]");
    const index = Number(params.cursor ?? 0), item = items[index];
    out({ id, result: { data: item ? [{ turnId: "history-turn", item }] : [], nextCursor: mode === "cursor-loop" ? "loop" : index + 1 < items.length ? String(index + 1) : null } });
  }
  if (method === "turn/start" || method === "turn/steer") {
    if (mode === "reject") { out({ id, error: { code: -32602, message: "Fixture input rejected." } }); continue; }
    const turnId = method === "turn/steer" ? params.expectedTurnId : "image-turn";
    const turn = { id: turnId, status: "inProgress" };
    if (method === "turn/start") out({ method: "turn/started", params: { threadId: "images-thread", turn } });
    if (!["response-only", "lost", "late", "wrong-turn", "wrong-start"].includes(mode)) out({ method: "item/completed", params: { threadId: "images-thread", turnId, item: { id: "user-" + id, type: "userMessage", clientId: params.clientUserMessageId, content: params.input } } });
    const result = method === "turn/steer" ? { turnId: mode === "wrong-turn" ? "wrong" : turnId } : { turn: mode === "wrong-start" ? { ...turn, id: "different-turn" } : turn };
    if (mode === "late") setTimeout(() => out({ id, result }), 100);
    else if (mode !== "lost") out({ id, result });
    last = turn;
  }
  if (method === "turn/interrupt") { out({ id, result: {} }); out({ method: "turn/completed", params: { threadId: "images-thread", turn: { ...last, status: "interrupted", items: [], itemsView: "full" } } }); }
}
