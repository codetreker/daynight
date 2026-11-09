import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseSessionV2Message } from "../../../session/v2/protocol.js";
import { canonicalSessionJson, SESSION_V2_LIMITS, SessionV2Error, text, uuid, type SessionV2ErrorCode } from "../../../session/v2/values.js";
import type { SessionV2Message, SessionV2Payloads } from "../../../session/v2/types.js";
import { herdrInputEnvelope } from "./input-store.js";
import type { HerdrInputStore } from "./input-store.js";
import type { HerdrInputBatch, HerdrInputOperation, HerdrInputRecord, HerdrInputTarget, HerdrInputWriteContext } from "./input-types.js";
import { HerdrAgentActionError, HerdrInputWaitingError } from "./agents.js";

type Result = SessionV2Payloads["operation_result"];
type ControlAck = SessionV2Payloads["control_ack"];
type Purpose = "automatic" | "manual" | "resume" | "cleanup";
const same = (a: unknown, b: unknown) => canonicalSessionJson(a) === canonicalSessionJson(b);
const digest = (value: unknown) => createHash("sha256").update(canonicalSessionJson(value)).digest("hex");
const result = (operationId: string, state: Result["state"], errorCode: SessionV2ErrorCode | null = null): Result => ({ operationId, state, errorCode });
class AdmissionError extends Error { constructor(readonly code: SessionV2ErrorCode) { super(`Herdr input admission rejected: ${code}.`); } }
const deny = (code: SessionV2ErrorCode): never => { throw new AdmissionError(code); };
/** One owner coordinates all input sources; native write attempts must explicitly mark their uncertainty boundary. */
export const createHerdrInputArbiter = (options: {
  store: HerdrInputStore; sessionId: string;
  verify: (target: HerdrInputTarget, purpose: Purpose, signal?: AbortSignal) => Promise<void>;
  execute: (batch: HerdrInputBatch, context: HerdrInputWriteContext) => Promise<void>;
  propagateAutomaticFailures?: boolean;
  now?: () => number; monotonic?: () => number;
}) => {
  const { store, sessionId } = options, now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  let leaseDeadline: { id: string; deadline: number } | null = null;
  let journalFault = false;
  const active = new Map<string, { controller: AbortController; written: boolean }>();
  const requireJournal = () => { if (journalFault) throw new Error("The input journal could not persist revocation; this arbiter cannot admit further input."); };
  const revoke = <T>(reason: SessionV2ErrorCode, persist: () => T): T => {
    try { return persist(); }
    catch (error) { journalFault = true; throw error; }
    finally {
      // Local cancellation must not depend on storage availability or a later retry.
      leaseDeadline = null;
      for (const running of active.values()) running.controller.abort(new AdmissionError(reason));
    }
  };
  const record = () => { const value = store.get(sessionId); if (!value) throw new Error("The original input journal is missing."); return value; };
  const update = (change: (draft: HerdrInputRecord) => void) => store.update(record(), change);
  const operation = (id: string) => record().operations.find(op => op.operationId === id);
  const busy = (except?: string) => record().operations.some(op => op.operationId !== except && ["queued", "dispatching"].includes(op.result.state));
  const suspend = (reason: SessionV2ErrorCode = "automation_suspended") => revoke(reason, () => {
    const old = record(); if (["closing", "closed"].includes(old.state)) return old;
    const next = update(draft => {
      draft.state = "suspended"; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.lease = null; draft.leaseSeq = "0"; draft.cleanupEligible = false;
      for (const op of draft.operations) if (op.result.state === "dispatching") {
        const written = active.get(op.operationId)?.written ?? true;
        op.result = result(op.operationId, written ? "unknown" : "rejected", written ? "input_unknown" : reason);
        if (op.source !== "control" && written) draft.unknownInput = true;
        if (op.source === "initial") draft.initialOutcome = written ? "unknown" : "pending";
      }
    });
    return next;
  });
  const expire = () => {
    const value = record();
    if (value.lease !== null && (leaseDeadline?.id !== value.lease.leaseId || monotonic() >= leaseDeadline.deadline)) suspend("lease_expired");
  };
  const project = (value: HerdrInputRecord): SessionV2Payloads["control_state"] => {
    const unavailable = ["closing", "closed"].includes(value.state);
    const initialAssignment = value.initialDisposition === null ? value.initialOutcome : "transport_completed";
    const unresolvedInitial = ["unknown", "unconfirmed"].includes(value.initialOutcome) && value.initialDisposition === null;
    const availableActions: SessionV2Payloads["control_state"]["availableActions"] = unavailable ? [] : value.state === "manual" ? ["renew_control", "release_control", "paste", "keys"] : ["acquire_control", ...(value.state === "suspended" ? [unresolvedInitial ? "resolve_initial_assignment" as const : "resume_automation" as const] : [])];
    return { connectionEpoch: value.target.connectionEpoch, controlEpoch: value.controlEpoch, state: value.state, lease: value.lease, initialAssignment, availableActions, unavailableReason: value.unknownInput && value.initialDisposition === null ? "input_unknown" : value.state === "suspended" ? "automation_suspended" : null };
  };
  const state = (): SessionV2Payloads["control_state"] => { requireJournal(); expire(); return project(record()); };
  const existing = (id: string, hash: string) => {
    const previous = operation(id); if (previous && previous.digest !== hash) throw new Error("The operation ID was already used with a different payload digest."); return previous;
  };
  const storeOperation = (op: HerdrInputOperation, change?: (draft: HerdrInputRecord) => void) => update(draft => { draft.operations.push(op); change?.(draft); });
  const refusal = (id: string, source: HerdrInputOperation["source"], hash: string, target: HerdrInputTarget, code: SessionV2ErrorCode, web?: SessionV2Payloads["operation"]) => {
    const value = result(id, "rejected", code); storeOperation({ operationId: id, source, digest: hash, target, controlEpoch: web?.controlEpoch ?? record().controlEpoch, leaseId: web?.leaseId ?? null, leaseSeq: web?.leaseSeq ?? null, result: value, controlAck: null }); return value;
  };
  const sameTarget = (expected: HerdrInputTarget) => {
    const current = record().target;
    // Native session discovery may enrich a null identity without changing the terminal target.
    return same({ ...expected, binding: { ...expected.binding, nativeSessionId: current.binding.nativeSessionId } }, current) && (expected.binding.nativeSessionId === null || expected.binding.nativeSessionId === current.binding.nativeSessionId);
  };
  const admission = (batch: HerdrInputBatch, epoch: string, web?: SessionV2Payloads["operation"]) => {
    requireJournal();
    expire(); const value = record(), op = operation(batch.operationId);
    if (!sameTarget(batch.target) || value.controlEpoch !== epoch) deny("stale_fence");
    if (op?.result.state !== "dispatching") deny("stale_fence");
    if (batch.source === "web") {
      if (value.state !== "manual" || value.lease === null || !web || web.leaseId !== value.lease.leaseId || web.controlEpoch !== value.controlEpoch) deny("lease_expired");
    } else if (batch.source === "cleanup") {
      if (value.state !== "closing" || !value.cleanupEligible) deny("automation_suspended");
    } else if (value.state !== "automation" || value.unknownInput || batch.source === "initial" && value.initialOutcome !== "dispatching") deny("automation_suspended");
  };
  const dispatch = async (batch: HerdrInputBatch, hash: string, signal?: AbortSignal, web?: SessionV2Payloads["operation"]): Promise<Result> => {
    requireJournal();
    const previous = existing(batch.operationId, hash); if (previous) return previous.result;
    expire(); const before = record(), epoch = before.controlEpoch;
    let rejection: SessionV2ErrorCode | undefined;
    if (!sameTarget(batch.target)) rejection = "stale_fence";
    else if (busy()) rejection = "input_busy";
    else if (batch.source === "web") {
      if (!web || before.state !== "manual" || before.lease === null || web.leaseId !== before.lease.leaseId || web.controlEpoch !== epoch || BigInt(web.leaseSeq) <= BigInt(before.leaseSeq)) rejection = "lease_expired";
    } else if (batch.source === "cleanup") {
      if (batch.operationId !== before.cleanupOperationId || before.state !== "closing" || !before.cleanupEligible) rejection = "automation_suspended";
    } else if (before.state !== "automation" || before.unknownInput || batch.source === "initial" && (batch.operationId !== before.initialAttemptOperationId || before.initialOutcome !== "pending") || batch.source === "continuation" && !["transport_completed", "unknown", "unconfirmed"].includes(before.initialOutcome)) rejection = "automation_suspended";
    if (rejection) return refusal(batch.operationId, batch.source, hash, batch.target, rejection, web);
    const running = { controller: new AbortController(), written: false }; active.set(batch.operationId, running);
    try { storeOperation({ operationId: batch.operationId, source: batch.source, digest: hash, target: batch.target, controlEpoch: epoch, leaseId: web?.leaseId ?? null, leaseSeq: web?.leaseSeq ?? null, result: result(batch.operationId, "dispatching"), controlAck: null }, draft => { if (batch.source === "initial") draft.initialOutcome = "dispatching"; if (web) { draft.leaseSeq = web.leaseSeq; draft.draftRisk = true; } }); }
    catch (error) { active.delete(batch.operationId); throw error; }
    const abort = () => running.controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => running.controller.abort(new Error("The native input batch deadline elapsed.")), SESSION_V2_LIMITS.inputTimeoutMs);
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(running.controller.signal.reason); if (running.controller.signal.aborted) onAbort(); else running.controller.signal.addEventListener("abort", onAbort, { once: true }); });
    const purpose: Purpose = batch.source === "web" ? "manual" : batch.source === "cleanup" ? "cleanup" : "automatic";
    try {
      await Promise.race([interrupted, (async () => {
        await options.verify(batch.target, purpose, running.controller.signal); admission(batch, epoch, web); running.controller.signal.throwIfAborted();
        await options.execute(batch, { signal: running.controller.signal, beforeWrite: async () => { running.controller.signal.throwIfAborted(); admission(batch, epoch, web); await options.verify(batch.target, purpose, running.controller.signal); admission(batch, epoch, web); running.controller.signal.throwIfAborted(); }, markWritten: () => { running.controller.signal.throwIfAborted(); admission(batch, epoch, web); running.written = true; } });
        running.controller.signal.throwIfAborted();
        if (!running.written) throw new Error("The native adapter returned without attempting an input write.");
      })()]);
      update(draft => { const op = draft.operations.find(value => value.operationId === batch.operationId)!; if (op.result.state !== "dispatching") return; op.result = result(batch.operationId, "transport_completed"); if (batch.source === "initial") draft.initialOutcome = "transport_completed"; });
    } catch (error) {
      let blockedBeforeWrite = false;
      update(draft => {
        const op = draft.operations.find(value => value.operationId === batch.operationId)!; if (op.result.state !== "dispatching") return;
        blockedBeforeWrite = !running.written && batch.source !== "web" && error instanceof HerdrInputWaitingError;
        op.result = result(batch.operationId, running.written ? "unknown" : "rejected", running.written ? "input_unknown" : blockedBeforeWrite ? "automation_suspended" : (error instanceof AdmissionError || error instanceof SessionV2Error) ? error.code : "invalid_payload");
        if (batch.source === "initial") draft.initialOutcome = running.written ? "unknown" : "pending";
        if (running.written) { draft.unknownInput = true; draft.lease = null; draft.leaseSeq = "0"; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); if (!["closing", "closed"].includes(draft.state)) draft.state = "suspended"; }
      });
      if (blockedBeforeWrite) throw error;
      if (!running.written && batch.source !== "web" && batch.source !== "cleanup" && error instanceof AdmissionError && error.code === "automation_suspended" && operation(batch.operationId)?.result.state === "rejected" && ["manual", "suspended"].includes(record().state)) {
        throw new HerdrInputWaitingError("control_suspended", "Automatic input is waiting for explicit control handoff.", { cause: error });
      }
      if (options.propagateAutomaticFailures && !running.written && batch.source !== "web" && batch.source !== "cleanup" && !(error instanceof AdmissionError) && !(error instanceof SessionV2Error) && operation(batch.operationId)?.result.state === "rejected") {
        throw new HerdrAgentActionError("The original input admission failed before a write.", "agent.prompt", "not-submitted", { cause: error, promptSubmission: "not-submitted" });
      }
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (onAbort) running.controller.signal.removeEventListener("abort", onAbort); running.controller.abort(new Error("The native input batch ended.")); active.delete(batch.operationId); }
    return operation(batch.operationId)!.result;
  };
  const control = async (raw: Extract<SessionV2Message, { type: "control_dispatch" }>, signal?: AbortSignal): Promise<ControlAck> => {
    requireJournal();
    const message = parseSessionV2Message(raw); if (message.type !== "control_dispatch") throw new Error("Expected an authorized control dispatch.");
    const { request, actorUserId, requestDigest } = message.payload;
    if (requestDigest !== digest({ actorUserId, request })) throw new Error("The authorized control request digest differs from its body.");
    const hash = digest(message), previous = existing(request.operationId, hash);
    if (previous?.controlAck) return previous.controlAck;
    if (previous) {
      if (["queued", "dispatching"].includes(previous.result.state)) throw new Error("The original control result is pending; observe it before another decision.");
      const ack: ControlAck = { requestDigest, durable: true, controlState: state(), result: previous.result };
      update(draft => { draft.operations.find(op => op.operationId === request.operationId)!.controlAck = ack; }); return ack;
    }
    expire(); const before = record();
    const matches = same(herdrInputEnvelope(before.target), { protocol: message.protocol, schemaVersion: message.schemaVersion, projectionVersion: message.projectionVersion, agentControlMode: message.agentControlMode, contentKind: message.contentKind, sessionId: message.sessionId, claimId: message.claimId, executionGeneration: message.executionGeneration }) && request.connectionEpoch === before.target.connectionEpoch && request.controlEpoch === before.controlEpoch;
    let code: SessionV2ErrorCode | undefined;
    if (!matches) code = "stale_fence";
    else if (["closing", "closed"].includes(before.state)) code = "automation_suspended";
    else if (busy()) code = "input_busy";
    else if (request.action === "acquire_control" && before.lease !== null) code = "input_busy";
    else if (["renew_control", "release_control"].includes(request.action) && (before.lease === null || before.lease.leaseId !== request.leaseId || before.lease.holderUserId !== actorUserId || before.lease.browserClientId !== request.browserClientId)) code = "lease_expired";
    else if (request.action === "resolve_initial_assignment" && (before.state !== "suspended" || before.lease !== null || !["unknown", "unconfirmed"].includes(before.initialOutcome) || before.initialDisposition !== null)) code = "automation_suspended";
    else if (request.action === "resume_automation" && (before.state !== "suspended" || !request.draftHandled || ["unknown", "unconfirmed"].includes(before.initialOutcome) && before.initialDisposition === null)) code = "automation_suspended";
    if (code) {
      const ack: ControlAck = { requestDigest, durable: true, controlState: state(), result: result(request.operationId, "rejected", code) };
      storeOperation({ operationId: request.operationId, source: "control", target: before.target, digest: hash, controlEpoch: request.controlEpoch, leaseId: request.leaseId, leaseSeq: null, result: ack.result, controlAck: ack }); return ack;
    }
    storeOperation({ operationId: request.operationId, source: "control", target: before.target, digest: hash, controlEpoch: request.controlEpoch, leaseId: request.leaseId, leaseSeq: null, result: result(request.operationId, "dispatching"), controlAck: null });
    const running = { controller: new AbortController(), written: false }; active.set(request.operationId, running);
    const abort = () => running.controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => running.controller.abort(new AdmissionError("input_busy")), SESSION_V2_LIMITS.inputTimeoutMs);
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(running.controller.signal.reason); if (running.controller.signal.aborted) onAbort(); else running.controller.signal.addEventListener("abort", onAbort, { once: true }); });
    try {
      await Promise.race([interrupted, options.verify(before.target, request.action === "resume_automation" ? "resume" : "manual", running.controller.signal)]); running.controller.signal.throwIfAborted(); expire();
      const fresh = record();
      if (!sameTarget(before.target) || fresh.controlEpoch !== before.controlEpoch || operation(request.operationId)?.result.state !== "dispatching") deny("stale_fence");
      const granted = update(draft => {
        if (request.action === "acquire_control") {
          draft.state = "manual"; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.leaseSeq = "0"; draft.draftRisk = true;
          draft.lease = { leaseId: randomUUID(), holderUserId: actorUserId, browserClientId: request.browserClientId, controlEpoch: draft.controlEpoch, expiresAt: new Date(now() + SESSION_V2_LIMITS.leaseTtlMs).toISOString() };
        } else if (request.action === "renew_control") draft.lease!.expiresAt = new Date(now() + SESSION_V2_LIMITS.leaseTtlMs).toISOString();
        else {
          draft.state = request.action === "resume_automation" ? "automation" : "suspended"; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.lease = null; draft.leaseSeq = "0";
          if (request.action === "resolve_initial_assignment") {
            draft.initialDisposition = { actorUserId, operationId: request.operationId, decidedAt: new Date(now()).toISOString(), disposition: "delivered_continue" };
          }
          if (request.action === "resume_automation") {
            draft.draftRisk = false; draft.unknownInput = false;
          }
        }
        const ack: ControlAck = { requestDigest, durable: true, controlState: project(draft), result: result(request.operationId, "transport_completed") };
        const op = draft.operations.find(value => value.operationId === request.operationId)!; op.result = ack.result; op.controlAck = ack;
      });
      leaseDeadline = granted.lease === null ? null : { id: granted.lease.leaseId, deadline: monotonic() + SESSION_V2_LIMITS.leaseTtlMs };
      return granted.operations.find(op => op.operationId === request.operationId)!.controlAck!;
    } catch (error) {
      const op = operation(request.operationId)!;
      if (op.controlAck !== null) return op.controlAck;
      const ack: ControlAck = { requestDigest, durable: true, controlState: state(), result: op.result.state === "dispatching" ? result(request.operationId, "rejected", (error instanceof AdmissionError || error instanceof SessionV2Error) ? error.code : "invalid_payload") : op.result };
      update(draft => { const original = draft.operations.find(value => value.operationId === request.operationId)!; original.result = ack.result; original.controlAck = ack; }); return ack;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (onAbort) running.controller.signal.removeEventListener("abort", onAbort); running.controller.abort(new Error("The control decision ended.")); active.delete(request.operationId); }
  };
  const beginClosing = () => revoke("stale_fence", () => {
    requireJournal();
    const before = record(); if (before.state === "closed" || before.state === "closing") return { canNotify: before.cleanupEligible && !operation(before.cleanupOperationId) };
    const canNotify = before.state === "automation" && !before.draftRisk && !before.unknownInput && !busy() && (before.initialOutcome === "transport_completed" || before.initialDisposition !== null);
    update(draft => {
      draft.state = "closing"; draft.lease = null; draft.leaseSeq = "0"; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.cleanupEligible = canNotify; draft.automationBeforeClosing = canNotify;
      for (const op of draft.operations) if (op.result.state === "dispatching") { const written = active.get(op.operationId)?.written ?? true; op.result = result(op.operationId, written ? "unknown" : "rejected", written ? "input_unknown" : "stale_fence"); if (op.source === "initial") draft.initialOutcome = written ? "unknown" : "pending"; if (op.source !== "control" && written) draft.unknownInput = true; }
    });
    return { canNotify };
  });
  return {
    record, state, control, suspend, beginClosing,
    submit: (request: { operationId: string; source: "initial" | "continuation" | "cleanup"; text: string }, signal?: AbortSignal) => {
      requireJournal();
      uuid(request.operationId); text(request.text, 1024 * 1024);
      const hash = digest({ operationId: request.operationId, source: request.source, text: request.text });
      let id = request.operationId;
      if (request.source === "initial") {
        const current = record();
        if (request.operationId !== current.initialOperationId) throw new Error("The initial assignment identity cannot change.");
        if (current.initialDigest !== null && current.initialDigest !== hash) throw new Error("The original assignment payload digest differs.");
        if (current.initialDigest === null) update(draft => { draft.initialDigest = hash; });
        const prior = operation(current.initialAttemptOperationId);
        // The assignment is stable; a definitely unsent rejection permits a new attempt, never rewriting the old operation receipt.
        if (prior?.result.state === "rejected" && current.initialOutcome === "pending" && current.state === "automation") update(draft => { draft.initialAttemptOperationId = randomUUID(); });
        id = record().initialAttemptOperationId;
      }
      const batch: HerdrInputBatch = { operationId: id, source: request.source, target: record().target, payload: { kind: "prompt", text: request.text } };
      return dispatch(batch, hash, signal);
    },
    input: (raw: Extract<SessionV2Message, { type: "operation" }>, signal?: AbortSignal) => {
      const message = parseSessionV2Message(raw); if (message.type !== "operation") throw new Error("Expected a terminal input operation.");
      const p = message.payload, target = { sessionId: message.sessionId, claimId: message.claimId, executionGeneration: message.executionGeneration, connectionEpoch: p.connectionEpoch, segmentId: p.segmentId, binding: p.binding };
      const batch: HerdrInputBatch = { operationId: p.operationId, source: "web", target, payload: p.kind === "paste" ? { kind: "paste", text: p.payload.text } : { kind: "keys", key: p.payload.key } };
      return dispatch(batch, digest(message), signal, p);
    },
    bind: (target: HerdrInputTarget, options: { allowRecovery?: boolean } = {}) => { const old = record(); const next = store.bind(target, old.initialOutcome, old.controlEpoch, options); if (old.controlEpoch !== next.controlEpoch) { leaseDeadline = null; for (const pending of active.values()) pending.controller.abort(new AdmissionError("stale_fence")); } return next; },
    recover: () => { leaseDeadline = null; for (const pending of active.values()) pending.controller.abort(new AdmissionError("stale_fence")); return store.recover(sessionId); },
    close: () => { beginClosing(); return update(draft => { draft.state = "closed"; draft.cleanupEligible = false; draft.automationBeforeClosing = false; }); },
  };
};
export type HerdrInputArbiter = ReturnType<typeof createHerdrInputArbiter>;
