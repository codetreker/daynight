import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { prepareControllerIpcEndpoint } from "../../controller/paths.js";
import { readControllerSnapshot, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { ControllerStartupError } from "../../controller/startup.js";
import { parseProviderArguments } from "../../controller/providers/projection.js";
import { createControllerExecutionSerializer, launchControllerProcess, observeControllerProcess } from "../backends/controller-process.js";
import { controllerCredentialNeedsRefresh } from "../backends/grant-renewal.js";
import { writeControllerCredential } from "../backends/session-api.js";
import { BotEnvironmentCleanupError, prepareBotEnvironment, type PreparedBotEnvironment } from "./environment.js";
import { selectBotRole } from "./instructions.js";
import type { BotExecutionStore } from "./execution-store.js";
import type { BotStore } from "./store.js";
import type { BotSessionApi } from "./session-api.js";
import type { BotRecord } from "./types.js";

/** Execution handles retain original identities; callers hold the Worker instance lock. */
export const createBotProcess = (options: {
  homeDirectory: string; packageDirectory: string; store: BotStore; executions: BotExecutionStore;
  sessionApi: BotSessionApi; recoveryLimit: number; now?: () => number;
  dependencies?: { prepareEnvironment?: typeof prepareBotEnvironment; launch?: typeof launchControllerProcess; observe?: typeof observeControllerProcess };
}) => {
  const now = options.now ?? Date.now, serialize = createControllerExecutionSerializer();
  const environments = new Map<string, PreparedBotEnvironment>();
  const pendingCleanup = new Map<string, BotEnvironmentCleanupError>();
  const environment = options.dependencies?.prepareEnvironment ?? prepareBotEnvironment;
  const launch = options.dependencies?.launch ?? launchControllerProcess, observe = options.dependencies?.observe ?? observeControllerProcess;
  const current = (input: BotRecord): BotRecord => {
    const record = options.store.get(input.owner, input.botId);
    if (record === null || record.observed.deletion !== null || record.definition === null) throw new Error("Bot execution requires its original active definition.");
    return record;
  };
  const checkedTicket = async (record: BotRecord): Promise<ControllerLaunchTicket> => {
    const intent = record.intent;
    if (intent === null || intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot launch intent is incomplete.");
    const ticket = await readLaunchTicket(options.homeDirectory, intent.launchId), config = record.definition!.resolvedConfiguration;
    if (ticket.testExecutionId !== intent.executionId || ticket.executionId !== intent.executionId || ticket.sessionId !== intent.sessionId
      || ticket.controllerId !== intent.registration.controllerId || ticket.controllerInstanceId !== intent.registration.controllerInstanceId
      || ticket.executionGeneration !== intent.executionGeneration || ticket.ownerUserId !== record.owner.ownerUserId || ticket.serverOrigin !== record.owner.serverOrigin
      || ticket.provider !== config.provider || ticket.cwd !== config.cwd || ticket.initialInput !== "none" || ticket.initialPrompt !== ""
      || ticket.initialOperationId !== intent.initialOperationId || ticket.instructions !== intent.roleConfiguration.instructions || ticket.credentialFile !== intent.credentialFile
      || controllerPayloadHash(ticket.configuration) !== controllerPayloadHash({ agent: config.provider, agentControlMode: "web", model: config.model, args: config.args, recoveryLimit: intent.recoveryLimit })) throw new Error("Bot ticket conflicts with the original frozen execution intent.");
    return ticket;
  };
  const sessionRecord = (record: BotRecord): BotRecord => {
    const execution = record.intent === null ? null : options.executions.get(record);
    const nativeSessionId = execution?.snapshot?.nativeSessionId ?? record.intent?.nativeSessionId ?? null;
    return record.intent === null ? record : { ...record, intent: { ...record.intent, nativeSessionId } };
  };
  const remember = (input: BotRecord, snapshot: ControllerSnapshot): ControllerSnapshot => {
    options.executions.update(current(input), { launchSubmission: "acknowledged", snapshot, ...(snapshot.startup === undefined ? {} : { startup: snapshot.startup }), lastError: snapshot.error });
    return snapshot;
  };
  const prepareEnvironment = async (record: BotRecord, signal: AbortSignal): Promise<PreparedBotEnvironment> => {
    const cleanup = pendingCleanup.get(record.botId);
    if (cleanup !== undefined) { await cleanup.retryCleanup(); pendingCleanup.delete(record.botId); }
    const retained = environments.get(record.botId);
    if (retained !== undefined) return retained;
    const config = record.definition!.resolvedConfiguration;
    parseProviderArguments(config.provider, config.args);
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
    if (prior?.startup?.state === "failed") throw new ControllerStartupError(prior.startup, prior.lastError ?? "The original Bot initialization failed.");
    if (prior !== null && prior.launchSubmission !== "not-submitted") {
      const ticket = await checkedTicket(record);
      try { return remember(record, await observe(ticket, signal)); }
      catch (error) {
        signal.throwIfAborted();
        const saved = readControllerSnapshot(record.intent!.journalPath);
        // A stopped startup failure remains reportable after IPC closes. Old
        // ready snapshots never establish that the current execution is online.
        if (saved?.startup?.state === "failed") return remember(record, saved);
        throw error;
      }
    }
    // Preflight may report a failure and advance the Bot version. Freeze the first
    // registration only once the initial environment is known to be usable.
    const prepared = await prepareEnvironment(record, signal);
    try {
      if (record.intent === null) options.store.prepare(record.owner, record.botId, { homeDirectory: options.homeDirectory, recoveryLimit: options.recoveryLimit });
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
        const intent = record.intent!, config = record.definition!.resolvedConfiguration;
        if (intent.sessionId === null || intent.roleConfiguration === null) throw new Error("Bot registration did not establish its frozen role and Session.");
        await mkdir(controllerExecutionDirectory(options.homeDirectory, intent.executionId), { recursive: true, mode: 0o700 });
        const nativeHome = config.provider === "codex" ? prepared.environment.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")
          : config.provider === "claude" ? prepared.environment.CLAUDE_CONFIG_DIR ?? path.join(options.homeDirectory, ".claude")
          : prepared.environment.COPILOT_HOME ?? path.join(options.homeDirectory, ".copilot");
        ticket = { schemaVersion: 1, launchId: intent.launchId, executionId: intent.executionId, testExecutionId: intent.executionId,
          controllerId: intent.registration.controllerId, controllerInstanceId: intent.registration.controllerInstanceId, sessionId: intent.sessionId,
          executionGeneration: intent.executionGeneration, serverOrigin: record.owner.serverOrigin, ownerUserId: record.owner.ownerUserId,
          provider: config.provider, cwd: config.cwd, nativeHome, configuration: { agent: config.provider, agentControlMode: "web", model: config.model, args: config.args, recoveryLimit: intent.recoveryLimit },
          initialInput: "none", initialOperationId: intent.initialOperationId, initialPrompt: "", instructions: intent.roleConfiguration.instructions, resumeNativeSessionId: intent.nativeSessionId,
          credentialFile: intent.credentialFile, ipcEndpoint: await prepareControllerIpcEndpoint(options.homeDirectory, intent.launchId), ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(now()).toISOString() };
        await writeLaunchTicket(options.homeDirectory, ticket);
      }
      const grant = await options.sessionApi.grant(sessionRecord(current(record)), signal);
      await writeControllerCredential(ticket.credentialFile, grant);
      record = current(record);
      return await launch({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, ticket, env: prepared.environment, signal,
        onSubmitting: () => { options.executions.update(current(record), { launchSubmission: "unknown" }); },
        onSpawned: proof => { options.executions.update(current(record), { controllerProcess: proof }); },
        onObserved: snapshot => { remember(record, snapshot); },
      });
    } catch (error) {
      record = current(record);
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
  return {
    advance: (record: BotRecord, signal: AbortSignal) => serialize(record.botId, () => advance(record, signal)),
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
