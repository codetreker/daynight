import { ClaudeControls, type ClaudeControlQuery } from "./controls-claude.js";
import { NativeTurns } from "./turns.js";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { query, getSessionInfo, getSessionMessages, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { InteractionResponse, SessionInteraction } from "../../../session/protocol.js";
import { record, string, NativeRpcError } from "./native-rpc.js";
import { nativeEntryId, parseProviderArguments, readable, limited } from "./projection.js";
import { formInteraction, validateResponse } from "./interactions.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";

class InputStream implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []; private wake: (() => void) | null = null; private closed = false;
  push(message: SDKUserMessage): void { if (this.closed) throw new Error("Native input is closed."); this.items.push(message); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> { while (!this.closed) { const item = this.items.shift(); if (item) { yield item; continue; } await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = null; } }
}
const deadline = <T>(promise: Promise<T>, message: string, ms = 30_000): Promise<T> => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(message)), ms); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
type PendingInteraction = { interaction: SessionInteraction; resolve(response: InteractionResponse): void; reject(error: Error): void; nativeToolId: string | null; turnId: string | null; submitted: boolean; confirm?: () => void; rejectConfirmation?: (error: Error) => void };
export const openClaudeProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  const config = parseProviderArguments("claude", options.args), input = new InputStream();
  const nativeId = options.resumeNativeSessionId ?? randomUUID();
  const capabilities = { send: true, steer: false, cancel: true, respond: true };
  let currentTurnId: string | null = null, activity: ProviderState["activity"] = "initializing", closed = false, verified = false, disconnected = false;
  let controls: ClaudeControls | undefined, turnStartedAt: string | null = null;
  let cancellation: { turnId: string; acknowledged: boolean; result?: unknown } | undefined;
  const steered = new Map<string, { text: string; started: boolean; resolve(value: ProviderReceipt): void; reject(error: Error): void }>();
  const children: ChildProcessWithoutNullStreams[] = [], interactions = new Map<string, PendingInteraction>();
  const accepted = new Map<string, { resolve(): void; reject(error: Error): void }>(); const cancelWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const state = () => options.onState({ nativeSessionId: verified ? nativeId : null, activity: interactions.size ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value } : {}), capabilities: closed || disconnected ? { send: false, steer: false, cancel: false, respond: false } : capabilities });
  let identityResolve!: () => void; let identityReject!: (error: Error) => void;
  const identity = new Promise<void>((resolve, reject) => { identityResolve = resolve; identityReject = reject; });
  void identity.catch(() => {});
  const verify = (sessionId: unknown) => { if (sessionId !== nativeId) { const error = new Error("Native Claude session identity mismatch."); identityReject(error); throw error; } if (!verified) { verified = true; identityResolve(); state(); } };
  const publishInteraction = (interaction: SessionInteraction) => options.onTimeline({ entryId: interaction.interactionId, revision: interaction.revision, kind: "interaction", interaction });
  const ask = (interaction: SessionInteraction, signal: AbortSignal, nativeToolId: string | null = null): Promise<InteractionResponse> => new Promise((resolve, reject) => {
    const abort = () => { const pending = interactions.get(interaction.interactionId); if (!pending) return; interactions.delete(interaction.interactionId); publishInteraction({ ...interaction, revision: "2", state: "expired" }); const error = new Error("Native interaction expired."); reject(error); pending.rejectConfirmation?.(error); state(); };
    if (signal.aborted) { reject(new Error("Native interaction expired.")); return; }
    signal.addEventListener("abort", abort, { once: true });
    interactions.set(interaction.interactionId, { interaction, nativeToolId, turnId: currentTurnId, submitted: false, resolve: response => { signal.removeEventListener("abort", abort); resolve(response); }, reject }); publishInteraction(interaction); state();
  });
  const turns = new NativeTurns();
  const confirmInteraction = (id: string, pending: PendingInteraction) => {
    if (!pending.submitted) return;
    interactions.delete(id); publishInteraction({ ...pending.interaction, state: "resolved", revision: "2" }); pending.confirm?.(); state();
  };
  const withdrawInput = (id: string) => {
    const item = steered.get(id); if (!item) return;
    steered.delete(id); item.reject(new NativeRpcError(-32602, "Native queued input was stopped before execution."));
    if (!item.started) options.onTimeline({ entryId: nativeEntryId(nativeId, `cancelled:${id}`), revision: "1", kind: "error", code: "input_cancelled", message: "Queued input was stopped before execution." });
  };
  const tools = new Map<string, { name: string; input: string }>();
  const textBlocks = new Map<string, { text: string; kind: "text" | "thinking" }>();
  const streamKeys = new Map<string, string>(), assistantKeys = new Map<string, string>();
  const streamOrdinals = new Map<string, number>(), assistantOrdinals = new Map<string, number>();
  const blockKey = (keys: Map<string, string>, ordinals: Map<string, number>, source: string, messageId: string, kind: string): string => {
    const existing = keys.get(source); if (existing) return existing;
    const group = `${messageId}:${kind}`, ordinal = ordinals.get(group) ?? 0;
    const key = `${group}:${ordinal}`; ordinals.set(group, ordinal + 1); keys.set(source, key); return key;
  };
  let streamingMessageId = "";
  const project = (raw: unknown, history = false) => {
    const m = record(raw), message = record(m.message), type = string(m.type);
    if (m.session_id !== undefined) verify(m.session_id);
    if (!history && !m.parent_tool_use_id && type === "system") {
      controls?.observe(m);
      if (m.subtype === "init") { const declared = Array.isArray(m.capabilities) ? m.capabilities : []; capabilities.steer = ["msg_lifecycle_v1", "interrupt_cancel_queued_v1"].every(value => declared.includes(value)); state(); }
    }
    if (!history && !m.parent_tool_use_id && type === "command_lifecycle") {
      const id = string(m.command_uuid);
      if (m.state === "started" && currentTurnId === id && !turnStartedAt) { turnStartedAt = new Date().toISOString(); state(); }
      const item = steered.get(id); if (!item) return;
      if (m.state === "queued") { item.resolve({ disposition: "queued", ...(currentTurnId ? { turnId: currentTurnId } : {}) }); options.onInputObserved?.(id); }
      if (m.state === "started") {
        item.started = true;
        if (!currentTurnId) { currentTurnId = id; turnStartedAt = new Date().toISOString(); activity = "working"; }
        item.resolve({ disposition: "handled", turnId: currentTurnId }); options.onInputObserved?.(id); state();
      }
      if (m.state === "cancelled") withdrawInput(id);
      if (m.state === "completed") steered.delete(id);
      return;
    }
    if (type === "stream_event") {
      const e = record(m.event), delta = record(e.delta), block = record(e.content_block);
      if (e.type === "message_start") { streamingMessageId = string(record(e.message).id); if (!m.parent_tool_use_id && currentTurnId && !turnStartedAt) { turnStartedAt = new Date().toISOString(); state(); } }
      const key = `${streamingMessageId}:${String(e.index)}`;
      if (e.type === "content_block_start" && (block.type === "text" || block.type === "thinking")) { textBlocks.set(key, { text: string(block.text ?? block.thinking), kind: block.type }); blockKey(streamKeys, streamOrdinals, key, streamingMessageId, block.type); }
      if (e.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(string(delta.type))) {
        const value = textBlocks.get(key) ?? { text: "", kind: delta.type === "thinking_delta" ? "thinking" as const : "text" as const }; value.text += string(delta.text ?? delta.thinking); textBlocks.set(key, value);
        const canonicalKey = blockKey(streamKeys, streamOrdinals, key, streamingMessageId, value.kind);
        options.onTimeline(value.kind === "thinking" ? { entryId: nativeEntryId(nativeId, canonicalKey), revision: "1", kind: "reasoning", text: limited(value.text) } : { entryId: nativeEntryId(nativeId, canonicalKey), revision: "1", kind: "assistant_message", content: [{ type: "text", text: limited(value.text) }] });
      }
      if (currentTurnId) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
      return;
    }
    if (type === "user" || type === "assistant") {
      const id = type === "assistant" ? string(message.id) || string(m.uuid) : string(m.uuid) || randomUUID();
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
      if (type === "user" && typeof m.uuid === "string" && content.some(part => record(part).type === "text") && !content.some(part => record(part).type === "tool_result")) options.onInputObserved?.(m.uuid);
      content.forEach((raw, index) => {
        const part = record(raw);
        // SDK assistant messages arrive one completed block at a time: array index
        // zero can refer to text after a streamed thinking block at index zero.
        const key = type === "assistant" ? blockKey(assistantKeys, assistantOrdinals, `${string(m.uuid) || id}:${index}`, id, string(part.type)) : `${id}:${index}`;
        const base = { entryId: nativeEntryId(nativeId, key), revision: "1" };
        if (part.type === "text") options.onTimeline({ ...base, kind: type === "user" ? "user_message" : "assistant_message", content: [{ type: "text", text: limited(string(part.text)) }] });
        else if (part.type === "thinking") options.onTimeline({ ...base, kind: "reasoning", text: limited(string(part.thinking)) });
        else if (part.type === "tool_use") { const callId = string(part.id), tool = { name: string(part.name), input: limited(readable(part.input)) }; tools.set(callId, tool); options.onTimeline({ entryId: nativeEntryId(nativeId, callId), revision: "1", kind: "tool_call", callId, ...tool, output: [], status: "running", truncated: false }); }
        else if (part.type === "tool_result") { const callId = string(part.tool_use_id); if (!history) for (const [id, pending] of interactions) if (pending.nativeToolId === callId) confirmInteraction(id, pending); const output = readable(part.content); const tool = tools.get(callId) ?? { name: "tool", input: "" }; options.onTimeline({ entryId: nativeEntryId(nativeId, callId), revision: "1", kind: "tool_call", callId, ...tool, output: [{ type: "text", text: limited(output) }], status: part.is_error ? "failed" : "completed", truncated: output.length > 200_000 }); }
        else options.onTimeline({ ...base, kind: "error", code: "unsupported_native_content", message: `Native ${string(part.type)} content is unavailable in this text session.` });
      });
      if (!history && currentTurnId) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
    }
    if (type === "result") {
      if (history || m.parent_tool_use_id || m.user_message_uuid && m.user_message_uuid !== currentTurnId) return;
      const interrupted = cancellation && cancellation.turnId === currentTurnId && m.user_message_uuid === currentTurnId && ["aborted_streaming", "aborted_tools"].includes(string(m.terminal_reason));
      // The result can precede the interrupt receipt. Only a successful native
      // receipt and an explicitly aborted result establish user cancellation.
      if (interrupted && !cancellation!.acknowledged) { cancellation!.result = raw; return; }
      if (!m.is_error && !interrupted && currentTurnId) for (const [id, pending] of interactions) if (pending.nativeToolId === null && pending.turnId === currentTurnId) confirmInteraction(id, pending);
      if (currentTurnId) turns.complete(currentTurnId, interrupted ? new Error("Native Claude turn was interrupted by the user.") : m.is_error ? new Error(`Native Claude turn failed: ${readable(m.errors ?? m.subtype)}`) : null);
      if (currentTurnId) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
      if (interrupted) options.onTimeline({ entryId: nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "error", code: "turn_interrupted", message: "Interrupted by the user." });
      else if (m.is_error) options.onTimeline({ entryId: nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "error", code: "native_result_error", message: limited(readable(m.errors ?? m.result ?? m.subtype)) });
      for (const [id, pending] of interactions) {
        interactions.delete(id); publishInteraction({ ...pending.interaction, state: "expired", revision: "2" }); const ended = new Error("The native turn ended before interaction confirmation."); pending.reject(ended); pending.rejectConfirmation?.(ended);
      }
      cancellation = undefined; currentTurnId = null; turnStartedAt = null; activity = "idle"; for (const waiter of cancelWaiters) waiter.resolve(); cancelWaiters.clear(); state();
    }
    if (type === "system" && m.subtype === "compact_boundary") options.onTimeline({ entryId: nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "compaction", summary: "Native conversation context compacted." });
  };
  if (options.resumeNativeSessionId) {
    // SDK history readers use their own process environment, not Query.options.env.
    // A read-only process preserves the writer's private home without mutating ours.
    const history = options.env && options.env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR
      ? await new Promise<{ info: Awaited<ReturnType<typeof getSessionInfo>>; messages: Awaited<ReturnType<typeof getSessionMessages>> }>((resolve, reject) => {
        const source = `import {getSessionInfo,getSessionMessages} from ${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))}; const [id,dir]=process.argv.slice(1); const info=await getSessionInfo(id,{dir}); const messages=info ? await getSessionMessages(id,{dir,includeSystemMessages:true}) : []; process.stdout.write(JSON.stringify({info,messages}));`;
        execFile(process.execPath, ["--input-type=module", "--eval", source, nativeId, options.cwd], { env: options.env, cwd: options.cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) { reject(new Error("Native Claude history reader failed, timed out, or exceeded its output limit.")); return; }
          try { resolve(JSON.parse(stdout) as { info: Awaited<ReturnType<typeof getSessionInfo>>; messages: Awaited<ReturnType<typeof getSessionMessages>> }); }
          catch { reject(new Error("Native Claude history reader returned invalid data.")); }
        });
      })
      : { info: await getSessionInfo(nativeId, { dir: options.cwd }), messages: await getSessionMessages(nativeId, { dir: options.cwd, includeSystemMessages: true }) };
    if (!history.info || history.info.sessionId !== nativeId || history.info.cwd && await realpath(history.info.cwd) !== await realpath(options.cwd) || !Array.isArray(history.messages)) throw new Error("Native Claude history identity or working directory is unavailable.");
    for (const m of history.messages) project(m, true);
  }
  const native = query({ prompt: input, options: {
    ...(options.resumeNativeSessionId ? { resume: nativeId } : { sessionId: nativeId }), cwd: options.cwd,
    ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && config.effort ? { effort: config.effort } : {}),
    ...(config.additionalDirectories ? { additionalDirectories: config.additionalDirectories } : {}),
    ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}), env: options.env ?? process.env,
    allowDangerouslySkipPermissions: true, persistSession: true, includePartialMessages: true, settingSources: ["user", "project", "local"], ...(!options.resumeNativeSessionId ? { permissionMode: options.unattended ? "bypassPermissions" : config.permissionMode ?? "default", ...(options.unattended ? { sandbox: { enabled: false } } : {}) } : {}),
    hooks: { SessionStart: [{ hooks: [async event => { verify(event.session_id); return {}; }] }] },
    spawnClaudeCodeProcess: args => { const child = spawn(args.command, args.args, { cwd: args.cwd ?? options.cwd, env: args.env, signal: args.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false }); children.push(child); options.onSpawn(child); child.stderr.on("data", chunk => options.onDiagnostic?.(String(chunk))); return child; },
    canUseTool: async (name, toolInput, context): Promise<PermissionResult> => {
      const base = { interactionId: randomUUID(), revision: "1", state: "pending" as const };
      if (name === "AskUserQuestion") {
        const interaction: SessionInteraction = { ...base, kind: "question", title: "Agent question", canDismiss: true, questions: (Array.isArray(toolInput.questions) ? toolInput.questions : []).map((raw, i) => { const q = record(raw); return { questionId: String(i), label: string(q.question), multiple: q.multiSelect === true, required: true, sensitive: false, allowCustom: true, options: (Array.isArray(q.options) ? q.options : []).map(raw => { const o = record(raw); return { id: string(o.label), label: string(o.label) }; }) }; }) };
        const response = await ask(interaction, context.signal, context.toolUseID);
        if (response.kind !== "question") return { behavior: "deny", message: "User dismissed the question." };
        return { behavior: "allow", updatedInput: { ...toolInput, answers: Object.fromEntries(response.answers.map(a => [interaction.questions.find(q => q.questionId === a.questionId)!.label, [...a.optionIds, ...(a.text ? [a.text] : [])].join(", ")])) } };
      }
      const response = await ask({ ...base, kind: "approval", title: `Approve ${name}`, detail: limited(readable(toolInput)), actions: ["allow_once", "reject"] }, context.signal, context.toolUseID);
      return response.kind === "approval" && response.action === "allow_once" ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "User rejected this operation." };
    },
    onElicitation: async (request, context) => {
      if (request.mode !== "form") return { action: "decline" };
      const response = await ask(formInteraction(request.message, request.requestedSchema), context.signal);
      return response.kind === "form" ? { action: "accept", content: Object.fromEntries(response.values.map(v => [v.fieldId, Array.isArray(v.value) ? [...v.value] : v.value as string | number | boolean])) } : { action: "decline" };
    }, stderr: line => options.onDiagnostic?.(line),
  } });
  controls = new ClaudeControls(native as ClaudeControlQuery, options.resumeNativeSessionId ? null : options.model, options.resumeNativeSessionId ? undefined : config.effort, state, options.onControlConfirmed, !!options.resumeNativeSessionId, options.controlsRevisionFloor);
  const disconnect = (error: Error) => {
    if (disconnected || closed) return;
    disconnected = true; controls?.close(); input.close(); native.close(); identityReject(error);
    for (const item of steered.values()) item.reject(error); steered.clear();
    for (const pending of accepted.values()) pending.reject(error); accepted.clear();
    for (const waiter of cancelWaiters) waiter.reject(error); cancelWaiters.clear();
    if (currentTurnId) turns.complete(currentTurnId, error);
    for (const [id, pending] of interactions) {
      interactions.delete(id); pending.reject(error); pending.rejectConfirmation?.(error);
      publishInteraction({ ...pending.interaction, revision: "2", state: "expired" });
    }
    currentTurnId = null; activity = "unknown";
    options.onTimeline({ entryId: randomUUID(), revision: "1", kind: "error", code: "native_connection_lost", message: error.message }); state();
    options.onFatalError?.(error);
  };
  const pump = (async () => {
    try { for await (const message of native) project(message); if (!closed) disconnect(new Error("Native Claude connection ended; pending operation results are unknown.")); }
    catch (error) { if (!closed && !disconnected) disconnect(new Error(`Native Claude connection lost; pending operation results are unknown: ${error instanceof Error ? error.message : String(error)}`)); }
  })();
  const close = async () => {
    if (closed) return; closed = true; controls?.close(); input.close(); native.close();
    const stopped = new Error("Native Claude process stopped; pending operation results are unknown.");
    for (const item of steered.values()) item.reject(stopped); steered.clear();
    for (const pending of accepted.values()) pending.reject(stopped); accepted.clear();
    for (const waiter of cancelWaiters) waiter.reject(stopped); cancelWaiters.clear();
    if (currentTurnId) turns.complete(currentTurnId, stopped);
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : deadline(new Promise<void>(resolve => child.once("close", () => resolve())), "Native Claude stop is unconfirmed.", 10_000)));
    await pump; activity = "stopped"; for (const p of interactions.values()) { publishInteraction({ ...p.interaction, revision: "2", state: "expired" }); p.reject(stopped); p.rejectConfirmation?.(stopped); } interactions.clear(); state();
  };
  try { await deadline(native.initializationResult(), "Claude initialization timed out."); if (disconnected) throw new Error("Native Claude connection ended during initialization."); await controls.refresh(); activity = "idle"; state(); } catch (error) { await close(); throw error; }
  const send = async (text: string, operationId: string, expectedTurnId: string | null): Promise<ProviderReceipt> => {
      if (closed || disconnected || currentTurnId !== expectedTurnId || interactions.size) throw new NativeRpcError(-32602, "Claude cannot accept input in this session state.");
      if (currentTurnId !== null) {
        if (!capabilities.steer) throw new NativeRpcError(-32602, "This Claude version cannot accept input during an active turn.");
        const confirmation = new Promise<ProviderReceipt>((resolve, reject) => steered.set(operationId, { text, started: false, resolve, reject }));
        input.push({ type: "user", uuid: operationId as ReturnType<typeof randomUUID>, session_id: nativeId, message: { role: "user", content: text }, parent_tool_use_id: null });
        options.onTimeline({ entryId: nativeEntryId(nativeId, `${operationId}:0`), revision: "1", kind: "user_message", content: [{ type: "text", text: limited(text) }] });
        return deadline(confirmation, "Claude steering acceptance is unknown.", 60_000);
      }
      if ([...steered.values()].some(item => !item.started)) throw new NativeRpcError(-32602, "Claude has pending native input.");
      currentTurnId = operationId; turnStartedAt = null; activity = "working"; state();
      const receipt = new Promise<void>((resolve, reject) => accepted.set(operationId, { resolve, reject }));
      input.push({ type: "user", uuid: operationId as ReturnType<typeof randomUUID>, session_id: nativeId, message: { role: "user", content: text }, parent_tool_use_id: null });
      // SDK input is not echoed in every live stream. Display the dispatch with
      // the same identity used by native echo/history, without recording an ACK
      // or feeding locally submitted content into native recovery evidence.
      options.onTimeline({ entryId: nativeEntryId(nativeId, `${operationId}:0`), revision: "1", kind: "user_message", content: [{ type: "text", text: limited(text) }] });
      await deadline(Promise.all([identity, receipt]), "Claude input result or native session identity is unknown.", 60_000); return { disposition: "started", turnId: operationId };
  };
  return {
    nativeSessionId: nativeId, send,
    async refreshControls() { await controls!.refresh(); return { disposition: "handled" }; },
    async setSetting(id, value, operationId, revision) { if (closed || disconnected) throw new NativeRpcError(-32602, "Native session unavailable."); await controls!.set(id, value, operationId, revision); return { disposition: "handled" }; },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (currentTurnId !== null || expectedTurnId !== null || interactions.size) throw new NativeRpcError(-32602, "Claude commands require an idle session.");
      const command = controls!.command(id, revision); return send(`/${command.name}${args ? ` ${args}` : ""}`, operationId, null);
    },
    async cancel(expectedTurnId) {
      if (closed || disconnected || !currentTurnId || currentTurnId !== expectedTurnId || cancellation) throw new NativeRpcError(-32602, "Native turn changed or cancellation is already pending.");
      let waiter!: { resolve(): void; reject(error: Error): void };
      const stopped = new Promise<void>((resolve, reject) => { waiter = { resolve, reject }; cancelWaiters.add(waiter); }); void stopped.catch(() => {});
      const attempt = { turnId: currentTurnId, acknowledged: false, result: undefined as unknown }; cancellation = attempt;
      try { const interrupt = native.interrupt.bind(native) as (options?: { cancelQueued: boolean }) => Promise<unknown>;
        const result = await deadline(interrupt(capabilities.steer ? { cancelQueued: true } : undefined), "Claude interrupt receipt is unconfirmed.");
        if (closed || disconnected) throw new Error("Native Claude closed before interrupt confirmation.");
        attempt.acknowledged = true;
        for (const id of Array.isArray(record(result).cancelled) ? record(result).cancelled as unknown[] : []) if (typeof id === "string") withdrawInput(id);
        if (attempt.result) project(attempt.result);
        await deadline(stopped, "Claude turn cancellation is unconfirmed."); return { disposition: "handled" }; }
      finally { cancelWaiters.delete(waiter); if (cancellation === attempt) { cancellation = undefined; if (attempt.result && !attempt.acknowledged && !closed && !disconnected) project(attempt.result); } }
    },
    async respond(interactionId, revision, response): Promise<ProviderReceipt> {
      const pending = interactions.get(interactionId); if (!pending || pending.submitted || pending.interaction.revision !== revision) throw new NativeRpcError(-32602, "Native interaction is stale."); validateResponse(pending.interaction, response);
      const confirmation = new Promise<void>((resolve, reject) => { pending.confirm = resolve; pending.rejectConfirmation = reject; });
      pending.submitted = true; pending.resolve(response);
      // A resolved SDK callback is not a native receipt. The matching tool result,
      // or a successful elicitation turn, supplies the confirmation boundary.
      await deadline(confirmation, "Native Claude interaction result is unknown.");
      return { disposition: "handled" };
    }, waitForTurn: (turnId, deadline) => turns.wait(turnId, deadline), close,
  };
};
