import { homedir } from "node:os";
import { join } from "node:path";
import { CodexControls } from "./controls-codex.js";
import { NativeTurns } from "./turns.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { InteractionResponse, SessionInteraction } from "../../../session/protocol.js";
import { NativeRpc, NativeRpcError, record, string, type NativeObject } from "./native-rpc.js";
import { CodexProjection, nativeEntryId, parseProviderArguments, readable, limited } from "./projection.js";
import { formInteraction, validateResponse } from "./interactions.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";

type Pending = { nativeId: unknown; interaction: SessionInteraction; result(response: InteractionResponse): unknown; settled?: () => void; rejected?: (error: Error) => void };
export const openCodexProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  const config = parseProviderArguments("codex", options.args);
  const executable = options.executable ?? "codex";
  const child: ChildProcessWithoutNullStreams = spawn(/\.[cm]?js$/i.test(executable) ? process.execPath : executable, [...(/\.[cm]?js$/i.test(executable) ? [executable] : []), "app-server", "--stdio"], { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
  options.onSpawn(child); child.stderr.on("data", data => options.onDiagnostic?.(String(data)));
  let nativeId = "", currentTurnId: string | null = null, activity: ProviderState["activity"] = "initializing", closed = false, closing = false, sending = false;
  let projection: CodexProjection;
  let turnStartedAt: string | null = null;
  let controls: CodexControls;
  const pending = new Map<string, Pending>(); const turns = new NativeTurns();
  const capabilities = { send: true, steer: true, cancel: true, respond: true };
  const state = () => options.onState({ nativeSessionId: nativeId || null, activity: pending.size ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value } : {}), capabilities: closed ? { send: false, steer: false, cancel: false, respond: false } : capabilities });
  const showInteraction = (value: Pending) => options.onTimeline({ entryId: value.interaction.interactionId, revision: value.interaction.revision, kind: "interaction", interaction: value.interaction });
  const expire = () => { for (const p of pending.values()) { p.interaction = { ...p.interaction, state: "expired", revision: "2" }; showInteraction(p); p.rejected?.(new Error("Native interaction expired before confirmation.")); } pending.clear(); };
  const request = (message: NativeObject) => {
    const params = record(message.params), method = string(message.method);
    if (!nativeId || params.threadId !== nativeId) { rpc.reject(message.id, "The request does not belong to this session."); return; }
    let interaction: SessionInteraction; let result: Pending["result"];
    const base = { interactionId: randomUUID(), revision: "1", state: "pending" as const };
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "acceptForSession", "decline"];
      const rejection = decisions.includes("decline") ? "decline" : "cancel";
      const actions = (["allow_once", "allow_session", "reject"] as const).filter(action => decisions.includes(action === "allow_once" ? "accept" : action === "allow_session" ? "acceptForSession" : rejection));
      interaction = { ...base, kind: "approval", title: method.includes("fileChange") ? "Approve file changes" : "Approve command", detail: limited(readable(params)), actions };
      result = r => { if (r.kind !== "approval") throw new Error("Expected approval response."); return { decision: r.action === "allow_once" ? "accept" : r.action === "allow_session" ? "acceptForSession" : rejection }; };
    } else if (method === "item/tool/requestUserInput") {
      interaction = { ...base, kind: "question", title: "Agent question", canDismiss: false, questions: (Array.isArray(params.questions) ? params.questions : []).map(raw => { const q = record(raw); return { questionId: string(q.id), label: string(q.question), options: (Array.isArray(q.options) ? q.options : []).map(raw => { const o = record(raw); return { id: string(o.label), label: string(o.label) + (o.description ? ` — ${string(o.description)}` : "") }; }), multiple: false, allowCustom: q.isOther !== false, required: true, sensitive: q.isSecret === true }; }) };
      result = r => { if (r.kind !== "question") throw new Error("Expected question response."); return { answers: Object.fromEntries(r.answers.map(a => [a.questionId, { answers: [...a.optionIds, ...(a.text ? [a.text] : [])] }])) }; };
    } else if (method === "mcpServer/elicitation/request" && ["form", "openai/form", "openaiForm"].includes(string(params.mode))) {
      try { interaction = formInteraction(string(params.message) || "Agent form", params.requestedSchema); } catch (error) { rpc.reject(message.id, String(error)); return; }
      result = r => ({ action: r.kind === "dismiss" ? "decline" : "accept", content: r.kind === "form" ? Object.fromEntries(r.values.map(v => [v.fieldId, v.value])) : null, _meta: null });
    } else { rpc.reject(message.id, `Unsupported native interaction: ${method}`); options.onTimeline({ entryId: randomUUID(), revision: "1", kind: "error", code: "unsupported_interaction", message: `Unsupported native interaction: ${method}` }); return; }
    const p = { nativeId: message.id, interaction, result }; pending.set(interaction.interactionId, p); showInteraction(p); state();
  };
  const projectItem = (raw: unknown, completed: boolean) => {
    const item = record(raw);
    if (item.type === "userMessage" && typeof item.clientId === "string") options.onInputObserved?.(item.clientId);
    projection?.item(item, completed);
  };
  const rpc = new NativeRpc(child, message => {
    if (message.id !== undefined) { request(message); return; }
    const method = string(message.method), p = record(message.params);
    if (p.threadId && nativeId && p.threadId !== nativeId) return;
    if (method === "thread/settings/updated") controls?.observe(p.threadSettings);
    if (method === "turn/started") { currentTurnId = string(record(p.turn).id); activity = "working"; turnStartedAt = new Date().toISOString(); state(); }
    if (method === "turn/completed") { const turn = record(p.turn); turns.complete(string(turn.id), turn.status === "completed" ? null : new Error(`Native turn ended with ${string(turn.status)}: ${readable(turn.error)}`)); if (!currentTurnId || record(p.turn).id === currentTurnId) { currentTurnId = null; turnStartedAt = null; activity = "idle"; expire(); state(); } }
    if (method === "item/started" || method === "item/completed") projectItem(p.item, method === "item/completed");
    if (method === "item/agentMessage/delta") projection?.delta(string(p.itemId), string(p.delta), "assistant_message");
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") projection?.delta(string(p.itemId), string(p.delta), "reasoning");
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") projection?.toolDelta(string(p.itemId), string(p.delta));
    if (method === "serverRequest/resolved") for (const [id, value] of pending) if (value.nativeId === p.requestId) { value.interaction = { ...value.interaction, state: "resolved", revision: "2" }; showInteraction(value); pending.delete(id); value.settled?.(); state(); }
    if (method === "error") options.onTimeline({ entryId: randomUUID(), revision: "1", kind: "error", code: "native_error", message: limited(readable(p.error ?? p)) });
    if (method === "turn/plan/updated") options.onTimeline({ entryId: nativeEntryId(nativeId, `plan:${string(p.turnId)}`), revision: "1", kind: "todo", items: (Array.isArray(p.plan) ? p.plan : []).map((raw, index) => { const item = record(raw); return { id: String(index), text: string(item.step), status: item.status === "completed" ? "completed" as const : item.status === "inProgress" ? "in_progress" as const : "pending" as const }; }) });
  });
  controls = new CodexControls(rpc, () => nativeId, () => currentTurnId, options.cwd, options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), state, options.onControlConfirmed, options.controlsRevisionFloor);
  child.once("close", () => {
    closed = true;
    const error = new Error("Native Codex connection ended; pending operation results are unknown.");
    if (currentTurnId) turns.complete(currentTurnId, error);
    currentTurnId = null; activity = closing ? "stopped" : "unknown"; expire(); state();
    if (!closing) options.onFatalError?.(error);
  });
  const close = async () => {
    closing = true; controls.close();
    if (closed) { rpc.dispose(); return; }
    const exited = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Native Codex stop is unconfirmed.")), 10_000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    child.stdin.end(); const kill = setTimeout(() => child.kill("SIGTERM"), 1_000); const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(kill); clearTimeout(force); rpc.dispose(); }
  };
  try {
    await rpc.request("initialize", { clientInfo: { name: "daynight", title: "Daynight Controller", version: "0.22.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized");
    const response = record(await rpc.request(options.resumeNativeSessionId ? "thread/resume" : "thread/start", { ...(options.resumeNativeSessionId ? { threadId: options.resumeNativeSessionId, excludeTurns: true } : {}), cwd: options.cwd, ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && config.sandbox ? { sandbox: config.sandbox } : {}), ...(!options.resumeNativeSessionId && config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}), config: { "features.default_mode_request_user_input": true } }));
    const thread = record(response.thread); nativeId = string(thread.id);
    if (!nativeId || options.resumeNativeSessionId && nativeId !== options.resumeNativeSessionId || await realpath(string(thread.cwd)) !== await realpath(options.cwd)) throw new Error("Native Codex session identity or working directory mismatch.");
    controls.seed({ ...response, ...(!options.resumeNativeSessionId && config.effort ? { effort: config.effort } : {}) });
    await controls.refresh();
    projection = new CodexProjection(nativeId, options.onTimeline);
    if (options.resumeNativeSessionId) {
      let cursor: string | null = null;
      do { const page = record(await rpc.request("thread/items/list", { threadId: nativeId, cursor, limit: 100, sortDirection: "asc" })); for (const raw of Array.isArray(page.data) ? page.data : []) projectItem(record(raw).item ?? raw, true); cursor = string(page.nextCursor) || null; } while (cursor);
    } else {
      // Persist an empty thread where supported; an absent native file is never guessed on recovery.
      await rpc.request("thread/read", { threadId: nativeId, includeTurns: true }).catch(error => { if (!(error instanceof NativeRpcError)) throw error; });
    }
    activity = "idle"; state();
  } catch (error) { await close(); throw error; }
  const send = async (text: string, operationId: string, expectedTurnId: string | null, skill?: { name: string; path: string }): Promise<ProviderReceipt> => {
      if (closed || sending || pending.size || expectedTurnId !== currentTurnId) throw new NativeRpcError(-32602, "Native turn changed or interaction is pending.");
      sending = true;
      try {
      const result = record(await rpc.request(currentTurnId ? "turn/steer" : "turn/start", { threadId: nativeId, ...(currentTurnId ? { expectedTurnId: currentTurnId } : {}), clientUserMessageId: operationId, input: [{ type: "text", text, text_elements: [] }, ...(skill ? [{ type: "skill", ...skill }] : [])], ...(!currentTurnId && (controls.store.value.settings.find(item => item.id === "effort")?.value ?? (options.resumeNativeSessionId ? undefined : config.effort)) ? { effort: controls.store.value.settings.find(item => item.id === "effort")?.value ?? (options.resumeNativeSessionId ? undefined : config.effort) } : {}) }));
      if (expectedTurnId) { if (result.turnId !== expectedTurnId) throw new Error("Native steer receipt is unknown."); return { disposition: "queued", turnId: expectedTurnId }; }
      const turn = record(result.turn); if (!string(turn.id)) throw new Error("Native turn receipt is unknown.");
      if (turn.status === "inProgress" && !turns.isComplete(string(turn.id))) { currentTurnId = string(turn.id); activity = "working"; state(); }
      return { disposition: "started", turnId: string(turn.id) };
      } finally { sending = false; }
  };
  return {
    nativeSessionId: nativeId, send,
    async refreshControls() { await controls.refresh(); return { disposition: "handled" }; },
    async setSetting(id, value, operationId, revision) { if (closed || sending) throw new NativeRpcError(-32602, "Native controls are busy."); await controls.set(id, value, operationId, revision); return { disposition: "handled" }; },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (closed || sending || currentTurnId !== null || expectedTurnId !== null || pending.size) throw new NativeRpcError(-32602, "Codex commands require an idle session.");
      const command = controls.command(id, revision);
      if (command.kind === "compact") { if (args.trim()) throw new NativeRpcError(-32602, "Compact does not accept arguments."); await rpc.request("thread/compact/start", { threadId: nativeId }); return { disposition: "handled" }; }
      if (command.kind === "skill") return send(args, operationId, null, { name: command.name, path: command.path });
      if (/\$(?!ARGUMENTS\b)(?:[A-Za-z_0-9{]|\$)/.test(command.body) || args.trim() && !command.body.includes("$ARGUMENTS")) throw new NativeRpcError(-32602, "This prompt supports only $ARGUMENTS placeholders.");
      return send(command.body.replace(/\$ARGUMENTS\b/g, () => args), operationId, null);
    },
    async cancel(expectedTurnId) { if (currentTurnId !== expectedTurnId) throw new NativeRpcError(-32602, "Native turn changed."); await rpc.request("turn/interrupt", { threadId: nativeId, turnId: expectedTurnId }); await turns.wait(expectedTurnId, Date.now() + 30_000).catch(error => { if (!turns.isComplete(expectedTurnId)) throw error; }); return { disposition: "handled" }; },
    async respond(interactionId, revision, response): Promise<ProviderReceipt> {
      const p = pending.get(interactionId); if (!p || revision !== p.interaction.revision || p.settled) throw new NativeRpcError(-32602, "Native interaction is stale."); validateResponse(p.interaction, response);
      const confirmed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Native interaction result is unknown.")), 30_000); p.settled = () => { clearTimeout(timer); resolve(); }; p.rejected = error => { clearTimeout(timer); reject(error); }; });
      rpc.respond(p.nativeId, p.result(response)); await confirmed; return { disposition: "handled" };
    }, waitForTurn: (turnId, deadline) => turns.wait(turnId, deadline), close,
  };
};
