import { ConfigurationAdmissionWaiting, assertConfigurationAdmission } from "./configuration-admission.js";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { readTaskPaused, readWorkerClaim } from "../../api/task-properties.js";
import type { TaskPlatform } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import { HerdrInputWaitingError, LegacyBindingUnavailableError } from "./herdr/agents.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrPromptGuard, HerdrTaskBinding, WorkerHerdrAdapter } from "./herdr.js";
import type { WorkerRemote } from "./remote.js";
import type { ManagedAssignment } from "./prompts.js";
import { appendWorkerPrompts, workerContinuationPrompt, workerPingPrompt } from "./prompts.js";
import type { WorkerPromptTuple } from "./prompt-source.js";
import { PromptInputLimitError } from "./prompt-input-limit.js";
import { validateHerdrPromptInput } from "./herdr/rpc.js";
import { validateMacosPromptInput } from "./herdr/terminal-input.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";
import type { CleanupTarget } from "./execution-stop.js";
import type { createWorkerGitManager } from "./worktrees.js";
import { WorktreeRestoreRequiredError } from "./worktrees.js";
import { managedNamespace, sameWorktreeLocation } from "./worktrees/paths.js";
import path from "node:path";
import { lstat } from "node:fs/promises";

export type WorkerEvent = { kind: string; message: string; projectId?: string; task?: LocalTask; identity?: CleanupTarget; component?: string; phase?: string; attemptId?: string; runKey?: string; error?: unknown };
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
export type ExecutionInput = { task: LocalTask; project: WorkerProject; owner: ResourceOwner; title: string; configuration: ExecutionConfiguration; freshClaim?: boolean; canAdmitNewExecution?: () => boolean; onBeforeStart?: () => void };
export type ExecutionAdvance = { kind: "observed"; observation: HerdrAgentObservation } | { kind: "waiting_input"; reason: "prompt_unknown" | "prompt_too_large" | "configuration_pending"; observation: HerdrAgentObservation | null };
export type WorkerObservedPhase =
  | { kind: "execution"; phase: "observation" | "worktree-preparation" | "agent-start" | "agent-observation" | "input-submission" | "preparing" | "executing" | "verifying" | "completing" | "waiting" | "paused" }
  | { kind: "cleanup"; phase: "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal" };
export type WorkerPhaseObserver = (identity: ClaimIdentity, phase: WorkerObservedPhase, progressed: boolean, deadlineAt?: number, operationKey?: string) => void;
export const observeWorkerPhase = (observer: WorkerPhaseObserver | undefined, identity: ClaimIdentity, phase: WorkerObservedPhase, progressed: boolean, deadlineAt?: number, operationKey?: string): void => {
  // Monitoring must not change the result, cancellation or resource ownership of the original operation.
  try { if (operationKey === undefined) observer?.(identity, phase, progressed, deadlineAt); else observer?.(identity, phase, progressed, deadlineAt, operationKey); } catch { /* The owning operation continues independently. */ }
};
class PromptInputWaiting extends Error {
  constructor(readonly reason: "prompt_unknown" | "prompt_too_large") { super(reason); }
}
export type ExecutionDependencies = {
  store: WorkerStore;
  git: WorkerGitManager;
  herdr: WorkerHerdrAdapter;
  readTask: WorkerRemote["readTask"];
  platform: TaskPlatform;
  workerId: string;
  serverOrigin: string;
  buildPrompt: (assignment: ManagedAssignment, platform: TaskPlatform) => string;
  promptSource?: { current(projectId: string): WorkerPromptTuple | null };
  preparePromptSource?: (projectId: string, signal?: AbortSignal) => Promise<void>;
  observePhase?: WorkerPhaseObserver;
  observeSuccess?: (identity: ClaimIdentity, phase: Extract<WorkerObservedPhase, { kind: "execution" }>, operationKey?: string) => void;
  emit: (event: WorkerEvent) => void;
  now: () => number;
};
export const isWorkerCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((failure) => isWorkerCancellation(failure, signal))
    && (error.cause === undefined || isWorkerCancellation(error.cause, signal));
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
  const matches = resources.filter((resource) => sameClaim(resource.owner, owner));
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
export const executionContext = (input: Pick<ExecutionInput, "owner"> & { task: Pick<LocalTask, "agent"> }, cwd: string): HerdrExecutionContext => ({
  ...input.owner, cwd, agent: input.task.agent,
});
export const newWorktreePath = (project: WorkerProject, owner: ResourceOwner): string => path.join(managedNamespace(project.localPath), owner.worktreeId);
export const originalWorktreePath = async (project: WorkerProject, owner: ResourceOwner, cwd: string | null): Promise<string> => {
  if (cwd !== null && [owner.taskId, owner.worktreeId].some(name => cwd === path.join(managedNamespace(project.localPath), name))) return cwd;
  if (cwd === null || !(await Promise.all([owner.taskId, owner.worktreeId].map(name => sameWorktreeLocation(cwd, path.join(managedNamespace(project.localPath), name))))).some(Boolean)) throw new Error("The original execution has no matching worktree path.");
  return cwd;
};
export const settleWorkerStops = async (deps: Pick<ExecutionDependencies, "herdr">, owner: ResourceOwner, signal?: AbortSignal, runOperation = workerOperation): Promise<boolean> => {
  const pending = deps.herdr.tasks.pendingStops().filter((stop) => sameClaim(stop.context, owner));
  for (const stop of pending) {
    if (stop.context.worktreeId !== owner.worktreeId) throw new Error("The claim has conflicting pending Herdr stop identities.");
    await runOperation((operation) => deps.herdr.tasks.stopAndClose(stop.context, stop.binding, operation), signal);
  }
  return pending.length > 0;
};
const assertNativeSession = (task: LocalTask, observation: HerdrAgentObservation): void => {
  if (task.sessionId !== null && observation.nativeSession !== null && observation.nativeSession.sessionId !== task.sessionId) throw new Error(`The observed native session ${observation.nativeSession.sessionId} differs from the recorded native session ${task.sessionId}.`);
};

export const createExecutionDriver = (deps: ExecutionDependencies) => {
  const success = (identity: ClaimIdentity, phase: Extract<WorkerObservedPhase, { kind: "execution" }>["phase"], operationKey?: string): void => {
    try { if (operationKey === undefined) deps.observeSuccess?.(identity, { kind: "execution", phase }); else deps.observeSuccess?.(identity, { kind: "execution", phase }, operationKey); } catch { /* Monitoring cannot change the operation result. */ }
  };
  const pendingInput = new Map<string, { binding: HerdrTaskBinding; prompt: string; continuation: boolean }>();
  const lastInput = new Map<string, string | null>();
  const observations = new Map<string, string>();
  const progressObservations = new Map<string, string>();
  const preparedWorktrees = new Set<string>();
  const rejected = new Map<string, string>();
  const key = (task: Pick<LocalTask, "projectId" | "taskId" | "claimId">): string => `${task.projectId}/${task.taskId}/${task.claimId}`;
  const promptSignature = (tuple: WorkerPromptTuple, configuration: ExecutionConfiguration, binding: HerdrTaskBinding, kind: "startup" | "ping" | "recovery"): string => JSON.stringify([[tuple.user.revision, tuple.project.revision, tuple.worker.revision], configuration, deps.platform, binding.paneId, kind]);
  const preparePromptValue = (task: LocalTask, configuration: ExecutionConfiguration, binding: HerdrTaskBinding, kind: "startup" | "ping" | "recovery", builtin: () => string): string => {
    if (deps.promptSource === undefined) return builtin();
    const tuple = deps.promptSource.current(task.projectId);
    if (tuple === null) throw new PromptInputWaiting("prompt_unknown");
    const identity = key(task);
    const revisions = [tuple.user.revision, tuple.project.revision, tuple.worker.revision];
    const signature = promptSignature(tuple, configuration, binding, kind);
    if (rejected.get(identity) === signature) throw new PromptInputWaiting("prompt_too_large");
    const prompt = appendWorkerPrompts(builtin(), tuple);
    try {
      if (deps.platform === "macos") validateMacosPromptInput(prompt);
      else validateHerdrPromptInput(binding.paneId, prompt);
    } catch (error) {
      if (!(error instanceof PromptInputLimitError)) throw error;
      rejected.set(identity, signature);
      deps.emit({ kind: "waiting", task, message: JSON.stringify({ reason: "prompt_too_large", inputPath: error.inputPath, actualBytes: error.actualBytes, maxBytes: error.maxBytes, revisions }) });
      throw new PromptInputWaiting("prompt_too_large");
    }
    rejected.delete(identity);
    return prompt;
  };
  const preparePrompt = (task: LocalTask, configuration: ExecutionConfiguration, binding: HerdrTaskBinding, kind: "startup" | "ping" | "recovery", builtin: () => string): string => {
    const operationKey = `prompt-${kind}`;
    observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "preparing" }, false, undefined, operationKey);
    const result = preparePromptValue(task, configuration, binding, kind, builtin);
    success(task, "preparing", operationKey);
    return result;
  };
  const prepareBuiltin = (task: LocalTask, builtin: () => string): string => {
    observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "preparing" }, false, undefined, "prompt-startup");
    const result = builtin();
    success(task, "preparing", "prompt-startup");
    return result;
  };
  const prepareSource = async (task: LocalTask, signal?: AbortSignal): Promise<void> => {
    if (deps.preparePromptSource === undefined) return;
    observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "preparing" }, false, undefined, "prompt-source");
    await deps.preparePromptSource(task.projectId, signal);
    success(task, "preparing", "prompt-source");
  };
  const inputState = (observation: HerdrAgentObservation): string => {
    const { session, workspaceId, paneId, terminalId } = observation.binding;
    return JSON.stringify([session, workspaceId, paneId, terminalId, observation.status, observation.stateChangeSeq, observation.completionSeq]);
  };
  const continuationGuard = (task: LocalTask, context: HerdrExecutionContext): HerdrPromptGuard => async (operation) => {
    const remote = await deps.readTask(task.projectId, task.taskId, operation.signal);
    const paused = readTaskPaused(remote.properties);
    const claim = readWorkerClaim(remote.properties);
    const current = deps.store.getTask(task);
    return paused !== true && remote.projectId === task.projectId && remote.id === task.taskId
      && claim !== undefined && claim.state === "active" && claim.claimId === task.claimId
      && claim.workerId === deps.workerId && claim.worktreeId === context.worktreeId
      && claim.agent === task.agent && claim.agentControlMode === (task.agentControlMode ?? "herdr")
      && current !== null && current.status === "active";
  };
  const submitInput = async (task: LocalTask, context: HerdrExecutionContext, observed: HerdrAgentObservation, prompt: string, signal?: AbortSignal, beforeSubmit?: HerdrPromptGuard, initialOnly = false, operationKey?: string): Promise<{ observation: HerdrAgentObservation; submitted: boolean }> => {
    const identity = key(task);
    observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "input-submission" }, false, undefined, operationKey);
    let transportCompleted = false;
    const onTransportCompleted = (): void => {
      transportCompleted = true;
      success(task, "input-submission", operationKey);
      observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "input-submission" }, true, undefined, operationKey);
      observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "agent-observation" }, false);
    };
    const receipt = await workerOperation((operation) => initialOnly
      ? deps.herdr.tasks.submitInitialPrompt(context, observed.binding, prompt, operation, beforeSubmit, onTransportCompleted)
      : deps.herdr.tasks.submitPrompt(context, observed.binding, prompt, operation, beforeSubmit, onTransportCompleted), signal).catch((error: unknown) => {
      if (error instanceof HerdrInputWaitingError) { /* A zero-write wait preserves the previous input baseline. */ }
      else if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") lastInput.delete(identity);
      else lastInput.set(identity, null);
      throw error;
    });
    if (receipt.submission === "skipped") return { observation: receipt.observation, submitted: false };
    if (!transportCompleted) {
      success(task, "input-submission", operationKey);
      observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "input-submission" }, true, undefined, operationKey);
    }
    lastInput.set(identity, inputState(receipt.observation));
    observeWorkerPhase(deps.observePhase, task, { kind: "execution", phase: "agent-observation" }, false);
    const current = await workerOperation((operation) => deps.herdr.tasks.observe(context, observed.binding, operation, () => success(task, "preparing", "herdr-attachment")), signal);
    if (task.sessionId === null || current.nativeSession === null || current.nativeSession.sessionId === task.sessionId) success(task, "agent-observation");
    return { observation: current, submitted: true };
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
      message: pending ? pendingInput.get(identity)!.continuation ? "The recovery input is waiting in this worker process; use daynight worker attach to resolve the native screen." : "The first managed input is waiting in this worker process; use daynight worker attach to resolve the native screen."
        : blocked ? "The native agent is waiting for input; use daynight worker attach."
        : started ? "Started the managed task conversation."
        : "Connected to the existing agent without repeating its managed assignment.",
    });
  };
  return {
    forget: (task: LocalTask): void => { pendingInput.delete(key(task)); lastInput.delete(key(task)); observations.delete(key(task)); progressObservations.delete(key(task)); preparedWorktrees.delete(key(task)); rejected.delete(key(task)); },
    advance: (input: ExecutionInput, signal?: AbortSignal): Promise<ExecutionAdvance> => (async (): Promise<ExecutionAdvance> => {
      let task = deps.store.getTask(input.task);
      if (task === null || task.status !== "active") throw new Error("Resource startup requires an active local claim.");
      const identity = key(task);
      const original = await workerOperation(operation => deps.git.resolveWorktreeBinding(input.project, input.owner, operation), signal);
      observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "observation" }, false);
      await settleWorkerStops(deps, input.owner, signal);
      const resources = await workerOperation((operation) => deps.herdr.tasks.listResources(operation), signal);
      let actual = actualTaskPane(input.owner, resources);
      const lifecycleCwd = deps.herdr.lifecycle?.worktreePath?.(input.owner) ?? null;
      if (actual !== undefined && actual.cwd === null && lifecycleCwd === null && original === null) throw new Error("The original Herdr workspace has no worktree path evidence.");
      const savedCwd = lifecycleCwd ?? actual?.cwd ?? original?.worktreePath ?? newWorktreePath(input.project, input.owner);
      const originalCwd = lifecycleCwd ?? actual?.cwd ?? original?.worktreePath ?? undefined;
      const cwd = await originalWorktreePath(input.project, input.owner, savedCwd);
      if (original !== null && !await sameWorktreeLocation(cwd, original.worktreePath)) throw new Error("The original execution path differs from its manifest.");
      const context = executionContext({ ...input, task }, cwd);
      const originallySubmitted = task.sessionId !== null || deps.herdr.lifecycle?.hasSubmittedExecution?.(input.owner) === true || actual !== undefined && liveAgent(actual);
      const canAdmitNewExecution = () => originallySubmitted || (input.canAdmitNewExecution?.() ?? true);
      deps.herdr.lifecycle?.assertCanAdvance(context);
      let checkoutMissing = false;
      let legacyStopped = false;
      try { await lstat(cwd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; checkoutMissing = true; }
      const requireExistingBranch = task.sessionId !== null || actual !== undefined || deps.herdr.lifecycle?.hasStarted?.(input.owner) === true;
      const stopForRestore = async (): Promise<void> => {
        if (!(actual !== undefined || deps.herdr.lifecycle?.hasStarted?.(input.owner) === true && !deps.herdr.lifecycle.isStopped(input.owner))) return;
        if (deps.herdr.lifecycle !== undefined) {
          await workerOperation(operation => deps.herdr.lifecycle!.stop(input.owner, "shutdown", operation), signal);
          if (!deps.herdr.lifecycle.isStopped(input.owner)) throw new Error("The original Herdr execution has not stopped; its worktree cannot be restored.");
          deps.herdr.lifecycle.assertCanAdvance(context);
        } else if (actual !== undefined) {
          await workerOperation(operation => deps.herdr.tasks.stopAndClose(context, actual!.binding, operation), signal);
          await settleWorkerStops(deps, input.owner, signal);
        }
        actual = actualTaskPane(input.owner, await workerOperation(operation => deps.herdr.tasks.listResources(operation), signal));
        if (actual !== undefined) throw new Error("The original Herdr workspace still exists; its worktree cannot be restored.");
      };
      if (checkoutMissing) await stopForRestore();
      const observeLegacyStop = async (): Promise<void> => {
        if (actual !== undefined || deps.herdr.lifecycle !== undefined) return;
        const stop = await workerOperation(operation => deps.herdr.tasks.observeExecutionStop(input.owner, operation), signal);
        if (stop.kind !== "stopped" && stop.kind !== "not-started" && !(stop.kind === "unknown" && stop.error instanceof LegacyBindingUnavailableError)) throw new Error("The original Herdr execution stop is unconfirmed; its worktree cannot be restored.", stop.kind === "unknown" ? { cause: stop.error } : undefined);
        legacyStopped = true;
      };
      await observeLegacyStop();
      success(input.owner, "observation");
      observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "worktree-preparation" }, false);
      const allowRestore = () => actual === undefined && (deps.herdr.lifecycle === undefined ? legacyStopped : !(deps.herdr.lifecycle.hasStarted?.(input.owner) === true && !deps.herdr.lifecycle.isStopped(input.owner)));
      const prepare = () => workerOperation((operation) => deps.git.prepareWorktree(input.project, input.owner, operation, originalCwd, requireExistingBranch, undefined, allowRestore()), signal, 180_000);
      let worktree;
      try { worktree = await prepare(); }
      catch (error) {
        if (!(error instanceof WorktreeRestoreRequiredError) || allowRestore()) throw error;
        await stopForRestore();
        await observeLegacyStop();
        if (!allowRestore()) throw error;
        worktree = await prepare();
      }
      if (!await sameWorktreeLocation(worktree.worktreePath, context.cwd)) throw new Error("The prepared worktree differs from the original execution binding.");
      success(input.owner, "worktree-preparation");
      if (task.sessionId === null && !preparedWorktrees.has(identity)) {
        preparedWorktrees.add(identity);
        observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "worktree-preparation" }, true);
      }
      if (actual !== undefined && liveAgent(actual)) {
        input.onBeforeStart?.();
        observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, false);
        let observed = await workerOperation((operation) => deps.herdr.tasks.observe(context, actual!.binding, operation, () => success(input.owner, "preparing", "herdr-attachment")), signal);
        assertNativeSession(task, observed);
        success(input.owner, "agent-observation");
        const observedState = inputState(observed);
        if (progressObservations.get(identity) !== observedState) {
          progressObservations.set(identity, observedState);
          observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, true);
        }
        // A prompt ACK precedes native input consumption. Retain its observed turn
        // until native progress makes another continuation a new decision.
        if (lastInput.has(identity) && lastInput.get(identity) === null) lastInput.set(identity, inputState(observed));
        if (observed.status === "working") lastInput.delete(identity);
        let pending = pendingInput.get(identity);
        if (pending === undefined) {
          const initialPrompt = deps.herdr.lifecycle?.pendingInitialPrompt?.(input.owner);
          if (initialPrompt != null) {
            pending = { binding: actual.binding, prompt: initialPrompt, continuation: false };
          }
        }
        if (pending !== undefined && pending.binding.terminalId === actual.binding.terminalId && pending.binding.paneId === actual.binding.paneId && observed.status !== "blocked" && observed.interactiveReady && !observed.launchPending) {
          try {
            const initialOnly = !pending.continuation && (deps.herdr.lifecycle !== undefined || input.configuration.toolLaunch !== undefined);
            const result = await submitInput(task, context, observed, pending.prompt, signal, pending.continuation ? continuationGuard(task, context) : undefined, initialOnly, pending.continuation ? undefined : "startup-input");
            observed = result.observation;
            if (result.submitted || initialOnly) {
              pendingInput.delete(identity);
              if (!result.submitted) lastInput.set(identity, inputState(observed));
            }
          } catch (error) {
            if (!(error instanceof HerdrAgentActionError) || error.promptSubmission !== "not-submitted") pendingInput.delete(identity);
            throw error;
          }
        } else if (pending === undefined && (observed.status === "idle" || observed.status === "done") && observed.interactiveReady && !observed.launchPending && lastInput.get(identity) !== inputState(observed)) {
          await prepareSource(task, signal);
          let prompt: string;
          try { prompt = preparePrompt(task, input.configuration, observed.binding, "ping", () => workerPingPrompt(task!)); }
          catch (error) {
            if (!(error instanceof PromptInputWaiting)) throw error;
            if (observed.nativeSession !== null) deps.store.setSessionId(task, observed.nativeSession.sessionId);
            observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
            return { kind: "waiting_input", reason: error.reason, observation: observed };
          }
          observed = (await submitInput(task, context, observed, prompt, signal, continuationGuard(task, context))).observation;
        }
        assertNativeSession(task, observed);
        if (observed.nativeSession !== null) task = deps.store.setSessionId(task, observed.nativeSession.sessionId);
        reportObservation(task, observed);
        if (observed.status === "blocked") observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
        return { kind: "observed", observation: observed };
      }
      if (deps.herdr.lifecycle === undefined && deps.promptSource !== undefined && deps.preparePromptSource === undefined) {
        const tuple = deps.promptSource.current(task.projectId);
        if (tuple === null) { observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false); return { kind: "waiting_input", reason: "prompt_unknown", observation: null }; }
        if (actual !== undefined && rejected.get(identity) === promptSignature(tuple, input.configuration, actual.binding, "startup")) { observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false); return { kind: "waiting_input", reason: "prompt_too_large", observation: null }; }
      }
      if (actual === undefined && deps.herdr.lifecycle === undefined) success(input.owner, "observation", "resource-stop");
      if (actual !== undefined && !deps.herdr.lifecycle?.hasPreparedRun(input.owner)) {
        // Cold restore drops workspace environment overrides and retains the old native reference.
        // A fresh workspace restores native XDG settings and observes only the new launch's SessionStart.
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L568-L580
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L687-L713
        observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "observation" }, false, undefined, "resource-stop");
        await workerOperation((operation) => deps.herdr.lifecycle
          ? deps.herdr.lifecycle.stop(input.owner, "shutdown", operation)
          : deps.herdr.tasks.stopAndClose(context, actual!.binding, operation), signal);
        success(input.owner, "observation", "resource-stop");
      }
      observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-start" }, false, undefined, "workspace-preparation");
      assertConfigurationAdmission(canAdmitNewExecution);
      const binding = await workerOperation((operation) => deps.herdr.tasks.prepareWorkspace(context, input.title, operation, { canAdmitNewExecution }), signal);
      success(input.owner, "agent-start", "workspace-preparation");
      if (deps.herdr.lifecycle === undefined) await prepareSource(task, signal);
      if (task.sessionId === null) deps.emit({ kind: "info", task, message: "Starting a new native conversation in the task worktree." });
      const assignment: ManagedAssignment = { ...task, serverOrigin: deps.serverOrigin, workerId: deps.workerId, worktreeId: input.owner.worktreeId, worktree: { ...worktree, worktreePath: context.cwd }, configuration: input.configuration };
      let prompt: string;
      try { prompt = deps.herdr.lifecycle === undefined
        ? preparePrompt(task, input.configuration, binding, "startup", () => deps.buildPrompt(assignment, deps.platform))
        : prepareBuiltin(task, () => deps.buildPrompt(assignment, deps.platform)); }
      catch (error) {
        if (!(error instanceof PromptInputWaiting)) throw error;
        observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
        return { kind: "waiting_input", reason: error.reason, observation: null };
      }
      pendingInput.set(identity, { binding, prompt, continuation: false });
      lastInput.delete(identity);
      let observation: HerdrAgentObservation;
      let observedAfterInput = false;
      let observedExistingAgent = false;
      let startupTransportCompleted = false;
      observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-start" }, false);
      try {
        assertConfigurationAdmission(canAdmitNewExecution);
        input.onBeforeStart?.();
        observation = await workerOperation((operation) => deps.herdr.tasks.start(context, binding, {
          configuration: input.configuration, prompt, canAdmitNewExecution,
          ...(deps.herdr.lifecycle === undefined ? {} : { preparePrompt: (recovery: boolean) => {
            return preparePrompt(task!, input.configuration, binding, recovery ? "recovery" : "startup", () => recovery ? workerContinuationPrompt(task!) : deps.buildPrompt(assignment, deps.platform));
          }, ...(deps.preparePromptSource === undefined ? {} : { preparePromptSource: (operation: Operation) => prepareSource(task!, operation.signal) }),
          onPromptPrepared: (prepared: string, recovery: boolean) => { pendingInput.set(identity, { binding, prompt: prepared, continuation: recovery }); observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-start" }, false); } }),
          ...(assignment.sessionId === null ? {} : { resumeSessionId: assignment.sessionId }),
          onAgentStarted: () => { success(input.owner, "agent-start"); observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-start" }, true); },
          onAgentInitializing: () => observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "preparing" }, false, undefined, "herdr-attachment"),
          onAgentInitialized: () => success(input.owner, "preparing", "herdr-attachment"),
          onPromptSubmitting: () => observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "input-submission" }, false, undefined, "startup-input"),
          onPromptTransportCompleted: () => { startupTransportCompleted = true; success(input.owner, "input-submission", "startup-input"); observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "input-submission" }, true, undefined, "startup-input"); observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, false); },
          onExistingAgentObserved: () => { observedExistingAgent = true; observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, false); },
          onPromptSubmitted: (receipt) => { pendingInput.delete(identity); lastInput.set(identity, inputState(receipt.observation)); if (!startupTransportCompleted) { success(input.owner, "input-submission", "startup-input"); observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "input-submission" }, true, undefined, "startup-input"); } observedAfterInput = true; observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, false); },
        }, operation), signal);
        if (!deps.herdr.lifecycle) pendingInput.delete(identity);
      } catch (error) {
        if (error instanceof PromptInputWaiting) {
          pendingInput.delete(identity);
          observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
          return { kind: "waiting_input", reason: error.reason, observation: null };
        }
        if (error instanceof HerdrAgentActionError && error.action === "agent.prompt") observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "input-submission" }, false, undefined, "startup-input");
        if (pendingInput.has(identity) && error instanceof HerdrAgentActionError && error.action === "agent.prompt" && error.promptSubmission === "unknown") {
          pendingInput.delete(identity);
          lastInput.set(identity, null);
        }
        if (!(error instanceof HerdrAgentActionError) || error.action !== "agent.prompt" || error.promptSubmission !== "not-submitted") throw error;
        if (deps.herdr.lifecycle && !(error instanceof HerdrInputWaitingError)) throw error;
        observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "agent-observation" }, false);
        observation = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding, operation, () => success(input.owner, "preparing", "herdr-attachment")), signal);
        assertNativeSession(task, observation);
        success(input.owner, "agent-observation");
      }
      assertNativeSession(task, observation);
      if (observedAfterInput || observedExistingAgent) success(input.owner, "agent-observation");
      if (observation.nativeSession !== null) task = deps.store.setSessionId(task, observation.nativeSession.sessionId);
      progressObservations.set(identity, inputState(observation));
      reportObservation(task, observation, true);
      if (observation.status === "blocked") observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
      return { kind: "observed", observation };
    })().catch((error: unknown): ExecutionAdvance => {
      if (!(error instanceof ConfigurationAdmissionWaiting) || signal?.aborted) throw error;
      pendingInput.delete(key(input.task));
      observeWorkerPhase(deps.observePhase, input.owner, { kind: "execution", phase: "waiting" }, false);
      return { kind: "waiting_input", reason: "configuration_pending", observation: null };
    }),
  };
};
