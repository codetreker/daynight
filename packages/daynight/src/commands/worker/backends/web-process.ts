import { ControllerStartupError } from "../../controller/startup.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { prepareControllerIpcEndpoint } from "../../controller/paths.js";
import { controllerExecutionDirectory, controllerTicketPath, readLaunchTicket, writeLaunchTicket, serializeLaunchTicket, LaunchTicketLimitError, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped } from "../../controller/process-proof.js";
import type { WebExecutionStore } from "./web-store.js";
import type { LocalTask } from "./web-types.js";
import type { WorkerSessionApi } from "./session-api.js";
import { writeControllerCredential } from "./session-api.js";
import { createControllerExecutionSerializer, launchControllerProcess } from "./controller-process.js";
import { controllerCredentialNeedsRefresh } from "./grant-renewal.js";
import { PromptInputLimitError } from "../prompt-input-limit.js";
import { matchesLaunchConfiguration, readLaunchToolSelection, writeLaunchToolSelection } from "../../controller/launch-tool-selection.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { FrozenToolObservation } from "../types.js";
export const createWebControllerLauncher = (options: { homeDirectory: string; packageDirectory: string; store: WebExecutionStore; sessionApi: WorkerSessionApi; now: () => number;
  selectToolLaunch?: (agent: "codex" | "copilot", signal: AbortSignal) => Promise<ResolvedToolLaunch>;
  toolObservationFor?: (launch: ResolvedToolLaunch) => FrozenToolObservation | undefined;
}) => {
  let grantObserver: { started(task: LocalTask): void; settled(task: LocalTask): void; checked(task: LocalTask): void; refreshed(task: LocalTask): void; failed(task: LocalTask, error: unknown, started: boolean): void; ticketFailed(task: LocalTask, error: unknown): void; ticketVerified(task: LocalTask): void; identityUnknown(task: LocalTask): void; identityResolved(task: LocalTask): void; identityLost(task: LocalTask): void } | undefined;
  const current = (task: LocalTask) => { const latest = options.store.getTask(task); if (latest?.webExecution == null) throw new Error("The web execution identity disappeared."); return latest; };
  const serializeExecution = createControllerExecutionSerializer();
  const serialize = <T>(task: LocalTask, action: () => Promise<T>): Promise<T> => serializeExecution(task.webExecution?.executionId ?? task.claimId, action);
  const checkTicket = (task: LocalTask, ticket: ControllerLaunchTicket): void => {
    const execution = task.webExecution!;
    if (task.configuration === null) throw new Error("The frozen Web configuration disappeared.");
    if (ticket.launchId !== execution.launchId || ticket.executionId !== execution.executionId || ticket.claimId !== task.claimId
      || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.worktreeId !== task.worktreeId
      || ticket.workerId !== task.workerId || ticket.userId !== task.userId || ticket.serverOrigin !== task.serverOrigin
      || ticket.controllerId !== execution.controllerId || ticket.controllerInstanceId !== execution.controllerInstanceId
      || ticket.executionGeneration !== execution.executionGeneration || ticket.initialOperationId !== execution.initialOperationId
      || ticket.sessionId !== execution.sessionId || ticket.initialPrompt !== execution.initialPrompt
      || task.resources.worktree !== null && ticket.cwd !== task.resources.worktree.worktreePath
      || !matchesLaunchConfiguration(ticket.configuration, task.configuration)) throw new Error("An existing launch ticket does not match the durable execution intent.");
  };
  const missingSelection = (task: LocalTask): ToolSelectionError => new ToolSelectionError(task.configuration!.agent as "codex" | "copilot", "web", "launch", "legacy_tool_identity_missing");
  const assertUnsubmitted = (input: LocalTask): LocalTask => {
    const task = current(input), execution = task.webExecution!;
    if (task.status !== "active" || task.cleanup !== null || execution.launchId !== input.webExecution!.launchId
      || execution.executionGeneration !== "1" || execution.launchSubmission !== "not-submitted"
      || execution.controllerProcess !== null || execution.nativeProcesses.length !== 0 || execution.initialInputState !== "not_submitted"
      || task.resources.nativeSession !== null || task.recovery.count !== 0 || task.recovery.retryAuthorized || execution.restartAfterShutdown
      || readControllerSnapshot(path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite")) !== null) throw missingSelection(task);
    return task;
  };
  const prepareExistingSelection = async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
    let task = current(input);
    checkTicket(task, ticket);
    // Reattachment and cleanup keep the original process proof; only a new spawn needs this binding.
    if (task.configuration!.agent === "claude" || task.webExecution!.launchSubmission !== "not-submitted") return;
    let selected = await readLaunchToolSelection(options.homeDirectory, ticket);
    if (selected === undefined) {
      task = assertUnsubmitted(task);
      selected = task.configuration!.toolLaunch ?? await options.selectToolLaunch?.(task.configuration!.agent as "codex" | "copilot", signal);
      if (selected === undefined) throw missingSelection(task);
      signal.throwIfAborted();
      await writeLaunchToolSelection(options.homeDirectory, ticket, selected, () => { assertUnsubmitted(task); });
    }
    if (task.configuration!.toolLaunch === undefined) {
      assertUnsubmitted(task);
      const observation = options.toolObservationFor?.(selected);
      options.store.freezeToolLaunch(task, selected, options.now(), { sidecarLaunchId: ticket.launchId, ...(observation === undefined ? {} : { observation }) });
    } else if (task.configuration!.toolLaunch.selectionKey !== selected.selectionKey) throw new Error("The original Web ticket tool selection differs from its frozen configuration.");
  };
  const cleanupStopped = async (task: LocalTask): Promise<boolean> => {
    if (task.cleanup === null) return false;
    const execution = task.webExecution!;
    const saved = readControllerSnapshot(path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite"));
    if (saved !== null && (saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.executionGeneration !== execution.executionGeneration || saved.controllerInstanceId !== execution.controllerInstanceId)) throw new Error("Controller credential renewal has conflicting cleanup evidence.");
    const proof = saved?.controllerProcess ?? execution.controllerProcess;
    return proof !== null && await confirmControllerProcessesStopped(proof, saved?.nativeProcesses ?? execution.nativeProcesses);
  };
  const methods = {
    prepare: async (input: LocalTask, prompt: string | (() => string), signal: AbortSignal): Promise<ControllerLaunchTicket> => {
      let task = current(input); let execution = task.webExecution!;
      if (execution.ticketPath !== null) { const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId); await prepareExistingSelection(task, ticket, signal); if (execution.nativeHome === null) options.store.updateWebExecution(task,{nativeHome:ticket.nativeHome},options.now()); return ticket; }
      try {
        const existing = await readLaunchTicket(options.homeDirectory, execution.launchId);
        if (existing.executionId !== execution.executionId || existing.claimId !== task.claimId || existing.executionGeneration !== execution.executionGeneration || existing.controllerInstanceId !== execution.controllerInstanceId || existing.initialOperationId !== execution.initialOperationId || existing.sessionId !== execution.sessionId || existing.initialPrompt !== execution.initialPrompt) throw new Error("An existing launch ticket does not match the durable execution intent.");
        await prepareExistingSelection(task, existing, signal);
        options.store.updateWebExecution(task, { ticketPath: controllerTicketPath(options.homeDirectory, execution.launchId), nativeHome: existing.nativeHome }, options.now()); return existing;
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (task.resources.worktree === null || task.configuration === null || task.userId === null) throw new Error("Controller launch requires its original worktree, provider and owner.");
      if (task.configuration.agent !== "claude" && task.configuration.toolLaunch === undefined) {
        assertUnsubmitted(task);
        const selected = await options.selectToolLaunch?.(task.configuration.agent, signal);
        if (selected === undefined) throw missingSelection(task);
        signal.throwIfAborted(); assertUnsubmitted(task);
        const observation = options.toolObservationFor?.(selected);
        task = options.store.freezeToolLaunch(task, selected, options.now(), observation === undefined ? {} : { observation });
        execution = task.webExecution!;
      }
      if (execution.sessionId === null) { const registered = await options.sessionApi.register(task, execution, signal); task = options.store.updateWebExecution(task, { sessionId: registered.sessionId }, options.now()); execution = task.webExecution!; }
      const directory = controllerExecutionDirectory(options.homeDirectory, execution.executionId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const credentialFile = path.join(directory, "credential.json");
      const previous = readControllerSnapshot(path.join(directory, "journal.sqlite"));
      const stop = previous !== null && previous.executionGeneration !== execution.executionGeneration && previous.nativeStopped && previous.stoppedAt !== null ? { generation: previous.executionGeneration, instanceId: previous.controllerInstanceId, recordId: execution.launchId, stoppedAt: previous.stoppedAt } : undefined;
      const grant = await options.sessionApi.grant(task, execution, signal, stop); await writeControllerCredential(credentialFile, grant);
      const ipcEndpoint = await prepareControllerIpcEndpoint(options.homeDirectory, execution.launchId);
      if (task.resources.worktree === null || task.configuration === null || task.userId === null) throw new Error("The frozen launch binding disappeared.");
      const nativeHome = execution.nativeHome ?? (task.configuration.agent === "codex" ? process.env.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")
        : task.configuration.agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? path.join(options.homeDirectory, ".claude")
        : process.env.COPILOT_HOME ?? path.join(options.homeDirectory, ".copilot"));
      if (execution.nativeHome === null) execution = options.store.updateWebExecution(task,{nativeHome},options.now()).webExecution!;
      const initialPrompt = execution.initialPrompt ?? (typeof prompt === "function" ? prompt() : prompt);
      const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId, provider: task.configuration.agent, cwd: task.resources.worktree.worktreePath, nativeHome, configuration: task.configuration, initialOperationId: execution.initialOperationId, initialPrompt, resumeNativeSessionId: task.resources.nativeSession?.sessionId ?? null, credentialFile, ipcEndpoint, ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(options.now()).toISOString() };
      try { serializeLaunchTicket(ticket); }
      catch (error) {
        if (error instanceof LaunchTicketLimitError) throw new PromptInputLimitError("web_ticket", error.actualBytes, error.maxBytes);
        throw error;
      }
      // Freeze only the same complete ticket that passed both existing size checks.
      if (execution.initialPrompt === null) task = options.store.updateWebExecution(task, { initialPrompt }, options.now());
      const ticketPath = await writeLaunchTicket(options.homeDirectory, ticket);
      options.store.updateWebExecution(task, { ticketPath, initialPrompt }, options.now());
      return ticket;
    },
    launch: async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
      let task = current(input); if (task.webExecution!.launchSubmission !== "not-submitted") return;
      checkTicket(task, ticket);
      if (ticket.provider !== "claude") {
        const selected = await readLaunchToolSelection(options.homeDirectory, ticket);
        if (selected === undefined) throw missingSelection(task);
        if (task.configuration?.toolLaunch?.selectionKey !== selected.selectionKey) throw new Error("Web spawn requires its original frozen tool selection.");
      }
      // A reusable grant also supports the first hello, including a lost bootstrap handshake.
      await writeControllerCredential(ticket.credentialFile, await options.sessionApi.grant(task, { ...task.webExecution!, launchSubmission: "unknown" }, signal));
      let submitting = false, acknowledged = false;
      try {
        await launchControllerProcess({
          homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, ticket, signal,
          env: { ...process.env, DN_CONFIG_DIR: resolveConfigurationPaths(options.homeDirectory).stateDirectory },
          onSubmitting: () => { submitting = true; task = options.store.updateWebExecution(task, { launchSubmission: "unknown" }, options.now()); },
          onSpawned: proof => { task = options.store.updateWebExecution(task, { controllerProcess: proof }, options.now()); },
          onObserved: snapshot => { options.store.updateWebExecution(task, { launchSubmission: "acknowledged", nativeProcesses: snapshot.nativeProcesses }, options.now()); acknowledged = true; },
        });
      } catch (error) {
        if (error instanceof ControllerStartupError) options.store.observeStartup(task, error.observation, options.now());
        else if (!signal.aborted && submitting && !acknowledged) options.store.observeStartup(task, { state: "unknown", reasonCode: "controller_start_unknown" }, options.now());
        throw error;
      }
    },
    refreshGrant: async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal, onRefreshed?: () => void, onStarting?: () => void, onChecked?: () => void): Promise<void> => {
      let task: LocalTask | null;
      try { task = options.store.getTask(input); }
      catch (error) {
        if (onRefreshed === undefined && !signal.aborted) try { grantObserver?.identityUnknown(input); } catch { /* Optional monitoring cannot alter the lookup failure. */ }
        throw error;
      }
      if (onRefreshed === undefined && !signal.aborted) try { grantObserver?.identityResolved(input); } catch { /* Optional monitoring cannot alter identity handling. */ }
      if (task?.webExecution == null) {
        if (!signal.aborted) try { grantObserver?.identityLost(input); } catch { /* Optional monitoring cannot alter identity handling. */ }
        throw new Error("The web execution identity disappeared.");
      }
      let started = false;
      try {
        if (task.webExecution!.launchId !== ticket.launchId || await cleanupStopped(task)) return;
        const needsRefresh = await controllerCredentialNeedsRefresh(ticket.credentialFile, options.now());
        if (!signal.aborted) {
          try { onChecked?.(); } catch { /* Optional monitoring cannot alter renewal. */ }
          try { grantObserver?.checked(task); } catch { /* Optional monitoring cannot alter renewal. */ }
        }
        if (!needsRefresh) return;
        signal.throwIfAborted();
        started = true;
        try { onStarting?.(); } catch { /* Optional monitoring cannot alter renewal. */ }
        try { grantObserver?.started(task); } catch { /* Optional monitoring cannot alter renewal. */ }
        const grant = await options.sessionApi.grant(task, task.webExecution!, signal);
        const latest = current(task);
        if (latest.webExecution!.launchId !== ticket.launchId || await cleanupStopped(latest)) return;
        signal.throwIfAborted();
        await writeControllerCredential(ticket.credentialFile, grant);
        try { onRefreshed?.(); } catch { /* Optional monitoring cannot alter the refresh result. */ }
        try { grantObserver?.refreshed(latest); } catch { /* Optional monitoring cannot alter the refresh result. */ }
      } catch (error) {
        if (onRefreshed === undefined && !signal.aborted) try { grantObserver?.failed(task, error, started); } catch { /* Optional monitoring cannot alter the refresh failure. */ }
        throw error;
      } finally {
        if (started) try { grantObserver?.settled(task); } catch { /* Optional monitoring cannot alter renewal. */ }
      }
    },
  };
  return {
    setGrantObserver: (observer: typeof grantObserver): void => { grantObserver = observer; },
    reportTicketFailure: (task: LocalTask, error: unknown): void => { try { grantObserver?.ticketFailed(task, error); } catch { /* Optional monitoring cannot alter renewal. */ } },
    reportTicketVerified: (task: LocalTask): void => { try { grantObserver?.ticketVerified(task); } catch { /* Optional monitoring cannot alter renewal. */ } },
    prepare: (...args: Parameters<typeof methods.prepare>) => serialize(args[0], () => methods.prepare(...args)),
    launch: (...args: Parameters<typeof methods.launch>) => serialize(args[0], () => methods.launch(...args)),
    refreshGrant: (...args: Parameters<typeof methods.refreshGrant>) => serialize(args[0], () => methods.refreshGrant(...args)),
  };
};
