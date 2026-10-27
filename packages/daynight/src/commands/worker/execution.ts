import path from "node:path";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { TaskPlatform } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, WorkerHerdrAdapter } from "./herdr.js";
import type { ManagedAssignment } from "./prompts.js";
import type { WorkerStore } from "./store.js";
import type { ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";
import type { createWorkerGitManager } from "./worktrees.js";

export type WorkerEvent = { kind: string; message: string; task?: LocalTask; error?: unknown };
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
export type ExecutionInput = { task: LocalTask; project: WorkerProject; owner: ResourceOwner; configuration: ExecutionConfiguration };
export type ExecutionDependencies = {
  store: WorkerStore;
  git: WorkerGitManager;
  herdr: WorkerHerdrAdapter;
  platform: TaskPlatform;
  workerId: string;
  buildPrompt: (assignment: ManagedAssignment, platform: TaskPlatform) => string;
  emit: (event: WorkerEvent) => void;
  now: () => number;
};
export const isWorkerCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((failure) => isWorkerCancellation(failure, signal));
  return error === signal.reason || (error instanceof OperationError && error.kind === "cancelled" && error.cause === signal.reason)
    || (error instanceof Error && error.cause !== undefined && isWorkerCancellation(error.cause, signal));
};
export const workerOperation = async <T>(action: (operation: Operation) => Promise<T>, signal?: AbortSignal, totalMs = 120_000): Promise<T> => {
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs } });
  try { return await action(operation); } finally { operation.dispose(); }
};
export const sameClaim = (left: { projectId: string; taskId: string; claimId: string }, right: { projectId: string; taskId: string; claimId: string }): boolean =>
  left.projectId === right.projectId && left.taskId === right.taskId && left.claimId === right.claimId;
export const ownedWorkspace = (owner: ResourceOwner, resources: readonly HerdrOwnedWorkspace[]): HerdrOwnedWorkspace | undefined => {
  const matches = resources.filter((resource) => sameClaim(resource.owner, owner) && resource.owner.serverOrigin === owner.serverOrigin);
  if (matches.length > 1 || matches.some((resource) => resource.owner.worktreeId !== owner.worktreeId)) throw new Error("The claim has conflicting Herdr resource identities.");
  return matches[0];
};
export const actualTaskPane = (owner: ResourceOwner, resources: readonly HerdrOwnedWorkspace[]) => {
  const workspace = ownedWorkspace(owner, resources);
  if (workspace === undefined) return undefined;
  if (workspace.panes.length !== 1) throw new Error("The task workspace must contain exactly one managed pane.");
  return workspace.panes[0];
};
export const liveAgent = (pane: { kind: string | null; launchPending: boolean; interactiveReady: boolean }): boolean =>
  pane.kind !== null || pane.launchPending || pane.interactiveReady;
export const executionContext = (input: Pick<ExecutionInput, "owner" | "project"> & { task: Pick<LocalTask, "agent"> }): HerdrExecutionContext => ({
  ...input.owner, cwd: path.join(input.project.localPath, ".worktrees", "daynight", input.owner.taskId), agent: input.task.agent,
});
export const settleWorkerStops = async (deps: Pick<ExecutionDependencies, "herdr">, owner: ResourceOwner, signal?: AbortSignal): Promise<boolean> => {
  const pending = deps.herdr.tasks.pendingStops().filter((stop) => sameClaim(stop.context, owner) && stop.context.serverOrigin === owner.serverOrigin);
  for (const stop of pending) {
    if (stop.context.worktreeId !== owner.worktreeId) throw new Error("The claim has conflicting pending Herdr stop identities.");
    await workerOperation((operation) => deps.herdr.tasks.stopAndClose(stop.context, stop.binding, operation), signal);
  }
  return pending.length > 0;
};

export const createExecutionDriver = (deps: ExecutionDependencies) => {
  const pendingInput = new Map<string, { binding: HerdrTaskBinding; prompt: string }>();
  const key = (task: Pick<LocalTask, "projectId" | "taskId" | "claimId">): string => `${task.projectId}/${task.taskId}/${task.claimId}`;
  return {
    forget: (task: LocalTask): void => { pendingInput.delete(key(task)); },
    advance: async (input: ExecutionInput, signal?: AbortSignal): Promise<HerdrAgentObservation> => {
      let task = deps.store.getTask(input.task);
      if (task === null || task.status !== "active") throw new Error("Resource startup requires an active local claim.");
      const context = executionContext({ ...input, task });
      await settleWorkerStops(deps, input.owner, signal);
      const resources = await workerOperation((operation) => deps.herdr.tasks.listResources(operation), signal);
      const actual = actualTaskPane(input.owner, resources);
      const worktree = task.sessionId === null
        ? await workerOperation((operation) => deps.git.prepareWorktree(input.project, input.owner, operation), signal, 180_000)
        : await workerOperation((operation) => deps.git.verifyWorktree(input.project, input.owner, operation), signal);
      if (actual !== undefined && liveAgent(actual)) {
        let observed = await workerOperation((operation) => deps.herdr.tasks.observe(context, actual.binding, operation), signal);
        const pending = pendingInput.get(key(task));
        if (pending !== undefined && pending.binding.terminalId === actual.binding.terminalId && pending.binding.paneId === actual.binding.paneId && observed.status !== "blocked" && observed.interactiveReady && !observed.launchPending) {
          pendingInput.delete(key(task));
          try {
            await workerOperation((operation) => deps.herdr.tasks.submitPrompt(context, actual.binding, pending.prompt, operation), signal);
            observed = await workerOperation((operation) => deps.herdr.tasks.observe(context, actual.binding, operation), signal);
          } catch (error) {
            if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") pendingInput.set(key(task), pending);
            throw error;
          }
        }
        if (observed.nativeSession !== null) task = deps.store.setSessionId(task, observed.nativeSession.sessionId);
        deps.emit({ kind: observed.status === "blocked" ? "waiting" : "reconnected", task, message: "Connected to the existing agent without repeating its managed assignment." });
        return observed;
      }
      if (actual !== undefined) {
        // Cold restore drops workspace environment overrides and retains the old native reference.
        // A fresh workspace restores native XDG settings and observes only the new launch's SessionStart.
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L568-L580
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L687-L713
        await workerOperation((operation) => deps.herdr.tasks.stopAndClose(context, actual.binding, operation), signal);
      }
      const binding = await workerOperation((operation) => deps.herdr.tasks.prepareWorkspace(context, operation), signal);
      if (task.sessionId === null) deps.emit({ kind: "warning", task, message: "The native session ID is missing; starting a new conversation in the existing task worktree." });
      const assignment: ManagedAssignment = { ...task, serverOrigin: input.owner.serverOrigin, workerId: deps.workerId, worktreeId: input.owner.worktreeId, worktree, configuration: input.configuration };
      const prompt = deps.buildPrompt(assignment, deps.platform);
      pendingInput.delete(key(task));
      let observation: HerdrAgentObservation;
      try {
        observation = await workerOperation((operation) => deps.herdr.tasks.start(context, binding, {
          configuration: input.configuration, prompt,
          ...(assignment.sessionId === null ? {} : { resumeSessionId: assignment.sessionId }),
        }, operation), signal);
      } catch (error) {
        if (!(error instanceof HerdrAgentActionError) || error.action !== "agent.prompt" || error.promptSubmission !== "not-submitted") throw error;
        pendingInput.set(key(task), { binding, prompt });
        observation = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding, operation), signal);
        deps.emit({ kind: "waiting", task, message: "The first managed input is waiting in this worker process; use daynight worker attach to resolve the native screen." });
      }
      if (observation.nativeSession !== null) task = deps.store.setSessionId(task, observation.nativeSession.sessionId);
      deps.emit({ kind: observation.status === "blocked" ? "waiting" : "started", task, message: observation.status === "blocked" ? "The native agent is waiting for input; use daynight worker attach." : "Started the managed task conversation." });
      return observation;
    },
  };
};
