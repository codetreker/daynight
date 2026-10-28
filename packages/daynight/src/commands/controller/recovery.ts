import type { ControllerLifecycleStore, ControllerOperation } from "./lifecycle-store.js";

export const isCleaningGeneration = (operations: readonly ControllerOperation[], generation: string): boolean =>
  operations.some(operation => operation.kind === "cleanup" && operation.executionGeneration === generation);

/** A native user-message identity proves receipt, not successful turn completion. */
export const observeNativeInput = (journal: ControllerLifecycleStore, operationId: string): boolean => {
  const operation = journal.getOperation(operationId);
  if (!operation || !["initial", "send_message", "execute_command"].includes(operation.kind) || !["dispatching", "unknown"].includes(operation.state)) return false;
  journal.recordOperation(operationId, "provider_accepted", operation.result);
  return true;
};

/** A late native resolution can settle a timed-out response without resubmitting it. */
export const observeNativeInteraction = (journal: ControllerLifecycleStore, interactionId: string, generation: string): ControllerOperation[] => {
  const receipts: ControllerOperation[] = [];
  for (const operation of journal.listOperations()) {
    if (operation.executionGeneration !== generation || operation.kind !== "interaction_response" || !["dispatching", "provider_accepted", "unknown"].includes(operation.state)) continue;
    if (!operation.payload || typeof operation.payload !== "object" || !("interactionId" in operation.payload) || operation.payload.interactionId !== interactionId) continue;
    receipts.push(journal.recordOperation(operation.operationId, "confirmed", { disposition: "handled" }));
  }
  return receipts;
};
