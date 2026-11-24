import { isDeepStrictEqual } from "node:util";
import { readWorkerClaim } from "../../api/task-properties.js";
import type { Task } from "../../api/types.js";
import { repositoryIdentity } from "../../repository/identity.js";
import type { LocalTask } from "./backends/web-types.js";
import type { ClaimIdentity, ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";
import { retainedWorktreePathInScope, sameWorktreeLocation } from "./worktrees/paths.js";

export type ResourceRecoveryRequest = ClaimIdentity & { worktreeId?: string; confirmed: boolean };
export type ResourceRecoveryDependencies = {
  serverOrigin: string; workerId: string; project: WorkerProject;
  currentUserId(signal: AbortSignal): Promise<string>;
  getRecord(identity: ClaimIdentity): LocalTask | null;
  readTask(projectId: string, taskId: string, signal: AbortSignal): Promise<Task>;
  readProject(projectId: string, signal: AbortSignal): Promise<{ id: string; repoUrl: string }>;
  inspectWorktree(owner: ResourceOwner, originalCwd: string, signal: AbortSignal): Promise<WorktreeBinding | null>;
  verifyStoppedArchive(record: LocalTask, signal: AbortSignal): Promise<void>;
  verifyPreserved(binding: WorktreeBinding, signal: AbortSignal): Promise<void>;
  removeSafely(owner: ResourceOwner, binding: WorktreeBinding, signal: AbortSignal): Promise<void>;
};

/** Recover only an archived, stopped execution whose original cleanup already completed. */
export const recoverCompletedWebResource = async (options: { request: ResourceRecoveryRequest; dependencies: ResourceRecoveryDependencies; signal: AbortSignal }) => {
  const { request, dependencies: d, signal } = options;
  signal.throwIfAborted();
  const record = d.getRecord(request);
  if (record === null) throw new Error("The original Web execution journal is missing. Restore the original Worker and Controller journals from backup; a Git worktree or completed Task cannot prove stop or archive preservation.");
  const owner = { projectId: record.projectId, taskId: record.taskId, claimId: record.claimId, worktreeId: record.worktreeId };
  const principal = await d.currentUserId(signal);
  if (record.projectId !== request.projectId || record.taskId !== request.taskId || record.claimId !== request.claimId || request.worktreeId !== undefined && request.worktreeId !== record.worktreeId
    || record.serverOrigin !== d.serverOrigin || record.workerId !== d.workerId || record.userId !== principal) throw new Error("The original resource does not belong to this service, Worker, authenticated owner and claim.");
  if (record.status !== "done" || record.cleanup?.kind !== "terminal" || record.configuration?.agentControlMode !== "web" || record.webExecution?.sessionId == null) throw new Error("Recovery requires the original completed Web cleanup and registered Session; unfinished executions use normal Worker reconciliation.");
  const project = d.project;
  const remoteProject = await d.readProject(request.projectId, signal);
  if (project.projectId !== owner.projectId || remoteProject.id !== owner.projectId || repositoryIdentity(project.repoUrl) !== repositoryIdentity(record.repoUrl)
    || repositoryIdentity(remoteProject.repoUrl) !== repositoryIdentity(record.repoUrl) || !await sameWorktreeLocation(project.localPath, record.repositoryPath)) throw new Error("The original project repository binding is unavailable or conflicting.");
  const expected = record.resources.worktree;
  if (expected === null || !retainedWorktreePathInScope(project.localPath, owner, expected.worktreePath)) throw new Error("The original resource has no retained worktree binding.");
  const verify = async (): Promise<WorktreeBinding> => {
    signal.throwIfAborted();
    const task = await d.readTask(owner.projectId, owner.taskId, signal), worker = readWorkerClaim(task.properties);
    if (task.id !== owner.taskId || task.projectId !== owner.projectId || !["done", "cancelled"].includes(task.status) || worker === undefined
      || worker.state === "active" || worker.claimId !== owner.claimId || worker.worktreeId !== owner.worktreeId || worker.workerId !== d.workerId
      || worker.userId !== principal || worker.agentControlMode !== "web" || worker.agent !== record.configuration!.agent
      || worker.nativeSessionId !== (record.resources.nativeSession?.sessionId ?? null)) throw new Error("The original terminal claim is no longer retained on this Worker; replacement claims cannot authorize recovery.");
    const binding = await d.inspectWorktree(owner, expected.worktreePath, signal);
    if (binding === null || binding.branch !== expected.branch || binding.branch !== `daynight/${owner.taskId}`
      || !await sameWorktreeLocation(binding.repositoryPath, expected.repositoryPath) || !await sameWorktreeLocation(binding.commonDirectory, expected.commonDirectory)
      || !await sameWorktreeLocation(binding.worktreePath, expected.worktreePath)) throw new Error("The current worktree does not match the complete original Git binding.");
    await d.verifyStoppedArchive(record, signal);
    await d.verifyPreserved(binding, signal);
    signal.throwIfAborted();
    if (!isDeepStrictEqual(d.getRecord(owner), record)) throw new Error("The original execution evidence changed during recovery.");
    return binding;
  };
  const binding = await verify();
  if (!request.confirmed) return { outcome: "verified" as const, owner, worktreePath: binding.worktreePath, message: "Original stop, archive and clean preserved Git content verified. Repeat with --confirm to remove this worktree; its branch and execution journals remain." };
  const current = await verify();
  if (!isDeepStrictEqual(current, binding)) throw new Error("The original worktree binding changed after recovery preview.");
  await d.removeSafely(owner, binding, signal);
  signal.throwIfAborted();
  return { outcome: "recovered" as const, owner, worktreePath: binding.worktreePath, message: "Original worktree removal confirmed; normal Worker observation will clear its reservation." };
};
