import { resolveBotControllerStateDirectory, resolveBotPaths } from "./paths.js";
import { lstat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { prepareControllerIpcEndpoint } from "../../controller/paths.js";
import { readControllerSnapshot, readCurrentControllerSnapshot, readCurrentControllerInventorySnapshot, readHistoricalStoppedControllerGeneration, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { isLinuxControllerLaunch } from "../../controller/linux-controller-launch.js";
import { readUnreleasedLaunch, unreleasedLaunchPath, UnreleasedLaunchReceiptDurabilityError } from "../../controller/unreleased-launch.js";
import type { ControllerProcessProof } from "../../controller/process-proof.js";
import type { BotExecution } from "./execution-store.js";
import { ControllerIpcOutcomeUnknownError, LegacyWorkerControllerError, requestController } from "../../controller/local-client.js";
import { ControllerBootstrapReplacedError, ControllerLaunchJournalObservationError, hasUnsafeControllerObservationFailure, isControllerJournalIoFailure, isControllerEvidenceReadIoFailure, reconcileSubmittedControllerLaunch, stopControllerBootstrap } from "../../controller/launch-observation.js";
import { confirmControllerProcessesStopped, stopControllerProcesses } from "../../controller/process-proof.js";
import { ControllerStartupError } from "../../controller/startup.js";
import { parseProviderArguments } from "../../controller/providers/projection.js";
import { createControllerExecutionSerializer, launchControllerProcess, observeControllerProcess } from "../backends/controller-process.js";
import { preservesControllerProcessProof, preservesNativeProcessPrefix } from "../backends/orchestration.js";
import { controllerCredentialNeedsRefresh } from "../backends/grant-renewal.js";
import { writeControllerCredential } from "../backends/session-api.js";
import { BotEnvironmentCleanupError, prepareBotEnvironment, type PreparedBotEnvironment } from "./environment.js";
import { selectBotRole } from "./instructions.js";
import { validateBotExecutionSnapshot, type BotExecutionStore } from "./execution-store.js";
import type { BotStore } from "./store.js";
import type { BotDeletionStop, BotSessionApi } from "./session-api.js";
import type { BotRecord } from "./types.js";
import { botNativeConfiguration } from "./configuration.js";
import { readLaunchToolSelection, writeLaunchToolSelection } from "../../controller/launch-tool-selection.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { FrozenToolObservation } from "../types.js";
import { createControllerJobLeases, type ControllerJobLeases } from "../backends/controller-job-leases.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld, type ControllerStoragePermit } from "../../controller/storage-lock.js";
import { ControllerStorageWaitingError, prepareControllerStorage } from "../../controller/storage-preparation.js";
import { SqliteAccessError } from "../../../platform/sqlite-error.js";
import { assertBotMigrationExecutable } from "./migration-state.js";

export class BotAdmissionBlockedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Bot initialization is waiting for Worker configuration.", options);
    this.name = "BotAdmissionBlockedError";
  }
}
export class BotExecutionEvidenceMissingError extends Error {
  constructor(options?: ErrorOptions) {
    super(`execution_evidence_missing: The original Bot execution submission or stop evidence is unavailable.${options?.cause instanceof Error ? ` ${options.cause.message}` : ""}`, options);
    this.name = "BotExecutionEvidenceMissingError";
  }
}
class BotReceiptReadIoError extends Error {
  constructor(cause: unknown) { super("Bot unreleased receipt could not be read.", { cause }); }
}
const waitForReceiptObservation = <T>(observation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
  observation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

const blockedAdmission = (cause: unknown): BotAdmissionBlockedError | undefined => {
  const seen = new Set<unknown>();
  let current = cause;
  while (current instanceof Error && !(current instanceof AggregateError) && !seen.has(current)) {
    if (current instanceof BotAdmissionBlockedError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
};

/** Execution handles retain original identities; callers hold the Worker instance lock. */
export const createBotProcess = (options: {
  homeDirectory: string; packageDirectory: string; store: BotStore; executions: BotExecutionStore;
  sessionApi: Omit<BotSessionApi, "registerRecovery">; recoveryLimit: number | (() => number); now?: () => number;
  reconcileHosting?: (record: BotRecord) => boolean;
  canControl?: (record: BotRecord) => boolean;
  canAdmitNewExecution(): boolean;
  selectToolLaunch?: (agent: "codex" | "copilot", signal: AbortSignal) => Promise<ResolvedToolLaunch>;
  jobLeases?: ControllerJobLeases;
  toolObservationFor?: (launch: ResolvedToolLaunch) => FrozenToolObservation | undefined;
  dependencies?: { prepareEnvironment?: typeof prepareBotEnvironment; launch?: typeof launchControllerProcess; observe?: typeof observeControllerProcess; readSnapshot?: typeof readControllerSnapshot; confirmStopped?: typeof confirmControllerProcessesStopped; stopProcesses?: typeof stopControllerProcesses; recordStopped?: typeof recordStoppedControllerGeneration; request?: typeof requestController; reconcileLaunch?: typeof reconcileSubmittedControllerLaunch; stopBootstrap?: typeof stopControllerBootstrap; prepareStorage?: typeof prepareControllerStorage; inspectUnreleasedPath?: (file: string) => Promise<unknown> };
}) => {
  const now = options.now ?? Date.now, serialize = createControllerExecutionSerializer();
  const environments = new Map<string, PreparedBotEnvironment>();
  const jobLeases = options.jobLeases ?? createControllerJobLeases();
  const retainJob = async (launchId: string, proof: ControllerProcessProof, deadline: number) => {
    if (!jobLeases.enabled) return;
    if (isLinuxControllerLaunch(proof)) throw new Error("Linux Controller identity cannot own a Windows Job.");
    await jobLeases.retain(launchId, proof, deadline);
  };
  const confirmWithLease = async (ticket: ControllerLaunchTicket, file: string, controller: Parameters<typeof confirmControllerProcessesStopped>[0], native: Parameters<typeof confirmControllerProcessesStopped>[1], deadline?: number, snapshot?: ControllerSnapshot) => {
    if (isLinuxControllerLaunch(controller) && snapshot !== undefined) {
      const historical = readHistoricalStoppedControllerGeneration(file, ticket, deadline ?? Date.now() + 5000);
      if (historical !== null) {
        if (controllerPayloadHash(historical) !== controllerPayloadHash(snapshot) || !preservesControllerProcessProof(controller, historical.controllerProcess, ticket.launchId) || controllerPayloadHash(native) !== controllerPayloadHash(historical.nativeProcesses)) throw new Error("Bot durable stop proof conflicts with its original execution evidence.");
        return true;
      }
    }
    if (!jobLeases.enabled) return deadline === undefined ? confirmStopped(controller, native) : confirmStopped(controller, native, deadline);
    const lease = await jobLeases.get(ticket.launchId);
    if (lease === undefined && snapshot?.lifecycle === "stopped" && snapshot.nativeStopped) {
      const proven = readProvenWindowsStoppedControllerGeneration(file, ticket, deadline);
      if (JSON.stringify(proven) !== JSON.stringify(snapshot) || !preservesControllerProcessProof(controller, proven.controllerProcess, ticket.launchId) || JSON.stringify(native) !== JSON.stringify(proven.nativeProcesses)) throw new Error("Bot durable stop proof conflicts with its original execution evidence.");
      return true;
    }
    return confirmStopped(controller, native, deadline, lease);
  };
  const stopWithLease = async (launchId: string, controller: Parameters<typeof stopControllerProcesses>[0], native: Parameters<typeof stopControllerProcesses>[1], deadline: number) => jobLeases.enabled
    ? stopProcesses(controller, native, deadline, await jobLeases.get(launchId)) : stopProcesses(controller, native, deadline);
  const recordWithLease = async (file: string, ticket: ControllerLaunchTicket, deadline?: number, permit?: ControllerStoragePermit, signal?: AbortSignal) => {
    const jobLease = jobLeases.enabled ? await jobLeases.get(ticket.launchId) : undefined;
    return recordStopped(file, ticket, {
      ...(deadline === undefined ? {} : { deadline }), ...(permit === undefined ? {} : { permit }),
      ...(signal === undefined ? {} : { signal }), ...(jobLease === undefined ? {} : { jobLease }),
    });
  };
  const pendingCleanup = new Map<string, BotEnvironmentCleanupError>();
  const initialUnsubmitted = (record: BotRecord): boolean => {
    const execution = record.intent === null ? null : options.executions.get(record);
    return record.intent?.nativeSessionId == null && (execution === null || execution.launchSubmission === "not-submitted");
  };
  const checkAdmission = (input: BotRecord): void => {
    if (initialUnsubmitted(current(input)) && !options.canAdmitNewExecution()) throw new BotAdmissionBlockedError();
  };
  const environment = options.dependencies?.prepareEnvironment ?? prepareBotEnvironment;
  const launch = options.dependencies?.launch ?? launchControllerProcess, observe = options.dependencies?.observe ?? observeControllerProcess;
  const readSnapshot = options.dependencies?.readSnapshot ?? readControllerSnapshot;
  const confirmStopped = options.dependencies?.confirmStopped ?? confirmControllerProcessesStopped;
  const stopProcesses = options.dependencies?.stopProcesses ?? stopControllerProcesses;
  const recordStopped = options.dependencies?.recordStopped ?? recordStoppedControllerGeneration;
  const request = options.dependencies?.request ?? requestController;
  const reconcileLaunch = options.dependencies?.reconcileLaunch ?? reconcileSubmittedControllerLaunch;
  const stopBootstrap = options.dependencies?.stopBootstrap ?? stopControllerBootstrap;
  const prepareStorage = options.dependencies?.prepareStorage ?? prepareControllerStorage;
  const prepareRecoveryStorage = async (record: BotRecord, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<ControllerSnapshot> => {
    signal.throwIfAborted();
    const journalFile = record.intent!.journalPath;
    let permit: ControllerStoragePermit;
    try { permit = acquireControllerStoragePermit(journalFile); }
    catch (cause) {
      if (isControllerStorageLockHeld(cause) && cause instanceof Error) throw new ControllerStorageWaitingError("lock_busy", cause);
      throw cause;
    }
    let failure: unknown, failed = false, stoppedCommitted = false;
    try {
      const stopped = await recordWithLease(journalFile, ticket, undefined, permit, signal);
      stoppedCommitted = true;
      options.executions.update(record, { snapshot: stopped });
      signal.throwIfAborted();
      const prepared = prepareStorage({ journalFile, mode: "stopped-maintenance", ticket }, permit);
      if (prepared.kind === "waiting") throw new ControllerStorageWaitingError(prepared.reason, prepared.cause);
      return stopped;
    } catch (cause) { failed = true; failure = cause; throw cause; }
    finally {
      if (!failed || !controllerStorageConnectionIsOpen(failure)) {
        try { permit.release(); }
        catch (release) {
          const cause = failed ? new AggregateError([failure, release], "Bot storage preparation and ownership release failed.", { cause: failure }) : release;
          if (stoppedCommitted) throw new SqliteAccessError("cleanup-failed", { database: "controller-journal", file: journalFile, phase: "release" }, { cause, outcome: "committed", connectionClosed: true });
          throw cause;
        }
      }
    }
  };
  const current = (input: BotRecord, stopping = false): BotRecord => {
    const record = options.store.get(input.owner, input.botId);
    if (record === null || !stopping && record.observed.deletion !== null || record.definition === null) throw new Error("Bot execution requires its original active definition.");
    assertBotMigrationExecutable(record);
    return record;
  };
  const checkedTicket = async (record: BotRecord): Promise<ControllerLaunchTicket> => {
    const intent = record.intent;
    if (intent === null || intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot launch intent is incomplete.");
    const ticket = await readLaunchTicket(options.homeDirectory, intent.launchId, resolveBotControllerStateDirectory(options.homeDirectory, record)), config = record.definition!.resolvedConfiguration, native = botNativeConfiguration(config);
    const { toolLaunch, toolObservation, ...configuration } = ticket.configuration;
    if (ticket.botId !== undefined && ticket.botId !== record.botId) throw new Error("Controller ticket belongs to another Bot.");
    if (ticket.codexBotRecovery !== undefined && (ticket.codexBotRecovery.botId !== record.botId
      || ticket.codexBotRecovery.directory !== resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).codexRecoveryDirectory)) throw new Error("Bot Codex recovery location conflicts with its original ownership.");
    if (ticket.claudeBotRecovery !== undefined && (ticket.claudeBotRecovery.botId !== record.botId
      || ticket.claudeBotRecovery.directory !== resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).claudeRecoveryDirectory)) throw new Error("Bot Claude recovery location conflicts with its original ownership.");
    if (ticket.copilotBotRecovery !== undefined && (ticket.copilotBotRecovery.botId !== record.botId
      || ticket.copilotBotRecovery.directory !== resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).copilotRecoveryDirectory)) throw new Error("Bot Copilot recovery location conflicts with its original ownership.");
    if (toolLaunch !== undefined && (intent.toolLaunch === undefined || controllerPayloadHash(toolLaunch) !== controllerPayloadHash(intent.toolLaunch))
      || toolObservation !== undefined && (intent.toolObservation === undefined || controllerPayloadHash(toolObservation) !== controllerPayloadHash(intent.toolObservation))) throw new Error("Bot ticket tool selection differs from the original frozen intent.");
    if (config.selection !== undefined) {
      const requiresSelection = native.model !== null || parseProviderArguments(config.provider, native.args, true).effort !== undefined;
      if ((ticket.configuration.validateNativeSelection === true) !== requiresSelection) throw new Error("Bot ticket selection validation conflicts with its frozen configuration.");
    }
    if (ticket.testExecutionId !== intent.executionId || ticket.executionId !== intent.executionId || ticket.sessionId !== intent.sessionId
      || ticket.controllerId !== intent.registration.controllerId || ticket.controllerInstanceId !== intent.controllerInstanceId
      || ticket.executionGeneration !== intent.executionGeneration || ticket.ownerUserId !== record.owner.ownerUserId || ticket.serverOrigin !== record.owner.serverOrigin
      || ticket.provider !== config.provider || ticket.cwd !== config.cwd || ticket.initialInput !== "none" || ticket.initialPrompt !== ""
      || ticket.resumeNativeSessionId !== intent.nativeSessionId
      || ticket.initialOperationId !== intent.initialOperationId || ticket.instructions !== intent.roleConfiguration.instructions || ticket.credentialFile !== intent.credentialFile
      || controllerPayloadHash(configuration) !== controllerPayloadHash({ agent: config.provider, agentControlMode: "web", model: native.model, args: native.args, recoveryLimit: intent.recoveryLimit, ...(ticket.configuration.validateNativeSelection === true ? { validateNativeSelection: true } : {}) })) throw new Error("Bot ticket conflicts with the original frozen execution intent.");
    return ticket;
  };
  const settleUnreleased = async (record: BotRecord, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<boolean> => {
    const execution = options.executions.get(record);
    if (execution === null || execution.launchSubmission === "not-submitted") return false;
    const storage = resolveBotControllerStateDirectory(options.homeDirectory, record);
    let receipt;
    try { receipt = await waitForReceiptObservation(readUnreleasedLaunch(options.homeDirectory, ticket, storage), signal); }
    catch (error) {
      if (!(error instanceof UnreleasedLaunchReceiptDurabilityError) && isControllerEvidenceReadIoFailure(error)) throw new BotReceiptReadIoError(error);
      throw error;
    }
    if (receipt === undefined) {
      if (execution.unreleased !== undefined) throw new Error("Bot unreleased launch receipt is missing; execution evidence is retained.");
      return false;
    }
    signal.throwIfAborted();
    if (execution.unreleased !== undefined && controllerPayloadHash(execution.unreleased) !== controllerPayloadHash(receipt)
      || execution.controllerProcess !== null && execution.controllerProcess.pid !== receipt.pid || execution.snapshot !== null) throw new Error("Bot unreleased launch receipt conflicts with saved process evidence.");
    const deadline = Date.now() + 10_000;
    try {
      await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 });
      throw new Error("Bot unreleased launch conflicts with authenticated Controller IPC.");
    } catch (error) {
      signal.throwIfAborted();
      const cause = error instanceof ControllerIpcOutcomeUnknownError ? error.cause : undefined;
      if (!(cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ECONNREFUSED"))) throw error;
    }
    const previous = execution.previous;
    const previousTicket = previous === null ? null : await readLaunchTicket(options.homeDirectory, previous.launchId, storage);
    if (previousTicket !== null && (previousTicket.executionId !== ticket.executionId || previousTicket.testExecutionId !== ticket.testExecutionId
      || previousTicket.sessionId !== ticket.sessionId || previousTicket.executionGeneration !== previous!.generation
      || previousTicket.controllerInstanceId !== previous!.instanceId || previousTicket.resumeNativeSessionId !== null && previousTicket.resumeNativeSessionId !== ticket.resumeNativeSessionId)) throw new Error("Bot preceding ticket conflicts with unreleased launch.");
    const currentJournal = readCurrentControllerInventorySnapshot(record.intent!.journalPath, previousTicket === null ? [ticket] : [ticket, previousTicket], deadline);
    if (currentJournal !== null) {
      if (previousTicket === null || currentJournal.ticket.launchId !== previousTicket.launchId) throw new Error("Bot unreleased launch conflicts with its current journal.");
      const saved = currentJournal.snapshot;
      if (saved.lifecycle !== "stopped" || !saved.nativeStopped || saved.stoppedAt !== previous!.stoppedAt || saved.nativeSessionId !== ticket.resumeNativeSessionId) throw new Error("Bot unreleased launch conflicts with preceding stop evidence.");
      if (saved.controllerProcess !== null && isLinuxControllerLaunch(saved.controllerProcess)) {
        const historical = readHistoricalStoppedControllerGeneration(record.intent!.journalPath, previousTicket, deadline);
        if (historical === null || controllerPayloadHash(historical) !== controllerPayloadHash(saved)) throw new Error("Bot preceding Controller stop is unproven.");
      }
    } else if (previous !== null) throw new Error("Bot preceding Controller journal is unavailable.");
    signal.throwIfAborted();
    options.executions.update(record, { unreleased: receipt });
    return true;
  };
  const historicalStop = (record: BotRecord, ticket: ControllerLaunchTicket, execution: BotExecution, deadline = Date.now() + 10_000, maxBusyMs?: number): ControllerSnapshot | null => {
    if (!isLinuxControllerLaunch(execution.controllerProcess)) return null;
    const saved = maxBusyMs === undefined ? readHistoricalStoppedControllerGeneration(record.intent!.journalPath, ticket, deadline)
      : readHistoricalStoppedControllerGeneration(record.intent!.journalPath, ticket, deadline, { maxBusyMs });
    if (saved === null) return null;
    validateBotExecutionSnapshot(record, saved);
    if (!preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
      || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], saved.nativeProcesses)
      || execution.snapshot?.nativeSessionId != null && execution.snapshot.nativeSessionId !== saved.nativeSessionId) throw new Error("Bot historical stop conflicts with its original process evidence.");
    return saved;
  };
  const missingSelection = (record: BotRecord): ToolSelectionError => new ToolSelectionError(record.definition!.resolvedConfiguration.provider as "codex" | "copilot", "web", "launch", "legacy_tool_identity_missing");
  const assertUnsubmitted = (input: BotRecord): BotRecord => {
    const record = current(input), intent = record.intent!, execution = options.executions.get(record);
    if (intent.launchId !== input.intent!.launchId || intent.executionGeneration !== "1" || intent.nativeSessionId !== null
      || execution !== null && (execution.launchSubmission !== "not-submitted" || execution.controllerProcess !== null || execution.snapshot !== null
        || execution.recoveryCount !== 0 || execution.restartAfterShutdown || execution.previous !== null || execution.retainedLaunchIds.length !== 0)
      || readSnapshot(intent.journalPath) !== null) throw missingSelection(record);
    return record;
  };
  const freezePendingSelection = async (input: BotRecord, signal: AbortSignal): Promise<BotRecord> => {
    let record = current(input);
    const provider = record.definition!.resolvedConfiguration.provider;
    if (provider === "claude") return record;
    let ticket: ControllerLaunchTicket | undefined;
    try { await readLaunchTicket(options.homeDirectory, record.intent!.launchId, resolveBotControllerStateDirectory(options.homeDirectory, record)); ticket = await checkedTicket(record); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    let selected = ticket === undefined ? record.intent!.toolLaunch : await readLaunchToolSelection(options.homeDirectory, ticket, resolveBotControllerStateDirectory(options.homeDirectory, record));
    if (selected === undefined) {
      record = assertUnsubmitted(record);
      selected = record.intent!.toolLaunch ?? await options.selectToolLaunch?.(provider, signal);
      if (selected === undefined) throw missingSelection(record);
      signal.throwIfAborted(); assertUnsubmitted(record);
      checkAdmission(record);
      if (ticket !== undefined) await writeLaunchToolSelection(options.homeDirectory, ticket, selected, () => { assertUnsubmitted(record); }, resolveBotControllerStateDirectory(options.homeDirectory, record));
    }
    if (record.intent!.toolLaunch === undefined) {
      assertUnsubmitted(record);
      checkAdmission(record);
      options.store.freezeToolLaunch(record, selected, options.toolObservationFor?.(selected));
      record = current(record);
    } else if (record.intent!.toolLaunch.selectionKey !== selected.selectionKey) throw new Error("The original Bot ticket tool selection differs from its frozen intent.");
    return record;
  };
  const sessionRecord = (record: BotRecord): BotRecord => {
    const execution = record.intent === null ? null : options.executions.get(record);
    const nativeSessionId = execution?.snapshot?.nativeSessionId ?? record.intent?.nativeSessionId ?? null;
    return record.intent === null ? record : { ...record, intent: { ...record.intent, nativeSessionId } };
  };
  const remember = (input: BotRecord, snapshot: ControllerSnapshot): ControllerSnapshot => {
    options.executions.update(current(input, true), { launchSubmission: "acknowledged", snapshot, ...(snapshot.startup === undefined ? {} : { startup: snapshot.startup }), lastError: snapshot.error });
    return snapshot;
  };
  const prepareEnvironment = async (record: BotRecord, signal: AbortSignal): Promise<PreparedBotEnvironment> => {
    const cleanup = pendingCleanup.get(record.botId);
    if (cleanup !== undefined) { await cleanup.retryCleanup(); pendingCleanup.delete(record.botId); }
    const retained = environments.get(record.botId);
    if (retained !== undefined) return retained;
    const config = record.definition!.resolvedConfiguration;
    parseProviderArguments(config.provider, botNativeConfiguration(config).args, config.selection !== undefined);
    try {
      const prepared = await environment({ homeDirectory: options.homeDirectory, cwd: config.cwd, workerPaths: resolveConfigurationPaths(options.homeDirectory), serverOrigin: record.owner.serverOrigin, ownerUserId: record.owner.ownerUserId, botId: record.botId, signal });
      environments.set(record.botId, prepared);
      return prepared;
    } catch (error) {
      if (error instanceof BotEnvironmentCleanupError) pendingCleanup.set(record.botId, error);
      throw error;
    }
  };
  const advance = async (input: BotRecord, signal: AbortSignal): Promise<ControllerSnapshot> => {
    let record = current(input);
    const prior = record.intent === null ? null : options.executions.get(record);
    checkAdmission(record);
    if (prior !== null && prior.launchSubmission !== "not-submitted") {
      const ticket = await checkedTicket(record);
      if (await settleUnreleased(record, ticket, signal)) {
        await releaseEnvironment(record.botId);
        throw new Error("Bot controller launch was confirmed unreleased; the original ticket cannot be replayed.");
      }
      if (prior.startup?.state === "failed" && prior.snapshot?.nativeSessionId == null && record.intent?.nativeSessionId == null) throw new ControllerStartupError(prior.startup, prior.lastError ?? "The original Bot initialization failed.");
      if (prior.controllerProcess === null) {
        // Legacy records can still authenticate a live peer, but cannot prove stop
        // or authorize a replacement generation without the original process proof.
        let snapshot: ControllerSnapshot;
        try { snapshot = await observe(ticket, signal); }
        catch (cause) {
          signal.throwIfAborted();
          if (!(cause instanceof ControllerIpcOutcomeUnknownError)) throw cause;
          throw new Error("Bot original spawn proof is unavailable; launch reconciliation is blocked.", { cause });
        }
        if (snapshot.sessionId !== ticket.sessionId) throw new Error("Bot controller IPC session identity mismatch.");
        if (["starting", "ready", "working"].includes(snapshot.lifecycle) && !snapshot.nativeStopped) {
          const observed = remember(record, snapshot);
          options.executions.resumeObserved(record);
          if (options.reconcileHosting?.(record)) await writeControllerCredential(ticket.credentialFile, await options.sessionApi.grant(sessionRecord(current(record)), signal));
          return observed;
        }
        throw new Error("Bot original spawn proof is unavailable; launch reconciliation is blocked.");
      }
      const reconcileOriginal = () => reconcileLaunch({ journalFile: record.intent!.journalPath, ticket, spawnProof: prior.controllerProcess!, signal });
      const historical = historicalStop(record, ticket, prior);
      let observation = historical === null ? await reconcileOriginal() : { kind: "controller-exited" as const, process: prior.controllerProcess, snapshot: historical };
      if (observation.kind === "observed" && observation.workerLifecycleProtocol === 1) {
        try {
          await shutdown(record, signal);
          signal.throwIfAborted();
          observation = await reconcileOriginal();
          if (observation.kind !== "controller-exited") throw new Error("Original Controller exit could not be verified after shutdown.");
        } catch (cause) {
          signal.throwIfAborted();
          throw new LegacyWorkerControllerError(ticket, { cause });
        }
      }
      if (observation.kind === "observed") {
        await retainJob(ticket.launchId, prior.controllerProcess, Date.now() + 10_000);
        const observed = remember(record, observation.snapshot);
        if (["starting", "ready", "working"].includes(observed.lifecycle) && !observed.nativeStopped) {
          options.executions.resumeObserved(record);
          if (options.reconcileHosting?.(record)) await writeControllerCredential(ticket.credentialFile, await options.sessionApi.grant(sessionRecord(current(record)), signal));
          return observed;
        }
        throw new Error("Bot original controller remains observable but is not available for recovery.");
      }
      if (observation.kind === "unknown") throw new Error("Bot original controller status is unknown; launch identity is retained.", { cause: observation.cause });
      if (observation.kind === "running-unobserved") throw new Error("Bot original controller is running without authenticated IPC; launch identity is retained.");
      if (observation.kind === "pre-writer-exited") throw new Error(`Bot original controller exited before committing its generation (${observation.journal}); launch is blocked.`);
      const saved = observation.snapshot;
      options.executions.update(record, { snapshot: saved });
      if (saved.controllerProcess === null || !await confirmWithLease(ticket, record.intent!.journalPath, saved.controllerProcess, saved.nativeProcesses, undefined, saved)) {
        throw new Error("Bot original writer stop is unproven; complete controller and native proof is required.");
      }
      if (saved.nativeSessionId === null) {
        if (saved.startup?.state === "failed") {
          options.executions.update(record, { startup: saved.startup, lastError: saved.error });
          throw new ControllerStartupError(saved.startup, saved.error ?? "Bot initialization failed before native session creation.");
        }
        throw new Error("Bot native session identity is missing; a blank replacement is forbidden.");
      }
      const toolLaunch = ticket.provider === "claude" ? undefined : record.intent!.toolLaunch ?? await readLaunchToolSelection(options.homeDirectory, ticket, resolveBotControllerStateDirectory(options.homeDirectory, record));
      if (ticket.provider !== "claude" && toolLaunch === undefined) throw missingSelection(record);
      const recovery = options.executions.get(record)!;
      if (recovery.recoveryBlocked !== null) throw new Error(recovery.recoveryBlocked);
      if (!(recovery.restartAfterShutdown && saved.error === null) && recovery.recoveryCount >= record.intent!.recoveryLimit) {
        const reason = "Bot execution recovery budget is exhausted.";
        options.executions.blockRecovery(record, reason);
        throw new Error(reason);
      }
      signal.throwIfAborted();
      const stopped = await prepareRecoveryStorage(record, ticket, signal);
      await jobLeases.release(ticket.launchId);
      signal.throwIfAborted();
      record = options.executions.beginRecovery(record, stopped, options.homeDirectory, toolLaunch);
      // A new launch must revalidate CLI owner/server configuration. Old aliases
      // remain listed in durable evidence for precise eventual deletion.
      environments.delete(record.botId);
    }
    // Preflight may report a failure and advance the Bot version. Freeze the first
    // registration only once the initial environment is known to be usable.
    const prepared = await prepareEnvironment(record, signal);
    try {
      checkAdmission(record);
      if (record.intent === null) {
        const provider = record.definition!.resolvedConfiguration.provider;
        const toolLaunch = provider === "claude" ? undefined : await options.selectToolLaunch?.(provider, signal);
        if (provider !== "claude" && toolLaunch === undefined) throw missingSelection(record);
        const toolObservation = toolLaunch === undefined ? undefined : options.toolObservationFor?.(toolLaunch);
        signal.throwIfAborted(); current(record);
        checkAdmission(record);
        options.store.prepare(record.owner, record.botId, { homeDirectory: options.homeDirectory, recoveryLimit: typeof options.recoveryLimit === "function" ? options.recoveryLimit() : options.recoveryLimit,
          ...(toolLaunch === undefined ? {} : { toolLaunch }), ...(toolObservation === undefined ? {} : { toolObservation }) });
      }
      record = current(record);
      record = await freezePendingSelection(record, signal);
      checkAdmission(record);
      options.store.freezeRole(record.owner, record.botId, selectBotRole({ serverRole: record.definition!.roleConfiguration, preparedRole: record.intent!.roleConfiguration }));
      record = current(record);
      options.executions.prepare(record);
      options.executions.update(record, { aliasDirectory: prepared.aliasDirectory });
      if (record.intent!.sessionId === null) {
        checkAdmission(record);
        const registered = await options.sessionApi.register(record, signal);
        options.store.observe(record.owner, registered.bot, now());
        record = current(record);
      }
      checkAdmission(record);
      let ticket: ControllerLaunchTicket;
      try { ticket = await checkedTicket(record); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const intent = record.intent!, config = record.definition!.resolvedConfiguration, native = botNativeConfiguration(config);
        if (intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot registration did not establish its frozen role and Session.");
        await mkdir(controllerExecutionDirectory(options.homeDirectory, intent.executionId, resolveBotControllerStateDirectory(options.homeDirectory, record)), { recursive: true, mode: 0o700 });
        const previous = options.executions.get(record)!.previous;
        const previousTicket = previous === null ? null : await readLaunchTicket(options.homeDirectory, previous.launchId, resolveBotControllerStateDirectory(options.homeDirectory, record));
        const nativeHome = previousTicket?.nativeHome ?? (config.provider === "codex" ? prepared.environment.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")
          : config.provider === "claude" ? prepared.environment.CLAUDE_CONFIG_DIR ?? path.join(options.homeDirectory, ".claude")
          : prepared.environment.COPILOT_HOME ?? path.join(options.homeDirectory, ".copilot"));
        ticket = { schemaVersion: 1, launchId: intent.launchId, executionId: intent.executionId, testExecutionId: intent.executionId,
          controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId, sessionId: intent.sessionId,
          executionGeneration: intent.executionGeneration, serverOrigin: record.owner.serverOrigin, ownerUserId: record.owner.ownerUserId, botId: record.botId,
          provider: config.provider, cwd: config.cwd, nativeHome, configuration: { agent: config.provider, agentControlMode: "web", model: native.model, args: native.args, recoveryLimit: intent.recoveryLimit,
            ...(intent.toolLaunch === undefined ? {} : { toolLaunch: intent.toolLaunch }), ...(intent.toolObservation === undefined ? {} : { toolObservation: intent.toolObservation }),
            ...(native.model !== null || parseProviderArguments(config.provider, native.args, config.selection !== undefined).effort !== undefined ? { validateNativeSelection: true as const } : {}) },
          ...(config.provider === "codex" && (previousTicket?.codexBotRecovery !== undefined || previousTicket === null && intent.nativeSessionId === null && resolveBotControllerStateDirectory(options.homeDirectory, record) !== undefined)
            ? { codexBotRecovery: previousTicket?.codexBotRecovery ?? { botId: record.botId, directory: resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).codexRecoveryDirectory } } : {}),
          ...(config.provider === "claude" && (previousTicket?.claudeBotRecovery !== undefined || previousTicket === null && intent.nativeSessionId === null && resolveBotControllerStateDirectory(options.homeDirectory, record) !== undefined)
            ? { claudeBotRecovery: previousTicket?.claudeBotRecovery ?? { botId: record.botId, directory: resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).claudeRecoveryDirectory } } : {}),
          ...(config.provider === "copilot" && (previousTicket?.copilotBotRecovery !== undefined || previousTicket === null && intent.nativeSessionId === null && resolveBotControllerStateDirectory(options.homeDirectory, record) !== undefined)
            ? { copilotBotRecovery: previousTicket?.copilotBotRecovery ?? { botId: record.botId, directory: resolveBotPaths(resolveConfigurationPaths(options.homeDirectory).stateDirectory, record.botId).copilotRecoveryDirectory } } : {}),
          initialInput: "none", initialOperationId: intent.initialOperationId, initialPrompt: "", instructions: intent.roleConfiguration.instructions, resumeNativeSessionId: intent.nativeSessionId,
          credentialFile: intent.credentialFile, ipcEndpoint: await prepareControllerIpcEndpoint(options.homeDirectory, intent.launchId, resolveBotControllerStateDirectory(options.homeDirectory, record)), ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(now()).toISOString() };
        await writeLaunchTicket(options.homeDirectory, ticket, resolveBotControllerStateDirectory(options.homeDirectory, record));
      }
      const previous = options.executions.get(current(record))!.previous;
      const stopProof = previous === null ? undefined : { generation: previous.generation, instanceId: previous.instanceId, recordId: previous.recordId, stoppedAt: previous.stoppedAt };
      checkAdmission(record);
      const grant = await options.sessionApi.grant(sessionRecord(current(record)), signal, stopProof);
      current(record); signal.throwIfAborted();
      checkAdmission(record);
      if (ticket.provider !== "claude" && (await readLaunchToolSelection(options.homeDirectory, ticket, resolveBotControllerStateDirectory(options.homeDirectory, record)))?.selectionKey !== record.intent!.toolLaunch?.selectionKey) throw missingSelection(record);
      checkAdmission(record);
      await writeControllerCredential(ticket.credentialFile, grant);
      record = current(record);
      checkAdmission(record);
      const storageStateDirectory = resolveBotControllerStateDirectory(options.homeDirectory, record);
      return await launch({ ...(storageStateDirectory === undefined ? {} : { storageStateDirectory }), homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, ticket, env: prepared.environment, signal,
        retainBirthCleanup: cleanup => jobLeases.retainBirthCleanup(ticket.launchId, cleanup),
        onSubmitting: () => { checkAdmission(record); options.executions.update(current(record), { launchSubmission: "unknown" }); },
        onSpawned: (proof, ownership) => {
          options.executions.update(current(record, true), { controllerProcess: proof });
          if (ownership !== undefined) {
            if (isLinuxControllerLaunch(proof)) throw new Error("Linux Controller identity cannot own a Windows Job.");
            jobLeases.adopt(ticket.launchId, proof, ownership.lease, ownership.closeHandles);
          }
        },
        onObserved: async snapshot => {
          if (jobLeases.enabled) {
            const proof = options.executions.get(current(record, true))?.controllerProcess;
            if (snapshot.controllerProcess !== null) {
              if (proof == null || !preservesControllerProcessProof(proof, snapshot.controllerProcess, ticket.launchId)) throw new Error("The observed Bot controller conflicts with its spawn proof.");
              await retainJob(ticket.launchId, proof, Date.now() + 10_000);
            }
          }
          remember(record, snapshot);
        },
      });
    } catch (error) {
      record = current(record, true);
      const execution = record.intent === null ? null : options.executions.get(record);
      const blocked = initialUnsubmitted(record) ? blockedAdmission(error) : undefined;
      if (execution !== null && blocked === undefined) options.executions.update(record, {
        lastError: error instanceof Error ? error.message : "Bot launch outcome is unknown.",
        ...(error instanceof ControllerStartupError ? { startup: error.observation } : {}),
      });
      if (execution === null || execution.launchSubmission === "not-submitted") {
        await prepared.release(); environments.delete(record.botId);
        if (execution !== null) options.executions.update(record, { aliasDirectory: null });
      }
      throw blocked === undefined || blocked === error ? error : new BotAdmissionBlockedError({ cause: error });
    }
  };
  const releaseEnvironment = async (botId: string): Promise<void> => {
    const pending = pendingCleanup.get(botId);
    if (pending !== undefined) { await pending.retryCleanup(); pendingCleanup.delete(botId); }
    const prepared = environments.get(botId);
    if (prepared !== undefined) { await prepared.release(); environments.delete(botId); }
  };
  const shutdown = async (input: BotRecord, signal: AbortSignal, onPrecheckStatus?: (complete: boolean) => void): Promise<void> => {
    const retained = options.store.get(input.owner, input.botId);
    if (retained === null) throw new Error("Bot shutdown lost its original inventory record.");
    // Migration required proven stop and fences every launch until takeover.
    if (retained.migration !== undefined) return;
    if (retained.intent === null) { await releaseEnvironment(retained.botId); return; }
    if (options.canControl?.(retained) === false) throw new Error("Bot hosting is unconfirmed; the original writer and recovery evidence are retained.");
    const record = current(retained, true);
    await jobLeases.cleanupBirth(record.intent!.launchId, Date.now() + 5000);
    const execution = options.executions.get(record);
    if (execution === null || execution.launchSubmission === "not-submitted") { await releaseEnvironment(record.botId); return; }
    const deadline = Date.now() + 10_000;
    const remaining = () => { const time = deadline - Date.now(); if (time <= 0) throw new Error("Bot cleanup exceeded its deadline; execution evidence is retained."); return time; };
    let originalTicket: ControllerLaunchTicket | undefined;
    let initialTicketReadFailure: unknown;
    let historicalReadFailure: ControllerLaunchJournalObservationError | undefined;
    let receiptReadFailure: unknown;
    try { originalTicket = await checkedTicket(record); }
    catch (error) {
      // I/O can be re-observed by the bounded path. A ticket or configuration
      // conflict must not be erased by a later successful read.
      if (!isControllerEvidenceReadIoFailure(error)) throw error;
      initialTicketReadFailure = error;
    }
    const checkUnreleased = async (ticket: ControllerLaunchTicket, cleanupSignal: AbortSignal): Promise<boolean> => {
      try { return await settleUnreleased(record, ticket, cleanupSignal); }
      catch (error) {
        if (!(error instanceof BotReceiptReadIoError)) throw error;
        receiptReadFailure = error.cause;
        // A recovered read must expose conflicting or settled evidence before
        // any stop. Persistent I/O permits only bounded identity-checked cleanup.
        try {
          if (await settleUnreleased(record, ticket, cleanupSignal)) throw receiptReadFailure;
        } catch (recheck) {
          if (recheck === receiptReadFailure) throw recheck;
          if (!(recheck instanceof BotReceiptReadIoError)) throw new AggregateError([receiptReadFailure, recheck], "Bot unreleased receipt could not be rechecked.", { cause: receiptReadFailure });
          receiptReadFailure = new AggregateError([receiptReadFailure, recheck.cause], "Bot unreleased receipt reads failed.");
          if (execution.unreleased !== undefined || execution.launchSubmission !== "acknowledged" || execution.controllerProcess === null || execution.snapshot?.controllerProcess == null
            || !preservesControllerProcessProof(execution.controllerProcess, execution.snapshot.controllerProcess, ticket.launchId)) throw receiptReadFailure;
          const file = unreleasedLaunchPath(options.homeDirectory, ticket, resolveBotControllerStateDirectory(options.homeDirectory, record));
          try {
            await waitForReceiptObservation((options.dependencies?.inspectUnreleasedPath ?? lstat)(file), AbortSignal.any([cleanupSignal, AbortSignal.timeout(remaining())]));
            throw new Error("Bot unreleased receipt exists but could not be read; execution evidence is retained.");
          } catch (probeError) {
            if (!(probeError instanceof Error && "code" in probeError && probeError.code === "ENOENT"))
              throw new AggregateError([receiptReadFailure, probeError], "Bot unreleased receipt presence is unconfirmed or conflicts with cleanup.", { cause: receiptReadFailure });
          }
        }
        return false;
      }
    };
    const checkHistorical = (ticket: ControllerLaunchTicket): ControllerSnapshot | null => {
      let historical: ControllerSnapshot | null = null;
      try { historical = historicalStop(record, ticket, execution, deadline, 1000); }
      catch (error) {
        // Identity and format conflicts remain refusals. Pure I/O failures use
        // the existing bounded stop path without discarding the original error.
        if (!isControllerEvidenceReadIoFailure(error)) throw error;
        historicalReadFailure = new ControllerLaunchJournalObservationError(new Error("Controller IPC was not observed after the historical journal read failed."), error);
      }
      if (historicalReadFailure !== undefined) try {
        // A recovered read must reject a newly visible conflict before any
        // signal; an already settled boundary needs no termination.
        const recovered = historicalStop(record, ticket, execution, deadline, 1000);
        if (recovered !== null) throw historicalReadFailure;
      } catch (error) {
        if (error === historicalReadFailure) throw error;
        if (!isControllerEvidenceReadIoFailure(error)) throw new AggregateError([historicalReadFailure, error], "Bot historical stop evidence could not be rechecked.", { cause: historicalReadFailure });
        historicalReadFailure = new ControllerLaunchJournalObservationError(new Error("Controller IPC was not observed after the historical journal read failed."), new AggregateError([historicalReadFailure.journalCause, error], "Bot historical journal reads failed."));
      }
      return historical;
    };
    if (originalTicket !== undefined) {
      if (await checkUnreleased(originalTicket, AbortSignal.timeout(remaining()))) { await releaseEnvironment(record.botId); return; }
      if (receiptReadFailure === undefined) onPrecheckStatus?.(true);
      let historical: ControllerSnapshot | null;
      try { historical = checkHistorical(originalTicket); }
      catch (error) { if (receiptReadFailure !== undefined) throw new AggregateError([receiptReadFailure, error], "Bot receipt and historical evidence failed.", { cause: receiptReadFailure }); throw error; }
      if (historical !== null && receiptReadFailure !== undefined) throw receiptReadFailure;
      if (historical !== null) { options.executions.update(record, { snapshot: historical }); await jobLeases.release(originalTicket.launchId); await releaseEnvironment(record.botId); return; }
    }
    if (execution.controllerProcess === null) {
      const missing = new Error("Bot shutdown has no original spawn proof; execution evidence is retained.");
      if (initialTicketReadFailure !== undefined) throw new AggregateError([initialTicketReadFailure, missing], "Bot shutdown cannot establish its original process evidence.", { cause: initialTicketReadFailure });
      if (receiptReadFailure !== undefined) throw new AggregateError([receiptReadFailure, missing], "Bot shutdown cannot establish its original process evidence.", { cause: receiptReadFailure });
      throw missing;
    }
    // Business cancellation cannot interrupt bounded cleanup after it starts.
    let cleanupSignal: AbortSignal;
    try { cleanupSignal = AbortSignal.timeout(remaining()); }
    catch (error) {
      if (initialTicketReadFailure !== undefined) throw new AggregateError([initialTicketReadFailure, error], "Bot ticket observation and cleanup deadline failed.", { cause: initialTicketReadFailure });
      if (receiptReadFailure !== undefined) throw new AggregateError([receiptReadFailure, error], "Bot receipt observation and cleanup deadline failed.", { cause: receiptReadFailure });
      if (historicalReadFailure !== undefined) throw new AggregateError([historicalReadFailure, error], "Bot historical observation and cleanup deadline failed.", { cause: historicalReadFailure });
      throw error;
    }
    let bootstrapAttempted = false, bootstrapCompleted = false, bootstrapStopBlocked = false, treeAttempted = false, treeEvidenceBlocked = false, leaseAttempted = false;
    let ticketReadFailure: unknown;
    let cleanupTicket: ControllerLaunchTicket | undefined, stopRequestFailure: { cause: unknown } | undefined;
    try {
      const ticket = await (async (): Promise<ControllerLaunchTicket> => {
        try { return await checkedTicket(record); }
        catch (error) {
          onPrecheckStatus?.(false);
          // A newly observed ticket conflict must not authorize even a single-PID
          // stop from the previously saved record. Pure read I/O retains the
          // original checked identity for bounded cleanup.
          const ioFailure = isControllerEvidenceReadIoFailure(error);
          if (originalTicket !== undefined) {
            if (ioFailure) { ticketReadFailure = error; return originalTicket; }
            bootstrapStopBlocked = true; treeEvidenceBlocked = true;
          }
          if (!ioFailure) { bootstrapStopBlocked = true; treeEvidenceBlocked = true; }
          throw error;
        }
      })();
      cleanupTicket = ticket;
      if (originalTicket === undefined && initialTicketReadFailure !== undefined) {
        try {
          if (await checkUnreleased(ticket, cleanupSignal) || checkHistorical(ticket) !== null) {
            bootstrapStopBlocked = true; treeEvidenceBlocked = true; throw initialTicketReadFailure;
          }
        } catch (error) {
          if (error !== initialTicketReadFailure) { bootstrapStopBlocked = true; treeEvidenceBlocked = true; }
          throw error;
        }
      }
      const before = await reconcileLaunch({ journalFile: record.intent!.journalPath, ticket, spawnProof: execution.controllerProcess, signal: cleanupSignal, deadline });
      remaining();
      if (before.kind === "controller-exited" || before.kind === "pre-writer-exited") bootstrapCompleted = true;
      if (before.kind === "pre-writer-exited") treeEvidenceBlocked = true;
      if (before.kind === "observed" || before.kind === "running-unobserved") { leaseAttempted = true; await retainJob(ticket.launchId, execution.controllerProcess, deadline); }
      if (before.kind === "observed") {
        const observed = before.snapshot;
        try {
          validateBotExecutionSnapshot(record, observed);
          if (observed.controllerProcess !== null && !preservesControllerProcessProof(execution.controllerProcess, observed.controllerProcess, ticket.launchId)
            || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], observed.nativeProcesses)
            || execution.snapshot?.nativeSessionId != null && observed.nativeSessionId !== execution.snapshot.nativeSessionId) throw new Error("Bot observation conflicts with the original process evidence.");
        } catch (error) { treeEvidenceBlocked = true; throw error; }
        if (execution.startup?.state === "failed") options.executions.update(record, { launchSubmission: "acknowledged", snapshot: observed });
        else remember(record, observed);
        const eligible = ["ready", "working"].includes(observed.lifecycle)
          && observed.error === null && observed.startup?.state === "ready" && !observed.nativeStopped;
        options.executions.markShutdown(record, eligible);
        try { await request(ticket, { kind: "stop", deadline }, { signal: cleanupSignal, timeoutMs: Math.min(2000, remaining()) }); }
        catch (error) { stopRequestFailure = { cause: error }; if (hasUnsafeControllerObservationFailure(error)) throw error; }
      }
      let observation = before, replacement: ControllerBootstrapReplacedError | undefined;
      if (before.kind === "observed" || before.kind === "running-unobserved") {
        bootstrapAttempted = true;
        try { await stopBootstrap(execution.controllerProcess, deadline); bootstrapCompleted = true; }
        catch (error) { if (!(error instanceof ControllerBootstrapReplacedError)) throw error; bootstrapCompleted = true; replacement = error; }
        try { observation = await reconcileLaunch({ journalFile: record.intent!.journalPath, ticket, spawnProof: execution.controllerProcess, signal: AbortSignal.timeout(remaining()), deadline }); remaining(); }
        catch (error) { if (replacement) throw new AggregateError([replacement, error], "Bot bootstrap replacement and launch classification failed.", { cause: error }); throw error; }
      }
      if (observation.kind === "unknown") { treeEvidenceBlocked = bootstrapCompleted; throw new Error("Bot shutdown cannot classify the original launch; evidence is retained.", { cause: replacement ? new AggregateError([replacement, observation.cause], "Bot bootstrap replacement and launch status are unconfirmed.") : observation.cause }); }
      if (observation.kind === "pre-writer-exited") treeEvidenceBlocked = true;
      if (observation.kind === "pre-writer-exited") throw new Error(`Bot controller exited before committing its generation (${observation.journal}); launch is blocked.`, { cause: replacement });
      if (observation.kind !== "controller-exited") { treeEvidenceBlocked = true; throw new Error("Bot original controller exit is unconfirmed; execution evidence is retained.", { cause: replacement }); }
      const saved = observation.snapshot;
      try {
        validateBotExecutionSnapshot(record, saved);
        if (saved.controllerProcess !== null && !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
          || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], saved.nativeProcesses)
          || execution.snapshot?.nativeSessionId != null && saved.nativeSessionId !== execution.snapshot.nativeSessionId) throw new Error("Bot journal conflicts with the original process evidence.");
      } catch (error) { treeEvidenceBlocked = true; throw error; }
      let stopped: ControllerSnapshot;
      try {
        if (stopRequestFailure === undefined) options.executions.update(record, { snapshot: saved });
        if (saved.controllerProcess === null) { treeEvidenceBlocked = true; throw new Error("Bot journal lacks complete controller proof; shutdown is blocked."); }
        treeAttempted = true;
        const alreadyProven = jobLeases.enabled && await jobLeases.get(ticket.launchId) === undefined && saved.lifecycle === "stopped" && saved.nativeStopped;
        if (!alreadyProven) await stopWithLease(ticket.launchId, saved.controllerProcess, saved.nativeProcesses, deadline);
        remaining();
        if (!await confirmWithLease(ticket, record.intent!.journalPath, saved.controllerProcess, saved.nativeProcesses, deadline, saved)) throw new Error("Bot original process tree did not stop; recovery evidence is retained.");
        remaining();
        if (stopRequestFailure !== undefined) throw stopRequestFailure.cause;
        if (historicalReadFailure !== undefined) throw historicalReadFailure;
        if (initialTicketReadFailure !== undefined) throw initialTicketReadFailure;
        if (receiptReadFailure !== undefined) throw receiptReadFailure;
        if (ticketReadFailure !== undefined) throw ticketReadFailure;
        // Records stop through the journal's process verification + snapshot CAS;
        // operation receipts and pending user input remain in that same journal.
        stopped = await recordWithLease(record.intent!.journalPath, ticket, deadline);
        remaining();
        options.executions.update(record, { snapshot: stopped });
        await jobLeases.release(ticket.launchId);
      } catch (error) { if (replacement) throw new AggregateError([replacement, error], "Bot bootstrap replacement and complete stopping failed.", { cause: error }); throw error; }
      await releaseEnvironment(record.botId);
    } catch (error) {
      const failures: unknown[] = [];
      if (initialTicketReadFailure !== undefined) failures.push(initialTicketReadFailure);
      if (receiptReadFailure !== undefined) failures.push(receiptReadFailure);
      if (historicalReadFailure !== undefined && !(error instanceof AggregateError && error.errors.includes(historicalReadFailure))) failures.push(historicalReadFailure);
      if (ticketReadFailure !== undefined && !failures.includes(ticketReadFailure)) failures.push(ticketReadFailure);
      if (stopRequestFailure !== undefined && !failures.includes(stopRequestFailure.cause)) failures.push(stopRequestFailure.cause);
      if (!failures.includes(error)) failures.push(error);
      treeEvidenceBlocked ||= hasUnsafeControllerObservationFailure(error);
      if ((historicalReadFailure !== undefined || initialTicketReadFailure !== undefined || receiptReadFailure !== undefined || ticketReadFailure !== undefined) && treeEvidenceBlocked) bootstrapStopBlocked = true;
      if (!bootstrapAttempted && !bootstrapCompleted && !leaseAttempted && cleanupTicket !== undefined) {
        try { leaseAttempted = true; await retainJob(cleanupTicket.launchId, execution.controllerProcess, deadline); } catch (leaseError) { failures.push(leaseError); }
      }
      if (!bootstrapStopBlocked && !bootstrapAttempted && !bootstrapCompleted) {
        try { await stopBootstrap(execution.controllerProcess, deadline); bootstrapCompleted = true; }
        catch (stopError) { failures.push(stopError); bootstrapCompleted = stopError instanceof ControllerBootstrapReplacedError; }
      }
      if (bootstrapCompleted && !treeEvidenceBlocked && !treeAttempted && cleanupTicket !== undefined) {
          let journalIoFailure = false;
          try {
            const observation = await reconcileLaunch({ journalFile: record.intent!.journalPath, ticket: cleanupTicket, spawnProof: execution.controllerProcess, signal: AbortSignal.timeout(remaining()), deadline });
            remaining();
            if (observation.kind === "controller-exited") {
              const saved = observation.snapshot;
              if (saved.controllerProcess === null) throw new Error("Bot journal lacks complete controller proof; stopping remains unconfirmed.");
              if (!preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, cleanupTicket.launchId) || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], saved.nativeProcesses) || execution.snapshot?.nativeSessionId != null && saved.nativeSessionId !== execution.snapshot.nativeSessionId || saved.initialInputState !== "not_required") throw new Error("Bot fallback journal conflicts with the original process evidence.");
              treeAttempted = true;
              await stopWithLease(cleanupTicket.launchId, saved.controllerProcess, saved.nativeProcesses, deadline); remaining();
              if (!await confirmWithLease(cleanupTicket, record.intent!.journalPath, saved.controllerProcess, saved.nativeProcesses, deadline, saved)) throw new Error("Bot original process tree did not stop; evidence is retained.");
              remaining();
            } else if (observation.kind !== "pre-writer-exited") throw new Error("Bot bootstrap exit could not be classified; evidence is retained.", observation.kind === "unknown" ? { cause: observation.cause } : undefined);
          } catch (verificationError) { failures.push(verificationError); journalIoFailure = isControllerJournalIoFailure(verificationError); }
          const saved = execution.snapshot;
          if (!treeAttempted && journalIoFailure && (isControllerJournalIoFailure(error) || error instanceof ControllerIpcOutcomeUnknownError)
            && (stopRequestFailure === undefined || stopRequestFailure.cause instanceof ControllerIpcOutcomeUnknownError)
            && process.platform !== "win32" && execution.launchSubmission === "acknowledged" && saved?.controllerProcess != null
            && (isLinuxControllerLaunch(execution.controllerProcess) ? execution.controllerProcess.launchId === cleanupTicket.launchId : execution.controllerProcess.processGroupId === execution.controllerProcess.pid && execution.controllerProcess.jobObjectName === undefined)
            && preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, cleanupTicket.launchId)) {
            try {
              remaining(); await stopProcesses(saved.controllerProcess, saved.nativeProcesses, deadline); remaining();
              if (!await confirmStopped(saved.controllerProcess, saved.nativeProcesses, deadline)) throw new Error("Bot retained process tree remains unconfirmed.");
              remaining();
            } catch (retainedError) { failures.push(retainedError); }
          }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Bot shutdown observation and stopping failed.", { cause: failures[0] });
      throw error;
    }
  };
  const deletionRecord = (input: BotRecord): BotRecord => {
    const record = options.store.get(input.owner, input.botId);
    if (record === null || input.observed.deletion === null || record.observed.deletion === null
      || input.observed.deletion.deletionId !== record.observed.deletion.deletionId
      || input.observed.deletion.requestedVersion !== record.observed.deletion.requestedVersion
      || controllerPayloadHash(input.intent) !== controllerPayloadHash(record.intent)) {
      throw new Error("Bot deletion identity differs from its original durable responsibility.");
    }
    return record;
  };
  const stopRetainedDeletionGeneration = async (record: BotRecord, signal: AbortSignal): Promise<BotDeletionStop> => {
    const intent = record.intent!;
    if (record.observed.deletion?.workerCleanup.code !== "execution_evidence_missing" || record.observed.deletion.workerCleanup.state !== "failed") throw new BotExecutionEvidenceMissingError();
    const deadline = Date.now() + 10_000, ticket = await checkedTicket(record);
    signal.throwIfAborted(); deletionRecord(record);
    const historical = readHistoricalStoppedControllerGeneration(intent.journalPath, ticket, deadline);
    const snapshot = historical !== null && isLinuxControllerLaunch(historical.controllerProcess) ? historical : readCurrentControllerSnapshot(intent.journalPath, ticket, deadline);
    validateBotExecutionSnapshot(record, snapshot);
    if (snapshot.controllerProcess === null) throw new BotExecutionEvidenceMissingError();
    let stopped: ControllerSnapshot;
    try {
      // A durable stop needs no second termination. Windows additionally requires
      // its authenticated Job proof; a stopped PID alone cannot prove the tree.
      if (historical !== null && isLinuxControllerLaunch(historical.controllerProcess)) {
        stopped = historical;
      } else if (snapshot.lifecycle === "stopped" && snapshot.nativeStopped) {
        stopped = await recordWithLease(intent.journalPath, ticket, deadline);
      } else {
        if (jobLeases.enabled) await retainJob(intent.launchId, snapshot.controllerProcess, deadline);
        signal.throwIfAborted(); deletionRecord(record);
        await stopWithLease(intent.launchId, snapshot.controllerProcess, snapshot.nativeProcesses, deadline);
        stopped = await recordWithLease(intent.journalPath, ticket, deadline);
      }
      validateBotExecutionSnapshot(record, stopped);
      if (stopped.lifecycle !== "stopped" || !stopped.nativeStopped || stopped.stoppedAt === null || stopped.controllerProcess === null) throw new Error("Original Bot generation stop remains unproven.");
    } finally { await jobLeases.release(intent.launchId); }
    // The original journal owns this proof. Missing execution history cannot be
    // reconstructed into a Bot execution row or a complete private cleanup plan.
    return { protocol: "daynight.session.v1", sessionId: intent.sessionId!, testExecutionId: intent.executionId,
      executionGeneration: intent.executionGeneration, controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
      stopProof: { recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: stopped.stoppedAt } };
  };
  const stopForDeletion = async (input: BotRecord, signal: AbortSignal, settings?: { recoverMissingExecution?: boolean }): Promise<BotDeletionStop | null> => {
    signal.throwIfAborted();
    assertBotMigrationExecutable(input);
    let record = deletionRecord(input);
    const preparation = pendingCleanup.get(record.botId);
    if (preparation !== undefined) { await preparation.retryCleanup(); pendingCleanup.delete(record.botId); }
    record = deletionRecord(input);
    const intent = record.intent;
    if (intent === null) {
      if (record.definition?.sessionId != null) throw new BotExecutionEvidenceMissingError();
      // Preflight can own aliases before launch intent exists. A failed release
      // retains this handle; registered execution aliases use the durable plan.
      const prepared = environments.get(record.botId);
      if (prepared !== undefined) { await prepared.release(); environments.delete(record.botId); }
      signal.throwIfAborted(); deletionRecord(input);
      return null;
    }
    const execution = options.executions.get(record);
    // A missing row cannot distinguish an interrupted preparation from lost
    // history. Only a persisted submission state can prove never-started.
    if (execution === null) {
      if (settings?.recoverMissingExecution === true) return stopRetainedDeletionGeneration(record, signal);
      throw new BotExecutionEvidenceMissingError();
    }
    const unsubmitted = execution.launchSubmission === "not-submitted";
    const rejected = execution?.startup?.state === "failed" && execution.startup.reasonCode === "controller_launch_failed"
      && execution.controllerProcess === null && execution.snapshot === null;
    // Submitted executions use the same bounded observation and stop path as
    // ordinary shutdown, including receipt I/O handling and identity checks.
    if (!unsubmitted && !rejected) {
      let precheckComplete = false;
      try { await shutdown(record, signal, complete => { precheckComplete = complete; }); }
      catch (cause) {
        if (precheckComplete && !signal.aborted && !existsSync(intent.journalPath)) throw new BotExecutionEvidenceMissingError({ cause });
        throw cause;
      }
      record = deletionRecord(input);
    }
    const unreleased = options.executions.get(record)?.unreleased !== undefined;
    if (unsubmitted || rejected || unreleased) {
      // A prepared recovery may have advanced the remote fence even when its
      // grant response was lost. Never guess which generation owns deletion.
      if (intent.executionGeneration !== "1") throw new Error("Bot deletion server generation is unconfirmed after recovery preparation; original evidence is retained.");
      if (intent.sessionId === null) throw new Error("Bot deletion registration outcome is unconfirmed; the original registration identity is retained.");
      await releaseEnvironment(record.botId);
      return { protocol: "daynight.session.v1", sessionId: intent.sessionId, testExecutionId: intent.executionId,
        executionGeneration: intent.executionGeneration, controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
        stopProof: { kind: "never_started", recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: new Date(now()).toISOString() } };
    }
    const stopped = options.executions.get(record)?.snapshot;
    if (stopped?.lifecycle !== "stopped" || !stopped.nativeStopped || stopped.stoppedAt === null || stopped.controllerProcess === null || intent.sessionId === null) {
      throw new Error("Bot deletion requires complete original writer stop evidence.");
    }
    return { protocol: "daynight.session.v1", sessionId: intent.sessionId, testExecutionId: intent.executionId,
      executionGeneration: intent.executionGeneration, controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
      stopProof: { recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: stopped.stoppedAt } };
  };
  return {
    /** Join launch/renewal, then retain the same lock through stop and private cleanup.
     * A persisted deletion receipt lets the caller skip stop after journal removal.
     */
    withDeletion: <T>(record: BotRecord, signal: AbortSignal, action: (stop: (settings?: { recoverMissingExecution?: boolean }) => Promise<BotDeletionStop | null>) => Promise<T>): Promise<T> => serialize(record.botId, async () => {
      assertBotMigrationExecutable(record);
      if (record.cleanup === undefined && options.canControl?.(record) === false) throw new Error("Bot deletion requires confirmed local hosting.");
      signal.throwIfAborted(); deletionRecord(record);
      let active = true;
      try { return await action(settings => {
        if (!active) return Promise.reject(new Error("Bot deletion stop must remain inside its serialized cleanup."));
        return stopForDeletion(record, signal, settings);
      }); }
      finally { active = false; }
    }),
    shutdown: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, () => shutdown(record, signal)),
    close: async (): Promise<void> => {
      if (pendingCleanup.size || environments.size) throw new Error("Bot preparation cleanup remains unconfirmed; original resources are retained.");
      await jobLeases.close();
    },
    advance: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, async () => {
      try { return await advance(record, signal); }
      catch (cause) {
        const latest = options.store.get(record.owner, record.botId);
        const blocked = latest !== null && initialUnsubmitted(latest) ? blockedAdmission(cause) : undefined;
        if (blocked === undefined && latest?.intent !== null && latest !== null && latest.migration === undefined && options.executions.get(latest) !== null) {
          options.executions.update(latest, { lastError: cause instanceof Error ? cause.message : "Bot recovery is unavailable." });
        }
        throw blocked === undefined || blocked === cause ? cause : new BotAdmissionBlockedError({ cause });
      }
    }),
    observe: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, async () => remember(record, await observe(await checkedTicket(current(record)), signal))),
    readTicket: (record: BotRecord) => checkedTicket(current(record)),
    refreshGrant: (input: BotRecord, signal: AbortSignal) => serialize(input.botId, async () => {
      const record = current(input), execution = record.intent === null ? null : options.executions.get(record);
      if (execution === null || execution.launchSubmission === "not-submitted" || execution.snapshot?.nativeStopped) return;
      const ticket = await checkedTicket(record);
      if (!await controllerCredentialNeedsRefresh(ticket.credentialFile, now())) return;
      const snapshot = remember(record, await observe(ticket, signal));
      if (!["starting", "ready", "working"].includes(snapshot.lifecycle) || snapshot.nativeStopped) return;
      const grant = await options.sessionApi.grant(sessionRecord(current(record)), signal);
      current(record); signal.throwIfAborted();
      await writeControllerCredential(ticket.credentialFile, grant);
    }),
  };
};
export type BotProcess = ReturnType<typeof createBotProcess>;
