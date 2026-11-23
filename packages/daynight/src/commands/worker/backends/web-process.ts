import { assertWorkerLifecycleAdmission, currentLifecycleBinding } from "../lifecycle-context.js";
import { assertConfigurationAdmission } from "../configuration-admission.js";
import { ControllerStartupError } from "../../controller/startup.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { prepareControllerIpcEndpoint } from "../../controller/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, readLaunchTicket, writeLaunchTicket, serializeLaunchTicket, LaunchTicketLimitError, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped } from "../../controller/process-proof.js";
import { reconcileSubmittedControllerLaunch } from "../../controller/launch-observation.js";
import type { WebExecutionStore } from "./web-store.js";
import type { LocalTask } from "./web-types.js";
import type { WorkerSessionApi } from "./session-api.js";
import { writeControllerCredential } from "./session-api.js";
import { controllerLaunchNeedsReplacement, createControllerExecutionSerializer, launchControllerProcess } from "./controller-process.js";
import { syncDurableDirectory } from "../../../platform/durable-directory.js";
import { controllerCredentialNeedsRefresh } from "./grant-renewal.js";
import { PromptInputLimitError } from "../prompt-input-limit.js";
import { matchesLaunchConfiguration, readLaunchToolSelection, writeLaunchToolSelection } from "../../controller/launch-tool-selection.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { FrozenToolObservation } from "../types.js";
import type { ControllerJobLeases } from "./controller-job-leases.js";
import { preservesControllerProcessProof } from "./orchestration.js";
export const createWebControllerLauncher = (options: { homeDirectory: string; packageDirectory: string; store: WebExecutionStore; sessionApi: WorkerSessionApi; now: () => number;
  jobLeases?: ControllerJobLeases;
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
  const prepareExistingSelection = async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal, canAdmitNewExecution?: () => boolean): Promise<void> => {
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
      await writeLaunchToolSelection(options.homeDirectory, ticket, selected, () => { assertUnsubmitted(task); assertConfigurationAdmission(canAdmitNewExecution); });
    }
    if (task.configuration!.toolLaunch === undefined) {
      assertUnsubmitted(task);
      const observation = options.toolObservationFor?.(selected);
      assertConfigurationAdmission(canAdmitNewExecution);
      options.store.freezeToolLaunch(task, selected, options.now(), { sidecarLaunchId: ticket.launchId, ...(observation === undefined ? {} : { observation }) });
    } else if (task.configuration!.toolLaunch.selectionKey !== selected.selectionKey) throw new Error("The original Web ticket tool selection differs from its frozen configuration.");
  };
  const cleanupStopped = async (task: LocalTask): Promise<boolean> => {
    if (task.cleanup === null) return false;
    const execution = task.webExecution!;
    if (execution.launchSubmission === "not-submitted" || execution.controllerProcess === null) return false;
    const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
    checkTicket(task, ticket);
    const observation = await reconcileSubmittedControllerLaunch({ journalFile: path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite"), ticket, spawnProof: execution.controllerProcess, signal: new AbortController().signal });
    if (observation.kind === "unknown") throw new Error("Controller credential renewal cannot determine cleanup process status.", { cause: observation.cause });
    if (observation.kind === "running-unobserved" || observation.kind === "pre-writer-exited") return false;
    const saved = observation.snapshot;
    return saved.controllerProcess !== null && (process.platform === "win32"
      ? await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses, undefined, await options.jobLeases?.get(ticket.launchId))
      : await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses));
  };
  const prepareExistingTicket = async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal, canAdmitNewExecution?: () => boolean): Promise<ControllerLaunchTicket> => {
    await prepareExistingSelection(input, ticket, signal, canAdmitNewExecution);
    let original = current(input);
    if (original.webExecution!.ticketPath === null || original.webExecution!.nativeHome === null) {
      original = options.store.updateWebExecution(original, { ticketPath: controllerTicketPath(options.homeDirectory, ticket.launchId), nativeHome: ticket.nativeHome }, options.now());
    }
    if (original.webExecution!.launchSubmission !== "not-submitted") return ticket;
    const binding = currentLifecycleBinding();
    const needsReplacement = controllerLaunchNeedsReplacement(options.homeDirectory, ticket);
    if (!needsReplacement && (binding === undefined || controllerPayloadHash(ticket.lifecycleBinding ?? null) === controllerPayloadHash(binding))) return ticket;
    if (binding === undefined) throw new Error("Task launch replacement requires current Worker lifecycle authorization.");
    const assertPending = (): void => {
      signal.throwIfAborted(); assertWorkerLifecycleAdmission(); assertConfigurationAdmission(canAdmitNewExecution);
      controllerLaunchNeedsReplacement(options.homeDirectory, ticket);
      const task = current(original), execution = task.webExecution!;
      checkTicket(task, ticket);
      // Missing observation alone does not imply dispatch. Keep that report and
      // require independent submission, reservation and journal evidence below.
      if (task.status !== "active" || task.cleanup !== null || task.control !== null
        || controllerPayloadHash([task.webExecution, task.configuration, task.resources, task.recovery]) !== controllerPayloadHash([original.webExecution, original.configuration, original.resources, original.recovery])
        || execution.launchSubmission !== "not-submitted" || execution.controllerProcess !== null || execution.nativeProcesses.length !== 0
        || execution.restartAfterShutdown || execution.cleanupOperationId !== null
        || execution.startupReport !== undefined && execution.startupReport.startup.state !== "starting"
          && !(execution.startupReport.startup.state === "unknown" && execution.startupReport.startup.reasonCode === "evidence_missing")
          && !(execution.startupReport.startup.state === "failed" && execution.startupReport.startup.reasonCode === "controller_launch_failed")
        || binding.serverOrigin !== task.serverOrigin || binding.userId !== task.userId || binding.workerId !== task.workerId) throw new Error("Task launch replacement requires proven never-submitted execution.");
      const previous = readControllerSnapshot(path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite"));
      if (execution.executionGeneration === "1") {
        if (previous !== null || task.resources.nativeSession !== null || execution.initialInputState !== "not_submitted") throw new Error("Task launch replacement cannot discard original execution evidence.");
      } else if (previous === null || previous.executionId !== execution.executionId || previous.claimId !== task.claimId || previous.sessionId !== execution.sessionId
        || String(BigInt(previous.executionGeneration) + 1n) !== execution.executionGeneration || previous.controllerInstanceId === execution.controllerInstanceId
        || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession?.sessionId
        || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null || previous.controllerProcess === null) {
        throw new Error("Task launch replacement requires its original stopped recovery generation.");
      }
    };
    assertPending();
    const launchId = randomUUID();
    const replacement: ControllerLaunchTicket = { ...ticket, schemaVersion: 2, lifecycleBinding: { ...binding }, launchId,
      ipcEndpoint: await prepareControllerIpcEndpoint(options.homeDirectory, launchId), ipcSecret: randomBytes(32).toString("hex") };
    assertPending();
    // Publish immutable ticket and tool evidence before atomically switching the
    // saved attempt. An interruption cannot rewrite or revive the old reservation.
    await writeLaunchTicket(options.homeDirectory, replacement);
    syncDurableDirectory(path.dirname(controllerTicketPath(options.homeDirectory, launchId)));
    if (ticket.provider !== "claude" && ticket.configuration.toolLaunch === undefined) {
      const selection = await readLaunchToolSelection(options.homeDirectory, ticket);
      if (selection === undefined) throw missingSelection(original);
      await writeLaunchToolSelection(options.homeDirectory, replacement, selection, assertPending);
    }
    assertPending();
    const updated = options.store.replaceUnsubmittedWebLaunch(original, launchId, options.homeDirectory, options.now());
    const saved = await readLaunchTicket(options.homeDirectory, updated.webExecution!.launchId);
    checkTicket(current(updated), saved);
    return saved;
  };
  const methods = {
    prepare: async (input: LocalTask, prompt: string | (() => string), signal: AbortSignal, canAdmitNewExecution?: () => boolean): Promise<ControllerLaunchTicket> => {
      let task = current(input); let execution = task.webExecution!;
      if (execution.ticketPath !== null) return prepareExistingTicket(task, await readLaunchTicket(options.homeDirectory, execution.launchId), signal, canAdmitNewExecution);
      let existing: ControllerLaunchTicket | undefined;
      try { existing = await readLaunchTicket(options.homeDirectory, execution.launchId); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (existing !== undefined) {
        if (existing.executionId !== execution.executionId || existing.claimId !== task.claimId || existing.executionGeneration !== execution.executionGeneration || existing.controllerInstanceId !== execution.controllerInstanceId || existing.initialOperationId !== execution.initialOperationId || existing.sessionId !== execution.sessionId || existing.initialPrompt !== execution.initialPrompt) throw new Error("An existing launch ticket does not match the durable execution intent.");
        return await prepareExistingTicket(task, existing, signal, canAdmitNewExecution);
      }
      if (task.resources.worktree === null || task.configuration === null || task.userId === null) throw new Error("Controller launch requires its original worktree, provider and owner.");
      if (task.configuration.agent !== "claude" && task.configuration.toolLaunch === undefined) {
        assertUnsubmitted(task);
        const selected = await options.selectToolLaunch?.(task.configuration.agent, signal);
        if (selected === undefined) throw missingSelection(task);
        signal.throwIfAborted(); assertUnsubmitted(task);
        const observation = options.toolObservationFor?.(selected);
        assertConfigurationAdmission(canAdmitNewExecution);
        task = options.store.freezeToolLaunch(task, selected, options.now(), observation === undefined ? {} : { observation });
        execution = task.webExecution!;
      }
      assertConfigurationAdmission(canAdmitNewExecution);
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
      const lifecycleBinding = currentLifecycleBinding();
      const ticket: ControllerLaunchTicket = { schemaVersion: lifecycleBinding === undefined ? 1 : 2, ...(lifecycleBinding === undefined ? {} : { lifecycleBinding: { ...lifecycleBinding } }), launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId, provider: task.configuration.agent, cwd: task.resources.worktree.worktreePath, nativeHome, configuration: task.configuration, initialOperationId: execution.initialOperationId, initialPrompt, resumeNativeSessionId: task.resources.nativeSession?.sessionId ?? null, credentialFile, ipcEndpoint, ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(options.now()).toISOString() };
      try { serializeLaunchTicket(ticket); }
      catch (error) {
        if (error instanceof LaunchTicketLimitError) throw new PromptInputLimitError("web_ticket", error.actualBytes, error.maxBytes);
        throw error;
      }
      assertConfigurationAdmission(canAdmitNewExecution);
      // Freeze only the same complete ticket that passed both existing size checks.
      if (execution.initialPrompt === null) task = options.store.updateWebExecution(task, { initialPrompt }, options.now());
      const ticketPath = await writeLaunchTicket(options.homeDirectory, ticket);
      options.store.updateWebExecution(task, { ticketPath, initialPrompt }, options.now());
      return ticket;
    },
    launch: async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal, canAdmitNewExecution?: () => boolean): Promise<void> => {
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
          retainBirthCleanup: cleanup => {
            if (options.jobLeases === undefined) throw new Error("Controller launch has no ownership registry.");
            return options.jobLeases.retainBirthCleanup(ticket.launchId, cleanup);
          },
          onSubmitting: () => { assertConfigurationAdmission(canAdmitNewExecution); submitting = true; task = options.store.updateWebExecution(task, { launchSubmission: "unknown" }, options.now()); },
          onSpawned: (proof, ownership) => {
            task = options.store.updateWebExecution(task, { controllerProcess: proof }, options.now());
            if (ownership !== undefined) {
              if (options.jobLeases === undefined) throw new Error("Controller launch has no Job ownership registry.");
              options.jobLeases.adopt(ticket.launchId, proof, ownership.lease, ownership.closeHandles);
            }
          },
          onObserved: async snapshot => {
            if (process.platform === "win32") {
              const proof = current(task).webExecution!.controllerProcess;
              if (snapshot.controllerProcess !== null) {
                if (proof === null || !preservesControllerProcessProof(proof, snapshot.controllerProcess, ticket.launchId)) throw new Error("The observed Web controller conflicts with its spawn proof.");
                await options.jobLeases?.retain(ticket.launchId, proof, Date.now() + 10_000);
              }
            }
            options.store.updateWebExecution(task, { launchSubmission: "acknowledged", nativeProcesses: snapshot.nativeProcesses }, options.now()); acknowledged = true;
          },
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
