import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { prepareControllerIpcEndpoint } from "../../controller/paths.js";
import { readControllerSnapshot, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { requestController } from "../../controller/local-client.js";
import { isControllerStopIdentityConflict, openControllerStop, recoverWindowsControllerProof } from "../../controller/controller-stop.js";
import { withControllerStop } from "../../controller/controller-stop-scope.js";
import { ControllerStartupError } from "../../controller/startup.js";
import { parseProviderArguments } from "../../controller/providers/projection.js";
import { createControllerExecutionSerializer, launchControllerProcess, observeControllerProcess } from "../backends/controller-process.js";
import { controllerCredentialNeedsRefresh } from "../backends/grant-renewal.js";
import { writeControllerCredential } from "../backends/session-api.js";
import { BotEnvironmentCleanupError, prepareBotEnvironment, type PreparedBotEnvironment } from "./environment.js";
import { selectBotRole } from "./instructions.js";
import type { BotExecutionStore } from "./execution-store.js";
import type { BotStore } from "./store.js";
import type { BotDeletionStop, BotSessionApi } from "./session-api.js";
import type { BotRecord } from "./types.js";
import { botNativeConfiguration } from "./configuration.js";

/** Execution handles retain original identities; callers hold the Worker instance lock. */
export const createBotProcess = (options: {
  homeDirectory: string; packageDirectory: string; store: BotStore; executions: BotExecutionStore;
  sessionApi: BotSessionApi; recoveryLimit: number | (() => number); now?: () => number;
  dependencies?: { prepareEnvironment?: typeof prepareBotEnvironment; launch?: typeof launchControllerProcess; observe?: typeof observeControllerProcess; readSnapshot?: typeof readControllerSnapshot; openStop?: typeof openControllerStop; recoverProof?: typeof recoverWindowsControllerProof; request?: typeof requestController };
}) => {
  const now = options.now ?? Date.now, serialize = createControllerExecutionSerializer();
  const environments = new Map<string, PreparedBotEnvironment>();
  const pendingCleanup = new Map<string, BotEnvironmentCleanupError>();
  const environment = options.dependencies?.prepareEnvironment ?? prepareBotEnvironment;
  const launch = options.dependencies?.launch ?? launchControllerProcess, observe = options.dependencies?.observe ?? observeControllerProcess;
  const readSnapshot = options.dependencies?.readSnapshot ?? readControllerSnapshot;
  const openStop = options.dependencies?.openStop ?? openControllerStop;
  const recoverProof = options.dependencies?.recoverProof ?? recoverWindowsControllerProof;
  const request = options.dependencies?.request ?? requestController;
  const current = (input: BotRecord, stopping = false): BotRecord => {
    const record = options.store.get(input.owner, input.botId);
    if (record === null || !stopping && record.observed.deletion !== null || record.definition === null) throw new Error("Bot execution requires its original active definition.");
    return record;
  };
  const checkedTicket = async (record: BotRecord): Promise<ControllerLaunchTicket> => {
    const intent = record.intent;
    if (intent === null || intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot launch intent is incomplete.");
    const ticket = await readLaunchTicket(options.homeDirectory, intent.launchId), config = record.definition!.resolvedConfiguration, native = botNativeConfiguration(config);
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
      || controllerPayloadHash(ticket.configuration) !== controllerPayloadHash({ agent: config.provider, agentControlMode: "web", model: native.model, args: native.args, recoveryLimit: intent.recoveryLimit, ...(ticket.configuration.validateNativeSelection === true ? { validateNativeSelection: true } : {}) })) throw new Error("Bot ticket conflicts with the original frozen execution intent.");
    return ticket;
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
      const prepared = await environment({ homeDirectory: options.homeDirectory, cwd: config.cwd, workerPaths: resolveConfigurationPaths(options.homeDirectory), serverOrigin: record.owner.serverOrigin, ownerUserId: record.owner.ownerUserId, signal });
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
    if (prior?.startup?.state === "failed" && prior.snapshot?.nativeSessionId == null && record.intent?.nativeSessionId == null) throw new ControllerStartupError(prior.startup, prior.lastError ?? "The original Bot initialization failed.");
    if (prior !== null && prior.launchSubmission !== "not-submitted") {
      const ticket = await checkedTicket(record);
      let observed: ControllerSnapshot | null = null;
      try { observed = await observe(ticket, signal); }
      catch { signal.throwIfAborted(); }
      if (observed !== null) {
        remember(record, observed);
        if (["starting", "ready", "working"].includes(observed.lifecycle) && !observed.nativeStopped) {
          options.executions.resumeObserved(record);
          return observed;
        }
      }
      const saved = readSnapshot(record.intent!.journalPath) ?? observed ?? prior.snapshot;
      if (saved !== null) options.executions.update(record, { snapshot: saved });
      // IPC loss is not a stop proof. Do not interrupt a possible writer to make
      // recovery convenient; shutdown is the separate explicit stopping path.
      const controller = saved?.controllerProcess ?? recoverProof(record.intent!.journalPath, ticket) ?? prior.controllerProcess;
      if (saved === null || controller === null) {
        if (saved?.startup?.state === "failed") return remember(record, saved);
        throw new Error("Bot original writer stop is unproven; IPC is unavailable or the process tree is still running.");
      }
      const stop = await openStop({ journalPath: record.intent!.journalPath, ticket, controller, native: saved.nativeProcesses });
      const stopped = await withControllerStop(stop, async () => {
        if (!await stop.confirm()) {
          if (saved.startup?.state === "failed") return null;
          throw new Error("Bot original writer stop is unproven; IPC is unavailable or the process tree is still running.");
        }
        if (saved.nativeSessionId === null) throw new Error("Bot native session identity is missing; a blank replacement is forbidden.");
        if (prior.recoveryBlocked !== null) throw new Error(prior.recoveryBlocked);
        if (!(prior.restartAfterShutdown && saved.error === null) && prior.recoveryCount >= record.intent!.recoveryLimit) {
          const reason = "Bot execution recovery budget is exhausted.";
          options.executions.blockRecovery(record, reason);
          throw new Error(reason);
        }
        signal.throwIfAborted();
        return stop.commit();
      });
      if (stopped === null) return remember(record, saved);
      stop.recheck();
      options.executions.update(record, { snapshot: stopped });
      record = options.executions.beginRecovery(record, stopped, options.homeDirectory);
      // A new launch must revalidate CLI owner/server configuration. Old aliases
      // remain listed in durable evidence for precise eventual deletion.
      environments.delete(record.botId);
    }
    // Preflight may report a failure and advance the Bot version. Freeze the first
    // registration only once the initial environment is known to be usable.
    const prepared = await prepareEnvironment(record, signal);
    try {
      if (record.intent === null) options.store.prepare(record.owner, record.botId, { homeDirectory: options.homeDirectory, recoveryLimit: typeof options.recoveryLimit === "function" ? options.recoveryLimit() : options.recoveryLimit });
      record = current(record);
      options.store.freezeRole(record.owner, record.botId, selectBotRole({ serverRole: record.definition!.roleConfiguration, preparedRole: record.intent!.roleConfiguration }));
      record = current(record);
      options.executions.prepare(record);
      options.executions.update(record, { aliasDirectory: prepared.aliasDirectory });
      if (record.intent!.sessionId === null) {
        const registered = await options.sessionApi.register(record, signal);
        options.store.observe(record.owner, registered.bot, now());
        record = current(record);
      }
      let ticket: ControllerLaunchTicket;
      try { ticket = await checkedTicket(record); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const intent = record.intent!, config = record.definition!.resolvedConfiguration, native = botNativeConfiguration(config);
        if (intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot registration did not establish its frozen role and Session.");
        await mkdir(controllerExecutionDirectory(options.homeDirectory, intent.executionId), { recursive: true, mode: 0o700 });
        const previous = options.executions.get(record)!.previous;
        const previousTicket = previous === null ? null : await readLaunchTicket(options.homeDirectory, previous.launchId);
        const nativeHome = previousTicket?.nativeHome ?? (config.provider === "codex" ? prepared.environment.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")
          : config.provider === "claude" ? prepared.environment.CLAUDE_CONFIG_DIR ?? path.join(options.homeDirectory, ".claude")
          : prepared.environment.COPILOT_HOME ?? path.join(options.homeDirectory, ".copilot"));
        ticket = { schemaVersion: 1, launchId: intent.launchId, executionId: intent.executionId, testExecutionId: intent.executionId,
          controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId, sessionId: intent.sessionId,
          executionGeneration: intent.executionGeneration, serverOrigin: record.owner.serverOrigin, ownerUserId: record.owner.ownerUserId,
          provider: config.provider, cwd: config.cwd, nativeHome, configuration: { agent: config.provider, agentControlMode: "web", model: native.model, args: native.args, recoveryLimit: intent.recoveryLimit,
            ...(native.model !== null || parseProviderArguments(config.provider, native.args, config.selection !== undefined).effort !== undefined ? { validateNativeSelection: true as const } : {}) },
          initialInput: "none", initialOperationId: intent.initialOperationId, initialPrompt: "", instructions: intent.roleConfiguration.instructions, resumeNativeSessionId: intent.nativeSessionId,
          credentialFile: intent.credentialFile, ipcEndpoint: await prepareControllerIpcEndpoint(options.homeDirectory, intent.launchId), ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(now()).toISOString() };
        await writeLaunchTicket(options.homeDirectory, ticket);
      }
      const previous = options.executions.get(current(record))!.previous;
      const stopProof = previous === null ? undefined : { generation: previous.generation, instanceId: previous.instanceId, recordId: previous.recordId, stoppedAt: previous.stoppedAt };
      const grant = await options.sessionApi.grant(sessionRecord(current(record)), signal, stopProof);
      current(record); signal.throwIfAborted();
      await writeControllerCredential(ticket.credentialFile, grant);
      record = current(record);
      return await launch({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, ticket, env: prepared.environment, signal,
        onSubmitting: () => { options.executions.update(current(record), { launchSubmission: "unknown" }); },
        onSpawned: proof => { options.executions.update(current(record, true), { controllerProcess: proof }); },
        onObserved: snapshot => { remember(record, snapshot); },
      });
    } catch (error) {
      record = current(record, true);
      const execution = record.intent === null ? null : options.executions.get(record);
      if (execution !== null) options.executions.update(record, {
        lastError: error instanceof Error ? error.message : "Bot launch outcome is unknown.",
        ...(error instanceof ControllerStartupError ? { startup: error.observation } : {}),
      });
      if (execution === null || execution.launchSubmission === "not-submitted") {
        await prepared.release(); environments.delete(record.botId);
        if (execution !== null) options.executions.update(record, { aliasDirectory: null });
      }
      throw error;
    }
  };
  const shutdown = async (input: BotRecord, signal: AbortSignal): Promise<void> => {
    const retained = options.store.get(input.owner, input.botId);
    if (retained === null) throw new Error("Bot shutdown lost its original inventory record.");
    if (retained.intent === null) return;
    const record = current(retained, true);
    const execution = options.executions.get(record);
    if (execution === null || execution.launchSubmission === "not-submitted") return;
    const ticket = await checkedTicket(record);
    let observed: ControllerSnapshot | null = null;
    try { observed = await observe(ticket, signal); }
    catch { signal.throwIfAborted(); }
    const candidate = readSnapshot(record.intent!.journalPath) ?? observed;
    // A recovery child may be spawned before it replaces the shared journal's
    // stopped predecessor. Only the current fence can supply native proofs;
    // the parent's persisted child proof still owns the stop attempt.
    const matchesCurrent = (snapshot: ControllerSnapshot): boolean => snapshot.executionId === ticket.executionId
      && snapshot.testExecutionId === ticket.testExecutionId && snapshot.claimId === undefined
      && snapshot.sessionId === ticket.sessionId && snapshot.executionGeneration === ticket.executionGeneration
      && snapshot.controllerInstanceId === ticket.controllerInstanceId;
    const saved = candidate !== null && matchesCurrent(candidate) ? candidate : execution.snapshot;
    if (saved !== null) options.executions.update(record, { snapshot: saved });
    const proof = saved?.controllerProcess ?? recoverProof(record.intent!.journalPath, ticket) ?? execution.controllerProcess;
    if (proof === null) throw new Error("Bot shutdown has no original process proof; execution evidence is retained.");
    const native = saved?.nativeProcesses ?? [];
    const stop = await openStop({ journalPath: record.intent!.journalPath, ticket, controller: proof, native });
    const stopped = await withControllerStop(stop, async () => {
    const alreadyStopped = await stop.confirm();
    if (!alreadyStopped) {
      // Only a live, authenticated healthy observation earns orderly restart.
      // A stale ready journal cannot erase an earlier abnormal failure.
      options.executions.markShutdown(record, observed !== null && matchesCurrent(observed) && ["ready", "working"].includes(observed.lifecycle)
        && observed.error === null && observed.startup?.state === "ready" && !observed.nativeStopped);
      let graceful = false;
      try { await request(ticket, { kind: "stop", deadline: Date.now() + 10_000 }, { signal, timeoutMs: 10_000 }); graceful = true; }
      catch { signal.throwIfAborted(); }
      signal.throwIfAborted();
      try { await stop.stop(Date.now() + 10_000, { graceful }); }
      catch (error) { if (isControllerStopIdentityConflict(error) || !await stop.confirm()) throw error; }
      if (!await stop.confirm()) throw new Error("Bot original process tree did not stop; recovery evidence is retained.");
    }
    // Records stop through the journal's process verification + snapshot CAS;
    // operation receipts and pending user input remain in that same journal.
    return stop.commit();
    });
    stop.recheck();
    options.executions.update(record, { snapshot: stopped });
    environments.delete(record.botId);
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
  const stopForDeletion = async (input: BotRecord, signal: AbortSignal): Promise<BotDeletionStop | null> => {
    signal.throwIfAborted();
    let record = deletionRecord(input);
    const preparation = pendingCleanup.get(record.botId);
    if (preparation !== undefined) { await preparation.retryCleanup(); pendingCleanup.delete(record.botId); }
    record = deletionRecord(input);
    const intent = record.intent;
    if (intent === null) {
      if (record.definition?.sessionId != null) throw new Error("Bot deletion lost the original execution evidence for its registered Session.");
      // Preflight can own aliases before launch intent exists. A failed release
      // retains this handle; registered execution aliases use the durable plan.
      const prepared = environments.get(record.botId);
      if (prepared !== undefined) { await prepared.release(); environments.delete(record.botId); }
      signal.throwIfAborted(); deletionRecord(input);
      return null;
    }
    const execution = options.executions.get(record);
    const unsubmitted = execution === null || execution.launchSubmission === "not-submitted";
    const rejected = execution?.startup?.state === "failed" && execution.startup.reasonCode === "controller_launch_failed"
      && execution.controllerProcess === null && execution.snapshot === null;
    if (unsubmitted || rejected) {
      // A prepared recovery may have advanced the remote fence even when its
      // grant response was lost. Never guess which generation owns deletion.
      if (intent.executionGeneration !== "1") throw new Error("Bot deletion server generation is unconfirmed after recovery preparation; original evidence is retained.");
      if (intent.sessionId === null) throw new Error("Bot deletion registration outcome is unconfirmed; the original registration identity is retained.");
      return { protocol: "daynight.session.v1", sessionId: intent.sessionId, testExecutionId: intent.executionId,
        executionGeneration: intent.executionGeneration, controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
        stopProof: { kind: "never_started", recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: new Date(now()).toISOString() } };
    }
    await shutdown(record, signal);
    record = deletionRecord(input);
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
    withDeletion: <T>(record: BotRecord, signal: AbortSignal, action: (stop: () => Promise<BotDeletionStop | null>) => Promise<T>): Promise<T> => serialize(record.botId, async () => {
      signal.throwIfAborted(); deletionRecord(record);
      let active = true;
      try { return await action(() => {
        if (!active) return Promise.reject(new Error("Bot deletion stop must remain inside its serialized cleanup."));
        return stopForDeletion(record, signal);
      }); }
      finally { active = false; }
    }),
    shutdown: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, () => shutdown(record, signal)),
    advance: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, async () => {
      try { return await advance(record, signal); }
      catch (cause) {
        const latest = options.store.get(record.owner, record.botId);
        if (latest?.intent !== null && latest !== null && options.executions.get(latest) !== null) {
          options.executions.update(latest, { lastError: cause instanceof Error ? cause.message : "Bot recovery is unavailable." });
        }
        throw cause;
      }
    }),
    observe: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, async () => remember(record, await observe(await checkedTicket(current(record)), signal))),
    readTicket: (record: BotRecord) => checkedTicket(current(record)),
    refreshGrant: (input: BotRecord, signal: AbortSignal) => serialize(input.botId, async () => {
      const record = current(input), execution = record.intent === null ? null : options.executions.get(record);
      if (execution === null || execution.launchSubmission === "not-submitted" || execution.snapshot?.nativeStopped) return;
      const ticket = await checkedTicket(record);
      if (!await controllerCredentialNeedsRefresh(ticket.credentialFile, now())) return;
      const grant = await options.sessionApi.grant(sessionRecord(record), signal);
      current(record); signal.throwIfAborted();
      await writeControllerCredential(ticket.credentialFile, grant);
    }),
  };
};
export type BotProcess = ReturnType<typeof createBotProcess>;
