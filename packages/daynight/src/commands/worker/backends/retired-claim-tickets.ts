import { readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import type { Operation } from "../../../api/operation.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { resolveControllerStateDirectory } from "../../controller/paths.js";
import type { CleanupTarget } from "../execution-stop.js";
import { readLifecycleControllerLocation } from "../lifecycle-controller-ticket.js";
import type { LifecycleIdentity, LifecycleResource, LifecycleStore } from "../lifecycle-store.js";

export type LocatedClaimController = { ticket: ControllerLaunchTicket; journalFile: string; storageStateDirectory: string; resources: LifecycleResource[] };
export type LocatedClaimNative = { target: CleanupTarget; controllers: LocatedClaimController[] };
export type ClaimNativeLocation = { target: CleanupTarget; located: LocatedClaimNative } | { target: CleanupTarget; error: unknown };
export const retiredClaimKey = (target: CleanupTarget): string => `${target.projectId}/${target.taskId}/${target.claimId}`;
const matches = (target: CleanupTarget, ticket: ControllerLaunchTicket): boolean => ticket.projectId === target.projectId && ticket.taskId === target.taskId && ticket.claimId === target.claimId;
const attemptIntent = (ticket: ControllerLaunchTicket): string => {
  const { schemaVersion: _version, lifecycleBinding: _binding, launchId: _launch, ipcEndpoint: _endpoint, ipcSecret: _secret, ...intent } = ticket;
  return controllerPayloadHash(intent);
};

/** Batch discovery stays inside the Worker's inventory; lifecycle records bind their own original roots. */
export const locateRetiredClaimControllers = async (options: {
  homeDirectory: string; identity: LifecycleIdentity; storageStateDirectory?: string;
  lifecycle?: Pick<LifecycleStore, "listResources">;
}, targets: readonly CleanupTarget[], operation: Operation): Promise<ReadonlyMap<string, ClaimNativeLocation>> => {
  const entries = new Map(targets.map(target => [retiredClaimKey(target), { target, located: { target, controllers: [] } } as ClaimNativeLocation]));
  operation.check();
  if (targets.length === 0) return entries;
  const add = (target: CleanupTarget, ticket: ControllerLaunchTicket, root: string, resource?: LifecycleResource): void => {
    const key = retiredClaimKey(target), result = entries.get(key)!;
    if ("error" in result) return;
    if (ticket.serverOrigin !== options.identity.serverOrigin || ticket.workerId !== options.identity.workerId || ticket.userId !== options.identity.userId)
      throw new Error("Original retired claim Controller belongs to another Worker identity.");
    if (target.worktreeId !== undefined && ticket.worktreeId !== target.worktreeId) throw new Error("Original retired claim Controller worktree conflicts with its cleanup target.");
    const generation = result.located.controllers.filter(item => item.ticket.executionId === ticket.executionId && item.ticket.executionGeneration === ticket.executionGeneration);
    if (generation.some(item => item.storageStateDirectory !== root || attemptIntent(item.ticket) !== attemptIntent(ticket)))
      throw new Error("Original retired claim has conflicting Controller generation intents.");
    const previous = result.located.controllers.find(item => item.ticket.launchId === ticket.launchId);
    if (previous !== undefined) {
      if (previous.storageStateDirectory !== root || controllerPayloadHash(previous.ticket) !== controllerPayloadHash(ticket))
        throw new Error("Original retired claim has conflicting Controller launch tickets.");
      if (resource !== undefined && !previous.resources.some(item => item.resourceId === resource.resourceId)) previous.resources.push(resource);
      return;
    }
    result.located.controllers.push({ ticket, journalFile: path.join(controllerExecutionDirectory(options.homeDirectory, ticket.executionId, root), "journal.sqlite"), storageStateDirectory: root, resources: resource === undefined ? [] : [resource] });
  };
  for (const resource of options.lifecycle?.listResources() ?? []) {
    operation.check();
    if (resource.ownerKind !== "controller") continue;
    const target = targets.find(item => resource.identity.projectId === item.projectId && resource.identity.taskId === item.taskId && resource.identity.claimId === item.claimId);
    if (target === undefined) continue;
    try {
      const location = await readLifecycleControllerLocation(options.homeDirectory, options.identity, resource);
      add(target, location.ticket, location.storageStateDirectory, resource);
    }
    catch (error) { entries.set(retiredClaimKey(target), { target, error }); }
  }
  const root = resolveControllerStateDirectory(options.homeDirectory, options.storageStateDirectory);
  let files: string[];
  try { files = await readdir(path.join(root, "controller", "launches")); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") files = []; else throw error; }
  if (files.length > 20_000) throw new Error("Controller launch inventory exceeds its safe bound.");
  for (const filename of files) {
    operation.check();
    if (!filename.endsWith(".json") || canonicalId(filename.slice(0, -5)) !== filename.slice(0, -5)) continue;
    const ticket = await readLaunchTicket(options.homeDirectory, filename.slice(0, -5), root);
    const target = targets.find(item => matches(item, ticket));
    if (target === undefined) continue;
    try { add(target, ticket, root); }
    catch (error) { entries.set(retiredClaimKey(target), { target, error }); }
  }
  operation.check();
  return entries;
};
