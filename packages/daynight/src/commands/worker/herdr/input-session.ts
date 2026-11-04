import { assertTerminalBinding, parseSessionV2Message } from "../../../session/v2/protocol.js";
import { canonicalSessionJson } from "../../../session/v2/values.js";
import type { SessionV2Message, SessionV2Payloads } from "../../../session/v2/types.js";
import type { HerdrExecutionOwner } from "./agents.js";
import type { HerdrLifecycleRecord } from "./lifecycle-types.js";
import type { HerdrSessionApi } from "./session-api.js";
import { createHerdrInputBridge, type HerdrInputBridge } from "./input-bridge.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
type Entry = {
  registration: Message<"registration">; owner: HerdrExecutionOwner; epoch: string;
  bridge: HerdrInputBridge; active: boolean; closed: boolean; polling: boolean;
  activation: Promise<void>; activate(): void; rejectActivation(error: Error): void;
  activationTimer: NodeJS.Timeout; controls: Map<string, { timer: NodeJS.Timeout; result: SessionV2Payloads["operation_result"] | null }>;
};
export type HerdrInputSessionOptions = {
  serverToken: string;
  getRecord(owner: HerdrExecutionOwner): HerdrLifecycleRecord;
  control(owner: HerdrExecutionOwner, message: Message<"control_dispatch">, signal: AbortSignal): Promise<SessionV2Payloads["control_ack"]>;
  input(owner: HerdrExecutionOwner, message: Message<"operation">, signal: AbortSignal): Promise<SessionV2Payloads["operation_result"]>;
  state(owner: HerdrExecutionOwner): SessionV2Payloads["control_state"];
  suspend(owner: HerdrExecutionOwner): void;
  /** Latches a failed durable suspension in the owner before future input. */
  onError(owner: HerdrExecutionOwner, error: Error): void;
  api(owner: HerdrExecutionOwner): Pick<HerdrSessionApi, "state">;
};
const same = (a: unknown, b: unknown): boolean => canonicalSessionJson(a) === canonicalSessionJson(b);
const envelope = (message: Message<"registration">) => ({ protocol: message.protocol, schemaVersion: message.schemaVersion, projectionVersion: message.projectionVersion, sessionId: message.sessionId, claimId: message.claimId, executionGeneration: message.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const });
const hasActiveSegment = (record: HerdrLifecycleRecord): boolean => {
  const run = record.runs.at(-1), segment = record.segments.at(-1);
  return run?.phase === "active" && segment !== undefined && segment.endedAt === null && segment.executionGeneration === run.run.executionGeneration && run.run.segmentIds.includes(segment.segmentId);
};

/**
 * Owns input-channel lifetime without claiming registration ownership. The
 * lifecycle journal commits register()'s ACK before calling activate(). No
 * failed registration, offered input, or control acknowledgement is replayed.
 */
export const createHerdrInputSession = (options: HerdrInputSessionOptions) => {
  const entries = new Map<string, Entry>();
  let stopped = false;
  const stop = (entry: Entry, error: Error): void => {
    if (entry.closed) return;
    entry.closed = true; entry.active = false;
    clearTimeout(entry.activationTimer); entry.rejectActivation(error);
    for (const pending of entry.controls.values()) clearTimeout(pending.timer);
    entry.controls.clear();
    // The caller preserves suspension even when registration precedes creation
    // of the first segment and therefore no input arbiter exists yet.
    try { options.suspend(entry.owner); }
    catch (cause) {
      // Socket/timer callbacks must still finish closing when the journal is
      // unavailable. Report the failure rather than claiming durable suspension.
      options.onError(entry.owner, cause instanceof Error ? cause : new Error("The input suspension journal failed."));
    }
    finally { entry.bridge.close(); }
  };
  const requireRecord = (entry: Entry): HerdrLifecycleRecord => {
    const record = options.getRecord(entry.owner), current = record.runs.at(-1);
    if (record.sessionId !== entry.registration.sessionId || record.claimId !== entry.registration.claimId || !same(record.owner, entry.registration.payload.owner) || current?.run.executionGeneration !== entry.registration.executionGeneration) throw new Error("The input channel no longer belongs to the original runtime.");
    assertTerminalBinding(entry.registration.payload.binding, current.run.binding);
    return record;
  };
  const pollEntry = async (entry: Entry): Promise<void> => {
    if (entry.closed || !entry.active || entry.polling) return;
    entry.polling = true;
    try {
      const before = requireRecord(entry);
      if (!hasActiveSegment(before)) return;
      if (before.connectionEpoch !== entry.epoch || before.registrationRequest !== null) throw new Error("The input channel registration is no longer current.");
      const stateAtRead = options.state(entry.owner), controlsAtRead = entry.controls.size;
      const remote = await options.api(entry.owner).state({ owner: before.owner, sessionId: before.sessionId, claimId: before.claimId }, AbortSignal.timeout(10_000));
      if (entry.closed) return;
      const current = requireRecord(entry);
      if (remote.sessionId !== current.sessionId || remote.claimId !== current.claimId || !same(remote.owner, current.owner) || remote.executionGeneration !== entry.registration.executionGeneration || remote.connectionEpoch !== entry.epoch || !remote.connected) throw new Error("The service revoked or replaced the original input channel.");
      assertTerminalBinding(remote.binding, current.runs.at(-1)!.run.binding);
      let local = options.state(entry.owner);
      // A lease grant exists locally before its correlated durable ACK reaches
      // the service. Neither a stale read nor a heartbeat can replace that ACK.
      if (controlsAtRead > 0 || entry.controls.size > 0 || !same(stateAtRead, local)) return;
      if (remote.control !== null && ["closing", "closed"].includes(remote.control.state)) throw new Error("The service closed terminal control.");
      const revoked = remote.control !== null && BigInt(remote.control.controlEpoch) > BigInt(local.controlEpoch)
        || local.state === "manual" && (remote.control?.state !== "manual" || !same(local.lease, remote.control.lease) || remote.control.controlEpoch !== local.controlEpoch)
        || local.state === "automation" && remote.control !== null && remote.control.state !== "automation";
      if (revoked) {
        options.suspend(entry.owner); local = options.state(entry.owner);
        if (local.state !== "suspended" || remote.control !== null && BigInt(local.controlEpoch) < BigInt(remote.control.controlEpoch)) throw new Error("The local input journal cannot reconcile the revoked control epoch.");
      }
      await entry.bridge.send({ ...envelope(entry.registration), type: "control_state", payload: local });
    } catch (error) { stop(entry, error instanceof Error ? error : new Error("The input control state could not be reconciled.")); }
    finally { entry.polling = false; }
  };
  const poll = async (sessionId?: string): Promise<void> => {
    if (sessionId !== undefined) { const entry = entries.get(sessionId); if (entry !== undefined) await pollEntry(entry); return; }
    await Promise.all([...entries.values()].map(pollEntry));
  };
  const heartbeat = setInterval(() => { void poll(); }, 10_000); heartbeat.unref();
  return {
    register: async (raw: Message<"registration">, signal?: AbortSignal): Promise<Message<"registration_ack">> => {
      if (stopped) throw new Error("The Herdr input session owner is closed.");
      signal?.throwIfAborted();
      const registration = parseSessionV2Message(raw);
      if (registration.type !== "registration" || Object.values(registration.payload.capabilities).some(Boolean)) throw new Error("Input-session registration must preserve the combined capability gate.");
      const owner = { ...registration.payload.owner, claimId: registration.claimId };
      const record = options.getRecord(owner);
      if (!same(record.registrationRequest, registration) || record.connectionEpoch !== registration.payload.connectionEpoch) throw new Error("The input registration intent must be durably recorded first.");
      const previous = entries.get(registration.sessionId);
      if (previous !== undefined && (!previous.closed || same(previous.registration, registration))) throw new Error("The input registration already has a channel or an unconfirmed attempt; it cannot be replayed.");
      let resolveActivation!: () => void, rejectActivation!: (error: Error) => void;
      const activation = new Promise<void>((resolve, reject) => { resolveActivation = resolve; rejectActivation = reject; });
      void activation.catch(() => {});
      let entry!: Entry;
      const bridge = createHerdrInputBridge({ registration, serverToken: options.serverToken,
        onDisconnect: error => { if (entry !== undefined) stop(entry, error); },
        onMessage: async (message, dispatchSignal) => {
          await activation; dispatchSignal.throwIfAborted();
          if (entry.closed) throw new Error("The original input channel is closed.");
          const fresh = requireRecord(entry);
          if (!hasActiveSegment(fresh) || fresh.connectionEpoch !== entry.epoch || fresh.registrationRequest !== null) throw new Error("The original input run is not ready.");
          if (message.type === "control_dispatch") {
            const id = message.payload.request.operationId;
            if (entry.controls.has(id)) throw new Error("The service repeated an outstanding control dispatch.");
            const timeout = setTimeout(() => stop(entry, new Error("The control acknowledgement remains unconfirmed.")), 10_000); timeout.unref(); const pending = { timer: timeout, result: null as SessionV2Payloads["operation_result"] | null }; entry.controls.set(id, pending);
            const payload = await options.control(owner, message, dispatchSignal);
            pending.result = payload.result;
            await bridge.send({ ...envelope(registration), type: "control_ack", payload });
          } else {
            const payload = await options.input(owner, message, dispatchSignal);
            await bridge.send({ ...envelope(registration), type: "operation_result", payload });
          }
        },
        onReceipt: message => {
          if (message.type !== "operation_result") return;
          const pending = entry.controls.get(message.payload.operationId);
          if (pending !== undefined) { clearTimeout(pending.timer); entry.controls.delete(message.payload.operationId); }
          if (message.payload.state === "unknown" || pending?.result?.state === "transport_completed" && message.payload.state !== "transport_completed") stop(entry, new Error("The service did not confirm the original terminal operation."));
        },
      });
      const activationTimer = setTimeout(() => stop(entry, new Error("The input registration ACK was not committed by its owner.")), 10_000); activationTimer.unref();
      entry = { registration, owner, epoch: String(BigInt(registration.payload.connectionEpoch ?? "0") + 1n), bridge, activation, activationTimer, activate: resolveActivation, rejectActivation, active: false, closed: false, polling: false, controls: new Map() };
      entries.set(registration.sessionId, entry);
      const abort = () => stop(entry, new Error("The input registration was cancelled; its result requires reconciliation."));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try { return await bridge.ready; }
      finally { signal?.removeEventListener("abort", abort); }
    },
    activate: (sessionId: string): void => {
      const entry = entries.get(sessionId);
      if (!entry || entry.closed || !entry.bridge.connected()) throw new Error("The input channel has no acknowledged registration.");
      const record = requireRecord(entry);
      if (record.registrationRequest !== null || record.connectionEpoch !== entry.epoch) throw new Error("The lifecycle owner has not committed the input registration ACK.");
      entry.active = true; clearTimeout(entry.activationTimer); entry.activate();
    },
    connected: (sessionId: string): boolean => { const entry = entries.get(sessionId); return entry !== undefined && entry.active && !entry.closed && entry.bridge.connected(); },
    poll,
    close: (sessionId?: string): void => {
      if (sessionId !== undefined) { const entry = entries.get(sessionId); if (entry !== undefined) stop(entry, new Error("The original input session was closed.")); return; }
      stopped = true; clearInterval(heartbeat);
      for (const entry of entries.values()) stop(entry, new Error("The Herdr input session owner was closed."));
    },
  };
};
export type HerdrInputSession = ReturnType<typeof createHerdrInputSession>;
