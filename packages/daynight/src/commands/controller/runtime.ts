import { formatOutboxDiagnostic, isOutboxFailure } from "./outbox-diagnostic.js";
import { restoreCanonicalInputIntent } from "./media/input-intent.js";
import { createControllerCaptureBridge } from "./media/capture.js";
import { ImageCaptureNotDispatchedError, ImageCapturePrerequisiteError } from "./media/capture-error.js";
import { createExternalImagePolicyProducer } from "./markdown/external-policy.js";
import { createMarkdownCaptureCoordinator } from "./markdown/coordinator.js";
import { createMarkdownTimelinePipeline } from "./markdown/pipeline.js";
import { textNativeInput } from "./providers/native-input.js";
import { startupFailure } from "./startup.js";
import { CLEANUP_OPERATION_MS } from "../cleanup-operation.js";
import { prepareAgentCliAliases } from "../../cli/agent-cli-aliases.js";
import { readAgentCliAliases } from "../../config/agent-cli-aliases.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { createNativeCommandQueue, assertControlCommand } from "./command-controls.js";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld, type ControllerStoragePermit } from "./storage-lock.js";
import { prepareControllerStorage } from "./storage-preparation.js";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionCommand } from "../../session/protocol.js";
import { readLaunchToolSelection } from "./launch-tool-selection.js";
import { controllerExecutionDirectory, readLaunchTicket } from "./launch-ticket.js";
import { openControllerLifecycleStore, type ControllerOperation } from "./lifecycle-store.js";
import { validateControllerLocalRequest, type ControllerLocalResponse } from "./local-client.js";
import { captureProcessProof, captureControllerProcessProof } from "./process-proof.js";
import { createControllerRelay } from "./relay.js";
import { providerDisplayEntry } from "./provider-display.js";
import { isCleaningGeneration, observeNativeInput, observeNativeInteraction } from "./recovery.js";
import { NativeRpcError } from "./providers/native-rpc.js";
import type { NativeInput } from "./providers/types.js";
import type { NativeInputLease } from "./media/preparations.js";
import type { NativeInputPublicationQuery, NativeInputPublicationResult } from "./media/native-publication-types.js";
import { nativeInputPublicationFailure } from "./media/native-publication.js";
import { IMAGE_LIMITS } from "../../session/image-values.js";
import { assertImageHistoryAvailable, syncControllerImageHistory } from "./media/history-sync.js";
import type { NativeProvider, NativeReadPolicy, ProviderOptions, ProviderState } from "./providers/types.js";

type ControllerRuntimeOptions = { homeDirectory: string; provider: "codex" | "claude" | "copilot"; launchId: string };
type ControllerRuntimeScope = { signal: AbortSignal; own(close: () => void | Promise<void>): () => Promise<void> };

export const runController = async (options: ControllerRuntimeOptions): Promise<void> => {
  const releases: (() => Promise<void>)[] = [];
  const own = (close: () => void | Promise<void>): (() => Promise<void>) => {
    let release: Promise<void> | undefined;
    const invoke = (): Promise<void> => release ??= Promise.resolve().then(close);
    releases.push(invoke);
    return invoke;
  };
  const bootstrap = new AbortController();
  const abortBootstrap = (): void => { bootstrap.abort(new Error("Controller initialization was stopped.")); };
  process.once("SIGINT", abortBootstrap); process.once("SIGTERM", abortBootstrap);
  let failed = false, primary: unknown;
  try {
    await runControllerRuntime(options, { signal: bootstrap.signal, own });
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    process.off("SIGINT", abortBootstrap); process.off("SIGTERM", abortBootstrap);
    const failures: unknown[] = [];
    for (const release of releases.reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      if (failed) throw new AggregateError([primary, ...failures], "Controller initialization or execution and resource cleanup failed.", { cause: primary });
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Controller resource cleanup failed.");
    }
  }
};

const runControllerRuntime = async (options: ControllerRuntimeOptions, { signal: bootstrapSignal, own }: ControllerRuntimeScope): Promise<void> => {
  const ticket = await readLaunchTicket(options.homeDirectory, options.launchId);
  const diagnostic = (value: unknown): void => {
    try {
      const message = formatOutboxDiagnostic(value, ticket) ?? (value instanceof Error ? value.message : String(value));
      process.stderr.write(`${new Date().toISOString()} ${message.slice(0, 4096)}\n`);
    } catch { /* Diagnostics cannot alter the operation outcome. */ }
  };
  if (ticket.provider !== options.provider || await realpath(ticket.cwd) !== await realpath(process.cwd())) throw new Error("Controller launch provider or working directory mismatch.");
  if (bootstrapSignal.aborted) return;
  const directory = controllerExecutionDirectory(options.homeDirectory, ticket.executionId); await mkdir(directory, { recursive: true, mode: 0o700 });
  const journalFile = path.join(directory, "journal.sqlite"), stateDirectory = resolveConfigurationPaths(options.homeDirectory).stateDirectory;
  let storagePermit: ControllerStoragePermit | undefined;
  let observedAt: number | undefined;
  while (!bootstrapSignal.aborted) {
    try { storagePermit = acquireControllerStoragePermit(journalFile); }
    catch (error) { if (!isControllerStorageLockHeld(error)) throw error; }
    if (storagePermit !== undefined) {
      let prepared;
      try { prepared = prepareControllerStorage({ journalFile, stateDirectory, mode: "writer", ticket }, storagePermit); }
      catch (error) {
        diagnostic(error);
        if (!controllerStorageConnectionIsOpen(error)) {
          try { storagePermit.release(); } catch (release) { throw new AggregateError([error, release], "Controller storage preparation and permit release failed."); }
        }
        throw error;
      }
      if (prepared.kind === "prepared") break;
      storagePermit.release(); storagePermit = undefined;
    }
    if (observedAt === undefined || Date.now() - observedAt >= 30_000) {
      process.stderr.write("Controller storage is busy; the original launch is waiting.\n");
      observedAt = Date.now();
    }
    await new Promise<void>(resolve => {
      const finish = (): void => { clearTimeout(timer); bootstrapSignal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 100);
      bootstrapSignal.addEventListener("abort", finish, { once: true });
      if (bootstrapSignal.aborted) finish();
    });
  }
  if (storagePermit === undefined) return;
  const acquiredPermit = storagePermit;
  let journalClosed = true, mediaClosed = true;
  own(() => { if (journalClosed && mediaClosed) acquiredPermit.release(); });
  if (bootstrapSignal.aborted) return;
  const controllerProcess = await captureControllerProcessProof(ticket.launchId);
  if (bootstrapSignal.aborted) return;
  let journal: ReturnType<typeof openControllerLifecycleStore>;
  try { journal = openControllerLifecycleStore(journalFile, ticket, { storagePermit, controllerProcess, contentOwnedLocally: true, mediaStateDirectory: stateDirectory }); }
  catch (error) { diagnostic(error); journalClosed = !controllerStorageConnectionIsOpen(error); throw error; }
  journalClosed = false; mediaClosed = false;
  own(() => { journal.close(); journalClosed = true; });
  const stopMedia = own(async () => { await journal.stopMedia?.(); mediaClosed = true; });
  let provider: NativeProvider | null = null, stopping = false, synchronized = false;
  let nativeReadPolicy: NativeReadPolicy | null = null;
  let nativeImages: ProviderState["images"];
  let projectionFailure: string | null = null, providerFailure: string | null = null;
  let accountingFailure: unknown;
  let startup: Promise<void> | null = null, shutdownPromise: Promise<void> | null = null;
  const historyAbort = new AbortController();
  let historyWork: Promise<void> | null = null;
  let historyTimer: NodeJS.Timeout | null = null;
  let markdownTimer: NodeJS.Timeout | null = null;
  const knownInteractions = new Set<string>(), cleanupInteractions = new Set<string>();
  let cleanupInputStarted = false;
  let cleaning = isCleaningGeneration(journal.listOperations(), ticket.executionGeneration);
  let complete!: () => void; const finished = new Promise<void>(resolve => { complete = resolve; });
  const queueNative = createNativeCommandQueue();
  const sockets = new Set<Socket>(), active = new Map<string, Promise<ControllerOperation>>();
  const processCaptures: Promise<void>[] = [];
  const closeProvider = own(async () => {
    const failures: unknown[] = [];
    try { await provider?.close(); } catch (error) { failures.push(error); }
    try { await Promise.all(processCaptures); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Native provider shutdown and process capture failed.");
  });
  const publishState = () => {
    const s = journal.getSnapshot();
    if (!stopping && !["failed", "paused", "stopped", "stopping"].includes(s.lifecycle)) {
      // Initial native input needs both the completed provider startup and a
      // synchronized relay. Provider state can arrive before its handle does.
      const waiting = !provider || s.activity === "initializing" || s.initialInputState === "not_submitted" && !synchronized;
      journal.patchSnapshot({ lifecycle: waiting ? "starting" : s.activity === "idle" ? "ready" : "working" });
    }
    journal.appendEvent({ kind: "state", payload: readState() });
  };
  const readState = (): import("../../session/controller-protocol.js").ControllerState => {
    const s = journal.getSnapshot();
    const qualified = !stopping && nativeImages?.expectedNativeSessionId === s.nativeSessionId && nativeImages.controlsRevision === (s.controls?.revision ?? null) ? nativeImages : undefined;
    const providerImages = journal.providerImageCapabilities?.(qualified ?? { expectedNativeSessionId: s.nativeSessionId, modelId: ticket.configuration.model, controlsRevision: s.controls?.revision ?? null, send: "unsupported", steer: "unsupported", reasonCode: "profile_disabled", inputMediaTypes: [], maxImageBytes: String(IMAGE_LIMITS.imageBytes), maxMessageImageBytes: String(IMAGE_LIMITS.messageBytes), maxImagesPerMessage: IMAGE_LIMITS.images, geometry: { version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 } });
    return { ...(providerImages ? { providerImages } : {}), nativeSessionId: s.nativeSessionId, initialInputState: s.initialInputState, synchronized, activity: !provider ? "initializing" : stopping ? "stopped" : s.activity, currentTurnId: s.currentTurnId, ...(provider && !stopping && s.controls ? { controls: s.controls } : {}), ...(s.turnStartedAt !== undefined ? { turnStartedAt: s.turnStartedAt } : {}), ...(cleaning ? { cleanupInteractionIds: [...cleanupInteractions] } : {}), capabilities: !provider || stopping ? { send: false, steer: false, cancel: false, respond: false } : cleaning ? { ...s.capabilities, send: false, steer: false, cancel: false } : s.capabilities };
  };
  const fail = (error: unknown) => {
    if (isOutboxFailure(error) && accountingFailure === undefined) { stopForAccountingFailure(error); return; }
    const message = error instanceof Error ? error.message : String(error); diagnostic(error);
    try {
      const startup = journal.getSnapshot().startup;
      // Shutdown may fail after initialization already supplied the decisive observation.
      const retain = startup !== undefined && startup.state !== "starting" && startup.reasonCode !== "evidence_missing";
      journal.patchSnapshot({ lifecycle: "paused", error: message, ...(retain ? {} : { startup: startupFailure(error) }) });
    } catch { /* The private log retains a journal failure when disk writes fail. */ }
  };
  const dispatch = (operation: ControllerOperation, invoke: () => Promise<unknown>): Promise<ControllerOperation> => {
    const running = active.get(operation.operationId); if (running) return running;
    if (operation.state !== "accepted") return Promise.resolve(operation);
    const execute = (async () => {
      if (["initial", "send_message", "interaction_response", "execute_command", "update_setting"].includes(operation.kind)) accountingBoundary(() => journal.assertInputCapacity());
      journal.markDispatching(operation.operationId); nativeEvent(publishState);
      if (accountingFailure !== undefined) throw accountingFailure;
      try { const result = await invoke(); const saved = journal.recordOperation(operation.operationId, "confirmed", result); nativeEvent(publishState); return saved; }
      catch (error) {
        if (accountingFailure !== undefined) throw accountingFailure;
        if (isOutboxFailure(error)) { stopForAccountingFailure(error); throw error; }
        const observed = journal.getOperation(operation.operationId);
        if (observed && (["confirmed", "failed", "rejected", "expired"].includes(observed.state) || ["initial", "send_message", "execute_command"].includes(operation.kind) && observed.state === "provider_accepted")) { nativeEvent(publishState); return observed; }
        const saved = journal.recordOperation(operation.operationId, error instanceof NativeRpcError ? "rejected" : "unknown", null, error instanceof Error ? error.message : String(error)); nativeEvent(publishState); return saved;
      }
    })();
    active.set(operation.operationId, execute); void execute.finally(() => active.delete(operation.operationId)).catch(fail); return execute;
  };
  const assertImageCommand = (command: SessionCommand): void => {
    if (command.kind !== "send_message" || !command.payload.content.some(part => part.type === "image")) return;
    const images = readState().providerImages, target = command.payload.target;
    if (!images || !target || target.expectedNativeSessionId !== journal.getSnapshot().nativeSessionId || command.payload.expectedImageCapabilityRevision !== images.revision) throw new NativeRpcError(-32602, "Image capability or native target changed before dispatch.");
    if ((command.payload.expectedTurnId === null ? images.send : images.steer) !== "supported") throw new NativeRpcError(-32602, "Native image input is disabled for this provider profile.");
  };
  let relay!: ReturnType<typeof createControllerRelay>;
  function stopForAccountingFailure(error: unknown): void {
    accountingFailure ??= error;
    journal.disableOutboxWrites();
    projectionFailure ??= error instanceof Error ? error.message : String(error);
    stopping = true;
    relay?.stop();
    fail(error);
    queueMicrotask(() => { void shutdown(); });
  }
  function accountingBoundary<T>(action: () => T): T {
    try { return action(); }
    catch (error) { if (isOutboxFailure(error)) stopForAccountingFailure(error); throw error; }
  }
  const assertNativeDispatch = (): void => {
    if (accountingFailure !== undefined) throw accountingFailure;
    if (stopping) throw new Error("Controller stopped before native dispatch.");
  };
  const captureBridge = createControllerCaptureBridge({ journal, capture: (action, body) => relay.capture(action, body), beforeCapture: () => synchronizeImageHistory(true), provider: () => provider, writable: () => !stopping && !cleaning && synchronized, retrySource: (request, signal) => markdownCaptures.retry(request, signal) });
  const externalImages = createExternalImagePolicyProducer({ paths: resolveConfigurationPaths(options.homeDirectory) });
  const closeExternalImages = own(() => externalImages.close());
  const markdownCaptures = createMarkdownCaptureCoordinator({ ticket, journal, bridge: captureBridge.providerOptions,
    writable: () => !stopping && !cleaning && synchronized,
    fence: () => { const fence = relay?.currentFence?.(); return fence ? JSON.stringify(fence) : null; },
    nativeReadPolicy: () => nativeReadPolicy,
    acquireExternalPolicy: externalImages.acquire,
    onReceipt: (request, receipt) => markdownTimeline.receipt(request, receipt),
    onFailure: (occurrence, error) => markdownTimeline.failure(occurrence, error),
  });
  const stopMarkdownCaptures = own(() => markdownCaptures.stop());
  const markdownTimeline = createMarkdownTimelinePipeline({ journal, captures: markdownCaptures, onError: error => nativeEvent(() => { throw error; }) });
  const stopMarkdownTimeline = own(() => markdownTimeline.stop());
  relay = createControllerRelay(ticket, journal, {
    onConnection: connected => { synchronized = connected; if (!connected) markdownCaptures.invalidate(); if (!stopping) { try { publishState(); } catch (error) { fail(error); } } },
    onError: error => {
      if (!isOutboxFailure(error)) { diagnostic(error); return; }
      stopForAccountingFailure(error);
    },
    readState,
    onAcknowledged: () => {
      provider?.acknowledgeImageOccurrences?.();
      if (historyTimer) clearTimeout(historyTimer);
      historyTimer = setTimeout(() => { historyTimer = null; void synchronizeImageHistory().catch(error => diagnostic(error)); }, 250);
    },
    beforeImage: () => synchronizeImageHistory(true),
    onRetryCapture: (body, signal) => captureBridge.retry(body, signal),
    acquireCaptureReadPolicy: request => markdownCaptures.acquireReadPolicy(request),
    onCommand: async command => {
      if (command.sessionId !== ticket.sessionId || command.claimId !== ticket.claimId || command.testExecutionId !== ticket.testExecutionId || command.executionGeneration !== ticket.executionGeneration) throw new Error("Stale session command.");
      const operation = accountingBoundary(() => journal.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command }));
      if (operation.state !== "accepted") { relay.receipt(operation); return; }
      if (!provider || stopping || !synchronized) throw new Error("Native provider is not available.");
      await queueNative(command.kind, async () => {
        const current = journal.getOperation(command.operationId);
        if (current && current.state !== "accepted") { relay.receipt(current); return; }
        if (!provider || stopping || !synchronized) throw new Error("Native provider is not available.");
        let lease: NativeInputLease | undefined;
        try {
          if (command.kind === "send_message" && command.payload.content.some(part => part.type === "image")) {
            // File acquisition can await I/O. It precedes the irreversible dispatch marker.
            lease = await journal.media().acquireInput(command.payload, command.operationId);
          }
          if (!provider || stopping || !synchronized) throw new NativeRpcError(-32602, "Native provider is not available.");
          assertControlCommand(command, journal.getSnapshot());
          if (lease) assertImageCommand(command);
          await relay.authorize(command.operationId);
          if (!relay.connected() || stopping) throw new Error("Relay authorization lost before native dispatch.");
          // Authorization is asynchronous too; check current turn and target again.
          assertControlCommand(command, journal.getSnapshot());
          if (lease) assertImageCommand(command);
          lease?.verify();
          const result = await dispatch(operation, () => { lease?.retain(); return executeCommand(command, lease?.input); }); relay.receipt(result);
        } catch (error) {
          if (isOutboxFailure(error)) { stopForAccountingFailure(error); throw error; }
          if (journal.getOperation(command.operationId)?.state === "accepted") relay.receipt(journal.recordOperation(command.operationId, "rejected", null, error instanceof NativeRpcError ? error.message : "Native dispatch did not start because its input could not be prepared or authorized."));
          else throw error;
        } finally { lease?.close(); }
      });
    },
  });
  if (accountingFailure !== undefined) relay.stop();
  const closeRelay = own(() => relay.close());
  // Source admission and AST analysis page the durable index independently;
  // native callbacks only persist text and never wait for media work.
  markdownTimer = setInterval(() => {
    void markdownTimeline.tick().catch(fail);
    void markdownCaptures.tick().catch(error => { if (isOutboxFailure(error)) fail(error); else diagnostic(error); });
  }, 250);
  own(() => { if (markdownTimer) { clearInterval(markdownTimer); markdownTimer = null; } });
  own(async () => {
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    historyAbort.abort(new Error("Controller history synchronization stopped."));
    await historyWork;
  });
  async function synchronizeImageHistory(forCapture = false): Promise<void> {
    let requiredSourceThrough: string | undefined;
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    if (stopping || !relay?.connected()) {
      if (forCapture) throw new ImageCaptureNotDispatchedError("Image capture is waiting for its history connection.");
      return;
    }
    if (!relay.imageHistorySupported?.()) {
      if (forCapture) throw new ImageCapturePrerequisiteError({ code: "component_unsupported", message: "Complete image history synchronization is unavailable." });
      return;
    }
    if (forCapture) {
      try { assertImageHistoryAvailable(journal); }
      catch (error) {
        // The current capture must see the confirmed failure. A later
        // checkpoint can independently establish recovery after space changes.
        historyTimer = setTimeout(() => { historyTimer = null; void synchronizeImageHistory().catch(cause => diagnostic(String(cause))); }, 250);
        throw error;
      }
      await relay.flush();
      if (stopping || !relay.connected()) throw new ImageCaptureNotDispatchedError("Image capture history connection changed before synchronization.");
      requiredSourceThrough = journal.getLastSourceSequence();
    }
    const previous = historyWork;
    const work = (async () => {
      if (previous) await previous;
      if (stopping) throw new ImageCaptureNotDispatchedError("Image history synchronization stopped before its checkpoint.");
      for (;;) {
        if (stopping) throw new ImageCaptureNotDispatchedError("Image history synchronization stopped before its checkpoint.");
        const fence = relay.currentFence();
        if (!fence || !relay.connected()) throw new ImageCaptureNotDispatchedError("Image history connection changed before synchronization.");
        await syncControllerImageHistory({ ticket, journal, fence, currentFence: relay.currentFence, signal: historyAbort.signal, ...(requiredSourceThrough === undefined ? {} : { requiredSourceThrough }) });
        if (!forCapture || journal.hasImageHistoryCheckpoint(journal.getLastSourceSequence())) return;
        // Native events can advance the acknowledged source while an older
        // frozen body uploads. Submit requires the complete current ledger.
        await relay.flush();
        requiredSourceThrough = journal.getLastSourceSequence();
      }
    })();
    historyWork = work;
    try { await work; } finally { if (historyWork === work) historyWork = null; }
  }
  const executeCommand = async (command: SessionCommand, input?: NativeInput) => {
    if (!provider || stopping) throw new NativeRpcError(-32602, "Native provider is unavailable.");
    if (cleaning && command.kind !== "interaction_response") throw new NativeRpcError(-32602, "The controller is cleaning this execution.");
    assertControlCommand(command, journal.getSnapshot());
    if (command.kind === "update_setting") {
      if (!provider.setSetting) throw new NativeRpcError(-32602, "Native settings are unavailable.");
      return provider.setSetting(command.payload.settingId, command.payload.value, command.operationId, command.payload.expectedControlsRevision);
    }
    if (command.kind === "execute_command") {
      if (!provider.executeCommand || !["not_required", "provider_accepted", "confirmed"].includes(journal.getSnapshot().initialInputState)) throw new NativeRpcError(-32602, "Native commands are unavailable.");
      return provider.executeCommand(command.payload.commandId, command.payload.arguments, command.operationId, command.payload.expectedControlsRevision, command.payload.expectedTurnId);
    }
    if (command.kind === "refresh_controls") {
      if (!provider.refreshControls) throw new NativeRpcError(-32602, "Native controls are unavailable.");
      return provider.refreshControls();
    }
    if (command.kind === "send_message") {
      if (!["not_required", "provider_accepted", "confirmed"].includes(journal.getSnapshot().initialInputState)) throw new NativeRpcError(-32602, "Initial task input is not confirmed.");
      if (ticket.initialInput === "none" && journal.getSnapshot().nativeSessionId === null && journal.listOperations().some(operation => operation.operationId !== command.operationId && operation.kind === "send_message" && ["dispatching", "provider_accepted", "confirmed", "unknown"].includes(operation.state))) throw new NativeRpcError(-32602, "The first native input is still unconfirmed; its original operation must be reconciled.");
      return provider.send(input ?? { content: command.payload.content.filter(part => part.type === "text") }, command.operationId, command.payload.expectedTurnId);
    }
    if (command.kind === "cancel") return provider.cancel(command.payload.expectedTurnId);
    if (cleaning && !cleanupInteractions.has(command.payload.interactionId)) throw new NativeRpcError(-32602, "Only the current cleanup interaction may be answered.");
    return provider.respond(command.payload.interactionId, command.payload.interactionRevision, command.payload.response);
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (markdownTimer) { clearInterval(markdownTimer); markdownTimer = null; }
    markdownCaptures.invalidate();
    const externalImagesClosed = closeExternalImages().catch(fail);
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    shutdownPromise = (async () => {
    try {
      await startup?.catch(() => {});
      try { journal.patchSnapshot({ lifecycle: "stopping" }); } catch (error) { fail(error); }
      await stopMarkdownCaptures();
      await closeProvider();
      await stopMarkdownTimeline();
      journal.patchSnapshot({ activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
      if (projectionFailure && accountingFailure === undefined) {
        // Drain committed events before recording a visible gap. Never discard an
        // earlier outbox row to make room for a later native callback.
        await relay.flush();
        journal.drainProjectionGap();
      }
      if (accountingFailure === undefined) { publishState(); await relay.flush().catch(fail); }
    }
    catch (error) { fail(error); }
    finally {
      await externalImagesClosed;
      await stopMarkdownCaptures().catch(fail);
      await stopMarkdownTimeline().catch(fail);
      historyAbort.abort(new Error("Controller history synchronization stopped."));
      await historyWork?.catch(error => diagnostic(error));
      try { await closeRelay(); } catch (error) { fail(error); }
      try { await stopMedia(); } catch (error) { fail(error); }
      for (const socket of sockets) socket.destroy();
      try { await closeServer(); } catch (error) { fail(error); }
      complete();
    }
    })();
    return shutdownPromise;
  };
  // One completion listener per dispatch, with removable socket waiters. A
  // disconnected caller cannot cancel native work or retain an async handler.
  const localWaiters = new Map<Promise<ControllerOperation>, Set<(value: ControllerOperation | null, error?: unknown) => void>>();
  let localWaiterCount = 0;
  const waitForOperation = (socket: Socket, execution: Promise<ControllerOperation>, milliseconds: number): Promise<ControllerOperation | null> => {
    const existing = localWaiters.get(execution);
    const waiters = existing ?? new Set<(value: ControllerOperation | null, error?: unknown) => void>();
    if (!existing) {
      localWaiters.set(execution, waiters);
      const complete = (value: ControllerOperation | null, error?: unknown) => {
        localWaiters.delete(execution);
        for (const waiter of waiters) waiter(value, error);
      };
      void execution.then(value => complete(value), error => complete(null, error));
    }
    return new Promise((resolve, reject) => {
      const finish = (value: ControllerOperation | null, error?: unknown) => {
        if (!waiters.delete(finish)) return;
        localWaiterCount--; clearTimeout(timer); socket.off("close", disconnected);
        if (error !== undefined) reject(error); else resolve(value);
      };
      const disconnected = () => finish(null);
      const timer = setTimeout(() => { socket.destroy(); disconnected(); }, milliseconds);
      waiters.add(finish); localWaiterCount++; socket.once("close", disconnected);
      if (socket.destroyed) disconnected();
    });
  };
  let ipcBound = false;
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setTimeout(30_000, () => socket.destroy()); socket.setEncoding("utf8"); let buffer = "", handled = false;
    socket.on("data", (text: string) => {
      if (handled) return; buffer += text; if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n"); if (newline < 0) return; handled = true;
      void (async () => {
        let requestId = "";
        try {
          const request = validateControllerLocalRequest(JSON.parse(buffer.slice(0, newline)), ticket); requestId = request.requestId;
          buffer = "";
          // Admission bounds unauthenticated/incomplete frames. Once admitted,
          // native RPC and action deadlines govern completion, including input
          // acceptance that legitimately takes longer than this socket window.
          socket.setTimeout(0);
          let operation: ControllerOperation | null | undefined;
          if (request.action.kind === "stop") {
            socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot() } satisfies ControllerLocalResponse) + "\n", () => { void shutdown(); }); return;
          }
          if (request.action.kind !== "observe") {
            const pending = active.get(request.action.operationId);
            if (localWaiterCount >= 32 || localWaiters.size >= 32 && (!pending || !localWaiters.has(pending))) throw new Error("Controller IPC action capacity is unavailable.");
            if (!stopping && request.action.kind === "submit_initial" && (!provider || !synchronized)) {
              // No dispatch intent exists yet. The worker may observe again
              // after startup/reconnection without treating this as a failure.
              journal.patchSnapshot({ lifecycle: "starting" });
              socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot() } satisfies ControllerLocalResponse) + "\n"); return;
            }
            if (!provider || stopping || request.action.kind === "submit_initial" && !synchronized) throw new Error("Controller is still initializing or disconnected.");
            if (request.action.kind === "submit_initial") {
              const prepared = accountingBoundary(() => journal.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } }));
              operation = await waitForOperation(socket, dispatch(prepared, () => provider!.send(textNativeInput(ticket.initialPrompt), ticket.initialOperationId, null)), 65_000);
              if (operation === null) return;
            } else {
              const action = request.action;
              cleaning = true; cleanupInputStarted = false; cleanupInteractions.clear(); nativeEvent(publishState);
              if (stopping) throw new Error("Controller stopped after a durable event failure.");
              if (Date.now() >= action.deadline) throw new Error("Cleanup deadline expired.");
              const prepared = accountingBoundary(() => journal.prepareOperation({ operationId: action.operationId, kind: "cleanup", payload: { text: action.prompt, deadline: action.deadline } }));
              operation = await waitForOperation(socket, dispatch(prepared, async () => {
                const turn = journal.getSnapshot().currentTurnId;
                if (turn !== null) {
                  await provider!.cancel(turn);
                  assertNativeDispatch();
                  while (journal.getSnapshot().currentTurnId !== null && Date.now() < action.deadline) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                    assertNativeDispatch();
                  }
                }
                assertNativeDispatch();
                if (Date.now() >= action.deadline) throw new Error("Cleanup deadline expired before input submission.");
                accountingBoundary(() => journal.assertInputCapacity());
                assertNativeDispatch();
                cleanupInputStarted = true;
                const receipt = await provider!.send(textNativeInput(action.prompt), action.operationId, null);
                journal.recordOperation(action.operationId, "provider_accepted", receipt);
                if (!receipt.turnId) throw new Error("Native cleanup turn identity is unknown.");
                await provider!.waitForTurn(receipt.turnId, action.deadline);
                return receipt;
              }), Math.max(1, Math.min(CLEANUP_OPERATION_MS, action.deadline - Date.now())));
              if (operation === null) return;
            }
          }
          socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot(), ...(operation ? { operation } : {}) } satisfies ControllerLocalResponse) + "\n");
        } catch (error) { if (isOutboxFailure(error)) stopForAccountingFailure(error); socket.end(JSON.stringify({ requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ControllerLocalResponse) + "\n"); }
      })().catch(fail);
    });
  });
  const closeServer = own(async () => {
    for (const socket of sockets) socket.destroy();
    const closed = server.listening ? once(server, "close") : null;
    server.close();
    if (closed) await closed;
    if (ipcBound && process.platform !== "win32") {
      try { await unlink(ticket.ipcEndpoint); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  });
  function nativeEvent(write: () => void): void {
    if (projectionFailure) return;
    try { write(); }
    catch (error) {
      if (isOutboxFailure(error)) stopForAccountingFailure(error);
      else { projectionFailure = error instanceof Error ? error.message : String(error); fail(error); }
      try { journal.markProjectionGap("Native projection stopped after a durable event failure. Resume must reload native history."); } catch (failure) { fail(failure); }
      // Initialization must acquire the provider handle before it can close it.
      if (provider && accountingFailure === undefined) void shutdown();
    }
  }
  const adoptNativePublication = <T extends NativeInputPublicationResult | NativeInputPublicationQuery>(result: T): T => {
    let current = result;
    nativeEvent(() => {
      journal.assertUsable();
      if (result.state !== "committed") return;
      const { entrySeq: _entrySeq, ...entry } = result.view.entry, identity = result.receipt.identity;
      const intent = journal.getInputIntent(identity.operationId);
      const command = intent?.sha256 === identity.intentSha256 ? restoreCanonicalInputIntent(intent, identity.operationId) : null;
      const text = command?.kind === "send_message" ? command.payload.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : null;
      const bodies = entry.content.flatMap(part => part.type === "text" || part.type === "markdown" && part.text.length > 0 ? [part.text] : []);
      const complete = text !== null && bodies.length === 1 && bodies[0] === text;
      markdownTimeline.adoptCommitted(entry, { complete, format: "markdown", truncated: !complete });
      const displayed = journal.getTimelineEntry(entry.entryId);
      if (!displayed || displayed.kind !== "user_message") throw new Error("Native publication lost its current committed message.");
      current = { ...result, view: { ...result.view, entry: displayed } };
    });
    return current;
  };
  const signal = () => { void shutdown(); };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  startup = (async () => {
    journal.patchSnapshot({ startup: { state: "starting", reasonCode: "initializing" } });
    await journal.reconcileNativeIndexReservation();
    if (stopping) return;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(ticket.ipcEndpoint, () => { ipcBound = true; server.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") await chmod(ticket.ipcEndpoint, 0o600);
    if (stopping) return;
    const paths = resolveConfigurationPaths(options.homeDirectory);
    const aliases = await prepareAgentCliAliases({ aliases: await readAgentCliAliases(paths), environment: process.env, stateDirectory: paths.stateDirectory });
    if (stopping) return;
    for (const binding of aliases.bindings) diagnostic(`Agent CLI alias ${binding.name} -> ${binding.target} (${binding.executable}).`);
    const env = { ...aliases.environment };
    for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete env[key];
    if (ticket.provider === "codex") env.CODEX_HOME = ticket.nativeHome;
    else if (ticket.provider === "claude") env.CLAUDE_CONFIG_DIR = ticket.nativeHome;
    else env.COPILOT_HOME = ticket.nativeHome;
    const toolLaunch = await readLaunchToolSelection(options.homeDirectory, ticket);
    if (stopping) return;
    const nativeOptions: ProviderOptions = {
      ...(toolLaunch ? { toolLaunch, toolRuntimeRoot: path.join(paths.stateDirectory, "worker", "tool-runtimes") } : {}),
      ...(ticket.instructions === undefined ? {} : { instructions: ticket.instructions }),
      ...(aliases.bindings.length > 0 ? { agentCliEnvironment: { PATH: env.PATH!, DN_CONFIG_DIR: env.DN_CONFIG_DIR! } } : {}),
      ...(journal.getSnapshot().controlsRevisionFloor ? { controlsRevisionFloor: journal.getSnapshot().controlsRevisionFloor! } : {}),
      cwd: ticket.cwd, model: ticket.configuration.model, args: ticket.configuration.args, resumeNativeSessionId: ticket.resumeNativeSessionId, unattended: ticket.claimId !== undefined, env,
      assertNativeDispatch,
      ...(ticket.configuration.validateNativeSelection === true ? { validateNativeSelection: true as const } : {}),
      onDiagnostic: diagnostic,
      onNativeReadPolicy: policy => { nativeReadPolicy = policy; if (!policy) markdownCaptures.invalidateNativeReadPolicy(); },
      drainNativeReadPolicy: () => markdownCaptures.drainNativeReadPolicy(),
      onFatalError: error => {
        if (providerFailure) return;
        providerFailure = error.message; fail(error);
        // Startup must first acquire the provider handle. Awaiting shutdown from
        // an opening callback would make startup wait for its own completion.
        if (provider) void shutdown();
      },
      onImageOccurrence: (occurrence, source) => journal.registerImageOccurrence(occurrence, source).acknowledged,
      imageOccurrenceAcknowledged: imageId => journal.imageOccurrenceAcknowledged(imageId),
      ...captureBridge.providerOptions,
      imageRuntime: {
        publishNativeInputAssociation: request => {
          const result = accountingBoundary(() => journal.publishNativeInputAssociation(request));
          const failure = nativeInputPublicationFailure(result);
          if (failure !== undefined) stopForAccountingFailure(failure);
          return adoptNativePublication(result);
        },
        patchNativeImagePart: (occurrence, part) => {
          const current = accountingBoundary(() => journal.patchNativeImagePart(occurrence, part)), { entrySeq: _entrySeq, ...entry } = current;
          nativeEvent(() => { markdownTimeline.adoptCommitted(entry); });
          return current;
        },
        queryNativeInputAssociation: identity => adoptNativePublication(accountingBoundary(() => journal.queryNativeInputAssociation(identity))),
        getIntent: operationId => {
          const intent = journal.getInputIntent(operationId), operation = journal.getOperation(operationId);
          return intent && operation ? { sha256: intent.sha256, command: restoreCanonicalInputIntent(intent, operationId), state: operation.state } : null;
        },
        readState: key => journal.readNativeImageState(key),
        writeState: (key, value) => journal.writeNativeImageState(key, value),
        createSpool: maximum => journal.media().createSpool(maximum),
        indexDirectory: () => journal.media().nativeIndexDirectory(),
        reserveIndex: additional => journal.media().reserveNativeIndex(additional),
        acquireIndexReservation: (additional, owner) => journal.acquireNativeIndexReservation(additional, owner),
      },
      onInputMessage: (operationId, nativeSessionId, entryId) => {
        let originalEntryId: string | undefined;
        nativeEvent(() => { originalEntryId = journal.associateInputMessage(operationId, nativeSessionId, entryId); });
        return originalEntryId;
      },
      onInputObserved: observation => {
        let accepted = false;
        nativeEvent(() => {
        const operationId = typeof observation === "string" ? observation : observation.operationId;
        if (!observeNativeInput(journal, observation)) return;
        accepted = true;
        publishState();
        const receipt = journal.getOperation(operationId);
        if (receipt?.kind === "send_message" || receipt?.kind === "execute_command") { try { relay.receipt(receipt); } catch (error) { diagnostic(error); } }
        });
        return accepted;
      },
      onControlConfirmed: operationId => nativeEvent(() => {
        const operation = journal.getOperation(operationId);
        if (!operation || !["update_setting", "execute_command"].includes(operation.kind) || !["dispatching", "provider_accepted", "unknown"].includes(operation.state)) return;
        const receipt = journal.recordOperation(operationId, "confirmed", { disposition: "handled" });
        publishState(); try { relay.receipt(receipt); } catch (error) { diagnostic(error); }
      }),
      hasTimelineEntry: entryId => journal.hasTimelineEntry(entryId),
      onTimeline: (entry, metadata) => nativeEvent(() => {
        const displayed = providerDisplayEntry(entry);
        markdownTimeline.accept(displayed, metadata && { ...metadata, truncated: metadata.truncated || JSON.stringify(displayed) !== JSON.stringify(entry) });
        if (entry.kind === "interaction") {
          const id = entry.interaction.interactionId;
          if (cleaning && cleanupInputStarted && !knownInteractions.has(id) && entry.interaction.state === "pending") cleanupInteractions.add(id);
          knownInteractions.add(id);
          if (entry.interaction.state !== "pending") cleanupInteractions.delete(id);
          if (cleaning) publishState();
        }
        if (entry.kind === "interaction" && entry.interaction.state === "resolved") {
          for (const receipt of observeNativeInteraction(journal, entry.interaction.interactionId, ticket.executionGeneration)) {
            try { relay.receipt(receipt); } catch (error) { diagnostic(error); }
          }
        }
      }),
      onState: state => nativeEvent(() => { const { nativeSessionId, images, ...status } = state; nativeImages = images; journal.patchSnapshot({ ...status, ...(nativeSessionId !== null ? { nativeSessionId } : {}), lifecycle: state.activity === "idle" ? "ready" : state.activity === "stopped" ? "stopping" : "working" }); publishState(); }),
      onSpawn: child => { if (!child.pid) throw new Error("Native process identity is unavailable."); const capture = captureProcessProof(child.pid).then(proof => { const s = journal.getSnapshot(); journal.patchSnapshot({ nativeProcesses: [...s.nativeProcesses, proof] }); }); processCaptures.push(capture); void capture.catch(fail); },
      onNativeProcessProof: proof => { const s = journal.getSnapshot(); if (!s.nativeProcesses.some(saved => saved.pid === proof.pid && saved.startedAt === proof.startedAt && saved.commandHash === proof.commandHash)) journal.patchSnapshot({ nativeProcesses: [...s.nativeProcesses, proof] }); },
    };
    provider = await (ticket.provider === "codex" ? (await import("./providers/codex.js")).openCodexProvider(nativeOptions)
      : ticket.provider === "claude" ? (await import("./providers/claude.js")).openClaudeProvider(nativeOptions)
      : (await import("./providers/copilot.js")).openCopilotProvider(nativeOptions));
    await Promise.all(processCaptures);
    if (accountingFailure !== undefined) throw accountingFailure;
    if (projectionFailure) throw new Error(projectionFailure);
    if (providerFailure) throw new Error(providerFailure);
    if (stopping) return;
    journal.patchSnapshot({ lifecycle: "ready", startup: { state: "ready", reasonCode: "ready" } }); publishState();
  })();
  try {
    if (bootstrapSignal.aborted) void shutdown();
    await startup;
    await finished;
    if (accountingFailure !== undefined) throw accountingFailure;
  } catch (error) {
    if (isOutboxFailure(error) && accountingFailure === undefined) stopForAccountingFailure(error);
    const failure = accountingFailure ?? error; fail(failure); await shutdown(); throw failure;
  }
  finally { process.off("SIGINT", signal); process.off("SIGTERM", signal); }
};
