import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { openLifecycleStore, type LifecycleJson, type LifecycleResource } from "../worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../worker/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, projectControllerLifecycleBinding, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerOperation } from "./lifecycle-store.js";
import { freezeNativeLifecycleFence } from "./native-lifecycle.js";
import type { ProcessProof } from "./process-proof.js";
import { resolveControllerStateDirectory } from "./paths.js";

/** A stopped Worker still permits interruption and storage of original results. */
const management = new AsyncLocalStorage<boolean>();
export const controllerManagementActive = (): boolean => management.getStore() === true;
export const withinControllerManagement = <T>(action: () => T): T => management.run(true, action);

const controllerIdentity = (homeDirectory: string, source: ControllerLaunchTicket, storageStateDirectory?: string): { [key: string]: LifecycleJson } => {
  const value: { [key: string]: LifecycleJson } = { executionId: source.executionId, sessionId: source.sessionId, executionGeneration: source.executionGeneration,
    controllerInstanceId: source.controllerInstanceId, controllerId: source.controllerId, launchId: source.launchId,
    storageStateDirectory: resolveControllerStateDirectory(homeDirectory, storageStateDirectory), ticketHash: controllerPayloadHash(source),
    journalFile: path.join(controllerExecutionDirectory(homeDirectory, source.executionId, storageStateDirectory), "journal.sqlite") };
  if (source.claimId === undefined) value.testExecutionId = source.testExecutionId!;
  else Object.assign(value, { projectId: source.projectId, taskId: source.taskId, claimId: source.claimId, worktreeId: source.worktreeId });
  return value;
};

/** Verify the complete immutable reservation identity before adoption or stopped reconciliation. */
export const assertRecoveredInitialReservation = (homeDirectory: string, current: ControllerLaunchTicket, resource: LifecycleResource, original: ControllerLaunchTicket, storageStateDirectory?: string, allowedStage: "reserved" | "not_dispatched" = "reserved"): void => {
  parseLaunchTicket(original);
  if (current.claimId === undefined || original.claimId === undefined || current.initialOperationId !== original.initialOperationId
    || resource.operationId !== current.initialOperationId || resource.ownerKind !== "controller"
    || resource.stage !== allowedStage || resource.processProof !== null || resource.stopProof !== null || resource.saveState !== "durable" || resource.error !== null
    || original.lifecycleBinding === undefined || resource.instanceId !== original.lifecycleBinding.instanceId
    || resource.scopeGeneration !== original.lifecycleBinding.scopeGeneration
    || controllerPayloadHash(resource.identity) !== controllerPayloadHash({ ...controllerIdentity(homeDirectory, original, storageStateDirectory), kind: "input", operationKind: "initial", nativeSessionId: current.resumeNativeSessionId }))
    throw new Error("Recovered initial reservation conflicts with its original ticket.");
};

export const openControllerWorkerLifecycle = (homeDirectory: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string) => {
  parseLaunchTicket(ticket);
  const file = path.join(resolveWorkerPaths(homeDirectory).workerDirectory, "lifecycle.sqlite");
  if (ticket.lifecycleBinding === undefined) {
    if (ticket.usageScope !== "standalone_test" && existsSync(file)) throw new Error("Legacy Controller has no persistent Worker lifecycle binding; its original boundary must stop before migration.");
    return null;
  }
  const binding = projectControllerLifecycleBinding(ticket.lifecycleBinding);
  const store = openLifecycleStore({ file, identity: { serverOrigin: binding.serverOrigin, userId: binding.userId, workerId: binding.workerId }, allowCreate: false });
  const identity = controllerIdentity(homeDirectory, ticket, storageStateDirectory);
  const reservations = new Map<string, string>();
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
    inputReservation: (operationId: string): LifecycleResource | null => {
      const resources = store.listResources().filter(resource => resource.operationId === operationId);
      if (resources.some(resource => resource.ownerKind !== "controller" || resource.identity.kind !== "input" || !["reserved", "not_dispatched"].includes(resource.stage))) throw new Error("Recovered initial input has conflicting lifecycle responsibility.");
      const active = resources.filter(resource => resource.stage === "reserved");
      if (active.length > 1) throw new Error("Recovered initial input has multiple live lifecycle reservations.");
      if (active.length === 1) return active[0]!;
      return resources.sort((a, b) => BigInt(String(a.identity.executionGeneration)) < BigInt(String(b.identity.executionGeneration)) ? 1 : -1)[0] ?? null;
    },
    reserve: (operation: ControllerOperation, nativeSessionId: string | null, recovered?: { resource: LifecycleResource; ticket: ControllerLaunchTicket }): void => {
      if (operation.kind === "cancel") return;
      if (reservations.has(operation.operationId)) { assertAdmission(); return; }
      const newIdentity = { ...identity, kind: "input", operationKind: operation.kind, nativeSessionId };
      if (recovered !== undefined) {
        if (operation.kind !== "initial" || nativeSessionId !== ticket.resumeNativeSessionId) throw new Error("Recovered reservation is not the original initial input.");
        assertRecoveredInitialReservation(homeDirectory, ticket, recovered.resource, recovered.ticket, storageStateDirectory, recovered.resource.stage === "not_dispatched" ? "not_dispatched" : "reserved");
        const resource = recovered.resource.stage === "not_dispatched"
          ? store.reserveAfterSettledControllerInput({ binding, previous: recovered.resource, resourceId: randomUUID(), identity: newIdentity })
          : store.adoptPreparedControllerInput({ binding, previous: recovered.resource, identity: newIdentity });
        reservations.set(operation.operationId, resource.resourceId);
      } else {
        store.reserveExecution({ binding, resourceId: operation.operationId, ownerKind: "controller", identity: newIdentity, operationId: operation.operationId });
        reservations.set(operation.operationId, operation.operationId);
      }
    },
    invoke: <T>(operation: ControllerOperation, action: () => T): T => operation.kind === "cancel" ? withinControllerManagement(action) : action(),
    settle: (operation: ControllerOperation): void => {
      if (operation.kind === "cancel") return;
      let resourceId = reservations.get(operation.operationId) ?? operation.operationId;
      let resource = store.getResource(resourceId);
      if (operation.kind === "initial") {
        const matching = store.listResources().filter(item => item.operationId === operation.operationId && item.ownerKind === "controller" && item.identity.kind === "input" && item.identity.executionGeneration === operation.executionGeneration);
        if (matching.length > 1) throw new Error("Controller input receipt has multiple matching lifecycle reservations.");
        resource = matching[0] ?? null;
        resourceId = resource?.resourceId ?? operation.operationId;
      }
      if (resource === null && operation.executionGeneration !== ticket.executionGeneration) return;
      if (resource === null || resource.operationId !== operation.operationId || resource.identity.executionId !== ticket.executionId || resource.identity.kind !== "input") throw new Error("Controller input receipt has no matching lifecycle reservation.");
      const stage = ["confirmed", "failed", "provider_accepted"].includes(operation.state) ? "confirmed"
        : ["rejected", "expired"].includes(operation.state) ? "not_dispatched" : "unknown";
      store.recordResource({ resourceId, stage, saveState: "durable", error: operation.error });
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
