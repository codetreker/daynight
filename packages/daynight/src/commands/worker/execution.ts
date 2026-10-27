import path from "node:path";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { TaskPlatform } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, WorkerHerdrAdapter } from "./herdr.js";
import type { ManagedAssignment } from "./prompts.js";
import { workerPingPrompt } from "./prompts.js";
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
const assertNativeSession = (task: LocalTask, observation: HerdrAgentObservation): void => {
  if (task.sessionId !== null && observation.nativeSession !== null && observation.nativeSession.sessionId !== task.sessionId) throw new Error(`The observed native session ${observation.nativeSession.sessionId} differs from the recorded native session ${task.sessionId}.`);
};

export const createExecutionDriver = (deps: ExecutionDependencies) => {
  const pendingInput = new Map<string, { binding: HerdrTaskBinding; prompt: string }>();
  const lastInput = new Map<string, string | null>();
  const observations = new Map<string, string>();
  const key = (task: Pick<LocalTask, "projectId" | "taskId" | "claimId">): string => `${task.projectId}/${task.taskId}/${task.claimId}`;
  const inputState = (observation: HerdrAgentObservation): string => {
    const { session, workspaceId, paneId, terminalId } = observation.binding;
    return JSON.stringify([session, workspaceId, paneId, terminalId, observation.status, observation.stateChangeSeq, observation.completionSeq]);
  };
  const submitInput = async (task: LocalTask, context: HerdrExecutionContext, observed: HerdrAgentObservation, prompt: string, signal?: AbortSignal): Promise<HerdrAgentObservation> => {
    const identity = key(task);
    lastInput.set(identity, inputState(observed));
    try {
      const receipt = await workerOperation((operation) => deps.herdr.tasks.submitPrompt(context, observed.binding, prompt, operation), signal);
      lastInput.set(identity, inputState(receipt.observation));
      return await workerOperation((operation) => deps.herdr.tasks.observe(context, observed.binding, operation), signal);
    } catch (error) {
      if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") lastInput.delete(identity);
      else lastInput.set(identity, null);
      throw error;
    }
  };
  const reportObservation = (task: LocalTask, observation: HerdrAgentObservation, started = false): void => {
    const identity = key(task);
    const pending = pendingInput.has(identity);
    const blocked = observation.status === "blocked";
    const waiting = pending || blocked;
    const { session, workspaceId, paneId, terminalId } = observation.binding;
    const state = JSON.stringify([session, workspaceId, paneId, terminalId, task.agent, task.sessionId, waiting, pending]);
    if (!started && observations.get(identity) === state) return;
    observations.set(identity, state);
    deps.emit({
      kind: waiting ? "waiting" : started ? "started" : "reconnected",
      task,
      message: pending ? "The first managed input is waiting in this worker process; use daynight worker attach to resolve the native screen."
        : blocked ? "The native agent is waiting for input; use daynight worker attach."
        : started ? "Started the managed task conversation."
        : "Connected to the existing agent without repeating its managed assignment.",
    });
  };
  return {
    forget: (task: LocalTask): void => { pendingInput.delete(key(task)); lastInput.delete(key(task)); observations.delete(key(task)); },
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
        assertNativeSession(task, observed);
        const identity = key(task);
        // A prompt ACK precedes native input consumption. Retain its observed turn
        // until native progress makes another continuation a new decision.
        if (lastInput.has(identity) && lastInput.get(identity) === null) lastInput.set(identity, inputState(observed));
        if (observed.status === "working") lastInput.delete(identity);
        const pending = pendingInput.get(identity);
        if (pending !== undefined && pending.binding.terminalId === actual.binding.terminalId && pending.binding.paneId === actual.binding.paneId && observed.status !== "blocked" && observed.interactiveReady && !observed.launchPending) {
          pendingInput.delete(identity);
          try {
            observed = await submitInput(task, context, observed, pending.prompt, signal);
          } catch (error) {
            if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") pendingInput.set(identity, pending);
            throw error;
          }
        } else if (pending === undefined && (observed.status === "idle" || observed.status === "done") && observed.interactiveReady && !observed.launchPending && lastInput.get(identity) !== inputState(observed)) {
          observed = await submitInput(task, context, observed, workerPingPrompt(task), signal);
        }
        assertNativeSession(task, observed);
        if (observed.nativeSession !== null) task = deps.store.setSessionId(task, observed.nativeSession.sessionId);
        reportObservation(task, observed);
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
      lastInput.set(key(task), null);
      let observation: HerdrAgentObservation;
      try {
        observation = await workerOperation((operation) => deps.herdr.tasks.start(context, binding, {
          configuration: input.configuration, prompt,
          ...(assignment.sessionId === null ? {} : { resumeSessionId: assignment.sessionId }),
        }, operation), signal);
      } catch (error) {
        if (!(error instanceof HerdrAgentActionError) || error.action !== "agent.prompt" || error.promptSubmission !== "not-submitted") throw error;
        observation = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding, operation), signal);
        assertNativeSession(task, observation);
        pendingInput.set(key(task), { binding, prompt });
        lastInput.delete(key(task));
      }
      assertNativeSession(task, observation);
      if (!pendingInput.has(key(task))) lastInput.set(key(task), inputState(observation));
      if (observation.nativeSession !== null) task = deps.store.setSessionId(task, observation.nativeSession.sessionId);
      reportObservation(task, observation, true);
      return observation;
    },
  };
};
