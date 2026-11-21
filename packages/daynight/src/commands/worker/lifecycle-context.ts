import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { assistantTaskClaimFingerprint } from "../../api/assistant-task-parse.js";
import type { AssistantTaskClaimInput, AssistantTaskClaimKind } from "../../api/assistant-task-types.js";
import { ApiError } from "../../api/client.js";
import type { ExecutionOwnerKind } from "./execution-scope.js";
import type { LifecycleBinding, LifecycleJson, openLifecycleStore } from "./lifecycle-store.js";

export type LifecycleContext = {
  store: ReturnType<typeof openLifecycleStore>;
  binding: LifecycleBinding;
  failed(error: unknown): void;
};
const context = new AsyncLocalStorage<LifecycleContext>();

export const currentLifecycleBinding = (): LifecycleBinding | undefined => context.getStore()?.binding;
export const withWorkerLifecycle = <T>(value: LifecycleContext, action: () => T): T => context.run(value, action);
export const assertWorkerLifecycleAdmission = (): void => {
  const current = context.getStore();
  if (current !== undefined) current.store.assertAdmission(current.binding);
};

export type LifecycleReservationSettlement = { stage: "confirmed" | "not_dispatched" | "unknown"; receipt?: LifecycleJson };

/** The persisted reservation precedes the side effect; unknown outcomes retain it. */
export const withLifecycleReservation = async <T>(ownerKind: ExecutionOwnerKind, identity: unknown, action: () => Promise<T>, operationId: string = randomUUID(), classify?: (result: T) => LifecycleReservationSettlement): Promise<T> => {
  const current = context.getStore();
  // Standalone commands and test Controllers have no Worker execution authority.
  if (current === undefined) return action();
  const resourceId = randomUUID();
  const savedIdentity = JSON.parse(JSON.stringify(identity, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)) as { [key: string]: LifecycleJson };
  current.store.reserveExecution({ binding: current.binding, resourceId, ownerKind, identity: savedIdentity, operationId });
  let result: T;
  try { result = await action(); } catch (error) {
    try {
      const refused = error instanceof ApiError && error.confirmedRefusal || error instanceof Error && "outcomeUnconfirmed" in error && error.outcomeUnconfirmed === false;
      current.store.recordResource({ resourceId, stage: refused ? "not_dispatched" : "unknown", saveState: "durable", error: error instanceof Error ? error.message : String(error) });
    } catch (saveError) { current.failed(saveError); throw new AggregateError([error, saveError], "Worker operation and responsibility persistence failed."); }
    throw error;
  }
  try {
    const settlement = classify?.(result) ?? { stage: "confirmed" as const };
    current.store.recordResource({ resourceId, stage: settlement.stage, saveState: "durable", ...(settlement.receipt === undefined ? {} : { stopProof: { kind: "external_result", operationId, receipt: settlement.receipt } }) });
  }
  catch (error) { current.failed(error); throw error; }
  return result;
};

/** A joined local producer leaves its independently reserved children responsible for their effects. */
export const withLifecycleProducer = async <T>(ownerKind: ExecutionOwnerKind, identity: unknown, action: () => Promise<T>): Promise<T> => {
  const current = context.getStore();
  if (current === undefined) return action();
  const resourceId = randomUUID(), operationId = randomUUID();
  const savedIdentity = JSON.parse(JSON.stringify(identity, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)) as { [key: string]: LifecycleJson };
  current.store.reserveExecution({ binding: current.binding, resourceId, ownerKind, identity: savedIdentity, operationId });
  const close = (outcome: "returned" | "failed", error?: unknown): void => {
    try { current.store.recordResource({ resourceId, stage: "stopped", saveState: "durable", stopProof: { kind: "producer_joined", outcome }, ...(outcome === "failed" ? { error: error instanceof Error ? error.message : String(error) } : {}) }); }
    catch (failure) { current.failed(failure); throw failure; }
  };
  let result: T;
  try { result = await action(); }
  catch (error) {
    try { close("failed", error); } catch (failure) { throw new AggregateError([error, failure], "Local producer failed and its join evidence could not be saved."); }
    throw error;
  }
  close("returned"); return result;
};

/** Preserve read-only management while fencing every application mutation. */
export const lifecycleAssistantApi = <T extends object>(api: T, botId?: string): T => new Proxy(api, {
  get(target, property, receiver): unknown {
    const method: unknown = Reflect.get(target, property, receiver);
    if (typeof property !== "string" || typeof method !== "function" || /^(get|list|related)/.test(property)) return method;
    return (...args: unknown[]) => {
      const current = context.getStore();
      if (current === undefined) return Reflect.apply(method, target, args);
      const assistantTaskId = typeof args[0] === "string" ? args[0] : null;
      const input = args.find(value => value !== null && typeof value === "object" && "operationId" in value) as (AssistantTaskClaimInput & { mode?: string; state?: string }) | undefined;
      const identity: { [key: string]: LifecycleJson } = { kind: "assistant_api", method: property, botId: botId ?? null, assistantTaskId };
      if (property === "claim" && input !== undefined && assistantTaskId !== null) {
        const claimKind = args[1] as AssistantTaskClaimKind;
        identity.claimKind = claimKind;
        identity.requestFingerprint = assistantTaskClaimFingerprint({ ...input, kind: claimKind, ownerUserId: current.binding.userId, taskId: assistantTaskId, actorBotId: botId ?? null });
      } else if (property === "ackEvent") {
        identity.eventId = typeof args[1] === "string" ? args[1] : null;
        identity.eventState = input?.state ?? "delivered";
      } else if (["enableInbox", "disableInbox", "rotateInbox"].includes(property) && input !== undefined && assistantTaskId !== null) {
        const kind = property === "enableInbox" ? "inbox_enable" : property === "disableInbox" ? "inbox_disable" : input.mode === "overlap" ? "inbox_rotate_overlap" : "inbox_rotate_immediate";
        identity.inboxKind = kind;
        identity.requestFingerprint = createHash("sha256").update(JSON.stringify(["daynight-assistant-inbox/1", kind, current.binding.userId, assistantTaskId, input.operationId, input.ifVersion])).digest("hex");
      }
      return withLifecycleReservation("assistant", identity, () => Reflect.apply(method, target, args) as Promise<unknown>, input?.operationId);
    };
  },
});
