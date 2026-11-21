import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { openLifecycleStore, type LifecycleJson } from "../worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../worker/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerOperation } from "./lifecycle-store.js";
import { freezeNativeLifecycleFence } from "./native-lifecycle.js";
import type { ProcessProof } from "./process-proof.js";

/** A stopped Worker still permits interruption and storage of original results. */
const management = new AsyncLocalStorage<boolean>();
export const controllerManagementActive = (): boolean => management.getStore() === true;
export const withinControllerManagement = <T>(action: () => T): T => management.run(true, action);

export const openControllerWorkerLifecycle = (homeDirectory: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string) => {
  parseLaunchTicket(ticket);
  const file = path.join(resolveWorkerPaths(homeDirectory).workerDirectory, "lifecycle.sqlite");
  const binding = ticket.lifecycleBinding;
  if (binding === undefined) {
    if (ticket.usageScope !== "standalone_test" && existsSync(file)) throw new Error("Legacy Controller has no persistent Worker lifecycle binding; its original boundary must stop before migration.");
    return null;
  }
  const store = openLifecycleStore({ file, identity: { serverOrigin: binding.serverOrigin, userId: binding.userId, workerId: binding.workerId }, allowCreate: false });
  const identity: { [key: string]: LifecycleJson } = { executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
    controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
    journalFile: path.join(controllerExecutionDirectory(homeDirectory, ticket.executionId, storageStateDirectory), "journal.sqlite") };
  if (ticket.claimId === undefined) identity.testExecutionId = ticket.testExecutionId!;
  else Object.assign(identity, { projectId: ticket.projectId, taskId: ticket.taskId, claimId: ticket.claimId, worktreeId: ticket.worktreeId });
  const reservations = new Set<string>();
  const assertAdmission = (): void => store.assertAdmission(binding);
  return {
    nativeFence: freezeNativeLifecycleFence({ file, binding }),
    close: (): void => store.close(),
    assertAdmission,
    reserveLaunch: (): void => {
      store.reserveExecution({ binding, resourceId: ticket.launchId, ownerKind: "controller", identity: { ...identity, kind: "launch" }, operationId: ticket.launchId });
    },
    settleLaunch: (closure: { kind: "not_dispatched" } | { kind: "stopped"; pid: number; proof: ProcessProof | null }): void => {
      const resource = store.getResource(ticket.launchId);
      if (resource === null || resource.operationId !== ticket.launchId || resource.identity.executionId !== ticket.executionId || resource.identity.kind !== "launch") throw new Error("Controller launch closure has no original lifecycle reservation.");
      const stopProof = closure.kind === "stopped" ? { kind: "controller_unreleased_gate", binding, launchId: ticket.launchId,
        controllerInstanceId: ticket.controllerInstanceId, pid: closure.pid, originalProcessProof: closure.proof, gateReleased: false, boundaryEmpty: true } : null;
      if (resource.stage === closure.kind && resource.saveState === "durable" && controllerPayloadHash(resource.stopProof) === controllerPayloadHash(stopProof)) return;
      store.recordResource({ resourceId: ticket.launchId, stage: closure.kind, ...(stopProof === null ? {} : { stopProof: JSON.parse(JSON.stringify(stopProof)) }), saveState: "durable" });
    },
    bindLaunch: (proof: ProcessProof): void => {
      store.recordResource({ resourceId: ticket.launchId, stage: "running", processProof: JSON.parse(JSON.stringify(proof)), saveState: "durable" });
    },
    startProvider: (proof: ProcessProof): void => {
      store.reserveExecution({ binding, resourceId: ticket.controllerInstanceId, ownerKind: "controller", identity: { ...identity, kind: "provider" }, operationId: ticket.launchId });
      // The Controller's pre-exec PGID/Job encloses every Provider descendant.
      // Only its original external owner can later prove that whole boundary empty.
      store.recordResource({ resourceId: ticket.controllerInstanceId, stage: "running", processProof: JSON.parse(JSON.stringify(proof)), saveState: "durable" });
    },
    hasReservation: (operation: ControllerOperation): boolean => reservations.has(operation.operationId),
    reserve: (operation: ControllerOperation, nativeSessionId: string | null): void => {
      if (operation.kind === "cancel") return;
      if (reservations.has(operation.operationId)) { assertAdmission(); return; }
      store.reserveExecution({ binding, resourceId: operation.operationId, ownerKind: "controller", identity: { ...identity, kind: "input", operationKind: operation.kind, nativeSessionId }, operationId: operation.operationId });
      reservations.add(operation.operationId);
    },
    invoke: <T>(operation: ControllerOperation, action: () => T): T => operation.kind === "cancel" ? withinControllerManagement(action) : action(),
    settle: (operation: ControllerOperation): void => {
      if (operation.kind === "cancel") return;
      const resource = store.getResource(operation.operationId);
      if (resource === null && operation.executionGeneration !== ticket.executionGeneration) return;
      if (resource === null || resource.operationId !== operation.operationId || resource.identity.executionId !== ticket.executionId || resource.identity.kind !== "input") throw new Error("Controller input receipt has no matching lifecycle reservation.");
      const stage = ["confirmed", "failed", "provider_accepted"].includes(operation.state) ? "confirmed"
        : ["rejected", "expired"].includes(operation.state) ? "not_dispatched" : "unknown";
      store.recordResource({ resourceId: operation.operationId, stage, saveState: "durable", error: operation.error });
    },
  };
};

/** Original launch cleanup may finish after its first SQLite connection closes. */
export const settleControllerLaunch = (homeDirectory: string, ticket: ControllerLaunchTicket,
  closure: { kind: "not_dispatched" } | { kind: "stopped"; pid: number; proof: ProcessProof | null }, storageStateDirectory?: string): void => {
  const lifecycle = openControllerWorkerLifecycle(homeDirectory, ticket, storageStateDirectory);
  try { lifecycle?.settleLaunch(closure); }
  finally { lifecycle?.close(); }
};
