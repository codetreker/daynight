import { randomBytes, randomUUID } from "node:crypto";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { SESSION_PROTOCOL } from "../../../session/protocol.js";
import type { ControllerGrantResponse } from "../../../session/controller-protocol.js";
import { BotRecoveryRejectedError, type BotRecoveryApi } from "./recovery-api.js";
import type { BotRecoveryBinding, BotRecoveryGrant, BotRecoveryIdentity, BotRecoveryReport, BotRecoveryResult } from "./recovery-protocol.js";
import type { BotRecoveryOperation, BotRecoveryState, openBotRecoveryStore } from "./recovery-store.js";
import type { BotRecoveryProof } from "./session-api.js";
import type { BotOwner, BotRecord } from "./types.js";

/** Hosting changes retain the original execution, operation identities and native input. */
export const createBotReconciliation = (options: {
  owner: BotOwner; store: ReturnType<typeof openBotRecoveryStore>; api: BotRecoveryApi; now?: () => number; applicable?(record: BotRecord): boolean;
  canSubmit(): boolean;
}) => {
  const now = options.now ?? Date.now;
  const verified = new Map<string, string>();
  const identity = (state: BotRecoveryState): BotRecoveryIdentity => ({ botRecoveryVersion: 1,
    serviceOrigin: options.owner.serverOrigin, recoveryIdentity: state.recoveryIdentity });
  const settle = async (record: BotRecord, state: BotRecoveryState, signal: AbortSignal): Promise<BotRecoveryState> => {
    const pending = state.pending;
    if (pending === null) return state;
    // Even a prepared request may have reached the service before a crash.
    const result = await options.api.operation(record, pending.workerId, pending.body.operationId, identity(state), signal);
    options.store.recordResult(record, pending.body.operationId, result);
    return options.store.finishOperation(record, pending.body.operationId);
  };
  const submit = async (record: BotRecord, operation: Omit<BotRecoveryOperation, "result">, signal: AbortSignal): Promise<BotRecoveryState> => {
    if (!options.canSubmit()) throw new Error("Bot recovery requires a confirmed Worker machine identity report before preparing an operation.");
    const observed = await options.api.observation(record, signal), intent = record.intent!;
    const grant = operation.kind === "register" ? null : (operation.body as BotRecoveryGrant).grant;
    if (observed.sessionId !== operation.body.sessionId || observed.testExecutionId !== operation.body.testExecutionId
      || observed.executionGeneration !== intent.executionGeneration && observed.executionGeneration !== grant?.previousGeneration
      || observed.nativeSessionId !== null && observed.nativeSessionId !== operation.body.nativeSessionId) {
      throw new Error("Bot recovery requires matching current service and authenticated local execution evidence before preparing an operation.");
    }
    if (grant?.previousGeneration != null && observed.nativeSessionId === null) throw new Error("Bot generation recovery requires the service to retain its original native Session binding.");
    const state = options.store.read(record)!;
    const hosting = state.current?.receipt ?? state.registration?.receipt;
    if (operation.kind === "register" ? observed.hostingGeneration !== null || observed.workerId !== record.owner.workerId
      : observed.hostingGeneration !== (operation.body as BotRecoveryGrant).expectedHostingGeneration || observed.workerId !== hosting?.workerId) {
      throw new Error("Bot recovery hosting changed before preparing an operation.");
    }
    // A live Controller may know its native ID before the relay can publish it.
    // Use the service's committed expectation without changing the local identity;
    // the renewed grant lets that same Controller finish synchronization.
    const prepared = { ...operation, body: { ...operation.body, nativeSessionId: observed.nativeSessionId,
      ...(operation.kind === "register" ? { botVersion: observed.botVersion } : {}) } };
    signal.throwIfAborted();
    if (!options.canSubmit()) throw new Error("Bot recovery requires a confirmed Worker machine identity report before preparing an operation.");
    options.store.prepare(record, prepared);
    signal.throwIfAborted();
    let result: BotRecoveryResult;
    try {
      if (prepared.kind === "register") result = await options.api.register(record, prepared.body as import("./recovery-protocol.js").BotRecoveryRegistration, signal);
      else result = await options.api[prepared.kind](record, prepared.body as BotRecoveryGrant, signal);
    } catch (cause) {
      // Only the original submission's complete, validated rejection proves that
      // this attempt did not commit. Queries and unknown responses never do.
      if (cause instanceof BotRecoveryRejectedError) options.store.rejectOperation(record, prepared.body.operationId,
        { status: 409, code: "resource_conflict", requestId: cause.requestId! });
      throw cause;
    }
    options.store.recordResult(record, prepared.body.operationId, result);
    return options.store.finishOperation(record, prepared.body.operationId);
  };
  const register = async (record: BotRecord, binding: BotRecoveryBinding, signal: AbortSignal): Promise<BotRecoveryState> => {
    let state = await settle(record, options.store.ensureIdentity(record), signal);
    if (state.registration !== null) return state;
    state = await submit(record, { kind: "register", workerId: record.owner.workerId, body: {
      ...identity(state), operationId: randomUUID(), botVersion: record.observed.version,
      ...binding,
    } }, signal);
    return state;
  };
  const grant = async (record: BotRecord, binding: BotRecoveryBinding, signal: AbortSignal, previous?: BotRecoveryProof): Promise<ControllerGrantResponse> => {
    verified.delete(record.botId);
    let state = await register(record, binding, signal);
    const intent = record.intent!;
    let original = state.currentOperation;
    if (original !== null && original.kind !== "register") {
      const result = await options.api.operation(record, original.workerId, original.body.operationId, identity(state), signal);
      if (original.result === null || controllerPayloadHash(result.receipt) !== controllerPayloadHash(original.result.receipt)) throw new Error("Bot recovery query differs from the retained original receipt.");
      // Query observations do not replace the durable original grant receipt.
      const receipt = result.receipt;
      if (result.current && receipt.workerId === options.owner.workerId && receipt.executionGeneration === intent.executionGeneration
        && receipt.controllerInstanceId === intent.controllerInstanceId && Date.parse(receipt.grantExpiresAt!) > now() + 30_000) {
        const body = original.body as BotRecoveryGrant;
        verified.set(record.botId, receipt.operationId);
        return { token: body.controllerToken, expiresAt: receipt.grantExpiresAt!, sessionId: receipt.sessionId,
          testExecutionId: receipt.testExecutionId, executionGeneration: receipt.executionGeneration,
          controllerId: receipt.controllerId, controllerInstanceId: receipt.controllerInstanceId };
      }
    }
    const receipt = state.current?.receipt ?? state.registration!.receipt;
    const kind = receipt.workerId === options.owner.workerId ? "grant" : "takeover";
    // The service accepts only the exact predecessor proof, including when a
    // queried operation already advanced to this Controller generation.
    const recovering = previous !== undefined;
    state = await submit(record, { kind, workerId: options.owner.workerId, body: {
      ...identity(state), operationId: randomUUID(), expectedHostingGeneration: receipt.hostingGeneration,
      ...binding,
      controllerToken: `dncontroller_${randomBytes(32).toString("base64url")}`,
      grant: { protocol: SESSION_PROTOCOL, testExecutionId: intent.executionId, controllerId: intent.registration.controllerId,
        controllerInstanceId: intent.controllerInstanceId, executionGeneration: intent.executionGeneration, kind: "reconnect",
        previousGeneration: recovering ? previous.generation : null,
        stopProof: recovering ? { recordId: previous.recordId, previousControllerInstanceId: previous.instanceId, stoppedAt: previous.stoppedAt } : null },
    } }, signal);
    const confirmed = state.current;
    original = state.currentOperation;
    if (confirmed === null || !confirmed.current || original === null || original.kind === "register"
      || confirmed.receipt.workerId !== options.owner.workerId || Date.parse(confirmed.receipt.grantExpiresAt!) <= now()) {
      throw new Error("Bot recovery authorization is no longer current; original receipt is retained.");
    }
    verified.set(record.botId, confirmed.receipt.operationId);
    return { token: (original.body as BotRecoveryGrant).controllerToken, expiresAt: confirmed.receipt.grantExpiresAt!,
      sessionId: confirmed.receipt.sessionId, testExecutionId: confirmed.receipt.testExecutionId,
      executionGeneration: confirmed.receipt.executionGeneration, controllerId: confirmed.receipt.controllerId,
      controllerInstanceId: confirmed.receipt.controllerInstanceId };
  };
  return {
    applicable: (record: BotRecord): boolean => options.applicable?.(record) ?? true,
    ownsHosting: (record: BotRecord): boolean => {
      if (record.owner.workerId === options.owner.workerId) return true;
      const state = options.store.read(record);
      return state?.current?.receipt.workerId === options.owner.workerId && state.current.receipt.kind !== "register";
    },
    register, grant,
    ready: (record: BotRecord): boolean => {
      if (options.applicable?.(record) === false) return true;
      const state = options.store.read(record);
      return state !== null && state.pending === null && state.current !== null
        && verified.get(record.botId) === state.current.receipt.operationId
        && state.current.receipt.workerId === options.owner.workerId && state.current.receipt.kind !== "register"
        && state.current.receipt.executionGeneration === record.intent?.executionGeneration
        && state.current.receipt.controllerInstanceId === record.intent?.controllerInstanceId
        && Date.parse(state.current.receipt.grantExpiresAt!) > now();
    },
    report: async (record: BotRecord, report: BotRecoveryReport["report"], signal: AbortSignal) => {
      const state = options.store.read(record);
      if (state === null || state.pending !== null || state.current === null || state.current.receipt.kind === "register"
        || verified.get(record.botId) !== state.current.receipt.operationId
        || state.current.receipt.workerId !== options.owner.workerId || Date.parse(state.current.receipt.grantExpiresAt!) <= now()) throw new Error("Bot recovery report requires confirmed current hosting.");
      return options.api.report(record, { ...identity(state), hostingGeneration: state.current.receipt.hostingGeneration, report }, signal);
    },
  };
};
export type BotReconciliation = ReturnType<typeof createBotReconciliation>;
