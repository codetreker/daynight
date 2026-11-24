import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { controllerExecutionDirectory, controllerPayloadHash, projectControllerLifecycleBinding, readLaunchTicket, type ControllerLaunchTicket } from "../controller/launch-ticket.js";
import { resolveControllerStateDirectory } from "../controller/paths.js";
import type { ProcessProof } from "../controller/process-proof.js";
import type { LifecycleIdentity, LifecycleResource } from "./lifecycle-store.js";

const unavailable = (): never => { throw new Error("Original lifecycle Controller ticket location or identity is unavailable."); };

/** Read only the ticket paired with the reservation's original journal and owner. */
export const readLifecycleControllerLocation = async (homeDirectory: string, owner: LifecycleIdentity, resource: LifecycleResource): Promise<{
  ticket: ControllerLaunchTicket; storageStateDirectory: string; journalFile: string;
}> => {
  const identity = resource.identity;
  if (resource.ownerKind !== "controller" || typeof identity.launchId !== "string" || typeof identity.executionId !== "string"
    || typeof identity.journalFile !== "string" || !path.isAbsolute(identity.journalFile) || path.resolve(identity.journalFile) !== identity.journalFile) return unavailable();
  // Older reservations retained the journal's full location. Invert that exact
  // layout and validate it; searching other roots could select another owner.
  const originalRoot = identity.storageStateDirectory === undefined
    ? path.dirname(path.dirname(path.dirname(path.dirname(identity.journalFile))))
    : typeof identity.storageStateDirectory === "string" ? identity.storageStateDirectory : unavailable();
  const root = resolveControllerStateDirectory(homeDirectory, originalRoot);
  if (identity.journalFile !== path.join(controllerExecutionDirectory(homeDirectory, identity.executionId, root), "journal.sqlite")) return unavailable();
  const ticket = await readLaunchTicket(homeDirectory, identity.launchId, root), binding = ticket.lifecycleBinding;
  if (binding === undefined || binding.serverOrigin !== owner.serverOrigin || binding.userId !== owner.userId || binding.workerId !== owner.workerId
    || binding.instanceId !== resource.instanceId || binding.scopeGeneration !== resource.scopeGeneration
    || ticket.executionId !== identity.executionId || ticket.sessionId !== identity.sessionId || ticket.executionGeneration !== identity.executionGeneration
    || ticket.controllerInstanceId !== identity.controllerInstanceId || ticket.serverOrigin !== owner.serverOrigin
    || identity.controllerId !== undefined && identity.controllerId !== ticket.controllerId
    || identity.ticketHash !== undefined && identity.ticketHash !== controllerPayloadHash(ticket)) return unavailable();
  if (ticket.claimId === undefined) {
    if (ticket.testExecutionId !== identity.testExecutionId || ticket.ownerUserId !== owner.userId || identity.claimId !== undefined) return unavailable();
  } else if (ticket.claimId !== identity.claimId || ticket.projectId !== identity.projectId || ticket.taskId !== identity.taskId
    || ticket.worktreeId !== identity.worktreeId || ticket.workerId !== owner.workerId || ticket.userId !== owner.userId || identity.testExecutionId !== undefined) return unavailable();
  return { ticket, storageStateDirectory: root, journalFile: identity.journalFile };
};

export const readLifecycleControllerTicket = async (homeDirectory: string, owner: LifecycleIdentity, resource: LifecycleResource): Promise<ControllerLaunchTicket> =>
  (await readLifecycleControllerLocation(homeDirectory, owner, resource)).ticket;

/** The original launch owner persisted this only after stopping its unreleased gate. */
export const hasLifecycleUnreleasedControllerGateProof = (ticket: ControllerLaunchTicket, resource: LifecycleResource, process: ProcessProof): boolean => {
  const saved = resource.stopProof;
  return resource.ownerKind === "controller" && resource.identity.kind === "launch" && resource.stage === "stopped" && resource.saveState === "durable"
    && ticket.lifecycleBinding !== undefined && saved !== null && typeof saved === "object" && !Array.isArray(saved)
    && resource.resourceId === ticket.launchId && resource.operationId === ticket.launchId
    && resource.instanceId === ticket.lifecycleBinding.instanceId
    && resource.scopeGeneration === ticket.lifecycleBinding.scopeGeneration
    && Object.keys(saved).sort().join() === "binding,boundaryEmpty,controllerInstanceId,gateReleased,kind,launchId,originalProcessProof,pid"
    && saved.kind === "controller_unreleased_gate" && saved.launchId === ticket.launchId && saved.controllerInstanceId === ticket.controllerInstanceId
    && saved.pid === process.pid && saved.gateReleased === false && saved.boundaryEmpty === true
    && isDeepStrictEqual(saved.binding, projectControllerLifecycleBinding(ticket.lifecycleBinding)) && isDeepStrictEqual(saved.originalProcessProof, process)
    && isDeepStrictEqual(resource.processProof, process);
};
