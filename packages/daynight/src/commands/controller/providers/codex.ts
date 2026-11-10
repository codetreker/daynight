import { nativeInputText, textNativeInput } from "./native-input.js";
import type { NativeInput } from "./types.js";
import { codexAgentCliOverrides } from "../../../cli/codex-agent-environment.js";
import { codexNativeHome } from "./codex-settings-metadata.js";
import { CodexInterruptions } from "./codex-interruptions.js";
import { CodexControls } from "./controls-codex.js";
import { persistCodexInitialSettings } from "./codex-initial-settings.js";
import { CodexErrors } from "./codex-errors.js";
import { codexApprovalDetail } from "./codex-approval-detail.js";
import { NativeTurns } from "./turns.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { InteractionResponse, SessionInteraction } from "../../../session/protocol.js";
import { NativeRpc, NativeRpcError, record, string, type NativeObject } from "./native-rpc.js";
import { CodexProjection, nativeEntryId, parseProviderArguments, readable } from "./projection.js";
import { formInteraction, validateResponse } from "./interactions.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";

type Pending = { nativeId: unknown; interaction: SessionInteraction; result(response: InteractionResponse): unknown; settled?: () => void; rejected?: (error: Error) => void };
export const openCodexProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  const config = parseProviderArguments("codex", options.args, options.validateNativeSelection);
  const executable = options.executable ?? "codex";
  const childEnvironment = { ...(options.env ?? process.env) };
  const nativeHome = codexNativeHome(childEnvironment, options.cwd);
  const child: ChildProcessWithoutNullStreams = spawn(/\.[cm]?js$/i.test(executable) ? process.execPath : executable, [...(/\.[cm]?js$/i.test(executable) ? [executable] : []), "app-server", "--stdio"], { cwd: options.cwd, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
  options.onSpawn(child); child.stderr.on("data", data => options.onDiagnostic?.(String(data)));
  let nativeId = "", currentTurnId: string | null = null, activity: ProviderState["activity"] = "initializing", closed = false, closing = false, sending = false;
  let projection: CodexProjection;
  const interruptions = new CodexInterruptions(() => nativeId, options.onTimeline, options.hasTimelineEntry);
  const completing = new Set<string>();
  const terminalProjections = new Set<Promise<void>>();
  let turnStartedAt: string | null = null;
  let controls: CodexControls;
  const initialSettingsAbort = new AbortController(); let awaitingInitialSettings = false;
  const pending = new Map<string, Pending>(); const turns = new NativeTurns();
  const approvalItems = new Map<string, NativeObject>();
  const errors = new CodexErrors(options.onTimeline);
  const capabilities = { send: true, steer: true, cancel: true, respond: true };
  const state = () => options.onState({ nativeSessionId: nativeId || null, activity: pending.size ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value } : {}), capabilities: closed ? { send: false, steer: false, cancel: false, respond: false } : capabilities });
  const showInteraction = (value: Pending) => options.onTimeline({ entryId: value.interaction.interactionId, revision: value.interaction.revision, kind: "interaction", interaction: value.interaction });
  const expire = () => { for (const p of pending.values()) { p.interaction = { ...p.interaction, state: "expired", revision: "2" }; showInteraction(p); p.rejected?.(new Error("Native interaction expired before confirmation.")); } pending.clear(); approvalItems.clear(); };
  const request = (message: NativeObject) => {
    const params = record(message.params), method = string(message.method);
    if (!nativeId || params.threadId !== nativeId) { rpc.reject(message.id, "The request does not belong to this session."); return; }
    let interaction: SessionInteraction; let result: Pending["result"];
    const base = { interactionId: randomUUID(), revision: "1", state: "pending" as const };
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "acceptForSession", "decline"];
      const rejection = decisions.includes("decline") ? "decline" : "cancel";
      const actions = (["allow_once", "allow_session", "reject"] as const).filter(action => decisions.includes(action === "allow_once" ? "accept" : action === "allow_session" ? "acceptForSession" : rejection));
      const item = params.turnId === currentTurnId ? approvalItems.get(string(params.itemId)) : undefined;
      interaction = { ...base, kind: "approval", title: method.includes("fileChange") ? "Approve file changes" : "Approve command", detail: codexApprovalDetail(method, params, item), actions };
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
  const projectItem = (raw: unknown, completed: boolean, turnId = "") => {
    const item = interruptions.item(turnId, record(raw));
    if (item.type === "userMessage" && typeof item.clientId === "string") options.onInputObserved?.(item.clientId);
    projection?.item(item, completed);
  };
  const readItems = async (turnId?: string, usersOnly = false, turnComplete = false): Promise<boolean> => {
    let cursor: string | null = null;
    do {
      const page = record(await rpc.request("thread/items/list", { threadId: nativeId, ...(turnId ? { turnId } : {}), cursor, limit: 100, sortDirection: "asc" }));
      if (closed || closing) return false;
      for (const raw of Array.isArray(page.data) ? page.data : []) {
        const entry = record(raw), item = record(entry.item ?? raw);
        if (turnId && entry.turnId && entry.turnId !== turnId) continue;
        if (!usersOnly || item.type === "userMessage") projectItem(item, item.type === "userMessage" || turnComplete || typeof entry.completedAtMs === "number", string(entry.turnId) || turnId || "");
      }
      cursor = string(page.nextCursor) || null;
    } while (cursor);
    return true;
  };
  const projectInterrupted = async (turn: NativeObject) => {
    const id = string(turn.id);
    for (const item of Array.isArray(turn.items) ? turn.items : []) if (record(item).type === "userMessage") projectItem(item, true, id);
    // A native completion can share a stdout chunk with a steer rejection. Wait
    // for the dispatch continuation before preserving unobserved input; turn
    // state and cancel confirmation are settled independently by finishTurn.
    const dispatch = interruptions.settlement(id);
    if (dispatch) await dispatch;
    let completeHistory = turn.itemsView === "full";
    interruptions.completed(turn, completeHistory ? true : null);
    if (!completeHistory && interruptions.missing(id) && !closed && !closing) {
      try { completeHistory = await readItems(id, true); }
      catch (error) { options.onDiagnostic?.(`Native interrupted-turn input could not be read: ${String(error)}`); }
    }
    interruptions.completed(turn, completeHistory);
    interruptions.finished(id);
  };
  const finishTurn = (turn: NativeObject) => {
    if (turn.status !== "interrupted") interruptions.finished(string(turn.id));
    turns.complete(string(turn.id), turn.status === "completed" ? null : new Error(`Native turn ended with ${string(turn.status)}: ${readable(turn.error)}`));
    if (!currentTurnId || turn.id === currentTurnId) { currentTurnId = null; turnStartedAt = null; activity = "idle"; expire(); state(); }
  };
  const rpc = new NativeRpc(child, message => {
    if (message.id !== undefined) { request(message); return; }
    const method = string(message.method), p = record(message.params);
    if (p.threadId && nativeId && p.threadId !== nativeId && (method !== "error" || typeof p.threadId === "string")) return;
    if (method === "thread/settings/updated") controls?.observe(p.threadSettings);
    if (method === "turn/started") { approvalItems.clear(); errors.started(); currentTurnId = string(record(p.turn).id); interruptions.started(currentTurnId); activity = "working"; turnStartedAt = new Date().toISOString(); state(); }
    if (method === "turn/completed") {
      const turn = record(p.turn), id = string(turn.id);
      errors.completed(p, nativeId);
      if (turn.status === "interrupted" && p.threadId === nativeId && id) {
        if (!completing.has(id)) {
          completing.add(id);
          const terminal = projectInterrupted(turn)
            .catch(error => { options.onFatalError?.(error instanceof Error ? error : new Error(String(error))); })
            .finally(() => { terminalProjections.delete(terminal); });
          terminalProjections.add(terminal);
        }
      }
      finishTurn(turn);
    }
    if (method === "item/started" || method === "item/completed") {
      const item = record(p.item), id = string(item.id);
      // Approval requests omit file changes; only their matching live item supplies them.
      if (p.threadId === nativeId && currentTurnId && p.turnId === currentTurnId && id) {
        if (method === "item/completed") approvalItems.delete(id);
        else if (item.type === "commandExecution" || item.type === "fileChange") approvalItems.set(id, item);
      }
      projectItem(p.item, method === "item/completed", string(p.turnId));
    }
    if (method === "item/agentMessage/delta") projection?.delta(string(p.itemId), string(p.delta), "assistant_message");
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") projection?.delta(string(p.itemId), string(p.delta), "reasoning");
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") projection?.toolDelta(string(p.itemId), string(p.delta));
    if (method === "serverRequest/resolved") for (const [id, value] of pending) if (value.nativeId === p.requestId) { value.interaction = { ...value.interaction, state: "resolved", revision: "2" }; showInteraction(value); pending.delete(id); value.settled?.(); state(); }
    if (method === "error") { errors.notification(p, nativeId, currentTurnId); if (awaitingInitialSettings) initialSettingsAbort.abort(new Error("Native Codex rejected initial settings asynchronously.")); }
    if (method === "turn/plan/updated") options.onTimeline({ entryId: nativeEntryId(nativeId, `plan:${string(p.turnId)}`), revision: "1", kind: "todo", items: (Array.isArray(p.plan) ? p.plan : []).map((raw, index) => { const item = record(raw); return { id: String(index), text: string(item.step), status: item.status === "completed" ? "completed" as const : item.status === "inProgress" ? "in_progress" as const : "pending" as const }; }) });
  });
  controls = new CodexControls(rpc, () => nativeId, () => currentTurnId, options.cwd, nativeHome, state, options.onControlConfirmed, options.controlsRevisionFloor);
  child.once("close", () => {
    initialSettingsAbort.abort(new Error("Native Codex closed before initial settings persistence was confirmed."));
    closed = true;
    const error = new Error("Native Codex connection ended; pending operation results are unknown.");
    if (currentTurnId) turns.complete(currentTurnId, error);
    currentTurnId = null; activity = closing ? "stopped" : "unknown"; expire(); state();
    if (!closing) options.onFatalError?.(error);
  });
  const close = async () => {
    initialSettingsAbort.abort(new Error("Native Codex stopped before initial settings persistence was confirmed."));
    closing = true; controls.close();
    if (closed) { rpc.dispose(); await Promise.all(terminalProjections); return; }
    const exited = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Native Codex stop is unconfirmed.")), 10_000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    child.stdin.end(); const kill = setTimeout(() => child.kill("SIGTERM"), 1_000); const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally {
      clearTimeout(kill); clearTimeout(force); rpc.dispose();
      // Closing transport settles unknown dispatches and history reads. Finish
      // their known terminal projection before the owner can close its journal.
      await Promise.all(terminalProjections);
    }
  };
  try {
    await rpc.request("initialize", { clientInfo: { name: "daynight", title: "Daynight Controller", version: "0.22.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized");
    const aliasOverrides = options.agentCliEnvironment
      ? codexAgentCliOverrides(options.agentCliEnvironment, await rpc.request("config/read", { cwd: options.cwd, includeLayers: false }))
      : {};
    const response = record(await rpc.request(options.resumeNativeSessionId ? "thread/resume" : "thread/start", { ...(options.resumeNativeSessionId ? { threadId: options.resumeNativeSessionId, excludeTurns: true } : {}), cwd: options.cwd, ...(options.instructions !== undefined ? { developerInstructions: options.instructions } : {}), ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && options.unattended ? { sandbox: "danger-full-access", approvalPolicy: "never" } : {}), ...(!options.resumeNativeSessionId && !options.unattended && config.sandbox ? { sandbox: config.sandbox } : {}), ...(!options.resumeNativeSessionId && !options.unattended && config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}), config: { "features.default_mode_request_user_input": true, ...(!options.resumeNativeSessionId && config.effort ? { model_reasoning_effort: config.effort } : {}), ...aliasOverrides } }));
    const thread = record(response.thread); nativeId = string(thread.id);
    if (!nativeId || options.resumeNativeSessionId && nativeId !== options.resumeNativeSessionId || await realpath(string(thread.cwd)) !== await realpath(options.cwd)) throw new Error("Native Codex session identity or working directory mismatch.");
    controls.seed({ ...response, ...(!options.resumeNativeSessionId && config.effort ? { effort: config.effort } : {}) });
    await controls.refresh();
    if (options.validateNativeSelection && !options.resumeNativeSessionId) controls.validateSelection({ model: options.model, ...(config.effort === undefined ? {} : { effort: config.effort }) });
    projection = new CodexProjection(nativeId, options.onTimeline);
    if (options.resumeNativeSessionId) {
      let cursor: string | null = null, readTurns = false;
      try {
        do {
          const page = record(await rpc.request("thread/turns/list", { threadId: nativeId, cursor, limit: 100, sortDirection: "asc", itemsView: "notLoaded" }));
          readTurns = true;
          for (const raw of Array.isArray(page.data) ? page.data : []) {
            const turn = record(raw), id = string(turn.id);
            if (!id) throw new Error("Native history turn identity is unavailable.");
            const completeHistory = await readItems(id, false, ["completed", "interrupted", "failed"].includes(string(turn.status)));
            interruptions.completed(turn, completeHistory);
          }
          cursor = string(page.nextCursor) || null;
        } while (cursor);
      } catch (error) {
        if (!(error instanceof NativeRpcError) || error.code !== -32601 || readTurns) throw error;
        // Older app servers expose items without terminal turn status.
        await readItems();
      }
    } else {
      const hasInitialSettings = Boolean(options.model || config.effort);
      // Persist an empty thread where supported; an absent native file is never guessed on recovery.
      await rpc.request("thread/read", { threadId: nativeId, includeTurns: true }).catch(error => {
        if (!(error instanceof NativeRpcError) || hasInitialSettings && (error.code !== -32601 || error.message !== "list_turns is not supported yet")) throw error;
      });
      if (hasInitialSettings) {
        awaitingInitialSettings = true;
        try {
          await persistCodexInitialSettings({ path: thread.path, home: nativeHome, cwd: options.cwd, threadId: nativeId,
            env: childEnvironment,
            readConfiguration: async () => { const [config, requirements] = await Promise.all([rpc.request("config/read", { cwd: options.cwd, includeLayers: false }), rpc.request("configRequirements/read", {})]); return { config, requirements }; },
            expected: { ...(options.model ? { model: options.validateNativeSelection ? string(response.model) : options.model } : {}), ...(config.effort ? { effort: config.effort } : {}) }, signal: initialSettingsAbort.signal,
            update: () => rpc.request("thread/settings/update", { threadId: nativeId, ...(options.model ? { model: options.model } : {}), ...(config.effort ? { effort: config.effort } : {}) }) });
        } finally { awaitingInitialSettings = false; }
      }
    }
    activity = "idle"; state();
  } catch (error) { await close(); throw error; }
  const send = async (inputValue: NativeInput, operationId: string, expectedTurnId: string | null, skill?: { name: string; path: string }): Promise<ProviderReceipt> => {
      const text = nativeInputText(inputValue);
      if (closed || sending || pending.size || expectedTurnId !== currentTurnId) throw new NativeRpcError(-32602, "Native turn changed or interaction is pending.");
      sending = true;
      interruptions.submitting(operationId, text, expectedTurnId);
      try {
      const result = record(await rpc.request(currentTurnId ? "turn/steer" : "turn/start", { threadId: nativeId, ...(currentTurnId ? { expectedTurnId: currentTurnId } : {}), clientUserMessageId: operationId, input: [{ type: "text", text, text_elements: [] }, ...(skill ? [{ type: "skill", ...skill }] : [])], ...(!currentTurnId && (controls.store.value.settings.find(item => item.id === "effort")?.value ?? (options.resumeNativeSessionId ? undefined : config.effort)) ? { effort: controls.store.value.settings.find(item => item.id === "effort")?.value ?? (options.resumeNativeSessionId ? undefined : config.effort) } : {}) }));
      if (expectedTurnId) { if (result.turnId !== expectedTurnId) throw new Error("Native steer receipt is unknown."); interruptions.accepted(operationId, expectedTurnId); return { disposition: "queued", turnId: expectedTurnId }; }
      const turn = record(result.turn); if (!string(turn.id)) throw new Error("Native turn receipt is unknown.");
      interruptions.accepted(operationId, string(turn.id));
      if (turn.status === "inProgress" && !turns.isComplete(string(turn.id))) { currentTurnId = string(turn.id); activity = "working"; state(); }
      return { disposition: "started", turnId: string(turn.id) };
      } catch (error) {
        if (error instanceof NativeRpcError) interruptions.rejected(operationId);
        throw error;
      } finally { sending = false; interruptions.dispatched(operationId); }
  };
  return {
    nativeSessionId: nativeId, send,
    async refreshControls() { await controls.refresh(); return { disposition: "handled" }; },
    async setSetting(id, value, operationId, revision) { if (closed || sending) throw new NativeRpcError(-32602, "Native controls are busy."); await controls.set(id, value, operationId, revision); return { disposition: "handled" }; },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (closed || sending || currentTurnId !== null || expectedTurnId !== null || pending.size) throw new NativeRpcError(-32602, "Codex commands require an idle session.");
      const command = controls.command(id, revision);
      if (command.kind === "compact") { if (args.trim()) throw new NativeRpcError(-32602, "Compact does not accept arguments."); await rpc.request("thread/compact/start", { threadId: nativeId }); return { disposition: "handled" }; }
      if (command.kind === "skill") return send(textNativeInput(args), operationId, null, { name: command.name, path: command.path });
      if (/\$(?!ARGUMENTS\b)(?:[A-Za-z_0-9{]|\$)/.test(command.body) || args.trim() && !command.body.includes("$ARGUMENTS")) throw new NativeRpcError(-32602, "This prompt supports only $ARGUMENTS placeholders.");
      return send(textNativeInput(command.body.replace(/\$ARGUMENTS\b/g, () => args)), operationId, null);
    },
    async cancel(expectedTurnId) { if (currentTurnId !== expectedTurnId) throw new NativeRpcError(-32602, "Native turn changed."); await rpc.request("turn/interrupt", { threadId: nativeId, turnId: expectedTurnId }); await turns.wait(expectedTurnId, Date.now() + 30_000).catch(error => { if (!turns.isComplete(expectedTurnId)) throw error; }); return { disposition: "handled" }; },
    async respond(interactionId, revision, response): Promise<ProviderReceipt> {
      const p = pending.get(interactionId); if (!p || revision !== p.interaction.revision || p.settled) throw new NativeRpcError(-32602, "Native interaction is stale."); validateResponse(p.interaction, response);
      const confirmed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Native interaction result is unknown.")), 30_000); p.settled = () => { clearTimeout(timer); resolve(); }; p.rejected = error => { clearTimeout(timer); reject(error); }; });
      rpc.respond(p.nativeId, p.result(response)); await confirmed; return { disposition: "handled" };
    }, waitForTurn: (turnId, deadline) => turns.wait(turnId, deadline), close,
  };
};
