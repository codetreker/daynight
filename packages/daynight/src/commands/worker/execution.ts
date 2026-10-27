import path from "node:path";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { TaskPlatform, WorkerAgent } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import { buildHerdrAgentArguments } from "./herdr/arguments.js";
import { herdrExecutionLabel } from "./herdr/agents.js";
import type { HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, HerdrWorkspaceEvidence, WorkerHerdrAdapter } from "./herdr.js";
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
const sameWorkspaceEvidence = (left: HerdrWorkspaceEvidence, right: HerdrWorkspaceEvidence): boolean => sameBinding(left.binding, right.binding) && left.ownerLabel === right.ownerLabel && left.environment.XDG_CONFIG_HOME === right.environment.XDG_CONFIG_HOME && left.environment.XDG_STATE_HOME === right.environment.XDG_STATE_HOME;
const live = (observation: { kind: string | null; launchPending: boolean; interactiveReady: boolean }): boolean => observation.kind !== null || observation.launchPending || observation.interactiveReady;
const firstInputWaiting = "The original native launch is waiting before its first managed input; attach to its private session and retry after intervention.";

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
  const captureUnsentLaunch = async (task: LocalTask, binding: HerdrTaskBinding, signal?: AbortSignal): Promise<LocalTask> => {
    if (task.nativeExecution?.stopObservation !== null && task.nativeExecution?.stopObservation !== undefined) return task;
    const observed = await workerOperation((operation) => deps.herdr.tasks.captureStop(executionContext(task), binding, operation), signal);
    const recorded = deps.store.recordStopObservation(task, observed, deps.now());
    if (observed.nativeProcessIds === null) throw new Error("The original native launch has no proven native process identity; its first input remains unsubmitted.");
    return recorded;
  };
  const advanceUnsentInput = async (task: LocalTask, resources: readonly HerdrOwnedWorkspace[], signal?: AbortSignal): Promise<LocalTask> => {
    const native = task.nativeExecution!;
    const binding = taskBinding(task);
    const launch = native.launchEvidence;
    const workspace = native.workspaceEvidence;
    const actual = actualTaskPane(task, resources);
    const context = executionContext(task);
    const ownerLabel = herdrExecutionLabel(context);
    if (task.resources.worktree === null || binding === null || actual === undefined || !sameBinding(binding, actual.binding)) throw new Error("The acknowledged native launch no longer has its original worktree and terminal binding; no first input was sent.");
    if (launch === null || workspace === null || launch.referenceBaseline !== "empty" || launch.agent !== context.agent || launch.ownerLabel !== ownerLabel || workspace.ownerLabel !== ownerLabel || !sameBinding(launch.binding, binding) || !sameBinding(workspace.binding, binding) || !sameWorkspaceEvidence(workspace, launch.workspaceEvidence)) throw new Error("The acknowledged native launch receipt does not match the original execution; no first input was sent.");
    const matchesArgv = (expected: readonly string[]): boolean => launch.argv.length === expected.length && launch.argv.every((argument, index) => argument === expected[index]);
    let resumeSessionId: string | undefined;
    if (!matchesArgv([context.agent, ...buildHerdrAgentArguments(task.configuration!)])) {
      const originalId = task.resources.nativeSession?.sessionId;
      if (originalId === undefined || !matchesArgv([context.agent, ...buildHerdrAgentArguments(task.configuration!, originalId)])) throw new Error("The acknowledged native launch does not preserve its frozen invocation; no first input was sent.");
      resumeSessionId = originalId;
    }
    await workerOperation((operation) => deps.git.verifyWorktree(task, operation), signal);
    const before = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding, operation), signal);
    const original = native.stopObservation;
    if (original === null || original.nativeProcessIds === null || !sameBinding(original.binding, binding) || original.ownerLabel !== ownerLabel || original.agent !== context.agent) throw new Error("The original native launch process evidence is unavailable; no first input was sent.");
    const current = await workerOperation((operation) => deps.herdr.tasks.captureStop(context, binding, operation), signal);
    const currentNativeIds = current.nativeProcessIds;
    if (!sameBinding(current.binding, binding) || current.ownerLabel !== ownerLabel || current.agent !== context.agent || current.shellPid !== original.shellPid || currentNativeIds === null || !original.nativeProcessIds.every((processId) => currentNativeIds.includes(processId))) throw new Error("The original native launch is no longer executing in its original shell; no first input was sent.");
    const expectedSession = task.resources.nativeSession?.sessionId;
    if ((expectedSession !== undefined && before.nativeSession !== null && before.nativeSession.sessionId !== expectedSession) || (expectedSession !== undefined && current.nativeSessionId !== null && current.nativeSessionId !== expectedSession) || (original.nativeSessionId !== null && current.nativeSessionId !== null && original.nativeSessionId !== current.nativeSessionId)) throw new Error("The original native launch now reports a different conversation; no first input was sent.");
    task = rememberNative(task, before.nativeSession);
    if ((task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) || before.status === "blocked") {
      deps.emit({ kind: "waiting", task, message: "The original native launch is waiting before its first managed input; attach to its private session and retry the paused claim after intervention." });
      return task;
    }
    if (task.recovery.retryAuthorized) task = deps.store.beginRecovery(task, deps.now());
    const prompt = deps.buildPrompt(task, deps.platform);
    deps.store.markNativePromptSubmitting(task, deps.now());
    try {
      const outcome = await workerOperation((operation) => deps.herdr.tasks.start(context, binding, { configuration: task.configuration!, prompt, initialPromptNotSubmitted: true, launchEvidence: launch, workspaceEvidence: workspace, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) }, operation), signal);
      deps.store.recordNativeStartOutcome(task, { ...(outcome.launchEvidence === null ? {} : { launchEvidence: outcome.launchEvidence }), promptSubmission: outcome.promptSubmission }, deps.now());
      if (outcome.kind === "rebind-required") throw new Error(`The original deferred startup input is fenced: ${outcome.reason}.`);
      task = rememberNative(task, outcome.observation.nativeSession);
      if (outcome.promptSubmission === "not-submitted") task = deps.store.pauseTask(task, firstInputWaiting, deps.now());
      deps.emit({ kind: outcome.kind === "waiting" || outcome.promptSubmission === "not-submitted" ? "waiting" : "started", task, message: outcome.promptSubmission === "submitted" ? "The first managed input was submitted to the original native launch without starting another agent." : firstInputWaiting });
      return refresh(task);
    } catch (error) {
      if (error instanceof HerdrAgentActionError) deps.store.recordNativeStartOutcome(task, { ...(error.launchEvidence === null ? {} : { launchEvidence: error.launchEvidence }), promptSubmission: error.promptSubmission === null ? "unknown" : error.promptSubmission }, deps.now());
      throw error;
    }
  };
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
      if (task.nativeExecution?.launchSubmission === "acknowledged" && task.nativeExecution.promptSubmission === "not-submitted") return advanceUnsentInput(task, resources, signal);
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
        deps.emit({ kind: before.status === "blocked" ? "waiting" : "reconnected", task: refresh(task), message: before.status === "blocked" ? "The original agent is waiting for input; run daynight worker attach in another terminal." : "Observed the original live agent without replaying its startup input." });
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
        if (outcome.promptSubmission === "not-submitted") {
          task = await captureUnsentLaunch(task, binding, signal);
          task = deps.store.pauseTask(task, firstInputWaiting, deps.now());
        } else await rememberStop(task, binding, signal);
        deps.emit({ kind: outcome.kind === "waiting" ? "waiting" : "started", task: refresh(task), message: task.resources.nativeSession === null ? "Native launch acknowledged; waiting for the original agent." : "Managed startup input submitted to the original native conversation." });
        return refresh(task);
      } catch (error) {
        if (error instanceof HerdrAgentActionError) {
          if (error.action === "agent.start" && error.submission !== "unknown" && error.launchEvidence === null && task.nativeExecution?.launchSubmission === "never-submitted") {
            deps.store.recordNativeLaunchNotSubmitted(task, error.submission === "rejected" ? { definiteRejection: true } : { notSubmitted: true }, deps.now());
          } else {
            const recorded = deps.store.recordNativeStartOutcome(task, { ...(error.launchEvidence === null ? {} : { launchEvidence: error.launchEvidence }), promptSubmission: error.promptSubmission === null ? "unknown" : error.promptSubmission }, deps.now());
            if (recorded.nativeExecution?.launchSubmission === "acknowledged" && recorded.nativeExecution.promptSubmission === "not-submitted") {
              try { await captureUnsentLaunch(recorded, binding, signal); }
              catch (observationError) { throw new AggregateError([error, observationError], "The first input remains unsubmitted, but original native process observation failed.", { cause: error }); }
            }
          }
        }
        throw error;
      }
    },
  };
};
