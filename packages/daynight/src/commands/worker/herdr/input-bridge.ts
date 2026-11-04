import WebSocket from "ws";
import { decodeSessionV2Message, parseSessionV2Message } from "../../../session/v2/protocol.js";
import type { SessionV2Message } from "../../../session/v2/types.js";
import { canonicalSessionJson, SESSION_V2_PROTOCOL } from "../../../session/v2/values.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
export type HerdrInputOffer = Message<"control_dispatch" | "operation">;
export type HerdrInputPublication = Message<"control_ack" | "control_state" | "operation_result" | "snapshot">;
export type HerdrInputReceipt = Message<"control_state" | "operation_result" | "snapshot">;
export type HerdrInputBridgeOptions = {
  /** The owner persists this exact registration intent before opening the channel. */
  registration: Message<"registration">;
  serverToken: string;
  onRegistered?: (ack: Message<"registration_ack">) => Promise<void>;
  onMessage: (message: HerdrInputOffer, signal: AbortSignal) => Promise<void>;
  onReceipt?: (message: HerdrInputReceipt) => void;
  onDisconnect: (error: Error) => void;
  signal?: AbortSignal;
};
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 32;
const DEADLINE_MS = 10_000;
const failure = (value: unknown): Error => value instanceof Error ? value : new Error("The Herdr input bridge failed.");

/**
 * One registered connection, with no automatic reconnect or replay. The lifecycle
 * owner reconciles an unknown registration before creating another bridge. Input
 * offers are passed to the durable arbiter; transport completion is not its ACK.
 */
export const createHerdrInputBridge = (options: HerdrInputBridgeOptions) => {
  const registration = parseSessionV2Message(options.registration);
  if (registration.type !== "registration") throw new Error("The Herdr input bridge requires an original registration intent.");
  if (!options.serverToken || /[\r\n]/.test(options.serverToken)) throw new Error("The Herdr input bridge requires a valid Worker credential.");
  const owner = registration.payload.owner;
  const url = new URL(`/api/v1/projects/${owner.projectId}/tasks/${owner.taskId}/sessions/${registration.sessionId}/worker-channel`, owner.serverOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const expectedEpoch = String(BigInt(registration.payload.connectionEpoch ?? "0") + 1n);
  const controller = new AbortController();
  let stopped = false, registered = false, acknowledgementSeen = false;
  let pendingFrames = 0, pendingBytes = 0, handlers = 0;
  let lastPong = performance.now();
  let incoming = Promise.resolve();
  let resolveReady!: (message: Message<"registration_ack">) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<Message<"registration_ack">>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A caller may first await another lifecycle operation. Retain the rejection
  // for ready without making the event emitter produce an unhandled rejection.
  void ready.catch(() => {});
  const waitingWrites = new Set<(error: Error) => void>();
  const socket = new WebSocket(url, SESSION_V2_PROTOCOL, {
    headers: { Authorization: `Bearer ${options.serverToken}` },
    handshakeTimeout: DEADLINE_MS,
    maxPayload: MAX_BYTES,
    followRedirects: false,
  });
  const deadline = setTimeout(() => stop(new Error("Herdr input registration was not durably acknowledged before its deadline.")), DEADLINE_MS);
  const heartbeat = setInterval(() => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    if (performance.now() - lastPong > 30_000) { stop(new Error("The Herdr input bridge stopped answering heartbeats.")); return; }
    socket.ping(undefined, undefined, error => { if (error) stop(error); });
  }, 10_000);
  deadline.unref(); heartbeat.unref();
  const aborted = (): void => { stop(failure(options.signal?.reason)); };
  function stop(error: Error): void {
    if (stopped) return;
    stopped = true; registered = false;
    clearTimeout(deadline); clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", aborted);
    controller.abort(error);
    rejectReady(error);
    for (const reject of waitingWrites) reject(error);
    waitingWrites.clear();
    socket.terminate();
    options.onDisconnect(error);
  }
  const assertFence = (message: SessionV2Message): void => {
    if (message.agentControlMode !== "herdr" || message.sessionId !== registration.sessionId || message.claimId !== registration.claimId || message.executionGeneration !== registration.executionGeneration) throw new Error("The Herdr input bridge received a different execution fence.");
  };
  const receive = async (bytes: Buffer): Promise<void> => {
    if (stopped) return;
    const message = await decodeSessionV2Message(bytes);
    if (stopped) return;
    assertFence(message);
    if (!acknowledgementSeen) {
      if (message.type !== "registration_ack" || message.payload.registrationId !== registration.payload.registrationId || message.payload.connectionEpoch !== expectedEpoch) throw new Error("The Herdr input registration acknowledgement does not match its original intent.");
      acknowledgementSeen = true;
      await options.onRegistered?.(message);
      if (stopped) return;
      clearTimeout(deadline); registered = true; resolveReady(message);
      return;
    }
    if (!registered) throw new Error("The Herdr input registration is not durable.");
    if (message.type === "control_dispatch" || message.type === "operation") {
      const epoch = message.type === "control_dispatch" ? message.payload.request.connectionEpoch : message.payload.connectionEpoch;
      if (epoch !== expectedEpoch) throw new Error("The Herdr input offer has a stale connection epoch.");
      if (++handlers > MAX_PENDING) throw new Error("The Herdr input bridge exceeded its pending dispatch limit.");
      // Do not serialize native batches here. The arbiter must observe a lease
      // request while an initial input is busy and revoke input during cleanup.
      void Promise.resolve().then(() => {
        if (!stopped) return options.onMessage(message, controller.signal);
      }).catch(error => stop(failure(error))).finally(() => { handlers--; });
      return;
    }
    if (message.type === "control_state" || message.type === "operation_result" || message.type === "snapshot") {
      if ((message.type === "control_state" || message.type === "snapshot") && message.payload.connectionEpoch !== expectedEpoch) throw new Error("The Herdr control receipt has a stale connection epoch.");
      options.onReceipt?.(message);
      return;
    }
    throw new Error("The Herdr input bridge received an unsupported message.");
  };
  const write = (message: SessionV2Message): Promise<void> => new Promise((resolve, reject) => {
    if (stopped || socket.readyState !== WebSocket.OPEN) { reject(new Error("The Herdr input bridge is disconnected.")); return; }
    const body = canonicalSessionJson(message);
    if (Buffer.byteLength(body) > MAX_BYTES || socket.bufferedAmount + Buffer.byteLength(body) > MAX_BYTES) { reject(new Error("The Herdr input bridge exceeded its output limit.")); return; }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return; settled = true; clearTimeout(timer); waitingWrites.delete(refuse);
      if (error) reject(error); else resolve();
    };
    const refuse = (error: Error): void => finish(error);
    const timer = setTimeout(() => { const error = new Error("The Herdr input publication result is unknown after its deadline."); finish(error); stop(error); }, DEADLINE_MS);
    timer.unref(); waitingWrites.add(refuse);
    socket.send(body, error => { finish(error); if (error) stop(error); });
  });
  socket.on("open", () => {
    if (stopped) return;
    if (socket.protocol !== SESSION_V2_PROTOCOL) { stop(new Error("The server did not select the required Herdr Session protocol.")); return; }
    void write(registration).catch(error => stop(failure(error)));
  });
  socket.on("message", (raw, binary) => {
    if (stopped) return;
    if (binary) { stop(new Error("The Herdr input bridge requires text messages.")); return; }
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (++pendingFrames > MAX_PENDING || (pendingBytes += bytes.length) > MAX_BYTES) { stop(new Error("The Herdr input bridge exceeded its incoming limit.")); return; }
    incoming = incoming.then(() => receive(bytes)).catch(error => stop(failure(error))).finally(() => { pendingFrames--; pendingBytes -= bytes.length; });
  });
  socket.on("pong", () => { lastPong = performance.now(); });
  socket.on("error", error => stop(error));
  socket.on("close", () => stop(new Error("The Herdr input bridge disconnected; outstanding input results remain unknown.")));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  return {
    ready,
    connected: (): boolean => registered && !stopped,
    /** Resolves only the socket write; onReceipt reports the server's response. */
    send: async (input: HerdrInputPublication): Promise<void> => {
      if (!registered || stopped) throw new Error("The Herdr input bridge is disconnected or not registered.");
      const message = parseSessionV2Message(input); assertFence(message);
      if (message.type !== "control_ack" && message.type !== "control_state" && message.type !== "operation_result" && message.type !== "snapshot") throw new Error("Unsupported Herdr input publication.");
      if ((message.type === "control_state" || message.type === "snapshot") && message.payload.connectionEpoch !== expectedEpoch || message.type === "control_ack" && message.payload.controlState.connectionEpoch !== expectedEpoch) throw new Error("The Herdr input publication has a stale connection epoch.");
      await write(message);
    },
    close: (): void => stop(new Error("The Herdr input bridge was closed by its owner.")),
  };
};
export type HerdrInputBridge = ReturnType<typeof createHerdrInputBridge>;
