import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { cleanupOperation } from "../cleanup-operation.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError, type WorkerCleanupStage } from "./cleanup-error.js";
import { sameClaim } from "./execution.js";
import type { WorkerGitManager } from "./execution.js";
import type { CleanupTarget } from "./execution-stop.js";
import type { RetiredClaimNativeCleanup, LocatedClaimNative } from "./backends/retired-claim-native.js";
import type { WorkerStore } from "./store.js";
import type { ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";

/** Native inventory clearance and Git effects retain their independent proof boundaries. */
export const cleanupRetiredClaim = async (options: {
  target: CleanupTarget; located: Promise<LocatedClaimNative>; native: RetiredClaimNativeCleanup;
  project: WorkerProject; store: WorkerStore; git: WorkerGitManager; signal: AbortSignal; deadline: number; now(): number;
  onOwner(owner: ResourceOwner): void; onCleared(owner: ResourceOwner, observedAt: number): void;
  onEffectError(error: AggregateError): void;
}): Promise<WorktreeBinding | undefined> => {
  let stage: WorkerCleanupStage = "observation";
  try {
    const located = await options.located;
    options.signal.throwIfAborted();
    stage = "agent-stop";
    const cleared = await options.native.stop(located, { deadline: options.deadline, signal: options.signal });
    options.signal.throwIfAborted();
    if (!sameClaim(cleared.target, options.target) || !cleared.inventoryComplete || !cleared.resourcesCleared)
      throw new Error("Original claim native inventory clearance is unavailable.");
    const owners = new Map<string, ResourceOwner>();
    const retain = (owner: ResourceOwner): void => {
      if (!sameClaim(owner, options.target) || options.target.worktreeId !== undefined && owner.worktreeId !== options.target.worktreeId)
        throw new Error("The original claim has conflicting worktree identities.");
      owners.set(owner.worktreeId, owner);
    };
    if (options.target.worktreeId !== undefined) retain({ ...options.target, worktreeId: options.target.worktreeId });
    for (const owner of cleared.owners) retain(owner);
    const schedule = options.store.getCleanupSchedule(options.target);
    if (schedule !== null) retain(schedule);
    stage = "worktree-removal";
    if (owners.size > 1) throw new Error("The original claim has conflicting worktree resources.");
    const published = new Set<string>();
    const publish = (owner: ResourceOwner): void => {
      if (published.has(owner.worktreeId)) return;
      options.onOwner(owner);
      options.onCleared(owner, cleared.observedAt);
      ensureCleanupSchedule(options.store, owner, options.now(), owner);
      published.add(owner.worktreeId);
    };
    for (const owner of owners.values()) publish(owner);
    let directory;
    try { directory = await lstat(options.project.localPath); }
    catch (error) {
      if (owners.size === 0 && error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Original Task repository must be an ordinary directory.");
    await cleanupOperation(operation => options.git.prepareRepository(options.project, operation), options.signal);
    const manifests = await cleanupOperation(operation => options.git.listWorktreeManifests(options.project, operation), options.signal);
    for (const resource of manifests) if (sameClaim(resource.owner, options.target)) retain(resource.owner);
    const worktrees = await cleanupOperation(operation => options.git.listWorktrees(options.project, operation), options.signal);
    for (const resource of worktrees) if (sameClaim(resource.owner, options.target)) retain(resource.owner);
    if (owners.size > 1) throw new Error("The original claim has conflicting worktree resources.");
    let completedBinding: WorktreeBinding | undefined;
    for (const owner of owners.values()) {
      publish(owner);
      const binding = await cleanupOperation(operation => options.git.resolveWorktreeBinding(options.project, owner, operation), options.signal);
      if (binding === null) await cleanupOperation(operation => options.git.removeUnpublishedReservation(options.project, owner, operation), options.signal);
      else {
        const outcome = await options.git.removeWorktree(options.project, owner, { signal: options.signal });
        if (outcome.effectErrors.length > 0) options.onEffectError(new AggregateError(outcome.effectErrors, "Worktree removal effect failed after reaching its postcondition.", { cause: outcome.effectErrors[0] }));
        const after = await cleanupOperation(operation => options.git.resolveWorktreeBinding(options.project, owner, operation), options.signal);
        if (!isDeepStrictEqual(binding, after)) throw new Error("The original worktree binding changed during cleanup.");
        completedBinding = binding;
      }
    }
    options.signal.throwIfAborted();
    return completedBinding;
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new WorkerCleanupError(stage, error);
  }
};
