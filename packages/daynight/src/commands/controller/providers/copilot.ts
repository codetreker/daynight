import { textNativeInput, validateNativeInput, verifyNativeImageFiles } from "./native-input.js";
import type { NativeInput } from "./types.js";
import { readCopilotRuntimeVersion } from "./copilot-status.js";
import { CopilotControls } from "./controls-copilot.js";
import { copilotImageProfile, type CopilotImageProfile } from "./copilot-image-profile.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { NativeRpcError, record, string } from "./native-rpc.js";
import { nativeEntryId, parseProviderArguments, markdownTimelineMetadata } from "./projection.js";
import { NativeTurns } from "./turns.js";
import { CopilotInteractions } from "./copilot-interactions.js";
import { CopilotProjection, copilotOwner } from "./copilot-projection.js";
import { copilotDeadline, copilotExecutable, startCopilotRuntime } from "./copilot-runtime.js";
import type { NativeProvider, ProviderOptions, ProviderReceipt, ProviderState } from "./types.js";
import { prepareCopilotAuthorityArtifacts } from "./copilot-read-authority-artifacts.js";
import { ControllerStartupError } from "../startup.js";
import { CopilotImageInputs } from "./copilot-image-input.js";
import { CopilotImages } from "./copilot-images.js";
import { sendCopilotBridgeImages } from "./copilot-bridge.js";

// Resolve the SDK's own RPC constructor; its local transport errors also use ResponseError.
const { ResponseError, ErrorCodes } = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"))("vscode-jsonrpc/node") as {
  ResponseError: new (...args: never[]) => Error & { code: number };
  ErrorCodes: { MessageWriteError: number; MessageReadError: number; PendingResponseRejected: number; ConnectionInactive: number };
};
const transportErrors = new Set([ErrorCodes.MessageWriteError, ErrorCodes.MessageReadError, ErrorCodes.PendingResponseRejected, ErrorCodes.ConnectionInactive]);

export const openCopilotProvider = async (options: ProviderOptions): Promise<NativeProvider> => {
  if (options.toolLaunch && (options.toolLaunch.tool !== "copilot" || options.toolLaunch.context !== "web")) throw new Error("Copilot Provider requires its frozen Web tool.");
  const args = parseProviderArguments("copilot", options.args, options.validateNativeSelection), cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Copilot working directory is not a directory.");
  const nativeId = options.resumeNativeSessionId ?? randomUUID(), turns = new NativeTurns();
  let controls: CopilotControls | undefined, turnStartedAt: string | null = null;
  let native: CopilotSession | undefined, client: CopilotClient | undefined;
  let verified = false, closed = false, stopped = false, disconnected = false, dispatching = false, startupFailed = false, controlsBusy = false;
  let imageProfile: CopilotImageProfile | null = null;
  let activity: ProviderState["activity"] = "initializing", currentTurnId: string | null = null, interactionId: string | null = null;
  let buffered: SessionEvent[] | undefined = [], bufferedBytes = 0, refill = false, heartbeat: NodeJS.Timeout | undefined, polling = false;
  const imageInputs = new CopilotImageInputs(options, nativeId), images = new CopilotImages(options, nativeId, imageInputs);
  const cancelWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const state = () => options.onState({ nativeSessionId: verified ? nativeId : null, activity: stopped ? "stopped" : closed || disconnected ? "unknown" : interactions.waiting ? "waiting_input" : activity, currentTurnId, turnStartedAt, ...(controls ? { controls: controls.store.value } : {}),
    ...(controls ? { images: controls.imageCapabilities(imageInputs.profileAllowed && !closed && !disconnected && !controlsBusy ? imageProfile : null, verified ? nativeId : null) } : {}),
    capabilities: verified && !closed && !disconnected ? { send: true, steer: true, cancel: true, respond: true } : { send: false, steer: false, cancel: false, respond: false } });
  const projection = new CopilotProjection(nativeId, options.onTimeline, images);
  const interactions = new CopilotInteractions({ sessionId: nativeId, onTimeline: options.onTimeline, onChange: state,
    permissionRpc: input => { if (!native) return Promise.reject(new Error("Native Copilot session is not ready.")); return native.rpc.permissions.handlePendingPermissionRequest(input); } });
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => { rejectLost = reject; }); void lost.catch(() => {});
  const disconnect = (error: Error) => {
    if (closed || disconnected) return;
    disconnected = true; runtime?.authority?.invalidate(); controls?.close(); if (heartbeat) clearInterval(heartbeat);
    rejectLost(error); interactions.dispose(error);
    if (currentTurnId) turns.complete(currentTurnId, error);
    for (const waiter of cancelWaiters) waiter.reject(error); cancelWaiters.clear();
    options.onTimeline({ entryId: nativeEntryId(nativeId, "connection-lost"), revision: "1", kind: "error", code: "native_connection_lost", message: error.message }); state();
    options.onFatalError?.(error);
  };
  const call = <T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> => copilotDeadline(Promise.race([promise, lost]), label, ms);
  const finish = (error: Error | null) => {
    imageInputs.finishTurn();
    if (currentTurnId) turns.complete(currentTurnId, error);
    currentTurnId = null; turnStartedAt = null; interactionId = null; activity = "idle";
    for (const waiter of cancelWaiters) waiter.resolve(); cancelWaiters.clear(); state();
  };
  let todoRead: Promise<void> = Promise.resolve();
  // Resumed history may already contain the stable todo entry and still needs clearing.
  let todoProjected = options.resumeNativeSessionId !== null;
  const refreshTodos = () => {
    todoRead = todoRead.then(async () => {
      if (!native || closed || disconnected) return;
      const { rows } = await call(native.rpc.plan.readSqlTodos(), "Copilot todo read");
      if (closed || disconnected) return;
      if (rows.length === 0 && !todoProjected) return;
      options.onTimeline({ entryId: nativeEntryId(nativeId, "todos"), revision: "1", kind: "todo", items: rows.flatMap(row => {
        const text = row.title || row.description, id = row.id;
        const status = row.status === "done" || row.status === "completed" ? "completed" : row.status === "in_progress" ? "in_progress" : row.status === "pending" ? "pending" : null;
        if (!text || !id || !status) {
          options.onTimeline({ entryId: nativeEntryId(nativeId, "todo-unavailable"), revision: "1", kind: "error", code: "unsupported_native_todo", message: "Some Copilot todo rows lack a supported identity, description, or status." }); return [];
        }
        return [{ id, text, status }];
      }) });
      todoProjected = true;
    }).catch(() => { options.onDiagnostic?.("Copilot todo state is unavailable."); });
  };
  const seen = new Set<string>(), hiddenPermissionEvents = new Set<string>();
  const accept = (event: SessionEvent, history = false) => {
    if (closed || disconnected || seen.has(event.id)) { images.discard(event); return; }
    if (seen.size >= 100_000) throw new Error("Copilot event identity metadata exceeded its bound.");
    projection.accept(event); seen.add(event.id);
    if (history) return;
    if (event.type === "session.todos_changed") refreshTodos();
    if (event.type === "session.model_change" || event.type === "session.mode_changed") { controls?.invalidateImages(); state(); }
    if (copilotOwner(event)) return;
    const data = record(event.data), nextInteraction = string(data.interactionId);
    if (event.type === "assistant.turn_start" || event.type === "user.message") {
      if (currentTurnId && interactionId && nextInteraction && nextInteraction !== interactionId && data.delivery !== "steering") finish(null);
      if (!currentTurnId) { currentTurnId = nativeEntryId(nativeId, `turn:${event.id}`); const stamp = Date.parse(event.timestamp); turnStartedAt = Number.isFinite(stamp) && event.type === "assistant.turn_start" ? new Date(stamp).toISOString() : null; }
      if (event.type === "assistant.turn_start" && !turnStartedAt) { const stamp = Date.parse(event.timestamp); if (Number.isFinite(stamp)) turnStartedAt = new Date(stamp).toISOString(); }
      if (nextInteraction) interactionId = nextInteraction;
      activity = "working"; state();
    } else if (event.type === "assistant.idle" || event.type === "session.idle") { images.finishHistory(); finish(null); }
    else if (event.type === "abort") finish(new Error("Native Copilot turn was canceled."));
    else if (event.type === "session.error") finish(new Error(string(data.message) || "Native Copilot turn failed."));
    else if (event.type === "session.shutdown") disconnect(new Error("Native Copilot session closed; operation results are unknown."));
  };
  const onEvent = (event: SessionEvent) => {
    runtime?.authority?.observe(event);
    if (runtime?.authority?.suppressPermissionEvent(event)) {
      if (hiddenPermissionEvents.size >= 100_000) runtime.authority.invalidate(); else hiddenPermissionEvents.add(event.id);
      images.discard(event); return;
    }
    if (closed || disconnected) { images.discard(event); return; }
    try {
      interactions.accept(event);
      if (buffered) {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (buffered.length >= 1000 || bufferedBytes + bytes > 16_777_216) {
          images.discard(event); refill = true;
          if (event.ephemeral) options.onTimeline({ entryId: nativeEntryId(nativeId, `ephemeral-unavailable:${event.id}`), revision: "1", kind: "error", code: "ephemeral_unavailable", message: "A transient native event could not be retained during history recovery." });
        } else { buffered.push(event); bufferedBytes += bytes; }
      } else accept(event);
    }
    catch { disconnect(new Error("Native Copilot event could not be processed; operation results are unknown.")); }
  };
  options.onNativeReadPolicy?.(null);
  const artifacts = options.onNativeReadPolicy && !options.executable && !options.toolLaunch ? await prepareCopilotAuthorityArtifacts(copilotExecutable(), options.env ?? process.env, options.onDiagnostic) : undefined;
  let runtime: ReturnType<typeof startCopilotRuntime>;
  try { options.assertNativeDispatch?.(); runtime = startCopilotRuntime({ ...options, cwd }, disconnect, artifacts, options.imageRuntime ? { createSpool: maximum => options.imageRuntime!.createSpool(maximum) } : undefined); }
  catch (error) { await artifacts?.cleanup(); throw error; }
  let permissionHistoryPrepared = false;
  const preparePermissionHistory = async (): Promise<void> => {
    if (!runtime.authority) return;
    // Authenticate complete refusal pairs before either event is projected. The
    // separate scan never transfers images or replaces the durable replay cursor.
    let cursor: string | undefined, reset = false, bytes = 0;
    const events: SessionEvent[] = [], cursors = new Set<string>();
    try {
      for (let pages = 0; !closed && !disconnected; pages++) {
        if (pages >= 100_000) throw new Error("Copilot permission history exceeded its page bound.");
        const page = await call(native!.rpc.eventLog.read({ ...(cursor ? { cursor } : {}), types: ["permission.requested", "permission.completed"], max: 1, includeEphemeral: false }), "Copilot permission history");
        try {
          if (!Array.isArray(page.events) || page.events.length > 1 || typeof page.cursor !== "string" || typeof page.hasMore !== "boolean") throw new Error("Copilot permission history page is invalid.");
          if (page.cursorStatus === "expired") {
            if (reset) throw new Error("Copilot permission history cursor repeatedly expired.");
            cursor = undefined; reset = true; bytes = 0; events.length = 0; cursors.clear(); continue;
          }
          if (page.cursorStatus !== "ok") throw new Error("Copilot permission history cursor is unavailable.");
          for (const event of page.events) {
            if (event.type !== "permission.requested" && event.type !== "permission.completed") throw new Error("Copilot permission history returned an unrelated event.");
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > 16_777_216) throw new Error("Copilot permission history exceeded its metadata bound.");
            events.push(event);
          }
          if (!page.hasMore) { runtime.authority.prepareHistory(events); permissionHistoryPrepared = true; return; }
          if (cursors.has(page.cursor) || page.cursor === cursor) throw new Error("Copilot permission history cursor did not advance.");
          cursor = page.cursor; cursors.add(cursor);
        } finally { if (Array.isArray(page.events)) for (const event of page.events) images.discard(event); }
      }
    } catch {
      runtime.authority.invalidate();
      options.onDiagnostic?.("Copilot image permission history is unverified; image reads are disabled and original interactions remain visible.");
    }
  };
  const historyKey = `copilot:cursor:${nativeEntryId(nativeId, "history")}`;
  let historyRead: Promise<SessionEvent | null> | null = null;
  const readHistory = (): Promise<SessionEvent | null> => historyRead ??= (async () => {
    const saved = record(options.imageRuntime?.readState(historyKey));
    let cursor = images.requiresReplay() ? undefined : string(saved.cursor) || undefined, last = saved.last as SessionEvent | null ?? null, reset = false;
    const cursors = new Set<string>();
    while (!closed && !disconnected) {
      const page = await call(native!.rpc.eventLog.read({ ...(cursor ? { cursor } : {}), max: 1, includeEphemeral: false }), "Copilot native history");
      if (!Array.isArray(page.events) || page.events.length > 1 || typeof page.cursor !== "string" || typeof page.hasMore !== "boolean") throw new Error("Copilot history page is invalid.");
      if (page.cursorStatus === "expired") { if (reset) throw new Error("Copilot history cursor repeatedly expired."); cursor = undefined; reset = true; cursors.clear(); continue; }
      for (const event of page.events) {
        if (hiddenPermissionEvents.has(event.id) || permissionHistoryPrepared && runtime.authority?.suppressPermissionEvent(event, true)) { images.discard(event); continue; }
        if (!buffered?.some(live => live.id === event.id)) interactions.accept(event, true);
        accept(event, true);
        if (!copilotOwner(event) && (event.type === "user.message" || event.type === "assistant.turn_start")) last = { ...event, data: { interactionId: string(record(event.data).interactionId) } } as SessionEvent;
      }
      // Source positions and occurrence intents are durable before the cursor advances.
      options.imageRuntime?.writeState(historyKey, { cursor: page.cursor, last });
      if (!page.hasMore) break;
      if (cursors.has(page.cursor) || page.cursor === cursor) throw new Error("Copilot history cursor did not advance.");
      cursor = page.cursor; cursors.add(cursor);
    }
    return last;
  })().finally(() => { historyRead = null; });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const attempt = (async () => {
      const errors: unknown[] = [];
      closed = true; runtime.authority?.invalidate(); controls?.close(); if (heartbeat) clearInterval(heartbeat);
      try { await options.drainNativeReadPolicy?.(); } catch (error) { errors.push(error); }
      const error = new Error("Native Copilot process is closing; pending operation results are unknown.");
      rejectLost(error);
      try { interactions.dispose(error); } catch (error) { errors.push(error); }
      if (currentTurnId) turns.complete(currentTurnId, error);
      for (const waiter of cancelWaiters) waiter.reject(error); cancelWaiters.clear();
      try { if (native && !startupFailed && !stopped) await copilotDeadline(native.disconnect(), "Copilot session disconnect", 2000); }
      catch { options.onDiagnostic?.("Copilot session disconnect was unconfirmed; stopping its owned runtime."); }
      try { await images.close(); } catch (error) { errors.push(error); }
      const retained: SessionEvent[] = [];
      for (const event of buffered ?? []) {
        try { images.discard(event); } catch (error) { retained.push(event); errors.push(error); }
      }
      buffered = retained.length ? retained : undefined;
      // Media failures cannot bypass owned-process termination. A failed join
      // never becomes a stopped observation, including callbacks during close.
      try { if (!stopped) await runtime.close(startupFailed); stopped = true; currentTurnId = null; activity = "stopped"; }
      catch (error) { errors.push(error); }
      try { state(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Copilot cleanup did not complete.");
    })();
    closing = attempt;
    // Retained media may be released later; retrying cleanup never starts a
    // native runtime or repeats its input, and skips an already joined runtime.
    void attempt.catch(() => { if (closing === attempt) closing = undefined; });
    return attempt;
  };
  try {
    state(); client = await runtime.ready;
    if (options.toolLaunch?.runtimeProfile) await call(readCopilotRuntimeVersion(client, options.toolLaunch), "Copilot frozen runtime compatibility");
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
      ...(options.instructions !== undefined ? { systemMessage: { mode: "append" as const, content: options.instructions } } : {}),
      ...(!options.resumeNativeSessionId && options.model ? { model: options.model } : {}), ...(!options.resumeNativeSessionId && args.effort ? { reasoningEffort: args.effort as NonNullable<SessionConfig["reasoningEffort"]> } : {}),
      onEvent, onPermissionRequest: (request, context) => runtime.authority?.rejectPermission(request, context) ?? interactions.onPermissionRequest(), onUserInputRequest: request => interactions.bindQuestion(request),
      onElicitationRequest: request => interactions.bindElicitation(request), onExitPlanModeRequest: request => interactions.bindPlan(request) };
    options.assertNativeDispatch?.();
    const opening = options.resumeNativeSessionId ? client.resumeSession(nativeId, config) : client.createSession(config);
    void opening.then(async opened => { if (closed && !startupFailed) await copilotDeadline(opened.disconnect(), "Late Copilot session disconnect", 2000); }).catch(() => {});
    native = await call(opening, "Copilot session open");
    const snapshot = await call(native.rpc.metadata.snapshot(), "Copilot session identity");
    if (native.sessionId !== nativeId || snapshot.sessionId !== nativeId || snapshot.isRemote || snapshot.alreadyInUse || !snapshot.workingDirectory || await realpath(snapshot.workingDirectory) !== cwd) throw new Error("Native Copilot session identity or working directory mismatch.");
    controls = new CopilotControls(native, state, options.onControlConfirmed, options.controlsRevisionFloor, skillDiscoveryError, options.assertNativeDispatch);
    await controls.initialize(options.resumeNativeSessionId !== null, options.unattended);
    try {
      const status = await call(client.getStatus(), "Copilot version profile");
      const sdk = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@github/copilot-sdk")), "utf8")) as { version?: unknown };
      imageProfile = options.imageRuntime ? copilotImageProfile(sdk.version, status.version) : null;
    } catch { imageProfile = null; }
    if (options.validateNativeSelection && !options.resumeNativeSessionId) await controls.validateSelection({ model: options.model, ...(args.effort === undefined ? {} : { effort: args.effort }) });
    await runtime.authority?.install(nativeId);
    await preparePermissionHistory();
    verified = true; state();
    for (const match of imageInputs.restoreAccepted()) images.accepted(match);
    const last = await readHistory();
    const { processing } = await call(native.rpc.metadata.isProcessing(), "Copilot foreground activity");
    // Callbacks must bind immediately, but timeline replay precedes queued live
    // updates. Finalized projection IDs prevent old deltas overwriting history.
    if (processing) {
      currentTurnId = nativeEntryId(nativeId, `turn:${last?.id ?? "processing"}`); interactionId = last ? string(record(last.data).interactionId) || null : null;
    }
    activity = processing ? "working" : "idle"; verified = true;
    const queued = buffered!; buffered = undefined; for (const event of queued) accept(event);
    if (refill) { refill = false; await readHistory(); }
    for (const match of imageInputs.pendingAccepted()) images.accepted(match);
    if (activity === "idle") { images.finishHistory(); imageInputs.finishTurn(); }
    if (disconnected) throw new Error("Copilot disconnected during session initialization.");
    state(); refreshTodos();
    // SDK exposes no public transport-close event. Observe owned process exit
    // immediately and use its public ping to detect a broken live connection.
    heartbeat = setInterval(() => {
      if (polling || closed || disconnected || !client) return; polling = true;
      void call(client.ping(), "Copilot connection health", 5000).catch(() => disconnect(new Error("Native Copilot connection lost; operation results are unknown."))).finally(() => { polling = false; });
    }, 5000); heartbeat.unref();
  } catch (error) {
    startupFailed = true;
    const failure = error instanceof ResponseError && !transportErrors.has(error.code)
      ? new ControllerStartupError({ state: "failed", reasonCode: "native_rejected" }, error.message, { cause: error }) : error;
    try { await close(); } catch { options.onDiagnostic?.("Copilot startup cleanup failed; native process stop remains unconfirmed."); }
    throw failure;
  }
  const send = async (inputValue: NativeInput, operationId: string, expectedTurnId: string | null, displayPrompt?: string): Promise<ProviderReceipt> => {
      const { text, images: inputImages } = validateNativeInput(inputValue);
      if (closed || disconnected || dispatching || controlsBusy || currentTurnId !== expectedTurnId || interactions.waiting) throw new NativeRpcError(-32602, "Native Copilot turn changed or cannot accept input.");
      const steering = currentTurnId !== null;
      dispatching = true;
      try {
        if (inputImages.length) {
          await verifyNativeImageFiles(inputImages); await controls!.refresh(false);
          const capability = controls!.imageCapabilities(imageInputs.profileAllowed ? imageProfile : null, verified ? nativeId : null);
          if (capability.send !== "supported" || steering && capability.steer !== "supported" || inputImages.length > capability.maxImagesPerMessage || inputImages.some(image => !capability.inputMediaTypes.includes(image.mediaType as "image/png") || BigInt(image.byteLength) > BigInt(capability.maxImageBytes))) throw new NativeRpcError(-32602, "Copilot image capability is unavailable or changed before dispatch.");
          if (closed || disconnected || currentTurnId !== expectedTurnId || interactions.waiting) throw new NativeRpcError(-32602, "Native Copilot turn changed before image dispatch.");
          imageInputs.prepare(inputValue, operationId, expectedTurnId);
        }
      } catch (error) { dispatching = false; state(); throw error; }
      const turnId = currentTurnId ?? randomUUID(); if (!currentTurnId) turnStartedAt = null; currentTurnId = turnId; activity = "working"; state();
      let uncertain = false;
      const sending = Promise.resolve().then(() => {
        options.assertNativeDispatch?.();
        if (closed || disconnected || currentTurnId !== turnId) throw new NativeRpcError(-32602, "Native Copilot turn changed before input dispatch.");
        if (inputImages.length) return sendCopilotBridgeImages(native!, { prompt: text, mode: "immediate", attachments: inputImages.map(image => ({ path: image.localPath, byteLength: image.byteLength, sha256: image.sha256, mimeType: image.mediaType })) });
        return native!.send({ prompt: text, ...(displayPrompt ? { displayPrompt } : {}), mode: "immediate" });
      }).then(messageId => {
        if (typeof messageId !== "string" || !messageId) throw new Error("Copilot returned no native message identity; input result is unknown.");
        if (!closed && !disconnected) options.onInputMessage?.(operationId, nativeId, nativeEntryId(nativeId, `:user:${messageId}`));
        if (inputImages.length) {
          if (closed || disconnected) throw new Error("Copilot image receipt arrived after runtime ownership was lost; outcome is unknown.");
          images.accepted(imageInputs.accept(operationId, messageId)); if (activity === "idle") imageInputs.finishTurn(); state();
        } else if (uncertain && !closed && !disconnected) options.onInputObserved?.(operationId);
        return messageId;
      });
      // A settled SDK send carries its own native message ID. Prompt equality and
      // locally generated operation IDs never establish native input acceptance.
      void sending.then(() => { dispatching = false; }, () => { dispatching = false; if (inputImages.length) imageProfile = null; state(); });
      let messageId: string;
      try { messageId = await call(sending, "Copilot input acceptance", 60_000); }
      catch (error) { uncertain = true; throw error; }
      if (typeof messageId !== "string" || !messageId) throw new Error("Copilot returned no native message identity; input result is unknown.");
      return { disposition: steering ? "handled" : "started", turnId };
  };
  return {
    nativeSessionId: nativeId, send,
    async refreshControls() { if (closed || disconnected || dispatching || controlsBusy) throw new NativeRpcError(-32602, "Native controls are unavailable."); controlsBusy = true; state(); try { await controls!.refresh(); return { disposition: "handled" }; } finally { controlsBusy = false; state(); } },
    async setSetting(id, value, operationId, revision) {
      if (closed || disconnected || dispatching || controlsBusy) throw new NativeRpcError(-32602, "Native controls are unavailable.");
      controlsBusy = true; controls!.invalidateImages(); state();
      const modelSetting = id === "model" || id === "effort";
      try {
        if (!modelSetting) { runtime.authority?.invalidate(); await options.drainNativeReadPolicy?.(); }
        try { await controls!.set(id, value, operationId, revision); }
        catch (error) {
          if (modelSetting) {
            runtime.authority?.invalidate();
            try { await options.drainNativeReadPolicy?.(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], "Copilot setting failed and image cleanup did not complete."); }
          }
          throw error;
        }
        // Settings-only readback preserves the checker; native permission events
        // can still revoke it while a model change awaits confirmation.
        if (modelSetting && runtime.authority) {
          let valid = true; try { runtime.authority.verify(); } catch { valid = false; }
          if (!valid) await options.drainNativeReadPolicy?.();
        }
        return { disposition: "handled" };
      } finally { controlsBusy = false; state(); }
    },
    async executeCommand(id, args, operationId, revision, expectedTurnId) {
      if (closed || disconnected || dispatching || controlsBusy || currentTurnId !== null || expectedTurnId !== null || interactions.waiting) throw new NativeRpcError(-32602, "Copilot commands require an idle session.");
      controlsBusy = true; controls!.invalidateImages(); state();
      let result: Awaited<ReturnType<CopilotControls["invoke"]>>;
      try { runtime.authority?.invalidate(); await options.drainNativeReadPolicy?.(); result = await controls!.invoke(id, args, revision); await controls!.refresh(false); } finally { controlsBusy = false; state(); }
      if (result.kind === "agent-prompt") { if (result.mode && result.mode !== "interactive") throw new NativeRpcError(-32602, "Copilot command requested an unsupported agent mode."); return send(textNativeInput(result.prompt), operationId, null, result.displayPrompt); }
      if (result.kind !== "text" && result.kind !== "completed") throw new NativeRpcError(-32602, "Copilot command requires unsupported subcommand selection.");
      const text = result.kind === "text" ? result.text : result.message;
      if (text) options.onTimeline({ entryId: nativeEntryId(nativeId, `command:${operationId}`), revision: "1", kind: "assistant_message", content: [{ type: "text", text }] }, markdownTimelineMetadata(text, true, "plain"));
      return { disposition: "handled" };
    },
    async cancel(expectedTurnId): Promise<ProviderReceipt> {
      if (closed || disconnected || currentTurnId !== expectedTurnId) throw new NativeRpcError(-32602, "Native Copilot turn changed.");
      let waiter!: { resolve(): void; reject(error: Error): void };
      const stopped = new Promise<void>((resolve, reject) => { waiter = { resolve, reject }; cancelWaiters.add(waiter); });
      try {
        options.assertNativeDispatch?.();
        const confirmation = call(stopped, "Copilot foreground cancellation");
        const [, result] = await Promise.all([confirmation, call(native!.rpc.interruptMainTurn({}), "Copilot interrupt")]);
        if (!result.interrupted && currentTurnId !== null) throw new Error("Copilot did not confirm foreground cancellation.");
        return { disposition: "handled" };
      } finally { cancelWaiters.delete(waiter); }
    },
    respond: (id, revision, response) => { options.assertNativeDispatch?.(); return interactions.respond(id, revision, response); },
    acknowledgeImageOccurrences: () => images.acknowledge(),
    waitForTurn: (id, deadline) => turns.wait(id, deadline), close,
  };
};
