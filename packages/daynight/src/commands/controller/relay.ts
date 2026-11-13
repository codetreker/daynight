import type { ImageCaptureReceipt, ValidatedImage } from "../../session/image-values.js";
import type { CaptureReadPolicy, ControllerMediaBlockLease } from "./media/preparations.js";
import { ImageReleaseStorageError, isImageReleaseStorageFailure } from "./media/release-error.js";
import { ImageCaptureNotDispatchedError, ImageCaptureRequestError } from "./media/capture-error.js";
import { sessionDisplayEntry, sessionWireBytes } from "./wire-display.js";
import { sessionFence, sessionBinding } from "../../session/protocol.js";
import { readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { SESSION_PROTOCOL, type SessionCommand, type SessionOperation, type ControllerFence } from "../../session/protocol.js";
import { RELAY_LIMITS, parseControllerGrantResponse, parseRelayMessage, type ControllerMessage, type ControllerGrantResponse, type SourceEvent, type Reconciliation, type ControllerState, type ContentResponse, type ContentRequest, type ImageRequest, type ImageResponse, parseImageCaptureMessage, type ImageCaptureAction, type ImageCaptureBody, type ImageCaptureMessage } from "../../session/controller-protocol.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerLifecycleStore, ControllerOperation } from "./lifecycle-store.js";
import { CONTENT_READ_VERSION_HEADER, SessionHistoryError } from "../../session/history.js";

export const publicOperation = (ticket: ControllerLaunchTicket, operation: ControllerOperation): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...sessionFence(ticket), executionGeneration: operation.executionGeneration ?? ticket.executionGeneration, operationId: operation.operationId, kind: operation.kind === "initial" || operation.kind === "cleanup" ? "send_message" : operation.kind, state: operation.state, providerResult: (operation.result as { disposition?: "started" | "queued" | "handled" } | null)?.disposition ?? null, error: operation.error ? { code: "native_operation_error", message: operation.error } : null });
export const readControllerGrant = async (ticket: ControllerLaunchTicket): Promise<ControllerGrantResponse> => {
  const metadata = await lstat(ticket.credentialFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384 || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Controller credential must be a private regular file.");
  const grant = parseControllerGrantResponse(JSON.parse(await readFile(ticket.credentialFile, "utf8")) as unknown);
  if (grant.sessionId !== ticket.sessionId || grant.claimId !== ticket.claimId || grant.testExecutionId !== ticket.testExecutionId || grant.executionGeneration !== ticket.executionGeneration || grant.controllerId !== ticket.controllerId || grant.controllerInstanceId !== ticket.controllerInstanceId || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Controller credential is stale or belongs to another execution.");
  return grant;
};
export const createControllerRelay = (ticket: ControllerLaunchTicket, journal: ControllerLifecycleStore, callbacks: { onConnection(connected: boolean): void; onCommand(command: SessionCommand): Promise<void>; onError(error: unknown): void; readState?(): ControllerState; onAcknowledged?(): void; beforeImage?(): Promise<void>; acquireCaptureReadPolicy?: CaptureReadPolicy; onRetryCapture?(body: { captureId: string; attemptId: string }, signal: AbortSignal): Promise<ValidatedImage> }) => {
  let socket: WebSocket | null = null, fence: ControllerFence | null = null, stopped = false, synchronized = false;
  let reconciled = false, requiresLiveSync = false, syncPending = false, connectionFloor = "0";
  let historyEpoch = "";
  let supportsImageHistory = false;
  const contentRequests: { request: ContentRequest; response: ContentResponse | null }[] = [];
  let reconciliation: ControllerOperation[][] = [];
  const mediaRequests = new Map<string, { key: string; promise: Promise<void>; controller: AbortController }>();
  const captureRequests = new Map<string, { action: ImageCaptureAction; captureId: string; attemptId: string | null; resolve(receipt: ImageCaptureReceipt): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let mediaDecoders = 0;
  const decoderQueue: { start(): void }[] = [];
  const acquireDecoder = (controller: AbortController): Promise<void> | null => {
    if (mediaDecoders === 0) { mediaDecoders++; return Promise.resolve(); }
    if (decoderQueue.length >= 32) return null;
    return new Promise<void>((resolve, reject) => {
      const waiter = { start: () => { controller.signal.removeEventListener("abort", cancel); mediaDecoders++; resolve(); } };
      const cancel = () => { const index = decoderQueue.indexOf(waiter); if (index >= 0) decoderQueue.splice(index, 1); reject(controller.signal.reason); };
      controller.signal.addEventListener("abort", cancel, { once: true }); decoderQueue.push(waiter);
    });
  };
  const releaseDecoder = (): void => { mediaDecoders--; decoderQueue.shift()?.start(); };
  const mediaWork = new Set<Promise<void>>();
  const handleImage = (request: ImageRequest, ws: WebSocket): void => {
    const requestFence = { protocol: SESSION_PROTOCOL, sessionId: request.sessionId, ...sessionBinding(request), executionGeneration: request.executionGeneration, connectionEpoch: request.connectionEpoch };
    const respond = (result: ImageResponse["result"], error: ImageResponse["error"]) => {
      if (stopped || socket !== ws || ws.readyState !== WebSocket.OPEN || fence?.connectionEpoch !== request.connectionEpoch) return;
      send({ ...requestFence, type: "image_response", requestId: request.requestId, action: request.action, result, error });
    };
    const requestKey = `${request.connectionEpoch}:${request.requestId}`;
    const key = JSON.stringify({ action: request.action, body: request.body });
    const previous = mediaRequests.get(requestKey);
    if (previous) { if (previous.key !== key) throw new Error("Media request ID has different content."); return; }
    const decode = request.action === "complete" || request.action === "retry_capture";
    const controller = new AbortController();
    if (!synchronized) { respond(null, { code: "rate_limited", message: "Controller media capacity is unavailable." }); return; }
    let blockLease: ControllerMediaBlockLease | null = null;
    // Only complete/retry metadata can queue; chunk bodies remain bounded by
    // the two active block slots and are reoffered under their durable identity.
    const admission = decode ? acquireDecoder(controller) : Promise.resolve();
    if (admission === null) { respond(null, { code: "rate_limited", message: "Controller decoder queue is full." }); return; }
    let acquired = !decode;
    const work = (async () => {
      // Publish the bounded in-flight identity before any synchronous failure.
      await Promise.resolve();
      try {
        if (!decode) {
          blockLease = journal.media().tryAcquireMediaBlock();
          if (!blockLease) { respond(null, { code: "rate_limited", message: "Controller media capacity is unavailable." }); return; }
        }
        await admission; acquired = true; controller.signal.throwIfAborted();
        const media = journal.media(); let result: ImageResponse["result"];
        switch (request.action) {
          case "prepare": await callbacks.beforeImage?.(); result = await media.prepare(request.body); break;
          case "write": result = await media.write(request.body); break;
          case "complete": result = await media.complete(request.body); break;
          case "status": result = await media.status(request.body); break;
          case "release": result = await media.release(request.body); break;
          case "read_prepared": result = await media.readPrepared(request.body); break;
          case "read": result = await media.read(request.body); break;
          case "read_capture": await media.readCapture(request.body, callbacks.acquireCaptureReadPolicy, chunk => respond(chunk, null)); return;
          case "retry_capture":
            if (!callbacks.onRetryCapture) throw new Error("component_unsupported: Image source retry resolver is unavailable.");
            result = await callbacks.onRetryCapture(request.body, controller.signal); break;
        }
        respond(result, null);
      } catch (error) {
        if (request.action === "retry_capture" && error !== null && typeof error === "object" && "code" in error && error.code === "rate_limited") {
          respond(null, { code: "rate_limited", message: "Controller source capture capacity is unavailable." }); return;
        }
        const description = String(error);
        const code = request.action === "release" && (error instanceof ImageReleaseStorageError || isImageReleaseStorageFailure(error)) ? "release_storage_unavailable" : description.includes("component_unsupported") ? "component_unsupported" : description.includes("target_changed") ? "target_changed" : description.includes("budget") || description.includes("capacity") ? "budget_exceeded" : description.includes("conflict") ? "upload_conflict" : description.includes("in_use") ? "upload_in_use" : "image_unavailable";
        respond(null, { code, message: "The Controller could not complete this image request." });
      } finally { if (acquired && decode) releaseDecoder(); blockLease?.close(); mediaRequests.delete(requestKey); }
    })();
    mediaRequests.set(requestKey, { key, promise: work, controller }); mediaWork.add(work); void work.finally(() => mediaWork.delete(work)).catch(error => callbacks.onError(error));
  };
  let pendingBatch: { id: string; through: string } | null = null, currentToken = "", lastHeartbeat = 0, reconnectAt = 0, connecting = false;
  const authorization = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const settleDispatchRefusal = (operation: SessionOperation, required = false, currentConnection = false): void => {
    const local = journal.getOperation(operation.operationId);
    if (!required && local?.state !== "accepted") return;
    if (!local || local.state !== "accepted" || operation.kind !== local.kind || operation.sessionId !== ticket.sessionId || operation.claimId !== ticket.claimId || operation.testExecutionId !== ticket.testExecutionId || (local.executionGeneration ?? ticket.executionGeneration) !== operation.executionGeneration || currentConnection && operation.executionGeneration !== fence?.executionGeneration || (operation.state !== "rejected" && operation.state !== "expired")) throw new Error("Invalid dispatch refusal receipt.");
    journal.recordOperation(operation.operationId, operation.state, null, operation.error?.message ?? "Operation no longer has current permission or state.");
  };
  const clearConnection = () => { fence = null; synchronized = false; reconciled = false; syncPending = false; contentRequests.length = 0; for (const work of mediaRequests.values()) work.controller.abort(new Error("Image request connection changed.")); mediaRequests.clear();
    for (const request of captureRequests.values()) { clearTimeout(request.timer); request.reject(new Error("Image capture outcome is unknown after relay disconnect; query the original capture.")); } captureRequests.clear(); pendingBatch = null; callbacks.onConnection(false); for (const waiter of authorization.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Relay disconnected before native dispatch authorization.")); } authorization.clear(); };
  const send = (message: ControllerMessage) => { if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Session relay is offline."); const text = JSON.stringify(message); if (sessionWireBytes(message) > RELAY_LIMITS.maxFrameBytes) throw new Error("Controller frame exceeds relay limit."); socket.send(text); };
  const prefix = () => { if (!fence) throw new Error("Session relay is not synchronized."); return { protocol: SESSION_PROTOCOL, ...fence }; };
  const sendReconciliation = () => {
    const batch = reconciliation.shift() ?? [];
    send({ ...prefix(), type: "reconcile", final: reconciliation.length === 0, operations: batch.map(o => ({ operationId: o.operationId, state: o.state === "accepted" ? "not_submitted" : ["confirmed", "failed", "rejected", "expired", "provider_accepted"].includes(o.state) ? o.state as Reconciliation["state"] : "unknown", providerResult: publicOperation(ticket, o).providerResult, error: publicOperation(ticket, o).error })) });
  };
  const connect = async () => {
    if (stopped || connecting || socket) return; connecting = true;
    try {
      const grant = await readControllerGrant(ticket); if (stopped) return; currentToken = grant.token;
      const url = new URL("/api/v1/controller-channel", ticket.serverOrigin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${grant.token}`, [CONTENT_READ_VERSION_HEADER]: "1" }, handshakeTimeout: 10_000, maxPayload: RELAY_LIMITS.maxFrameBytes }); socket = ws;
      ws.on("error", error => callbacks.onError(error.message));
      ws.on("close", () => { if (socket !== ws) return; socket = null; clearConnection(); reconnectAt = Date.now() + 1000; });
      ws.on("open", () => { if (stopped || socket !== ws) return; send({ type: "hello", protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, contentRevision: 2, ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, provider: ticket.provider, sourceEpoch: ticket.executionId, lastAckedSourceSeq: journal.getLastAcknowledgedSequence(), ...(journal.getSourceFloor ? { sourceFloor: connectionFloor = journal.getSourceFloor() } : {}) }); });
      ws.on("message", data => {
        if (stopped || socket !== ws) return;
        try {
          const message = parseRelayMessage(JSON.parse(data.toString()));
          if (message.type === "welcome") {
            if (message.session.sessionId !== ticket.sessionId || message.session.claimId !== ticket.claimId || message.session.testExecutionId !== ticket.testExecutionId || message.session.executionGeneration !== ticket.executionGeneration || message.session.identity.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Relay identity mismatch.");
            fence = { ...sessionFence(ticket), connectionEpoch: message.connectionEpoch };
            requiresLiveSync = message.requiresLiveSync === true; supportsImageHistory = message.session.contentRevision === 2; historyEpoch = message.session.historyEpoch; journal.recordRelayHistory?.(historyEpoch);
            journal.acknowledgeEvents(message.lastAckedSourceSeq);
            const unacknowledged: ControllerOperation[] = [];
            let after: string | undefined;
            for (;;) { const page = journal.listUnacknowledgedOperations(100, after); unacknowledged.push(...page.filter(o => o.kind !== "initial" && o.kind !== "cleanup")); if (page.length < 100) break; after = page.at(-1)!.operationId; }
            reconciliation = [];
            for (let i = 0; i < unacknowledged.length; i += 100) reconciliation.push(unacknowledged.slice(i, i + 100));
            if (!reconciliation.length) reconciliation.push([]);
            sendReconciliation();
            return;
          }
          if (!fence || message.sessionId !== fence.sessionId || message.claimId !== fence.claimId || message.testExecutionId !== fence.testExecutionId || message.executionGeneration !== fence.executionGeneration || message.connectionEpoch !== fence.connectionEpoch) throw new Error("Stale relay frame.");
          if (message.type === "reconcile_result") {
            for (const operation of message.operations) if (["confirmed", "failed", "rejected", "expired"].includes(operation.state)) {
              if (operation.state === "rejected" || operation.state === "expired") settleDispatchRefusal(operation);
              journal.markOperationAcknowledged(operation.operationId);
            }
            if (reconciliation.length) sendReconciliation(); else { reconciled = true; if (!requiresLiveSync) { synchronized = true; callbacks.onConnection(true); } }
          } else if (message.type === "sync_ack") {
            if (!requiresLiveSync || !syncPending || !reconciled) throw new Error("Unexpected live synchronization acknowledgement.");
            syncPending = false; synchronized = true; callbacks.onConnection(true);
            callbacks.onAcknowledged?.();
          } else if (message.type === "image_capture_result") {
            const pending = captureRequests.get(message.requestId);
            if (!pending) return;
            if (pending.action !== message.action || message.result && (message.result.captureId !== pending.captureId || pending.attemptId !== null && message.result.attemptId !== pending.attemptId)) throw new Error("Image capture result identity mismatch.");
            captureRequests.delete(message.requestId); clearTimeout(pending.timer);
            if (message.error) pending.reject(new ImageCaptureRequestError(message.error));
            else pending.resolve(message.result!);
          } else if (message.type === "image_request") {
            handleImage(message, ws);
          } else if (message.type === "content_request") {
            if (!synchronized || !requiresLiveSync) throw new Error("Content requested before live synchronization.");
            if (contentRequests.length >= 4) {
              send({ ...prefix(), type: "content_response", requestId: message.requestId, sourceThrough: journal.getLastAcknowledgedSequence(), result: null, error: { code: "rate_limited", message: "Local content request capacity is unavailable." } });
            } else contentRequests.push({ request: message, response: null });
          } else if (message.type === "receipt_ack") {
            const operation = message.operation;
            const waiter = authorization.get(operation.operationId);
            if (waiter || operation.state === "rejected" || operation.state === "expired") settleDispatchRefusal(operation, waiter !== undefined, true);
            journal.markOperationAcknowledged(operation.operationId);
            if (waiter) {
              authorization.delete(operation.operationId); clearTimeout(waiter.timer);
              waiter.reject(new Error(operation.error?.message ?? "Operation no longer has current permission or state."));
            }
          }
          else if (message.type === "events_ack") { if (message.sourceEpoch !== ticket.executionId || !pendingBatch || message.batchId !== pendingBatch.id || BigInt(message.lastAckedSourceSeq) < BigInt(pendingBatch.through)) throw new Error("Invalid event ACK."); journal.acknowledgeEvents(message.lastAckedSourceSeq); pendingBatch = null; callbacks.onAcknowledged?.(); }
          else if (message.type === "operation_offer") { if (!synchronized) throw new Error("Operation offered before reconciliation."); void callbacks.onCommand(message.command).catch(error => callbacks.onError(error)); }
          else if (message.type === "operation_authorized") { const waiter = authorization.get(message.operationId); if (waiter) { authorization.delete(message.operationId); clearTimeout(waiter.timer); waiter.resolve(); } }
          else if (message.type === "error") { callbacks.onError(`${message.code}: ${message.message}`); ws.close(); }
        } catch (error) { callbacks.onError(error); ws.close(1008, "Invalid relay frame"); }
      });
    } catch (error) { callbacks.onError(error); reconnectAt = Date.now() + 1000; }
    finally { connecting = false; }
  };
  let polling = false;
  const tick = async () => {
    if (stopped || polling) return; polling = true;
    try {
      if (!socket) { if (Date.now() >= reconnectAt) await connect(); return; }
      if (!fence || !reconciled) return;
      if (journal.getSourceFloor && BigInt(journal.getSourceFloor()) > BigInt(connectionFloor)) { socket.close(1000, "Local history synchronization required"); return; }
      if (syncPending) return;
      if (Date.now() - lastHeartbeat > 10_000) { const grant = await readControllerGrant(ticket); if (stopped || !socket || !fence || !reconciled) return; if (grant.token !== currentToken) { socket.close(1000, "Credential renewed"); return; } send({ ...prefix(), type: "heartbeat" }); lastHeartbeat = Date.now(); }
      if (pendingBatch) return;
      if (requiresLiveSync && !synchronized && !journal.pendingEvents(1).length) {
        const snapshot = journal.getSnapshot();
        const state = callbacks.readState?.() ?? { nativeSessionId: snapshot.nativeSessionId, initialInputState: snapshot.initialInputState, synchronized: true, activity: snapshot.activity, currentTurnId: snapshot.currentTurnId, capabilities: snapshot.capabilities, ...(snapshot.controls ? { controls: snapshot.controls } : {}), ...(snapshot.turnStartedAt !== undefined ? { turnStartedAt: snapshot.turnStartedAt } : {}) };
        send({ ...prefix(), type: "sync_state", state: { ...state, synchronized: true }, pendingInteractions: journal.pendingInteractions() });
        syncPending = true; return;
      }
      const request = contentRequests[0];
      if (request && !request.response) {
        let result: ContentResponse["result"] = null, error: ContentResponse["error"] = null;
        try {
          const query = request.request;
          if (query.kind !== "resource" && query.historyEpoch !== historyEpoch) throw new SessionHistoryError("reset_required", "The history cursor belongs to another connection.");
          switch (query.kind) {
            case "timeline": result = journal.readTimeline(query); break;
            case "resource": result = journal.readResource(query.resourceId, query.offset, query.limit); break;
            case "inspect_page": result = journal.readInspection(query); break;
            case "entry_chunk": result = journal.readEntryChunk(query); break;
          }
        } catch (failure) { error = { code: failure instanceof SessionHistoryError ? failure.code : "content_unavailable", message: failure instanceof Error ? failure.message.slice(0, 4096) : "Local content is unavailable." }; }
        request.response = { requestId: request.request.requestId, sourceThrough: journal.getLastSourceSequence(), result, error };
      }
      const response = request?.response;
      if (response && BigInt(journal.getLastAcknowledgedSequence()) >= BigInt(response.sourceThrough)) {
        // The response and its source barrier share WS ordering. Newer events
        // remain queued until after the server has captured this page's cursor.
        send({ ...prefix(), type: "content_response", ...response }); contentRequests.shift(); return;
      }
      journal.drainProjectionGap();
      const events: SourceEvent[] = []; let bytes = 1024;
      for (const row of journal.pendingEvents(RELAY_LIMITS.maxBatchEvents)) {
        if (response && BigInt(row.sequence) > BigInt(response.sourceThrough)) break;
        const source = { ...(row.payload as object), sourceSeq: row.sequence } as SourceEvent;
        // Older journals may already contain a display event that could never
        // fit the relay. Preserve its source identity and project it as history does.
        const event = requiresLiveSync && source.kind === "timeline_upsert" ? { ...source, payload: sessionDisplayEntry(source.payload) } : source;
        const size = sessionWireBytes(event);
        if (size + 1024 > RELAY_LIMITS.maxFrameBytes) throw new Error("Durable controller event exceeds relay frame limit.");
        if (bytes + size > RELAY_LIMITS.maxFrameBytes) break;
        events.push(event); bytes += size;
      }
      if (events.length) { const id = randomUUID(); pendingBatch = { id, through: events.at(-1)!.sourceSeq }; send({ ...prefix(), type: "events", batchId: id, sourceEpoch: ticket.executionId, events }); }
    } catch (error) { callbacks.onError(error); socket?.close(); }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void tick(); }, 100);
  void tick();
  const stop = (): void => {
    if (stopped) return;
    stopped = true; clearInterval(timer); socket?.terminate(); socket = null; clearConnection();
  };
  return {
    stop,
    connected: () => synchronized && fence !== null,
    currentFence: (): ControllerFence | null => fence ? { ...fence } : null,
    imageHistorySupported: (): boolean => supportsImageHistory && fence !== null,
    capture: <K extends ImageCaptureAction>(action: K, body: ImageCaptureBody[K]): Promise<ImageCaptureReceipt> => new Promise((resolve, reject) => {
      if (!synchronized || !supportsImageHistory) { reject(new ImageCaptureNotDispatchedError("Image capture relay is unavailable.")); return; }
      if (captureRequests.size >= 2) { reject(new ImageCaptureNotDispatchedError("Controller image capture request capacity is unavailable.")); return; }
      const requestId = randomUUID();
      const timer = setTimeout(() => { captureRequests.delete(requestId); reject(new Error("Image capture outcome is unknown; query the original capture.")); }, 15_000);
      captureRequests.set(requestId, { action, captureId: body.captureId, attemptId: "attemptId" in body ? body.attemptId : null, resolve, reject, timer });
      try { send(parseImageCaptureMessage({ ...prefix(), type: "image_capture", requestId, action, body }) as ImageCaptureMessage); }
      catch (error) { clearTimeout(timer); captureRequests.delete(requestId); reject(error); }
    }),
    authorize: (operationId: string): Promise<void> => new Promise((resolve, reject) => {
      if (!synchronized) { reject(new Error("Session relay is offline.")); return; }
      const timeout = setTimeout(() => { authorization.delete(operationId); reject(new Error("Operation authorization is unknown; native was not called.")); }, 15_000);
      authorization.set(operationId, { resolve, reject, timer: timeout });
      try { send({ ...prefix(), type: "operation_begin", operationId }); } catch (error) { clearTimeout(timeout); authorization.delete(operationId); reject(error); }
    }),
    receipt: (operation: ControllerOperation) => { if (synchronized && (!operation.executionGeneration || operation.executionGeneration === ticket.executionGeneration)) send({ ...prefix(), type: "operation_receipt", operation: publicOperation(ticket, operation) }); },
    async flush(timeoutMs = 5000): Promise<void> { const end = Date.now() + timeoutMs; while (journal.pendingEvents(1).length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); if (journal.pendingEvents(1).length) throw new Error("Session events remain in the durable outbox."); },
    close: async (): Promise<void> => { stop(); await journal.stopMedia?.(); await Promise.allSettled([...mediaWork]); },
  };
};
