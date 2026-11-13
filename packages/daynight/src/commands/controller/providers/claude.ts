import { assertNativeImageAdmission } from "./image-admission.js";
import { validateNativeInput, verifyNativeImageFiles, textNativeInput } from "./native-input.js";
import type { NativeInput } from "./types.js";
import { ClaudeControls, type ClaudeControlQuery } from "./controls-claude.js";
import { NativeTurns } from "./turns.js";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKUserMessage, PermissionResult, Options } from "@anthropic-ai/claude-agent-sdk";
import { queryClaudeLive, releaseClaudeLiveRecord, type ClaudeLiveQuery } from "./claude-live.js";
import { ClaudeImageInputs } from "./claude-image-input.js";
import { ClaudeProjection } from "./claude-image-projection.js";
import { openClaudeTranscriptHelper } from "./claude-transcript-helper.js";
import type { ClaudeTranscriptReader, ClaudeTranscriptRecord } from "./claude-transcript.js";
import type { InteractionResponse, SessionInteraction } from "../../../session/protocol.js";
import { record, string, NativeRpcError, NativeRpcTimeoutError } from "./native-rpc.js";
import { ControllerStartupError } from "../startup.js";
import { nativeEntryId, parseProviderArguments, readable, limited } from "./projection.js";
import { claudeApprovalDetail } from "./claude-approval-detail.js";
import { formInteraction, validateResponse } from "./interactions.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";

class InputStream implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []; private wake: (() => void) | null = null; private closed = false;
  push(message: SDKUserMessage): void { if (this.closed) throw new Error("Native input is closed."); this.items.push(message); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> { while (!this.closed) { const item = this.items.shift(); if (item) { yield item; continue; } await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = null; } }
}
const deadline = <T>(promise: Promise<T>, message: string, ms = 30_000): Promise<T> => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new NativeRpcTimeoutError(message)), ms); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
type PendingInteraction = { interaction: SessionInteraction; resolve(response: InteractionResponse): void; reject(error: Error): void; nativeToolId: string | null; turnId: string | null; submitted: boolean; confirm?: () => void; rejectConfirmation?: (error: Error) => void };
export const openClaudeProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  const config = parseProviderArguments("claude", options.args, options.validateNativeSelection), input = new InputStream();
  const nativeId = options.resumeNativeSessionId ?? randomUUID();
  const capabilities = { send: true, steer: false, cancel: true, respond: true };
  let currentTurnId: string | null = null, activity: ProviderState["activity"] = "initializing", closed = false, verified = false, disconnected = false;
  let controls: ClaudeControls | undefined, turnStartedAt: string | null = null, native: ClaudeLiveQuery | undefined;
  let historyReader: ClaudeTranscriptReader | undefined;
  const pendingInputMessages = new Map<string, string>();
  const projectionOptions: ProviderOptions = { ...options, onInputMessage: (operationId, sessionId, entryId) => {
    if (sessionId !== nativeId) throw new Error("Native Claude input provenance identity mismatch.");
    if (!verified) { pendingInputMessages.set(operationId, entryId); return; }
    options.onInputMessage?.(operationId, sessionId, entryId);
  } };
  const imageInputs = new ClaudeImageInputs(options, nativeId), projection = new ClaudeProjection(projectionOptions, nativeId, id => imageInputs.original(id));
  let cancellation: { turnId: string; acknowledged: boolean; result?: unknown; entryId?: string } | undefined;
  const steered = new Map<string, { text: string; started: boolean; resolve(value: ProviderReceipt): void; reject(error: Error): void }>();
  const interactions = new Map<string, PendingInteraction>();
  const accepted = new Map<string, { resolve(): void; reject(error: Error): void }>(); const cancelWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const state = () => options.onState({ nativeSessionId: verified ? nativeId : null, activity: interactions.size ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value, images: controls.imageCapabilities(verified ? nativeId : null, native?.profile ?? null, !!options.imageRuntime) } : {}), capabilities: closed || disconnected ? { send: false, steer: false, cancel: false, respond: false } : capabilities });
  let identityResolve!: () => void; let identityReject!: (error: Error) => void;
  const identity = new Promise<void>((resolve, reject) => { identityResolve = resolve; identityReject = reject; });
  void identity.catch(() => {});
  const verify = (sessionId: unknown) => { if (sessionId !== nativeId) { const error = new Error("Native Claude session identity mismatch."); identityReject(error); throw error; } if (!verified) {
    verified = true; identityResolve(); state();
    // The first dispatch can precede SessionStart. Publish the verified identity
    // before associating its retained input with the Controller's durable journal.
    for (const [operationId, entryId] of pendingInputMessages) options.onInputMessage?.(operationId, nativeId, entryId);
    pendingInputMessages.clear();
  } };
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
  const project = (raw: unknown, history = false, historyContext?: { row: ClaudeTranscriptRecord; reader: ClaudeTranscriptReader; acknowledged?: Promise<void> }) => {
    const m = record(raw), message = record(m.message), type = string(m.type);
    if (m.session_id !== undefined) verify(m.session_id);
    const confirmedImage = imageInputs.observe(m, history);
    if (confirmedImage) { accepted.get(confirmedImage)?.resolve(); accepted.delete(confirmedImage); }
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
      projection.stream(m);
      if (!m.parent_tool_use_id && record(m.event).type === "message_start" && currentTurnId && !turnStartedAt) { turnStartedAt = new Date().toISOString(); state(); }
      if (currentTurnId && !imageInputs.original(currentTurnId)) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
      return;
    }
    if (type === "user" || type === "assistant") {
      const id = type === "assistant" ? string(message.id) || string(m.uuid) : string(m.uuid) || randomUUID();
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
      // Native interrupt markers omit isSynthetic; SDK history also drops origin
      // metadata. Match only a complete single text block, never user prose that
      // quotes or discusses the marker. Live completion still needs its receipt.
      if (type === "user" && content.length === 1 && record(content[0]).type === "text" && ["[Request interrupted by user]", "[Request interrupted by user for tool use]"].includes(string(record(content[0]).text))) {
        const entryId = nativeEntryId(nativeId, `${id}:0`);
        if (!m.parent_tool_use_id) {
          if (history) options.onTimeline({ entryId, revision: "1", kind: "error", code: "turn_interrupted", message: "Interrupted by the user." });
          else if (cancellation && cancellation.turnId === currentTurnId) cancellation.entryId = entryId;
        }
        return;
      }
      if (type === "user" && typeof m.uuid === "string" && !imageInputs.original(m.uuid) && content.some(part => record(part).type === "text") && !content.some(part => ["tool_result", "image"].includes(string(record(part).type)))) options.onInputObserved?.(m.uuid);
      if (!history) for (const rawPart of content) { const part = record(rawPart); if (part.type === "tool_result") for (const [id, pending] of interactions) if (pending.nativeToolId === string(part.tool_use_id)) confirmInteraction(id, pending); }
      projection.message(m, historyContext);
      if (!history && currentTurnId && !imageInputs.original(currentTurnId)) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
    }

    if (type === "result") {
      if (history || m.parent_tool_use_id || m.user_message_uuid && m.user_message_uuid !== currentTurnId) return;
      const interrupted = cancellation && cancellation.turnId === currentTurnId && m.user_message_uuid === currentTurnId && ["aborted_streaming", "aborted_tools"].includes(string(m.terminal_reason));
      // The result can precede the interrupt receipt. Only a successful native
      // receipt and an explicitly aborted result establish user cancellation.
      if (interrupted && !cancellation!.acknowledged) { cancellation!.result = raw; return; }
      if (!m.is_error && !interrupted && currentTurnId) for (const [id, pending] of interactions) if (pending.nativeToolId === null && pending.turnId === currentTurnId) confirmInteraction(id, pending);
      if (currentTurnId) turns.complete(currentTurnId, interrupted ? new Error("Native Claude turn was interrupted by the user.") : m.is_error ? new Error(`Native Claude turn failed: ${readable(m.errors ?? m.subtype)}`) : null);
      if (currentTurnId && !imageInputs.original(currentTurnId)) { accepted.get(currentTurnId)?.resolve(); accepted.delete(currentTurnId); }
      else if (currentTurnId && accepted.has(currentTurnId)) {
        accepted.get(currentTurnId)!.reject(new Error("Claude image input ended without a durable root execution receipt; its result is unknown.")); accepted.delete(currentTurnId);
      }
      if (interrupted) options.onTimeline({ entryId: cancellation!.entryId ?? nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "error", code: "turn_interrupted", message: "Interrupted by the user." });
      else if (m.is_error) options.onTimeline({ entryId: nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "error", code: "native_result_error", message: limited(readable(m.errors ?? m.result ?? m.subtype)) });
      for (const [id, pending] of interactions) {
        interactions.delete(id); publishInteraction({ ...pending.interaction, state: "expired", revision: "2" }); const ended = new Error("The native turn ended before interaction confirmation."); pending.reject(ended); pending.rejectConfirmation?.(ended);
      }
      cancellation = undefined; currentTurnId = null; turnStartedAt = null; activity = "idle"; for (const waiter of cancelWaiters) waiter.resolve(); cancelWaiters.clear(); state();
    }
    if (type === "system" && m.subtype === "compact_boundary") options.onTimeline({ entryId: nativeEntryId(nativeId, string(m.uuid) || randomUUID()), revision: "1", kind: "compaction", summary: "Native conversation context compacted." });
  };
  const historyOptions = () => {
    if (!options.imageRuntime) throw new Error("Claude history storage component is unavailable.");
    const hint = options.imageRuntime.readState(`claude:transcript:${nativeId}`);
    return { nativeHome: options.env?.CLAUDE_CONFIG_DIR ?? path.join(options.env?.HOME ?? homedir(), ".claude"), cwd: options.cwd, nativeSessionId: nativeId,
      ...(typeof hint === "string" && hint ? { transcriptPath: hint } : {}), indexDirectory: options.imageRuntime.indexDirectory(), acquireIndexReservation: options.imageRuntime.acquireIndexReservation, onSpawn: options.onSpawn };
  };
  if (options.resumeNativeSessionId) {
    historyReader = await openClaudeTranscriptHelper(historyOptions());
    try {
      for (;;) {
        const page = await historyReader.nextPage(); let acknowledge!: () => void, reject!: (error: unknown) => void;
        const acknowledged = new Promise<void>((resolve, fail) => { acknowledge = resolve; reject = fail; }); void acknowledged.catch(() => {});
        try {
          for (const row of page.records) {
            if (row.value.type === "assistant" && row.rootInputUuid && row.value.user_message_uuid && row.value.user_message_uuid !== row.rootInputUuid) throw new Error("Claude history root input evidence differs.");
            project(row.value.type === "assistant" && row.rootInputUuid ? { ...row.value, user_message_uuid: row.rootInputUuid } : row.value, true, { row, reader: historyReader, acknowledged });
          }
          await historyReader.acknowledge(page.cursor); acknowledge();
        } catch (error) { reject(error); throw error; }
        if (page.done) break;
      }
    } catch (error) { await projection.close(); await historyReader.close(); throw error; }
  }
  try { options.assertNativeDispatch?.(); native = queryClaudeLive({ prompt: input, options: {

    ...(options.resumeNativeSessionId ? { resume: nativeId } : { sessionId: nativeId }), cwd: options.cwd,
    ...(options.instructions !== undefined ? { systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions } as const } : {}),
    ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && config.effort ? { effort: config.effort as NonNullable<Options["effort"]> } : {}),
    ...(config.additionalDirectories ? { additionalDirectories: config.additionalDirectories } : {}),
    ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}), env: options.env ?? process.env,
    allowDangerouslySkipPermissions: true, persistSession: true, includePartialMessages: true, settingSources: ["user", "project", "local"], ...(!options.resumeNativeSessionId ? { permissionMode: options.unattended ? "bypassPermissions" : config.permissionMode ?? "default", ...(options.unattended ? { sandbox: { enabled: false } } : {}) } : {}),
    hooks: { SessionStart: [{ hooks: [async event => { verify(event.session_id); if (event.transcript_path) options.imageRuntime?.writeState(`claude:transcript:${nativeId}`, event.transcript_path); return {}; }] }] },
    canUseTool: async (name, toolInput, context): Promise<PermissionResult> => {
      const base = { interactionId: randomUUID(), revision: "1", state: "pending" as const };
      if (name === "AskUserQuestion") {
        const interaction: SessionInteraction = { ...base, kind: "question", title: "Agent question", canDismiss: true, questions: (Array.isArray(toolInput.questions) ? toolInput.questions : []).map((raw, i) => { const q = record(raw); return { questionId: String(i), label: string(q.question), multiple: q.multiSelect === true, required: true, sensitive: false, allowCustom: true, options: (Array.isArray(q.options) ? q.options : []).map(raw => { const o = record(raw); return { id: string(o.label), label: string(o.label) }; }) }; }) };
        const response = await ask(interaction, context.signal, context.toolUseID);
        if (response.kind !== "question") return { behavior: "deny", message: "User dismissed the question." };
        return { behavior: "allow", updatedInput: { ...toolInput, answers: Object.fromEntries(response.answers.map(a => [interaction.questions.find(q => q.questionId === a.questionId)!.label, [...a.optionIds, ...(a.text ? [a.text] : [])].join(", ")])) } };
      }
      const response = await ask({ ...base, kind: "approval", title: `Approve ${name}`, detail: claudeApprovalDetail(name, toolInput), actions: ["allow_once", "reject"] }, context.signal, context.toolUseID);
      return response.kind === "approval" && response.action === "allow_once" ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "User rejected this operation." };
    },
    onElicitation: async (request, context) => {
      if (request.mode !== "form") return { action: "decline" };
      const response = await ask(formInteraction(request.message, request.requestedSchema), context.signal);
      return response.kind === "form" ? { action: "accept", content: Object.fromEntries(response.values.map(v => [v.fieldId, Array.isArray(v.value) ? [...v.value] : v.value as string | number | boolean])) } : { action: "decline" };
    }, stderr: line => options.onDiagnostic?.(line),
  } }, options); } catch (error) { await projection.close(); await historyReader?.close(); throw error; }
  controls = new ClaudeControls(native as ClaudeControlQuery, options.resumeNativeSessionId ? null : options.model, options.resumeNativeSessionId ? undefined : config.effort, state, options.onControlConfirmed, !!options.resumeNativeSessionId, options.controlsRevisionFloor, options.assertNativeDispatch);
  const disconnect = (error: Error) => {
    if (disconnected || closed) return;
    disconnected = true; controls?.close(); input.close(); native?.close(); identityReject(error);
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
    try { for await (const message of native!) { try { project(message); } finally { releaseClaudeLiveRecord(message); } } if (!closed) disconnect(new Error("Native Claude connection ended; pending operation results are unknown.")); }
    catch (error) { if (!closed && !disconnected) disconnect(new Error(`Native Claude connection lost; pending operation results are unknown: ${error instanceof Error ? error.message : String(error)}`)); }
  })();
  let closing: Promise<void> | null = null, closeRequested: Promise<void> | null = null;
  const close = (): Promise<void> => closing ??= (async () => {
    const stopped = new Error("Native Claude process stopped; pending operation results are unknown.");
    await (closeRequested ??= (async () => {
      closed = true; controls?.close(); input.close(); native?.close();
      for (const item of steered.values()) item.reject(stopped); steered.clear();
      for (const pending of accepted.values()) pending.reject(stopped); accepted.clear();
      for (const waiter of cancelWaiters) waiter.reject(stopped); cancelWaiters.clear();
      if (currentTurnId) turns.complete(currentTurnId, stopped);
    })());
    await native?.join?.();
    const failures: unknown[] = [];
    for (const cleanup of [() => projection.close(), () => historyReader?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Claude stopped image resources could not be released.");
    await pump; activity = "stopped"; for (const p of interactions.values()) { publishInteraction({ ...p.interaction, revision: "2", state: "expired" }); p.reject(stopped); p.rejectConfirmation?.(stopped); } interactions.clear(); state();
  })().catch(error => { closing = null; throw error; });
  try { await deadline(native!.initializationResult(), "Claude initialization timed out."); if (disconnected) throw new Error("Native Claude connection ended during initialization."); await controls.refresh(); if (options.validateNativeSelection && !options.resumeNativeSessionId) controls.validateSelection({ model: options.model, ...(config.effort === undefined ? {} : { effort: config.effort }) }); activity = "idle"; state(); }
  catch (error) {
    // The SDK marks a native control_response rejection separately from transport errors.
    const failure = error instanceof Error && "errorClass" in error && error.errorClass === "control_request_failed"
      ? new ControllerStartupError({ state: "failed", reasonCode: "native_rejected" }, error.message, { cause: error }) : error;
    try { await close(); } catch { options.onDiagnostic?.("Claude startup cleanup failed; native process stop remains unconfirmed."); }
    throw failure;
  }
  const submit = async (inputValue: NativeInput, operationId: string, text: string) => {
    options.assertNativeDispatch?.();
    try {
      if (inputValue.content.some(part => part.type === "image")) assertNativeImageAdmission(inputValue, controls!.imageCapabilities(verified ? nativeId : null, native?.profile ?? null, !!options.imageRuntime), null);
      if (native?.submit) await native.submit({ uuid: operationId, sessionId: nativeId, input: inputValue });
      else input.push({ type: "user", uuid: operationId as ReturnType<typeof randomUUID>, session_id: nativeId, message: { role: "user", content: text }, parent_tool_use_id: null });
    } catch (error) {
      disconnect(new Error("Claude input submission ended without an execution receipt; its result is unknown.", { cause: error }));
      throw error;
    }
  };
  const send = async (inputValue: NativeInput, operationId: string, expectedTurnId: string | null): Promise<ProviderReceipt> => {
      const { text, images } = validateNativeInput(inputValue);
      if (images.length && expectedTurnId !== null) throw new NativeRpcError(-32602, "Claude image steering is unsupported.");
      if (images.length) {
        const capability = controls!.imageCapabilities(verified ? nativeId : null, native?.profile ?? null, !!options.imageRuntime);
        if (capability.send !== "supported" || images.some(image => BigInt(image.byteLength) > BigInt(capability.maxImageBytes))) throw new NativeRpcError(-32602, "Claude image capability is unavailable for the actual native model and runtime.");
        await verifyNativeImageFiles(images);
      }
      if (closed || disconnected || currentTurnId !== expectedTurnId || interactions.size) throw new NativeRpcError(-32602, "Claude cannot accept input in this session state.");
      if (currentTurnId !== null) {
        if (!capabilities.steer) throw new NativeRpcError(-32602, "This Claude version cannot accept input during an active turn.");
        const confirmation = new Promise<ProviderReceipt>((resolve, reject) => steered.set(operationId, { text, started: false, resolve, reject }));
        void confirmation.catch(() => {});
        await submit(inputValue, operationId, text);
        projection.dispatch(inputValue, operationId);
        return deadline(confirmation, "Claude steering acceptance is unknown.", 60_000);
      }
      if ([...steered.values()].some(item => !item.started)) throw new NativeRpcError(-32602, "Claude has pending native input.");
      imageInputs.prepare(inputValue, operationId);
      currentTurnId = operationId; turnStartedAt = null; activity = "working"; state();
      const receipt = new Promise<void>((resolve, reject) => accepted.set(operationId, { resolve, reject }));
      void receipt.catch(() => {});
      await submit(inputValue, operationId, text);
      // SDK input is not echoed in every live stream. Display the dispatch with
      // the same identity used by native echo/history, without recording an ACK
      // or feeding locally submitted content into native recovery evidence.
      projection.dispatch(inputValue, operationId);
      await deadline(Promise.all([identity, receipt]), "Claude input result or native session identity is unknown.", 60_000); return { disposition: "started", turnId: operationId };
  };
  return {
    nativeSessionId: nativeId, send, acknowledgeImageOccurrences: () => projection.acknowledged(),
    async retryImageCapture(request, signal) {
      signal.throwIfAborted();
      if (closed || disconnected || request.nativeSource?.provider !== "claude" || request.nativeSource.nativeSessionId !== nativeId || !["local", "external"].includes(request.locator.kind) || !options.resolveImageCaptureSource) throw new NativeRpcError(-32602, "component_unsupported: Claude image source retry is unavailable.");
      const source = await options.resolveImageCaptureSource(request, signal);
      return { inputPath: source.path, byteLength: source.byteLength, sha256: source.sha256, release: source.release };
    },
    async refreshControls() { await controls!.refresh(); return { disposition: "handled" }; },
    async setSetting(id, value, operationId, revision) { if (closed || disconnected) throw new NativeRpcError(-32602, "Native session unavailable."); await controls!.set(id, value, operationId, revision); return { disposition: "handled" }; },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (currentTurnId !== null || expectedTurnId !== null || interactions.size) throw new NativeRpcError(-32602, "Claude commands require an idle session.");
      const command = controls!.command(id, revision); return send(textNativeInput(`/${command.name}${args ? ` ${args}` : ""}`), operationId, null);
    },
    async cancel(expectedTurnId) {
      if (closed || disconnected || !currentTurnId || currentTurnId !== expectedTurnId || cancellation) throw new NativeRpcError(-32602, "Native turn changed or cancellation is already pending.");
      let waiter!: { resolve(): void; reject(error: Error): void };
      const stopped = new Promise<void>((resolve, reject) => { waiter = { resolve, reject }; cancelWaiters.add(waiter); }); void stopped.catch(() => {});
      const attempt = { turnId: currentTurnId, acknowledged: false, result: undefined as unknown }; cancellation = attempt;
      try { options.assertNativeDispatch?.(); const interrupt = native!.interrupt.bind(native) as (options?: { cancelQueued: boolean }) => Promise<unknown>;
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
      options.assertNativeDispatch?.();
      const confirmation = new Promise<void>((resolve, reject) => { pending.confirm = resolve; pending.rejectConfirmation = reject; });
      pending.submitted = true; pending.resolve(response);
      // A resolved SDK callback is not a native receipt. The matching tool result,
      // or a successful elicitation turn, supplies the confirmation boundary.
      await deadline(confirmation, "Native Claude interaction result is unknown.");
      return { disposition: "handled" };
    }, waitForTurn: (turnId, deadline) => turns.wait(turnId, deadline), close,
  };
};
