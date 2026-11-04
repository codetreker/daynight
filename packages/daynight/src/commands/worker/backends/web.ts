import path from "node:path";
import { lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { controllerExecutionDirectory, readLaunchTicket } from "../../controller/launch-ticket.js";
import { requestController } from "../../controller/local-client.js";
import { readControllerOperation, readControllerSnapshot, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, stopControllerProcesses } from "../../controller/process-proof.js";
import { workerOperation, type WorkerGitManager } from "../execution.js";
import { workerCleanupPrompt } from "../prompts.js";
import { WorkerCleanupError, type WorkerCleanupStage } from "../cleanup-error.js";
import { taskAgentControlMode, type CleanupState, type LocalTask } from "./web-types.js";
import type { WebExecutionStore } from "./web-store.js";
import type { TaskPlatform } from "../../../api/types.js";
import type { createWebControllerLauncher } from "./web-process.js";
export type WebBackendOptions = {
  homeDirectory: string; store: WebExecutionStore; git: WorkerGitManager; launcher: ReturnType<typeof createWebControllerLauncher>;
  platform: TaskPlatform; buildPrompt: (task: LocalTask, platform: TaskPlatform) => string; emit: (event: { kind: string; message: string; task?: LocalTask }) => void; now: () => number;
  request?: typeof requestController;
  archive?: (task: LocalTask, journalPath: string, signal: AbortSignal) => Promise<void>;
};
export type WebCleanupOutcome = { task: LocalTask; complete: boolean };
export const createWebExecutionBackend = (options: WebBackendOptions) => {
  const request = options.request ?? requestController;
  const current = (task: LocalTask): LocalTask => { const latest = options.store.getTask(task); if (latest === null || taskAgentControlMode(latest) !== "web") throw new Error("The frozen Web execution disappeared."); return latest; };
  const journal = (task: LocalTask): string => path.join(controllerExecutionDirectory(options.homeDirectory, task.webExecution!.executionId), "journal.sqlite");
  const remember = (input: LocalTask, snapshot: ControllerSnapshot): LocalTask => {
    let task = current(input);
    task = options.store.updateWebExecution(task, { launchSubmission: "acknowledged", initialInputState: snapshot.initialInputState, activity: snapshot.activity, controllerProcess: snapshot.controllerProcess ?? task.webExecution!.controllerProcess, nativeProcesses: snapshot.nativeProcesses }, options.now());
    if (snapshot.nativeSessionId !== null) task = options.store.bindNativeSession(task, { source: "controller", sessionId: snapshot.nativeSessionId }, options.now());
    return task;
  };
  const removeEndpoint = async (endpoint: string): Promise<void> => {
    if (process.platform === "win32") return;
    try { await unlink(endpoint); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    try { await lstat(endpoint); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    throw new Error("The original controller endpoint still exists after cleanup.");
  };
  const matchesGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
    const execution = task.webExecution!;
    return snapshot.executionId === execution.executionId && snapshot.claimId === task.claimId && snapshot.sessionId === execution.sessionId
      && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId;
  };
  return {
    advance: async (input: LocalTask, signal: AbortSignal): Promise<LocalTask> => {
      let task = current(input);
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
      if (task.cleanup !== null || task.control !== null || task.configuration === null) throw new Error("Ordinary Web execution is fenced by cleanup or management.");
      const retryAttempt = task.recovery.retryAuthorized;
      let recovering = retryAttempt;
      const pause = (error: unknown): LocalTask => options.store.pauseRecovery(task, error instanceof Error ? error.message : String(error), options.now());
      const originalSnapshot = (): ControllerSnapshot => {
        const saved = readControllerSnapshot(journal(task)), execution = task.webExecution!;
        if (saved === null || saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId || saved.executionGeneration !== execution.executionGeneration || saved.controllerInstanceId !== execution.controllerInstanceId) throw new Error("The original controller generation evidence is unavailable.");
        return saved;
      };
      try {
        if (retryAttempt && task.recovery.pauseReason !== null) {
          // Authorization permits one replacement generation only after proving the old writer stopped.
          if (task.webExecution === null || task.resources.nativeSession === null) throw new Error("Web retry requires the original native session identity.");
          if (task.webExecution.launchSubmission === "not-submitted" && BigInt(task.webExecution.executionGeneration) > 1n) {
            // Preparation may fail after allocating a generation but before any writer is launched.
            const previous = readControllerSnapshot(journal(task));
            if (previous === null || previous.controllerProcess === null || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null) throw new Error("Unsubmitted recovery requires the original complete stopped generation evidence.");
            if (!await confirmControllerProcessesStopped(previous.controllerProcess, previous.nativeProcesses)) throw new Error("Unsubmitted recovery requires complete original controller and native process stop.");
            signal.throwIfAborted();
            if (JSON.stringify(readControllerSnapshot(journal(task))) !== JSON.stringify(previous)) throw new Error("The original stopped generation changed during unsubmitted recovery verification.");
            task = options.store.retryUnsubmittedWebGeneration(task, previous, options.now());
          } else {
            const saved = originalSnapshot();
            if (saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession.sessionId) throw new Error("Web retry requires the original native session identity.");
            task = remember(task, saved);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null || !await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses)) throw new Error("Web retry requires complete original controller and native process stop.");
            const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
            const stopped = await recordStoppedControllerGeneration(journal(task), ticket);
            task = options.store.beginWebGeneration(task, stopped, options.now());
          }
        } else if (!retryAttempt && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted" && task.recovery.count >= task.configuration.recoveryLimit) {
          // Older versions recorded exhaustion without a pause. Inspect before any launch preparation.
          try {
            const saved = originalSnapshot();
            task = remember(task, saved);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null) throw new Error("The exhausted execution has no complete original process stop evidence.");
            const stopped = await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses);
            if (stopped) {
              if (!task.webExecution!.restartAfterShutdown || saved.error !== null) return pause(new Error("The execution recovery budget is exhausted."));
            } else {
              if (["stopped", "stopping", "failed", "paused"].includes(saved.lifecycle)) throw new Error("The exhausted execution is stopped or failed, but complete original process stop is unproven.");
              const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
              const observed = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot;
              if (observed.lifecycle !== "ready" && observed.lifecycle !== "working" && observed.lifecycle !== "starting") throw new Error(observed.error ?? "The exhausted controller is not healthy.");
              task = remember(task, observed);
            }
          } catch (error) { signal.throwIfAborted(); return pause(error); }
        }
        if (task.resources.worktree === null) task = options.store.bindWorktree(task, await workerOperation(operation => options.git.prepareWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal), options.now());
        else await workerOperation(operation => options.git.verifyWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal);
        task = options.store.initializeWebExecution(task, options.now());
        let ticket = await options.launcher.prepare(task, task.webExecution!.initialPrompt ?? options.buildPrompt(task, options.platform), signal);
        task = current(task);
        await options.launcher.launch(task, ticket, signal);
        task = current(task);
        let snapshot: ControllerSnapshot;
        try { snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot; }
        catch (error) {
          signal.throwIfAborted();
          // A retry never grants a second generation when its first observation fails.
          if (retryAttempt) throw error;
          const saved = originalSnapshot();
          task = remember(task, saved);
          const proof = task.webExecution!.controllerProcess;
          if (proof === null || !await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses)) throw new Error("The original controller is unreachable; its native writer may still be alive and will not be replaced.", { cause: error });
          if (saved.nativeSessionId === null) throw new Error("The stopped native launch has no proven session identity; recovery cannot create another conversation.");
          const stopped = await recordStoppedControllerGeneration(journal(task), ticket);
          if (!task.webExecution!.restartAfterShutdown) task = options.store.beginRecovery(task, options.now());
          if (task.recovery.pauseReason !== null) return task;
          recovering = true;
          task = options.store.beginWebGeneration(task, stopped, options.now());
          ticket = await options.launcher.prepare(task, task.webExecution!.initialPrompt!, signal);
          await options.launcher.launch(current(task), ticket, signal);
          snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot;
        }
        task = remember(current(task), snapshot);
        if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "paused" || snapshot.lifecycle === "stopped" || snapshot.lifecycle === "stopping") {
          recovering = true;
          throw new Error(snapshot.error ?? "The native controller is paused or stopped.");
        }
        if ((snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") && snapshot.initialInputState === "not_submitted" && BigInt(task.webExecution!.executionGeneration) > 1n) {
          recovering = true;
          throw new Error("Recovery cannot resubmit the original managed assignment.");
        }
        if (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") {
          if (task.recovery.retryAuthorized) task = options.store.completeRecoveryRetry(task, snapshot, options.now());
          recovering = false;
        }
        await options.launcher.refreshGrant(task, ticket, signal);
        if (snapshot.lifecycle === "starting") return options.store.updateWebExecution(task, { activity: "initializing" }, options.now());
        if (snapshot.initialInputState === "not_submitted") {
          const response = await request(ticket, { kind: "submit_initial", operationId: task.webExecution!.initialOperationId }, { signal, timeoutMs: 30000 });
          task = remember(task, response.snapshot);
        }
        options.emit({ kind: "web-observed", task, message: `Original ${ticket.provider} controller generation ${ticket.executionGeneration} is bound to session ${ticket.sessionId}.` });
        return current(task);
      } catch (error) {
        if (!signal.aborted && (recovering && (retryAttempt || current(task).recovery.count >= task.configuration!.recoveryLimit))) pause(error);
        throw error;
      }
    },
    cleanup: async (input: LocalTask, kind: CleanupState["kind"], deadline: number, signal: AbortSignal = new AbortController().signal, immediateStop = false): Promise<WebCleanupOutcome> => {
      let stage: WorkerCleanupStage = "observation";
      try {
        const startedAt = options.now();
        let task = current(input);
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.retryAuthorized && task.recovery.pauseReason === null) task = options.store.pauseRecovery(task, "The explicit recovery attempt stopped before a successful observation.", options.now());
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.pauseReason === null && task.configuration !== null && task.recovery.count >= task.configuration.recoveryLimit && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted") {
          // Shutdown provenance must not turn an already exhausted writer into a healthy orderly restart.
          try {
            const saved = readControllerSnapshot(journal(task));
            if (saved === null || !matchesGeneration(task, saved) || saved.controllerProcess === null) throw new Error("The exhausted execution has no original generation evidence before shutdown.");
            if (["failed", "paused", "stopped", "stopping"].includes(saved.lifecycle) || await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses)) task = options.store.pauseRecovery(task, "The execution recovery budget is exhausted.", options.now());
          } catch (error) {
            signal.throwIfAborted();
            task = options.store.pauseRecovery(task, error instanceof Error ? error.message : String(error), options.now());
          }
        }
        if (task.status !== "done") task = options.store.beginCleanup(task, { kind, deadline: Math.max(startedAt, deadline) }, startedAt);
        const intent = task.cleanup;
        if (intent === null) throw new Error("The original cleanup intent is missing.");
        const execution = task.webExecution;
        if (execution === null && task.configuration === null) throw new Error("The recovered Web claim has no original launch provenance; its resources are retained.");
        stage = "agent-stop";
        let launched = false;
        if (execution !== null) {
          let saved = readControllerSnapshot(journal(task));
          if (saved !== null && !matchesGeneration(task, saved)) {
            if (execution.launchSubmission !== "not-submitted" || saved.executionId !== execution.executionId || saved.claimId !== task.claimId
              || saved.controllerProcess === null || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration)
              || !await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses)) throw new Error("The original controller generation cannot be identified and stopped from its journal.");
            saved = null;
          }
          launched = saved !== null || execution.launchSubmission !== "not-submitted";
          if (launched) {
            const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
            if (ticket.executionId !== execution.executionId || ticket.claimId !== task.claimId || ticket.sessionId !== execution.sessionId
              || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
              || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.serverOrigin !== task.serverOrigin) throw new Error("The cleanup ticket does not identify the original execution.");
            let response: Awaited<ReturnType<typeof request>> | undefined;
            try { response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 1000 }); }
            catch (error) {
              signal.throwIfAborted();
              const observed = readControllerSnapshot(journal(task));
              if (observed !== null) {
                if (!matchesGeneration(task, observed)) throw new Error("The original controller journal belongs to a different generation.", { cause: error });
                saved = observed;
              }
            }
            const reachable = response !== undefined;
            if (response !== undefined) {
              if (!matchesGeneration(task, response.snapshot)) throw new Error("The observed controller belongs to a different generation.");
              saved = response.snapshot;
            }
            if (saved?.nativeSessionId != null && task.status !== "done") task = options.store.bindNativeSession(task, { source: "controller", sessionId: saved.nativeSessionId }, options.now());
            if (saved?.controllerProcess != null && execution.controllerProcess !== null) {
              const original = execution.controllerProcess, observed = saved.controllerProcess;
              if (observed.pid !== original.pid || observed.startedAt !== original.startedAt || observed.commandHash !== original.commandHash
                || observed.processGroupId !== original.processGroupId) throw new Error("The original controller process identity conflicts with its journal.");
            }
            const proof = saved?.controllerProcess ?? execution.controllerProcess;
            const native = saved?.nativeProcesses ?? execution.nativeProcesses;
            if (proof === null) throw new Error("The original controller process identity is missing; cleanup cannot infer stop.");
            let stopped = await confirmControllerProcessesStopped(proof, native);
            if (!immediateStop && task.status !== "done" && !stopped && options.now() < intent.deadline) {
              if (!reachable) throw new Error("The original controller is unavailable; cleanup retains its fixed deadline and process identity.");
              if (task.webExecution!.cleanupOperationId === null) task = options.store.updateWebExecution(task, { cleanupOperationId: randomUUID() }, options.now());
              const operationId = task.webExecution!.cleanupOperationId!;
              let operation = readControllerOperation(journal(task), operationId);
              if (operation === null) {
                try { await request(ticket, { kind: "cleanup", operationId, prompt: workerCleanupPrompt(task, intent.deadline), deadline: intent.deadline }, { signal, timeoutMs: 30000 }); }
                catch (error) {
                  signal.throwIfAborted();
                  operation = readControllerOperation(journal(task), operationId);
                  if (operation === null) throw error;
                }
                operation = readControllerOperation(journal(task), operationId);
              }
              if (operation !== null && (operation.kind !== "cleanup" || operation.executionGeneration !== execution.executionGeneration)) throw new Error("The cleanup operation belongs to a different controller generation.");
              if (operation === null || !["confirmed", "failed", "rejected", "expired"].includes(operation.state)) return { task, complete: false };
            }
            if (!stopped) {
              if (reachable) try { await request(ticket, { kind: "stop", deadline: options.now() + 5000 }, { signal, timeoutMs: 5000 }); } catch { /* OS process observation remains authoritative after an IPC loss. */ }
              signal.throwIfAborted();
              try { await stopControllerProcesses(proof, native, Date.now() + 5000); }
              catch (error) { if (!await confirmControllerProcessesStopped(proof, native)) throw error; }
              stopped = await confirmControllerProcessesStopped(proof, native);
            }
            if (!stopped) throw new Error("The original controller or its native processes still exist.");
            if (saved !== null) await recordStoppedControllerGeneration(journal(task), ticket);
            stage = "backend-close";
            await removeEndpoint(ticket.ipcEndpoint);
          }
        }
        signal.throwIfAborted();
        if (kind === "shutdown") return { task, complete: true };
        if (launched) {
          stage = "archive";
          if (!options.archive) throw new Error("Session archive uploader is unavailable; the original worktree is retained.");
          await options.archive(task, journal(task), signal);
        }
        stage = "worktree-removal";
        const project = { projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath };
        await workerOperation(operation => options.git.removeWorktree(project, task, operation), signal);
        if (await workerOperation(operation => options.git.findWorktree(project, task, operation), signal) !== null) throw new Error("The original task still has Git worktree resources after cleanup.");
        return { task, complete: true };
      } catch (error) {
        throw new WorkerCleanupError(stage, error);
      }
    },
  };
};
export type WebExecutionBackend = ReturnType<typeof createWebExecutionBackend>;
