import { CopilotControls } from "./controls-copilot.js";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { NativeRpcError, record, string } from "./native-rpc.js";
import { nativeEntryId, parseProviderArguments } from "./projection.js";
import { NativeTurns } from "./turns.js";
import { CopilotInteractions } from "./copilot-interactions.js";
import { CopilotProjection, copilotOwner } from "./copilot-projection.js";
import { copilotDeadline, startCopilotRuntime } from "./copilot-runtime.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";

export const openCopilotProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  const args = parseProviderArguments("copilot", options.args), cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Copilot working directory is not a directory.");
  const nativeId = options.resumeNativeSessionId ?? randomUUID(), turns = new NativeTurns();
  let controls: CopilotControls | undefined, turnStartedAt: string | null = null;
  let native: CopilotSession | undefined, client: CopilotClient | undefined;
  let verified = false, closed = false, disconnected = false, dispatching = false;
  let activity: ProviderState["activity"] = "initializing", currentTurnId: string | null = null, interactionId: string | null = null;
  let buffered: SessionEvent[] | undefined = [], heartbeat: NodeJS.Timeout | undefined, polling = false;
  const cancelWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const state = () => options.onState({ nativeSessionId: verified ? nativeId : null, activity: closed ? "stopped" : disconnected ? "unknown" : interactions.waiting ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value } : {}),
    capabilities: verified && !closed && !disconnected ? { send: true, steer: true, cancel: true, respond: true } : { send: false, steer: false, cancel: false, respond: false } });
  const projection = new CopilotProjection(nativeId, options.onTimeline);
  const interactions = new CopilotInteractions({ sessionId: nativeId, onTimeline: options.onTimeline, onChange: state,
    permissionRpc: input => { if (!native) return Promise.reject(new Error("Native Copilot session is not ready.")); return native.rpc.permissions.handlePendingPermissionRequest(input); } });
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => { rejectLost = reject; }); void lost.catch(() => {});
  const disconnect = (error: Error) => {
    if (closed || disconnected) return;
    disconnected = true; controls?.close(); if (heartbeat) clearInterval(heartbeat);
    rejectLost(error); interactions.dispose(error);
    if (currentTurnId) turns.complete(currentTurnId, error);
    for (const waiter of cancelWaiters) waiter.reject(error); cancelWaiters.clear();
    options.onTimeline({ entryId: nativeEntryId(nativeId, "connection-lost"), revision: "1", kind: "error", code: "native_connection_lost", message: error.message }); state();
    options.onFatalError?.(error);
  };
  const call = <T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> => copilotDeadline(Promise.race([promise, lost]), label, ms);
  const finish = (error: Error | null) => {
    if (currentTurnId) turns.complete(currentTurnId, error);
    currentTurnId = null; turnStartedAt = null; interactionId = null; activity = "idle";
    for (const waiter of cancelWaiters) waiter.resolve(); cancelWaiters.clear(); state();
  };
  let todoRead: Promise<void> = Promise.resolve();
  const refreshTodos = () => {
    todoRead = todoRead.then(async () => {
      if (!native || closed || disconnected) return;
      const { rows } = await call(native.rpc.plan.readSqlTodos(), "Copilot todo read");
      if (closed || disconnected) return;
      options.onTimeline({ entryId: nativeEntryId(nativeId, "todos"), revision: "1", kind: "todo", items: rows.flatMap(row => {
        const text = row.title || row.description, id = row.id;
        const status = row.status === "done" || row.status === "completed" ? "completed" : row.status === "in_progress" ? "in_progress" : row.status === "pending" ? "pending" : null;
        if (!text || !id || !status) {
          options.onTimeline({ entryId: nativeEntryId(nativeId, "todo-unavailable"), revision: "1", kind: "error", code: "unsupported_native_todo", message: "Some Copilot todo rows lack a supported identity, description, or status." }); return [];
        }
        return [{ id, text, status }];
      }) });
    }).catch(() => { options.onDiagnostic?.("Copilot todo state is unavailable."); });
  };
  const seen = new Set<string>();
  const accept = (event: SessionEvent, history = false) => {
    if (closed || disconnected || seen.has(event.id)) return;
    seen.add(event.id); projection.accept(event);
    if (history) return;
    if (event.type === "session.todos_changed") refreshTodos();
    if (copilotOwner(event)) return;
    const data = record(event.data), nextInteraction = string(data.interactionId);
    if (event.type === "assistant.turn_start" || event.type === "user.message") {
      if (currentTurnId && interactionId && nextInteraction && nextInteraction !== interactionId && data.delivery !== "steering") finish(null);
      if (!currentTurnId) { currentTurnId = nativeEntryId(nativeId, `turn:${event.id}`); const stamp = Date.parse(event.timestamp); turnStartedAt = Number.isFinite(stamp) && event.type === "assistant.turn_start" ? new Date(stamp).toISOString() : null; }
      if (event.type === "assistant.turn_start" && !turnStartedAt) { const stamp = Date.parse(event.timestamp); if (Number.isFinite(stamp)) turnStartedAt = new Date(stamp).toISOString(); }
      if (nextInteraction) interactionId = nextInteraction;
      activity = "working"; state();
    } else if (event.type === "assistant.idle" || event.type === "session.idle") finish(null);
    else if (event.type === "abort") finish(new Error("Native Copilot turn was canceled."));
    else if (event.type === "session.error") finish(new Error(string(data.message) || "Native Copilot turn failed."));
    else if (event.type === "session.shutdown") disconnect(new Error("Native Copilot session closed; operation results are unknown."));
  };
  const onEvent = (event: SessionEvent) => {
    if (closed || disconnected) return;
    try { interactions.accept(event); if (buffered) buffered.push(event); else accept(event); }
    catch { disconnect(new Error("Native Copilot event could not be processed; operation results are unknown.")); }
  };
  const runtime = startCopilotRuntime({ ...options, cwd }, disconnect);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true; controls?.close(); if (heartbeat) clearInterval(heartbeat);
    const error = new Error("Native Copilot process stopped; pending operation results are unknown.");
    rejectLost(error); interactions.dispose(error);
    if (currentTurnId) turns.complete(currentTurnId, error);
    for (const waiter of cancelWaiters) waiter.reject(error); cancelWaiters.clear();
    try { if (native) await copilotDeadline(native.disconnect(), "Copilot session disconnect", 2000); }
    catch { options.onDiagnostic?.("Copilot session disconnect was unconfirmed; stopping its owned runtime."); }
    await runtime.close(); currentTurnId = null; activity = "stopped"; state();
  })();
  try {
    state(); client = await runtime.ready;
    if (options.resumeNativeSessionId) {
      const metadata = await call(client.getSessionMetadata(nativeId), "Copilot session metadata");
      if (!metadata || metadata.sessionId !== nativeId || metadata.isRemote || !metadata.context?.workingDirectory || await realpath(metadata.context.workingDirectory) !== cwd) throw new Error("Native Copilot history identity or working directory is unavailable.");
      const usage = await call(client.rpc.sessions.checkInUse({ sessionIds: [nativeId] }), "Copilot session ownership");
      if (usage.inUse.includes(nativeId)) throw new Error("Native Copilot session is already in use.");
    }
    let skillDirectories: string[] | undefined, skillDiscoveryError: string | null = null;
    try {
      const discovery = await call(client.rpc.skills.getDiscoveryPaths({ projectPaths: [cwd] }), "Copilot skill discovery");
      skillDirectories = discovery.paths.map(entry => entry.path);
    } catch (error) { skillDiscoveryError = error instanceof Error ? error.message : "Copilot skill discovery is unavailable."; }
    const config: SessionConfig = { ...(skillDirectories ? { skillDirectories } : {}), sessionId: nativeId, workingDirectory: cwd, streaming: true, includeSubAgentStreamingEvents: true,
      ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && args.effort ? { reasoningEffort: args.effort as "low" | "medium" | "high" | "xhigh" } : {}),
      onEvent, onPermissionRequest: () => interactions.onPermissionRequest(), onUserInputRequest: request => interactions.bindQuestion(request),
      onElicitationRequest: request => interactions.bindElicitation(request), onExitPlanModeRequest: request => interactions.bindPlan(request) };
    const opening = options.resumeNativeSessionId ? client.resumeSession(nativeId, config) : client.createSession(config);
    void opening.then(async opened => { if (closed) await copilotDeadline(opened.disconnect(), "Late Copilot session disconnect", 2000); }).catch(() => {});
    native = await call(opening, "Copilot session open");
    const snapshot = await call(native.rpc.metadata.snapshot(), "Copilot session identity");
    if (native.sessionId !== nativeId || snapshot.sessionId !== nativeId || snapshot.isRemote || snapshot.alreadyInUse || !snapshot.workingDirectory || await realpath(snapshot.workingDirectory) !== cwd) throw new Error("Native Copilot session identity or working directory mismatch.");
    controls = new CopilotControls(native, state, options.onControlConfirmed, options.controlsRevisionFloor, skillDiscoveryError);
    await controls.initialize(options.resumeNativeSessionId !== null, options.unattended);
    const history = await call(native.getEvents(), "Copilot native history");
    const { processing } = await call(native.rpc.metadata.isProcessing(), "Copilot foreground activity");
    // Callbacks must bind immediately, but timeline replay precedes queued live
    // updates. Finalized projection IDs prevent old deltas overwriting history.
    const liveIds = new Set(buffered!.map(event => event.id));
    for (const event of history) { if (!liveIds.has(event.id)) interactions.accept(event, true); accept(event, true); }
    if (processing) {
      const last = history.findLast(event => !copilotOwner(event) && (event.type === "user.message" || event.type === "assistant.turn_start"));
      currentTurnId = nativeEntryId(nativeId, `turn:${last?.id ?? "processing"}`); interactionId = last ? string(record(last.data).interactionId) || null : null;
    }
    activity = processing ? "working" : "idle"; verified = true;
    const queued = buffered!; buffered = undefined; for (const event of queued) accept(event);
    if (disconnected) throw new Error("Copilot disconnected during session initialization.");
    state(); refreshTodos();
    // SDK exposes no public transport-close event. Observe owned process exit
    // immediately and use its public ping to detect a broken live connection.
    heartbeat = setInterval(() => {
      if (polling || closed || disconnected || !client) return; polling = true;
      void call(client.ping(), "Copilot connection health", 5000).catch(() => disconnect(new Error("Native Copilot connection lost; operation results are unknown."))).finally(() => { polling = false; });
    }, 5000); heartbeat.unref();
  } catch (error) { await close(); throw error; }
  const send = async (text: string, operationId: string, expectedTurnId: string | null, displayPrompt?: string): Promise<ProviderReceipt> => {
      if (closed || disconnected || dispatching || currentTurnId !== expectedTurnId || interactions.waiting) throw new NativeRpcError(-32602, "Native Copilot turn changed or cannot accept input.");
      const steering = currentTurnId !== null;
      const turnId = currentTurnId ?? randomUUID(); if (!currentTurnId) turnStartedAt = null; currentTurnId = turnId; dispatching = true; activity = "working"; state();
      let uncertain = false;
      const sending = Promise.resolve().then(() => {
        if (closed || disconnected || currentTurnId !== turnId) throw new NativeRpcError(-32602, "Native Copilot turn changed before input dispatch.");
        return native!.send({ prompt: text, ...(displayPrompt ? { displayPrompt } : {}), mode: "immediate" });
      });
      // A settled SDK send carries its own native message ID. Prompt equality and
      // locally generated operation IDs never establish native input acceptance.
      void sending.then(messageId => {
        dispatching = false;
        if (uncertain && !closed && !disconnected && typeof messageId === "string" && messageId) options.onInputObserved?.(operationId);
      }, () => { dispatching = false; });
      let messageId: string;
      try { messageId = await call(sending, "Copilot input acceptance", 60_000); }
      catch (error) { uncertain = true; throw error; }
      if (typeof messageId !== "string" || !messageId) throw new Error("Copilot returned no native message identity; input result is unknown.");
      return { disposition: steering ? "handled" : "started", turnId };
  };
  return {
    nativeSessionId: nativeId, send,
    async refreshControls() { await controls!.refresh(); return { disposition: "handled" }; },
    async setSetting(id, value, operationId, revision) { if (closed || disconnected || dispatching) throw new NativeRpcError(-32602, "Native controls are unavailable."); await controls!.set(id, value, operationId, revision); return { disposition: "handled" }; },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (closed || disconnected || dispatching || currentTurnId !== null || expectedTurnId !== null || interactions.waiting) throw new NativeRpcError(-32602, "Copilot commands require an idle session.");
      const result = await controls!.invoke(id, args, revision);
      if (result.kind === "agent-prompt") { if (result.mode && result.mode !== "interactive") throw new NativeRpcError(-32602, "Copilot command requested an unsupported agent mode."); return send(result.prompt, operationId, null, result.displayPrompt); }
      if (result.kind !== "text" && result.kind !== "completed") throw new NativeRpcError(-32602, "Copilot command requires unsupported subcommand selection.");
      const text = result.kind === "text" ? result.text : result.message;
      if (text) options.onTimeline({ entryId: nativeEntryId(nativeId, `command:${operationId}`), revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
      return { disposition: "handled" };
    },
    async cancel(expectedTurnId): Promise<ProviderReceipt> {
      if (closed || disconnected || currentTurnId !== expectedTurnId) throw new NativeRpcError(-32602, "Native Copilot turn changed.");
      let waiter!: { resolve(): void; reject(error: Error): void };
      const stopped = new Promise<void>((resolve, reject) => { waiter = { resolve, reject }; cancelWaiters.add(waiter); });
      try {
        const confirmation = call(stopped, "Copilot foreground cancellation");
        const [, result] = await Promise.all([confirmation, call(native!.rpc.interruptMainTurn({}), "Copilot interrupt")]);
        if (!result.interrupted && currentTurnId !== null) throw new Error("Copilot did not confirm foreground cancellation.");
        return { disposition: "handled" };
      } finally { cancelWaiters.delete(waiter); }
    },
    respond: (id, revision, response) => interactions.respond(id, revision, response),
    waitForTurn: (id, deadline) => turns.wait(id, deadline), close,
  };
};
