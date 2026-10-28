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
      if (task.cleanup !== null || task.control !== null || task.configuration === null) throw new Error("Ordinary Web execution is fenced by cleanup or management.");
      if (task.resources.worktree === null) task = options.store.bindWorktree(task, await workerOperation(operation => options.git.prepareWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal), options.now());
      else await workerOperation(operation => options.git.verifyWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal);
      task = options.store.initializeWebExecution(task, options.now());
      let ticket = await options.launcher.prepare(task, task.webExecution!.initialPrompt ?? options.buildPrompt(task, options.platform), signal);
      task = current(task);
      await options.launcher.launch(task, ticket, signal);
      task = current(task);
      let snapshot: ControllerSnapshot;
      let orderlyRestart = false;
      try { snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot; }
      catch (error) {
        const saved = readControllerSnapshot(journal(task));
        if (saved !== null) task = remember(task, saved);
        const proof = task.webExecution!.controllerProcess;
        if (proof === null || !await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses)) throw new Error("The original controller is unreachable; its native writer may still be alive and will not be replaced.", { cause: error });
        if (saved?.nativeSessionId == null) throw new Error("The stopped native launch has no proven session identity; recovery cannot create another conversation.");
        const stopped = await recordStoppedControllerGeneration(journal(task), ticket);
        if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
        orderlyRestart = task.webExecution!.restartAfterShutdown;
        if (!orderlyRestart) task = options.store.beginRecovery(task, options.now());
        task = options.store.beginWebGeneration(task, stopped, options.now());
        ticket = await options.launcher.prepare(task, task.webExecution!.initialPrompt!, signal);
        await options.launcher.launch(current(task), ticket, signal);
        snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot;
      }
      task = remember(current(task), snapshot);
      await options.launcher.refreshGrant(task, ticket, signal);
      if (snapshot.lifecycle === "starting") return task;
      if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "paused") throw new Error(snapshot.error ?? "The native controller is paused.");
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
      if (task.recovery.retryAuthorized && !orderlyRestart) task = options.store.beginRecovery(task, options.now());
      if (snapshot.initialInputState === "not_submitted") {
        const response = await request(ticket, { kind: "submit_initial", operationId: task.webExecution!.initialOperationId }, { signal, timeoutMs: 30000 });
        task = remember(task, response.snapshot);
      }
      options.emit({ kind: "web-observed", task, message: `Original ${ticket.provider} controller generation ${ticket.executionGeneration} is bound to session ${ticket.sessionId}.` });
      return current(task);
    },
    cleanup: async (input: LocalTask, kind: CleanupState["kind"], deadline: number, signal: AbortSignal = new AbortController().signal, immediateStop = false): Promise<LocalTask> => {
      const startedAt = options.now();
      // An elapsed caller deadline has zero remaining budget, including immediate shutdown.
      let task = options.store.beginCleanup(current(input), { kind, deadline: Math.max(startedAt, deadline) }, startedAt);
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
          let reachable = false;
          try { const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 1000 }); task = remember(task, response.snapshot); reachable = true; }
          catch { const saved = readControllerSnapshot(journal(task)); if (saved !== null) task = remember(task, saved); }
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
      if (task.cleanup!.kind === "terminal" && !task.cleanup!.worktreeDeleted) {
        await workerOperation(operation => options.git.removeWorktree({ projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath }, task, operation), signal);
        task = options.store.confirmWorktreeDeleted(task, { worktreeDeleted: true }, options.now());
      }
      return task;
    },
  };
};
export type WebExecutionBackend = ReturnType<typeof createWebExecutionBackend>;
