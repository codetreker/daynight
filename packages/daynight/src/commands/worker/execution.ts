import path from "node:path";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { TaskPlatform, WorkerAgent } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import { buildHerdrAgentArguments } from "./herdr/arguments.js";
import type { HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, WorkerHerdrAdapter } from "./herdr.js";
import type { WorkerStore } from "./store.js";
import type { LocalTask } from "./types.js";
import type { createWorkerGitManager } from "./worktrees.js";

export type WorkerEvent = { kind: string; message: string; task?: LocalTask; error?: unknown };
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
export type ExecutionDependencies = {
  store: WorkerStore;
  git: WorkerGitManager;
  herdr: WorkerHerdrAdapter;
  platform: TaskPlatform;
  buildPrompt: (task: LocalTask, platform: TaskPlatform) => string;
  emit: (event: WorkerEvent) => void;
  now: () => number;
};
export const isWorkerCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  if (error instanceof AggregateError && error.errors.some((failure) => !isWorkerCancellation(failure, signal))) return false;
  return error === signal.reason ||
    (error instanceof OperationError && error.kind === "cancelled" && error.cause === signal.reason) ||
    (error instanceof Error && error.cause !== undefined && isWorkerCancellation(error.cause, signal));
};
export const workerOperation = async <T>(action: (operation: Operation) => Promise<T>, signal?: AbortSignal, totalMs = 120_000): Promise<T> => {
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs } });
  try { return await action(operation); } finally { operation.dispose(); }
};
export const executionContext = (task: LocalTask, agent?: WorkerAgent): HerdrExecutionContext => {
  const selected = task.configuration?.agent ?? agent;
  if (selected === undefined) throw new Error("The original native agent kind is unavailable; the execution was retained.");
  return { serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, worktreeId: task.worktreeId,
    cwd: task.resources.worktree?.worktreePath ?? path.join(task.repositoryPath, ".worktrees", "daynight", task.taskId), agent: selected };
};
export const taskBinding = (task: LocalTask): HerdrTaskBinding | null => {
  const binding = task.resources.herdr;
  const terminalId = task.nativeExecution?.terminalId;
  return binding === null || terminalId === null || terminalId === undefined ? null : { ...binding, terminalId };
};
export const ownedWorkspace = (task: LocalTask, resources: readonly HerdrOwnedWorkspace[]): HerdrOwnedWorkspace | undefined => resources.find(({ owner }) =>
  owner.serverOrigin === task.serverOrigin && owner.projectId === task.projectId && owner.taskId === task.taskId && owner.claimId === task.claimId && owner.worktreeId === task.worktreeId);
export const actualTaskPane = (task: LocalTask, resources: readonly HerdrOwnedWorkspace[]) => {
  const workspace = ownedWorkspace(task, resources);
  if (workspace === undefined) return undefined;
  const binding = task.resources.herdr;
  if (binding !== null && workspace.workspaceId === binding.workspaceId) return workspace.panes.find((pane) => pane.binding.paneId === binding.paneId);
  if (workspace.panes.length !== 1) throw new Error("The original task workspace has ambiguous panes; it was retained.");
  return workspace.panes[0];
};
const sameBinding = (left: HerdrTaskBinding, right: HerdrTaskBinding): boolean => left.session === right.session && left.workspaceId === right.workspaceId && left.paneId === right.paneId && left.terminalId === right.terminalId;
const live = (observation: { kind: string | null; launchPending: boolean; interactiveReady: boolean }): boolean => observation.kind !== null || observation.launchPending || observation.interactiveReady;

export const createExecutionDriver = (deps: ExecutionDependencies) => {
  const refresh = (task: LocalTask): LocalTask => {
    const current = deps.store.getTask(task);
    if (current === null) throw new Error("The local execution record disappeared.");
    return current;
  };
  const rememberStop = async (task: LocalTask, binding: HerdrTaskBinding, signal?: AbortSignal): Promise<void> => {
    if (task.nativeExecution?.stopObservation !== null && task.nativeExecution?.stopObservation !== undefined) return;
    try {
      const observation = await workerOperation((operation) => deps.herdr.tasks.captureStop(executionContext(task), binding, operation), signal);
      deps.store.recordStopObservation(task, observation, deps.now());
    } catch (error) {
      deps.emit({ kind: "stop-observation-unavailable", task, message: "Original native process identities are not yet available; cold recovery remains fenced.", error });
    }
  };
  const rememberNative = (task: LocalTask, nativeSession: { sessionId: string } | null): LocalTask => nativeSession === null ? refresh(task) : deps.store.bindNativeSession(task, { source: "herdr", sessionId: nativeSession.sessionId }, deps.now());
  const prepareWorkspace = async (task: LocalTask, signal?: AbortSignal) => {
    deps.store.markWorkspaceSubmitting(task, deps.now());
    try { return await workerOperation((operation) => deps.herdr.tasks.prepareWorkspace(executionContext(task), operation), signal); }
    catch (error) {
      if (error instanceof HerdrAgentActionError && error.action === "workspace.create" && error.submission !== "unknown") deps.store.recordWorkspaceNotSubmitted(task, error.submission === "rejected" ? { definiteRejection: true } : { notSubmitted: true }, deps.now());
      throw error;
    }
  };
  const rebind = async (task: LocalTask, actual: HerdrTaskBinding | null, signal?: AbortSignal): Promise<LocalTask> => {
    const original = taskBinding(task);
    if (original === null) throw new Error("The original Herdr terminal identity is unavailable; recovery was paused.");
    const context = executionContext(task);
    if (task.nativeExecution?.workspaceSubmission === "unknown" && actual === null) throw new HerdrAgentActionError("The original replacement workspace request has an unknown outcome; absence does not authorize another creation.", "workspace.create", "unknown");
    const evidence = task.nativeExecution?.stopObservation;
    if (task.nativeExecution?.launchSubmission === "never-submitted") {
      if (actual !== null) await workerOperation((operation) => deps.herdr.tasks.confirmEmptyPane(context, actual, operation), signal);
    } else {
      if (evidence === null || evidence === undefined) throw new Error("The original persisted native stop observation is missing; recovery cannot infer that the agent stopped.");
      if (actual === null) await workerOperation((operation) => deps.herdr.tasks.confirmMissingWorkspaceStopped(context, original, evidence, operation), signal);
      else if (sameBinding(original, actual)) await workerOperation((operation) => deps.herdr.tasks.confirmStopped(context, original, evidence, operation), signal);
      else if (original.workspaceId !== actual.workspaceId || original.paneId !== actual.paneId) await workerOperation((operation) => deps.herdr.tasks.confirmReplacedStop(context, original, actual, evidence, operation), signal);
      else await workerOperation((operation) => deps.herdr.tasks.confirmRestoredStop(context, original, actual, evidence, operation), signal);
    }
    if (task.nativeExecution?.workspaceSubmission === "unknown") {
      // The exact observed replacement establishes the previous create outcome. Its
      // environment receipt is unavailable, so a subsequent empty-pane rebind replaces it.
      return deps.store.rebindHerdrExecution(task, original, actual!, null, { originalAgentStopped: true, oldWorkspaceClosed: true }, deps.now());
    }
    await workerOperation((operation) => deps.herdr.tasks.closeWorkspace(context, actual === null ? original : actual, { agentStopped: true }, operation), signal);
    const prepared = await prepareWorkspace(task, signal);
    return deps.store.rebindHerdrExecution(task, original, prepared.binding, prepared.workspaceEvidence, { originalAgentStopped: true, oldWorkspaceClosed: true }, deps.now());
  };
  return {
    advance: async (input: LocalTask, resources: readonly HerdrOwnedWorkspace[], signal?: AbortSignal): Promise<LocalTask> => {
      let task = refresh(input);
      if (task.cleanup !== null || task.control !== null) throw new Error("Cleanup or source management prevents ordinary execution.");
      if (task.configuration === null) throw new Error("The original frozen execution configuration is missing; restore it before retrying.");
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized && (task.resources.worktree === null || task.resources.herdr === null)) return task;
      if (task.status !== "active") throw new Error("Only an active execution may prepare resources.");
      const original = actualTaskPane(task, resources);
      if (task.resources.nativeSession === null && task.nativeExecution?.launchSubmission !== "never-submitted") {
        if (original === undefined || (!live(original) && original.nativeSession === null)) throw new Error("The original native session ID is missing; recover its exact history identity before preparing replacement resources.");
        if (original.nativeSession !== null && task.resources.herdr !== null) task = rememberNative(task, original.nativeSession);
      }
      if (task.resources.worktree === null) {
        const binding = task.nativeExecution?.launchSubmission === "never-submitted"
          ? await workerOperation((operation) => deps.git.prepareWorktree(task, operation), signal, 180_000)
          : await workerOperation((operation) => deps.git.findWorktree(task, operation), signal);
        if (binding === null) throw new Error("The original native launch provenance and owned worktree are unavailable; a fresh worktree cannot substitute for recovery.");
        task = deps.store.bindWorktree(task, binding, deps.now());
      } else await workerOperation((operation) => deps.git.verifyWorktree(task, operation), signal);
      const actual = actualTaskPane(task, resources);
      if (actual?.nativeSession !== undefined && actual.nativeSession !== null && task.resources.nativeSession !== null && actual.nativeSession.sessionId !== task.resources.nativeSession.sessionId) throw new Error("The actual native history differs from the original execution; its resources were retained.");
      let binding = taskBinding(task);
      if (binding === null) {
        if (task.resources.herdr !== null) throw new Error("The original Herdr terminal identity is missing; an existing binding cannot be guessed.");
        if (actual !== undefined) {
          task = deps.store.bindHerdrExecution(task, actual.binding, null, deps.now());
          binding = actual.binding;
        } else {
          if (task.nativeExecution?.workspaceSubmission === "unknown") throw new HerdrAgentActionError("The original workspace creation has an unknown outcome; the absent snapshot does not authorize replay.", "workspace.create", "unknown");
          const prepared = await prepareWorkspace(task, signal);
          task = deps.store.bindHerdrExecution(task, prepared.binding, prepared.workspaceEvidence, deps.now());
          binding = prepared.binding;
        }
      } else if ((actual !== undefined && !sameBinding(binding, actual.binding)) || ownedWorkspace(task, resources) === undefined) {
        if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
        if (task.nativeExecution?.workspaceSubmission === "unknown" && actual === undefined) throw new HerdrAgentActionError("The original replacement workspace request is unresolved; the absent snapshot cannot authorize replay.", "workspace.create", "unknown");
        if (task.nativeExecution?.launchSubmission !== "never-submitted" && task.nativeExecution?.workspaceSubmission !== "unknown") {
          if (task.resources.nativeSession === null) throw new Error("The original native history identity is unavailable; missing Herdr resources do not authorize a new conversation.");
          task = deps.store.beginRecovery(task, deps.now());
        }
        task = await rebind(task, actual?.binding ?? null, signal);
        binding = taskBinding(task)!;
      }
      const context = executionContext(task);
      const before = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding!, operation), signal);
      task = rememberNative(task, before.nativeSession);
      if (live(before)) {
        await rememberStop(task, binding, signal);
        task = refresh(task);
        const native = task.nativeExecution;
        if (native?.launchSubmission === "acknowledged" && native.promptSubmission === "not-submitted" && native.launchEvidence !== null && before.status !== "blocked" && (task.recovery.pauseReason === null || task.recovery.retryAuthorized)) {
          if (task.recovery.retryAuthorized) task = deps.store.beginRecovery(task, deps.now());
          const originalNativeId = task.resources.nativeSession?.sessionId;
          const resumedArgv = originalNativeId === undefined ? null : [context.agent, ...buildHerdrAgentArguments(task.configuration!, originalNativeId)];
          const resumeSessionId = resumedArgv !== null && native.launchEvidence!.argv.length === resumedArgv.length && native.launchEvidence!.argv.every((argument, index) => argument === resumedArgv[index]) ? originalNativeId : undefined;
          const prompt = deps.buildPrompt(task, deps.platform);
          deps.store.markNativePromptSubmitting(task, deps.now());
          try {
            const outcome = await workerOperation((operation) => deps.herdr.tasks.start(context, binding!, { configuration: task.configuration!, prompt, initialPromptNotSubmitted: true, launchEvidence: native.launchEvidence!, workspaceEvidence: native.workspaceEvidence,
              ...(resumeSessionId === undefined ? {} : { resumeSessionId }) }, operation), signal);
            if (outcome.kind === "rebind-required") throw new Error(`The original deferred startup input is fenced: ${outcome.reason}.`);
            deps.store.recordNativeStartOutcome(task, { ...(outcome.launchEvidence === null ? {} : { launchEvidence: outcome.launchEvidence }), promptSubmission: outcome.promptSubmission }, deps.now());
            task = rememberNative(task, outcome.observation.nativeSession);
          } catch (error) {
            if (error instanceof HerdrAgentActionError) deps.store.recordNativeStartOutcome(task, { ...(error.launchEvidence === null ? {} : { launchEvidence: error.launchEvidence }), promptSubmission: error.promptSubmission === null ? "unknown" : error.promptSubmission }, deps.now());
            throw error;
          }
        }
        deps.emit({ kind: before.status === "blocked" ? "waiting" : "reconnected", task: refresh(task), message: before.status === "blocked" ? "The original agent is waiting for input; attach to its private Herdr session." : "Observed the original live agent without replaying its startup input." });
        return refresh(task);
      }
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
      const native = task.nativeExecution;
      if (native === null) throw new Error("The original native launch provenance is missing; a new launch would be unsafe.");
      if (native.launchSubmission !== "never-submitted") {
        if (task.resources.nativeSession === null) throw new Error("The original launch may have been submitted but its native history identity is unavailable; no second agent was started.");
        deps.store.beginRecovery(task, deps.now());
        task = refresh(task);
        task = await rebind(task, binding, signal);
        binding = taskBinding(task)!;
      } else if (native.workspaceEvidence === null) {
        task = await rebind(task, binding, signal);
        binding = taskBinding(task)!;
      }
      if (task.nativeExecution!.workspaceEvidence === null) {
        task = await rebind(task, binding, signal);
        binding = taskBinding(task)!;
      }
      if (task.recovery.retryAuthorized) task = deps.store.beginRecovery(task, deps.now());
      const prompt = deps.buildPrompt(task, deps.platform);
      deps.store.markNativeLaunchSubmitting(task, deps.now());
      try {
        const outcome = await workerOperation((operation) => deps.herdr.tasks.start(executionContext(task), binding, { configuration: task.configuration!, prompt,
          workspaceEvidence: task.nativeExecution!.workspaceEvidence, ...(task.resources.nativeSession === null ? {} : { resumeSessionId: task.resources.nativeSession.sessionId }) }, operation), signal);
        if (outcome.kind === "rebind-required") throw new Error(`The native launch was fenced: ${outcome.reason}.`);
        if (outcome.kind === "reconnected") throw new Error("An unexpected live agent was observed during a fresh launch; its input was retained.");
        deps.store.recordNativeStartOutcome(task, { ...(outcome.launchEvidence === null ? {} : { launchEvidence: outcome.launchEvidence }), promptSubmission: outcome.promptSubmission }, deps.now());
        task = rememberNative(task, outcome.observation.nativeSession);
        await rememberStop(task, binding, signal);
        deps.emit({ kind: outcome.kind === "waiting" ? "waiting" : "started", task: refresh(task), message: task.resources.nativeSession === null ? "Native launch acknowledged; waiting for the original agent." : "Managed startup input submitted to the original native conversation." });
        return refresh(task);
      } catch (error) {
        if (error instanceof HerdrAgentActionError) {
          if (error.action === "agent.start" && error.submission !== "unknown" && error.launchEvidence === null && task.nativeExecution?.launchSubmission === "never-submitted") {
            deps.store.recordNativeLaunchNotSubmitted(task, error.submission === "rejected" ? { definiteRejection: true } : { notSubmitted: true }, deps.now());
          } else deps.store.recordNativeStartOutcome(task, { ...(error.launchEvidence === null ? {} : { launchEvidence: error.launchEvidence }), promptSubmission: error.promptSubmission === null ? "unknown" : error.promptSubmission }, deps.now());
        }
        throw error;
      }
    },
  };
};
