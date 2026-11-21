import path from "node:path";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, type ControllerLaunchTicket } from "../controller/launch-ticket.js";
import { resolveControllerStateDirectory } from "../controller/paths.js";
import type { LifecycleIdentity, LifecycleResource } from "./lifecycle-store.js";

const unavailable = (): never => { throw new Error("Original lifecycle Controller ticket location or identity is unavailable."); };

/** Read only the ticket paired with the reservation's original journal and owner. */
export const readLifecycleControllerTicket = async (homeDirectory: string, owner: LifecycleIdentity, resource: LifecycleResource): Promise<ControllerLaunchTicket> => {
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
    || binding.instanceId !== resource.instanceId || binding.instanceEpoch !== resource.instanceEpoch || binding.scopeGeneration !== resource.scopeGeneration
    || ticket.executionId !== identity.executionId || ticket.sessionId !== identity.sessionId || ticket.executionGeneration !== identity.executionGeneration
    || ticket.controllerInstanceId !== identity.controllerInstanceId || ticket.serverOrigin !== owner.serverOrigin
    || identity.controllerId !== undefined && identity.controllerId !== ticket.controllerId
    || identity.ticketHash !== undefined && identity.ticketHash !== controllerPayloadHash(ticket)) return unavailable();
  if (ticket.claimId === undefined) {
    if (ticket.testExecutionId !== identity.testExecutionId || ticket.ownerUserId !== owner.userId || identity.claimId !== undefined) return unavailable();
  } else if (ticket.claimId !== identity.claimId || ticket.projectId !== identity.projectId || ticket.taskId !== identity.taskId
    || ticket.worktreeId !== identity.worktreeId || ticket.workerId !== owner.workerId || ticket.userId !== owner.userId || identity.testExecutionId !== undefined) return unavailable();
  return ticket;
};
