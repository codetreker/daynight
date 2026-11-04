import path from "node:path";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { controllerExecutionDirectory, readLaunchTicket } from "../../controller/launch-ticket.js";
import { requestController } from "../../controller/local-client.js";
import { readControllerOperation, readControllerSnapshot, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, stopControllerProcesses } from "../../controller/process-proof.js";
import { workerOperation, type WorkerGitManager } from "../execution.js";
import { workerCleanupPrompt } from "../prompts.js";
import { backendResourcesClosed, taskAgentControlMode, type CleanupState, type LocalTask } from "./web-types.js";
import type { WebExecutionStore } from "./web-store.js";
import type { TaskPlatform } from "../../../api/types.js";
import type { createWebControllerLauncher } from "./web-process.js";
export type WebBackendOptions = {
  homeDirectory: string; store: WebExecutionStore; git: WorkerGitManager; launcher: ReturnType<typeof createWebControllerLauncher>;
  platform: TaskPlatform; buildPrompt: (task: LocalTask, platform: TaskPlatform) => string; emit: (event: { kind: string; message: string; task?: LocalTask }) => void; now: () => number;
  request?: typeof requestController;
  archive?: (task: LocalTask, journalPath: string, signal: AbortSignal) => Promise<void>;
};
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
    cleanup: async (input: LocalTask, kind: CleanupState["kind"], deadline: number, signal: AbortSignal = new AbortController().signal, immediateStop = false): Promise<LocalTask> => {
      const startedAt = options.now();
      let original = current(input);
      if (kind === "shutdown" && original.cleanup === null && original.recovery.retryAuthorized && original.recovery.pauseReason === null) original = options.store.pauseRecovery(original, "The explicit recovery attempt stopped before a successful observation.", options.now());
      if (kind === "shutdown" && original.cleanup === null && original.recovery.pauseReason === null && original.configuration !== null && original.recovery.count >= original.configuration.recoveryLimit && original.webExecution !== null && original.webExecution.launchSubmission !== "not-submitted") {
        // Shutdown provenance must not turn an already exhausted writer into a healthy orderly restart.
        try {
          const saved = readControllerSnapshot(journal(original)), execution = original.webExecution;
          if (saved === null || saved.executionId !== execution.executionId || saved.claimId !== original.claimId || saved.executionGeneration !== execution.executionGeneration || saved.controllerInstanceId !== execution.controllerInstanceId) throw new Error("The exhausted execution has no original generation evidence before shutdown.");
          original = remember(original, saved);
          const proof = original.webExecution!.controllerProcess;
          if (proof === null) throw new Error("The exhausted execution has no complete original process stop evidence before shutdown.");
          if (["failed", "paused", "stopped", "stopping"].includes(saved.lifecycle) || await confirmControllerProcessesStopped(proof, original.webExecution!.nativeProcesses)) original = options.store.pauseRecovery(original, "The execution recovery budget is exhausted.", options.now());
        } catch (error) {
          signal.throwIfAborted();
          original = options.store.pauseRecovery(original, error instanceof Error ? error.message : String(error), options.now());
        }
      }
      // An elapsed caller deadline has zero remaining budget, including immediate shutdown.
      let task = options.store.beginCleanup(original, { kind, deadline: Math.max(startedAt, deadline) }, startedAt);
      if (task.resources.worktree === null) { const found = await workerOperation(operation => options.git.findWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal); if (found !== null) task = options.store.bindWorktree(task, found, options.now()); }
      const execution = task.webExecution;
      if (execution == null && task.configuration === null) throw new Error("The recovered Web claim has no original launch provenance; its native writer and worktree are retained.");
      if (!task.cleanup!.agentStopped) {
        if (execution == null || execution.launchSubmission === "not-submitted") {
          task = options.store.recordCleanupInputOutcome(task, "unavailable", options.now());
          task = options.store.recordCleanupResult(task, "unavailable", "No controller launch was submitted.", options.now());
          task = options.store.confirmAgentStopped(task, { agentStopped: true }, options.now());
          task = options.store.confirmBackendResourcesClosed(task, { controllerStopped: true, endpointClosed: true }, options.now());
        } else {
          if (execution.ticketPath === null) throw new Error("The original launch ticket is missing; cleanup retains its unknown native writer.");
          const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
          let response: Awaited<ReturnType<typeof request>> | undefined;
          try { response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 1000 }); }
          catch { const saved = readControllerSnapshot(journal(task)); if (saved !== null) task = remember(task, saved); }
          const reachable = response !== undefined;
          if (response !== undefined) task = remember(task, response.snapshot);
          const proof = task.webExecution!.controllerProcess;
          if (proof === null) throw new Error("The original controller process proof is missing; cleanup cannot infer stop.");
          let stopped = await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses);
          if (!immediateStop && !stopped && task.cleanup!.result === null && options.now() < task.cleanup!.deadline) {
            if (!reachable) throw new Error("The original controller is unavailable; cleanup retains its fixed deadline and process proof.");
            if (task.webExecution!.cleanupOperationId === null) task = options.store.updateWebExecution(task, { cleanupOperationId: randomUUID() }, options.now());
            if (task.cleanup!.input === "not-submitted") {
              task = options.store.markCleanupInputSubmitting(task, options.now());
              await request(ticket, { kind: "cleanup", operationId: task.webExecution!.cleanupOperationId!, prompt: workerCleanupPrompt(task, task.cleanup!.deadline), deadline: task.cleanup!.deadline }, { signal, timeoutMs: 30000 });
            }
            const operation = readControllerOperation(journal(task), task.webExecution!.cleanupOperationId!);
            if (operation?.state === "provider_accepted" || operation?.state === "confirmed") {
              if (task.cleanup!.input === "unknown") task = options.store.recordCleanupInputOutcome(task, "submitted", options.now());
              if (operation.state === "confirmed") task = options.store.recordCleanupResult(task, "completed", null, options.now());
            } else if (operation !== null && ["failed", "rejected", "expired"].includes(operation.state)) task = options.store.recordCleanupResult(task, "failed", operation.error, options.now());
            if (task.cleanup!.result === null) return task;
          }
          if (task.cleanup!.result === null) task = options.store.recordCleanupResult(task, stopped || immediateStop ? "unavailable" : "timed-out", stopped || immediateStop ? "Original processes stopped before cleanup completion was established." : "The original cleanup deadline elapsed.", options.now());
          if (!stopped) {
            if (reachable) try { await request(ticket, { kind: "stop", deadline: options.now() + 5000 }, { signal, timeoutMs: 5000 }); } catch { /* OS process proof remains authoritative after an IPC loss. */ }
            await stopControllerProcesses(proof, task.webExecution!.nativeProcesses, Date.now() + 5000);
            stopped = await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses);
          }
          if (!stopped) throw new Error("Complete original controller process stop is not proven.");
          await recordStoppedControllerGeneration(journal(task), ticket);
          task = options.store.confirmAgentStopped(task, { agentStopped: true }, options.now());
          await removeEndpoint(ticket.ipcEndpoint);
          task = options.store.confirmBackendResourcesClosed(task, { controllerStopped: true, endpointClosed: true }, options.now());
        }
      }
      if (!backendResourcesClosed(task.cleanup!)) throw new Error("The original Web backend resources are not closed.");
      // Shutdown proves stop but leaves any terminal finalization for normal reconciliation.
      if (kind === "shutdown") return task;
      if (task.cleanup!.kind === "terminal" && !task.cleanup!.worktreeDeleted) {
        if (execution && execution.launchSubmission !== "not-submitted") {
          if (!options.archive) throw new Error("Session archive uploader is unavailable; the original worktree is retained.");
          await options.archive(task, journal(task), signal);
        }
        await workerOperation(operation => options.git.removeWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal);
        task = options.store.confirmWorktreeDeleted(task, { worktreeDeleted: true }, options.now());
      }
      return task;
    },
  };
};
export type WebExecutionBackend = ReturnType<typeof createWebExecutionBackend>;
