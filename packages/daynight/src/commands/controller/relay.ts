import { sessionFence } from "../../session/protocol.js";
import { readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { SESSION_PROTOCOL, type SessionCommand, type SessionOperation, type ControllerFence } from "../../session/protocol.js";
import { RELAY_LIMITS, parseControllerGrantResponse, parseRelayMessage, type ControllerMessage, type ControllerGrantResponse, type SourceEvent, type Reconciliation } from "../../session/controller-protocol.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerLifecycleStore, ControllerOperation } from "./lifecycle-store.js";

export const publicOperation = (ticket: ControllerLaunchTicket, operation: ControllerOperation): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...sessionFence(ticket), executionGeneration: operation.executionGeneration ?? ticket.executionGeneration, operationId: operation.operationId, kind: operation.kind === "initial" || operation.kind === "cleanup" ? "send_message" : operation.kind, state: operation.state, providerResult: (operation.result as { disposition?: "started" | "queued" | "handled" } | null)?.disposition ?? null, error: operation.error ? { code: "native_operation_error", message: operation.error } : null });
export const readControllerGrant = async (ticket: ControllerLaunchTicket): Promise<ControllerGrantResponse> => {
  const metadata = await lstat(ticket.credentialFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384 || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Controller credential must be a private regular file.");
  const grant = parseControllerGrantResponse(JSON.parse(await readFile(ticket.credentialFile, "utf8")) as unknown);
  if (grant.sessionId !== ticket.sessionId || grant.claimId !== ticket.claimId || grant.testExecutionId !== ticket.testExecutionId || grant.executionGeneration !== ticket.executionGeneration || grant.controllerId !== ticket.controllerId || grant.controllerInstanceId !== ticket.controllerInstanceId || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Controller credential is stale or belongs to another execution.");
  return grant;
};
export const createControllerRelay = (ticket: ControllerLaunchTicket, journal: ControllerLifecycleStore, callbacks: { onConnection(connected: boolean): void; onCommand(command: SessionCommand): Promise<void>; onError(message: string): void }) => {
  let socket: WebSocket | null = null, fence: ControllerFence | null = null, stopped = false, synchronized = false;
  let reconciliation: ControllerOperation[][] = [];
  let pendingBatch: { id: string; through: string } | null = null, currentToken = "", lastHeartbeat = 0, reconnectAt = 0, connecting = false;
  const authorization = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const settleDispatchRefusal = (operation: SessionOperation, required = false, currentConnection = false): void => {
    const local = journal.getOperation(operation.operationId);
    if (!required && local?.state !== "accepted") return;
    if (!local || local.state !== "accepted" || operation.kind !== local.kind || operation.sessionId !== ticket.sessionId || operation.claimId !== ticket.claimId || operation.testExecutionId !== ticket.testExecutionId || (local.executionGeneration ?? ticket.executionGeneration) !== operation.executionGeneration || currentConnection && operation.executionGeneration !== fence?.executionGeneration || (operation.state !== "rejected" && operation.state !== "expired")) throw new Error("Invalid dispatch refusal receipt.");
    journal.recordOperation(operation.operationId, operation.state, null, operation.error?.message ?? "Operation no longer has current permission or state.");
  };
  const clearConnection = () => { fence = null; synchronized = false; pendingBatch = null; callbacks.onConnection(false); for (const waiter of authorization.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Relay disconnected before native dispatch authorization.")); } authorization.clear(); };
  const send = (message: ControllerMessage) => { if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Session relay is offline."); const text = JSON.stringify(message); if (Buffer.byteLength(text) > RELAY_LIMITS.maxFrameBytes) throw new Error("Controller frame exceeds relay limit."); socket.send(text); };
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
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${grant.token}` }, handshakeTimeout: 10_000, maxPayload: RELAY_LIMITS.maxFrameBytes }); socket = ws;
      ws.on("error", error => callbacks.onError(error.message));
      ws.on("close", () => { if (socket !== ws) return; socket = null; clearConnection(); reconnectAt = Date.now() + 1000; });
      ws.on("open", () => { if (stopped || socket !== ws) return; send({ type: "hello", protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, provider: ticket.provider, sourceEpoch: ticket.executionId, lastAckedSourceSeq: journal.getLastAcknowledgedSequence() }); });
      ws.on("message", data => {
        if (stopped || socket !== ws) return;
        try {
          const message = parseRelayMessage(JSON.parse(data.toString()));
          if (message.type === "welcome") {
            if (message.session.sessionId !== ticket.sessionId || message.session.claimId !== ticket.claimId || message.session.testExecutionId !== ticket.testExecutionId || message.session.executionGeneration !== ticket.executionGeneration || message.session.identity.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Relay identity mismatch.");
            fence = { ...sessionFence(ticket), connectionEpoch: message.connectionEpoch };
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
            if (reconciliation.length) sendReconciliation(); else { synchronized = true; callbacks.onConnection(true); }
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
          else if (message.type === "events_ack") { if (message.sourceEpoch !== ticket.executionId || !pendingBatch || message.batchId !== pendingBatch.id || BigInt(message.lastAckedSourceSeq) < BigInt(pendingBatch.through)) throw new Error("Invalid event ACK."); journal.acknowledgeEvents(message.lastAckedSourceSeq); pendingBatch = null; }
          else if (message.type === "operation_offer") { if (!synchronized) throw new Error("Operation offered before reconciliation."); void callbacks.onCommand(message.command).catch(error => callbacks.onError(String(error))); }
          else if (message.type === "operation_authorized") { const waiter = authorization.get(message.operationId); if (waiter) { authorization.delete(message.operationId); clearTimeout(waiter.timer); waiter.resolve(); } }
          else if (message.type === "error") { callbacks.onError(`${message.code}: ${message.message}`); ws.close(); }
        } catch (error) { callbacks.onError(String(error)); ws.close(1008, "Invalid relay frame"); }
      });
    } catch (error) { callbacks.onError(String(error)); reconnectAt = Date.now() + 1000; }
    finally { connecting = false; }
  };
  let polling = false;
  const tick = async () => {
    if (stopped || polling) return; polling = true;
    try {
      if (!socket) { if (Date.now() >= reconnectAt) await connect(); return; }
      if (!fence || !synchronized) return;
      if (Date.now() - lastHeartbeat > 10_000) { const grant = await readControllerGrant(ticket); if (stopped || !socket || !fence || !synchronized) return; if (grant.token !== currentToken) { socket.close(1000, "Credential renewed"); return; } send({ ...prefix(), type: "heartbeat" }); lastHeartbeat = Date.now(); }
      if (pendingBatch) return;
      journal.drainProjectionGap();
      const events: SourceEvent[] = []; let bytes = 1024;
      for (const row of journal.pendingEvents(RELAY_LIMITS.maxBatchEvents)) { const event = { ...(row.payload as object), sourceSeq: row.sequence } as SourceEvent; const size = Buffer.byteLength(JSON.stringify(event)); if (size + 1024 > RELAY_LIMITS.maxFrameBytes) throw new Error("Durable controller event exceeds relay frame limit."); if (bytes + size > RELAY_LIMITS.maxFrameBytes) break; events.push(event); bytes += size; }
      if (events.length) { const id = randomUUID(); pendingBatch = { id, through: events.at(-1)!.sourceSeq }; send({ ...prefix(), type: "events", batchId: id, sourceEpoch: ticket.executionId, events }); }
    } catch (error) { callbacks.onError(String(error)); socket?.close(); }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void tick(); }, 100);
  void tick();
  return {
    connected: () => synchronized && fence !== null,
    authorize: (operationId: string): Promise<void> => new Promise((resolve, reject) => {
      if (!synchronized) { reject(new Error("Session relay is offline.")); return; }
      const timeout = setTimeout(() => { authorization.delete(operationId); reject(new Error("Operation authorization is unknown; native was not called.")); }, 15_000);
      authorization.set(operationId, { resolve, reject, timer: timeout });
      try { send({ ...prefix(), type: "operation_begin", operationId }); } catch (error) { clearTimeout(timeout); authorization.delete(operationId); reject(error); }
    }),
    receipt: (operation: ControllerOperation) => { if (synchronized && (!operation.executionGeneration || operation.executionGeneration === ticket.executionGeneration)) send({ ...prefix(), type: "operation_receipt", operation: publicOperation(ticket, operation) }); },
    async flush(timeoutMs = 5000): Promise<void> { const end = Date.now() + timeoutMs; while (journal.pendingEvents(1).length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); if (journal.pendingEvents(1).length) throw new Error("Session events remain in the durable outbox."); },
    close: () => { stopped = true; clearInterval(timer); socket?.terminate(); socket = null; clearConnection(); },
  };
};
