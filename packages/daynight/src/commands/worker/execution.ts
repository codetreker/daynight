import path from "node:path";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { readTaskPaused, readWorkerClaim } from "../../api/task-properties.js";
import type { TaskPlatform } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import { HerdrInputWaitingError } from "./herdr/agents.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrPromptGuard, HerdrTaskBinding, WorkerHerdrAdapter } from "./herdr.js";
import type { WorkerRemote } from "./remote.js";
import type { ManagedAssignment } from "./prompts.js";
import { appendWorkerPrompts, workerPingPrompt } from "./prompts.js";
import type { WorkerPromptTuple } from "./prompt-source.js";
import { PromptInputLimitError } from "./prompt-input-limit.js";
import { validateHerdrPromptInput } from "./herdr/rpc.js";
import { validateMacosPromptInput } from "./herdr/terminal-input.js";
import type { WorkerStore } from "./store.js";
import type { ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";
import type { createWorkerGitManager } from "./worktrees.js";

export type WorkerEvent = { kind: string; message: string; task?: LocalTask; error?: unknown };
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
export type ExecutionInput = { task: LocalTask; project: WorkerProject; owner: ResourceOwner; title: string; configuration: ExecutionConfiguration };
export type ExecutionAdvance = { kind: "observed"; observation: HerdrAgentObservation } | { kind: "waiting_input"; reason: "prompt_unknown" | "prompt_too_large"; observation: HerdrAgentObservation | null };
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
export const executionContext = (input: Pick<ExecutionInput, "owner" | "project"> & { task: Pick<LocalTask, "agent"> }): HerdrExecutionContext => ({
  ...input.owner, cwd: path.join(input.project.localPath, ".worktrees", "daynight", input.owner.taskId), agent: input.task.agent,
});
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
  const pendingInput = new Map<string, { binding: HerdrTaskBinding; prompt: string; continuation: boolean }>();
  const lastInput = new Map<string, string | null>();
  const observations = new Map<string, string>();
  const rejected = new Map<string, string>();
  const key = (task: Pick<LocalTask, "projectId" | "taskId" | "claimId">): string => `${task.projectId}/${task.taskId}/${task.claimId}`;
  const promptSignature = (tuple: WorkerPromptTuple, configuration: ExecutionConfiguration, binding: HerdrTaskBinding, kind: "startup" | "ping" | "recovery"): string => JSON.stringify([[tuple.user.revision, tuple.project.revision, tuple.worker.revision], configuration, deps.platform, binding.paneId, kind]);
  const preparePrompt = (task: LocalTask, configuration: ExecutionConfiguration, binding: HerdrTaskBinding, kind: "startup" | "ping" | "recovery", builtin: () => string): string => {
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
  const submitInput = async (task: LocalTask, context: HerdrExecutionContext, observed: HerdrAgentObservation, prompt: string, signal?: AbortSignal, beforeSubmit?: HerdrPromptGuard): Promise<{ observation: HerdrAgentObservation; submitted: boolean }> => {
    const identity = key(task);
    const receipt = await workerOperation((operation) => deps.herdr.tasks.submitPrompt(context, observed.binding, prompt, operation, beforeSubmit), signal).catch((error: unknown) => {
      if (error instanceof HerdrInputWaitingError) { /* A zero-write wait preserves the previous input baseline. */ }
      else if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") lastInput.delete(identity);
      else lastInput.set(identity, null);
      throw error;
    });
    if (receipt.submission === "skipped") return { observation: receipt.observation, submitted: false };
    lastInput.set(identity, inputState(receipt.observation));
    return { observation: await workerOperation((operation) => deps.herdr.tasks.observe(context, observed.binding, operation), signal), submitted: true };
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
    forget: (task: LocalTask): void => { pendingInput.delete(key(task)); lastInput.delete(key(task)); observations.delete(key(task)); rejected.delete(key(task)); },
    advance: async (input: ExecutionInput, signal?: AbortSignal): Promise<ExecutionAdvance> => {
      let task = deps.store.getTask(input.task);
      if (task === null || task.status !== "active") throw new Error("Resource startup requires an active local claim.");
      const identity = key(task);
      const context = executionContext({ ...input, task });
      await settleWorkerStops(deps, input.owner, signal);
      deps.herdr.lifecycle?.assertCanAdvance(context);
      const resources = await workerOperation((operation) => deps.herdr.tasks.listResources(operation), signal);
      const actual = actualTaskPane(input.owner, resources);
      const worktree = task.sessionId === null
        ? await workerOperation((operation) => deps.git.prepareWorktree(input.project, input.owner, operation), signal, 180_000)
        : await workerOperation((operation) => deps.git.verifyWorktree(input.project, input.owner, operation), signal);
      if (actual !== undefined && liveAgent(actual)) {
        let observed = await workerOperation((operation) => deps.herdr.tasks.observe(context, actual.binding, operation), signal);
        assertNativeSession(task, observed);
        // A prompt ACK precedes native input consumption. Retain its observed turn
        // until native progress makes another continuation a new decision.
        if (lastInput.has(identity) && lastInput.get(identity) === null) lastInput.set(identity, inputState(observed));
        if (observed.status === "working") lastInput.delete(identity);
        const pending = pendingInput.get(identity);
        if (pending !== undefined && pending.binding.terminalId === actual.binding.terminalId && pending.binding.paneId === actual.binding.paneId && observed.status !== "blocked" && observed.interactiveReady && !observed.launchPending) {
          try {
            const result = await submitInput(task, context, observed, pending.prompt, signal, pending.continuation ? continuationGuard(task, context) : undefined);
            observed = result.observation;
            if (result.submitted) pendingInput.delete(identity);
          } catch (error) {
            if (!(error instanceof HerdrAgentActionError) || error.promptSubmission !== "not-submitted") pendingInput.delete(identity);
            throw error;
          }
        } else if (pending === undefined && (observed.status === "idle" || observed.status === "done") && observed.interactiveReady && !observed.launchPending && lastInput.get(identity) !== inputState(observed)) {
          await deps.preparePromptSource?.(task.projectId, signal);
          let prompt: string;
          try { prompt = preparePrompt(task, input.configuration, observed.binding, "ping", () => workerPingPrompt(task!)); }
          catch (error) {
            if (!(error instanceof PromptInputWaiting)) throw error;
            if (observed.nativeSession !== null) deps.store.setSessionId(task, observed.nativeSession.sessionId);
            return { kind: "waiting_input", reason: error.reason, observation: observed };
          }
          observed = (await submitInput(task, context, observed, prompt, signal, continuationGuard(task, context))).observation;
        }
        assertNativeSession(task, observed);
        if (observed.nativeSession !== null) task = deps.store.setSessionId(task, observed.nativeSession.sessionId);
        reportObservation(task, observed);
        return { kind: "observed", observation: observed };
      }
      if (deps.herdr.lifecycle === undefined && deps.promptSource !== undefined && deps.preparePromptSource === undefined) {
        const tuple = deps.promptSource.current(task.projectId);
        if (tuple === null) return { kind: "waiting_input", reason: "prompt_unknown", observation: null };
        if (actual !== undefined && rejected.get(identity) === promptSignature(tuple, input.configuration, actual.binding, "startup")) return { kind: "waiting_input", reason: "prompt_too_large", observation: null };
      }
      if (actual !== undefined && !deps.herdr.lifecycle?.hasPreparedRun(input.owner)) {
        // Cold restore drops workspace environment overrides and retains the old native reference.
        // A fresh workspace restores native XDG settings and observes only the new launch's SessionStart.
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L568-L580
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L687-L713
        await workerOperation((operation) => deps.herdr.lifecycle
          ? deps.herdr.lifecycle.stop(input.owner, "shutdown", operation)
          : deps.herdr.tasks.stopAndClose(context, actual.binding, operation), signal);
      }
      const binding = await workerOperation((operation) => deps.herdr.tasks.prepareWorkspace(context, input.title, operation), signal);
      if (deps.herdr.lifecycle === undefined) await deps.preparePromptSource?.(task.projectId, signal);
      if (task.sessionId === null) deps.emit({ kind: "info", task, message: "Starting a new native conversation in the task worktree." });
      const assignment: ManagedAssignment = { ...task, serverOrigin: deps.serverOrigin, workerId: deps.workerId, worktreeId: input.owner.worktreeId, worktree, configuration: input.configuration };
      let prompt: string;
      try { prompt = deps.herdr.lifecycle === undefined
        ? preparePrompt(task, input.configuration, binding, "startup", () => deps.buildPrompt(assignment, deps.platform))
        : deps.buildPrompt(assignment, deps.platform); }
      catch (error) {
        if (!(error instanceof PromptInputWaiting)) throw error;
        return { kind: "waiting_input", reason: error.reason, observation: null };
      }
      pendingInput.set(identity, { binding, prompt, continuation: false });
      lastInput.delete(identity);
      let observation: HerdrAgentObservation;
      try {
        observation = await workerOperation((operation) => deps.herdr.tasks.start(context, binding, {
          configuration: input.configuration, prompt,
          ...(deps.herdr.lifecycle === undefined ? {} : { preparePrompt: (recovery: boolean) => {
            return preparePrompt(task!, input.configuration, binding, recovery ? "recovery" : "startup", () => recovery ? "Continue the original assigned task under its existing authorization." : deps.buildPrompt(assignment, deps.platform));
          }, ...(deps.preparePromptSource === undefined ? {} : { preparePromptSource: (operation: Operation) => deps.preparePromptSource!(task!.projectId, operation.signal) }),
          onPromptPrepared: (prepared: string, recovery: boolean) => { pendingInput.set(identity, { binding, prompt: prepared, continuation: recovery }); } }),
          ...(assignment.sessionId === null ? {} : { resumeSessionId: assignment.sessionId }),
          onPromptSubmitted: (receipt) => { pendingInput.delete(identity); lastInput.set(identity, inputState(receipt.observation)); },
        }, operation), signal);
        if (!deps.herdr.lifecycle) pendingInput.delete(identity);
      } catch (error) {
        if (error instanceof PromptInputWaiting) {
          pendingInput.delete(identity);
          return { kind: "waiting_input", reason: error.reason, observation: null };
        }
        if (pendingInput.has(identity) && error instanceof HerdrAgentActionError && error.action === "agent.prompt" && error.promptSubmission === "unknown") {
          pendingInput.delete(identity);
          lastInput.set(identity, null);
        }
        if (!(error instanceof HerdrAgentActionError) || error.action !== "agent.prompt" || error.promptSubmission !== "not-submitted") throw error;
        if (deps.herdr.lifecycle && !(error instanceof HerdrInputWaitingError)) throw error;
        observation = await workerOperation((operation) => deps.herdr.tasks.observe(context, binding, operation), signal);
        assertNativeSession(task, observation);
      }
      assertNativeSession(task, observation);
      if (observation.nativeSession !== null) task = deps.store.setSessionId(task, observation.nativeSession.sessionId);
      reportObservation(task, observation, true);
      return { kind: "observed", observation };
    },
  };
};
