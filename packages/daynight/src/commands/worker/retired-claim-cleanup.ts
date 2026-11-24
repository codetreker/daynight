import { lstat } from "node:fs/promises";
import { cleanupOperation } from "../cleanup-operation.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError, type WorkerCleanupStage } from "./cleanup-error.js";
import { sameClaim } from "./execution.js";
import type { WorkerGitManager } from "./execution.js";
import type { CleanupTarget } from "./execution-stop.js";
import type { RetiredClaimNativeCleanup, LocatedClaimNative } from "./backends/retired-claim-native.js";
import type { WorkerStore } from "./store.js";
import type { ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";
import { sameWorktreeLocation } from "./worktrees/paths.js";

/** Native inventory clearance and Git effects retain their independent proof boundaries. */
export const cleanupRetiredClaim = async (options: {
  target: CleanupTarget; located: Promise<LocatedClaimNative>; native: RetiredClaimNativeCleanup;
  project: WorkerProject; originalCwd?: string; store: WorkerStore; git: WorkerGitManager; signal: AbortSignal; deadline: number; now(): number;
  findLegacyCwd?: () => Promise<string | undefined>;
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
    const schedule = options.store.getCleanupSchedule(options.target);
    const knownOwners = [...cleared.owners, ...(schedule === null ? [] : [schedule])];
    const owner = options.target.worktreeId === undefined ? knownOwners[0] : { ...options.target, worktreeId: options.target.worktreeId };
    if (owner !== undefined && (!sameClaim(owner, options.target) || knownOwners.some(candidate => !sameClaim(candidate, owner) || candidate.worktreeId !== owner.worktreeId)))
      throw new Error("The original claim has conflicting worktree identities.");
    stage = "worktree-removal";
    if (owner !== undefined) {
      options.onOwner(owner);
      options.onCleared(owner, cleared.observedAt);
      ensureCleanupSchedule(options.store, owner, options.now(), owner);
    }
    let directory;
    try { directory = await lstat(options.project.localPath); }
    catch (error) {
      if (owner === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Original Task repository must be an ordinary directory.");
    await cleanupOperation(operation => options.git.prepareRepository(options.project, operation), options.signal);
    if (owner === undefined) {
      const scan = await cleanupOperation(operation => options.git.scanWorktrees(options.project, operation), options.signal);
      if (!scan.enumerationComplete || scan.unknown.length > 0) throw scan.unknown[0]?.error ?? new Error("Original Git resource enumeration is incomplete.");
      if ([...scan.validated, ...scan.quarantined].some(worktree => worktree.taskId === options.target.taskId)) throw new Error("A registered task worktree has no confirmed original claim identity.");
      options.signal.throwIfAborted();
      return;
    }
    let originalCwd = options.originalCwd;
    for (const { ticket } of located.controllers) {
      if (ticket.worktreeId !== owner.worktreeId) throw new Error("The original Controller ticket has a conflicting worktree identity.");
      if (originalCwd !== undefined && !await sameWorktreeLocation(originalCwd, ticket.cwd)) throw new Error("The original Controller ticket has a conflicting worktree path.");
      originalCwd = ticket.cwd;
    }
    originalCwd ??= await options.findLegacyCwd?.();
    const binding = await cleanupOperation(operation => options.git.resolveWorktreeBinding(options.project, owner, operation, originalCwd), options.signal);
    if (binding === null) await cleanupOperation(operation => options.git.removeUnregisteredReservation(options.project, owner, operation), options.signal);
    else {
      const outcome = await options.git.removeWorktree(options.project, owner, { signal: options.signal, ...(originalCwd === undefined ? {} : { originalCwd }) });
      if (outcome.effectErrors.length > 0) options.onEffectError(new AggregateError(outcome.effectErrors, "Worktree removal effect failed after reaching its postcondition.", { cause: outcome.effectErrors[0] }));
    }
    options.signal.throwIfAborted();
    return binding ?? undefined;
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new WorkerCleanupError(stage, error);
  }
};
