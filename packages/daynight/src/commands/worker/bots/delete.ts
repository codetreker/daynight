import type { BotExecutionStore } from "./execution-store.js";
import { BotExecutionEvidenceMissingError, type BotProcess } from "./process.js";
import type { BotRemote } from "./remote.js";
import type { BotSessionApi, BotDeletionReceipt } from "./session-api.js";
import type { BotStore } from "./store.js";
import type { BotRecord } from "./types.js";
import { captureBotDeletionFiles, removeBotDeletionFile } from "./delete-files.js";
import { ApiError } from "../../../api/client.js";
import type { BotDeletionRecovery } from "../../bot/deletion-api.js";

export const requiresBotDeletionRecovery = (record: BotRecord): boolean => record.observed.deletion?.workerCleanup.state === "failed"
  && record.observed.deletion.workerCleanup.code === "execution_evidence_missing";

/** Server binding is authoritative; an empty local store is not a never-started execution. */
export const checkBotDeletionRecovery = (record: BotRecord, recovery: BotDeletionRecovery): void => {
  const deletion = record.observed.deletion;
  if (deletion === null || recovery.botId !== record.botId || recovery.workerId !== record.owner.workerId
    || recovery.deletionId !== deletion.deletionId || recovery.requestedVersion !== deletion.requestedVersion
    || BigInt(recovery.version) < BigInt(record.observed.version)) throw new Error("Bot deletion recovery differs from the original authority.");
  const binding = recovery.originalBinding, proof = record.cleanup?.stop;
  if (binding !== null && recovery.decision === null) {
    const local = proof ?? (record.intent === null ? null : {
      sessionId: record.intent.sessionId, testExecutionId: record.intent.executionId,
      executionGeneration: record.intent.executionGeneration, controllerId: record.intent.registration.controllerId,
      controllerInstanceId: record.intent.controllerInstanceId,
    });
    if (local !== null && Object.entries(binding).some(([key, value]) => local[key as keyof typeof local] !== value)) {
      throw new Error("Bot deletion evidence conflicts with its original server execution binding.");
    }
  }
};

/** Owns local deletion and receipt reconciliation while the caller holds the Worker lock. */
export const createBotDeletion = (options: {
  homeDirectory: string; store: BotStore; executions: BotExecutionStore;
  process: BotProcess; sessionApi: Pick<BotSessionApi, "completeDeletion">; remote: BotRemote; now?: () => number;
  onReceiptConfirmed?(): void;
  dependencies?: { capture?: typeof captureBotDeletionFiles; remove?: typeof removeBotDeletionFile };
}) => {
  const now = options.now ?? Date.now;
  const capture = options.dependencies?.capture ?? captureBotDeletionFiles;
  const remove = options.dependencies?.remove ?? removeBotDeletionFile;
  const refresh = async (input: BotRecord, signal: AbortSignal): Promise<BotRecord> => {
    const bot = await options.remote.read(input.botId, signal, input.owner);
    if (bot === null) throw new Error("Bot deletion authority is missing; local responsibility is retained.");
    const record = options.store.observe(input.owner, bot, now());
    if (record.observed.deletion === null || input.observed.deletion === null
      || record.observed.deletion.deletionId !== input.observed.deletion.deletionId
      || record.observed.deletion.requestedVersion !== input.observed.deletion.requestedVersion) throw new Error("Bot deletion authority changed; original local responsibility is retained.");
    return record;
  };
  return {
    advance: async (input: BotRecord, signal: AbortSignal, settings: { recover?: boolean } = {}): Promise<void> => {
      // An unavailable inventory/detail must not trigger destructive work or a
      // replacement receipt. Every retry observes the original deletion first.
      const original = await refresh(input, signal);
      const recovery = await options.remote.readDeletionRecovery?.(original.botId, signal, original.owner);
      if (recovery != null) {
        checkBotDeletionRecovery(original, recovery);
        // The owner's independent decision closes receipt reconciliation while
        // preserving the truthful, unverified local cleanup result.
        if (recovery.decision !== null) return;
        if (recovery.hostingWorkerId !== options.remote.owner.workerId) return;
      }
      if (requiresBotDeletionRecovery(original) && settings.recover !== true) return;
      if (requiresBotDeletionRecovery(original) && original.cleanup?.stop?.stopProof.kind === "never_started") {
        throw new BotExecutionEvidenceMissingError();
      }
      const reportMissing = async (record: BotRecord): Promise<void> => {
        if (requiresBotDeletionRecovery(record) || record.observed.deletion!.workerCleanup.state === "completed") return;
        const result = await options.sessionApi.completeDeletion(record, {
          deletionId: record.observed.deletion!.deletionId, stop: null,
          result: { state: "failed", code: "execution_evidence_missing" },
        }, signal);
        options.store.observe(record.owner, result, now());
      };
      if (original.cleanup?.stop?.stopProof.kind === "never_started" && !original.cleanup.localCompleted) {
        const execution = original.intent === null ? null : options.executions.get(original);
        const rejected = execution?.startup?.state === "failed" && execution.startup.reasonCode === "controller_launch_failed"
          && execution.controllerProcess === null && execution.snapshot === null;
        if (execution === null || execution.launchSubmission !== "not-submitted" && !rejected) {
          await reportMissing(original);
          if (settings.recover === true) throw new BotExecutionEvidenceMissingError();
          return;
        }
      }
      if (recovery?.requiresStopProof === true && original.intent === null && original.cleanup?.stop == null) {
        await reportMissing(original);
        if (settings.recover === true) throw new Error("execution_evidence_missing: The original execution evidence is unavailable; local stopping cannot be verified.");
        return;
      }
      if (original.observed.deletion!.workerCleanup.state === "completed" && original.observed.deletion!.serverCleanup.state === "completed") return;
      await options.process.withDeletion(original, signal, async stop => {
        let record = options.store.get(original.owner, original.botId)!;
        let failureCode = "execution_stop_unproven";
        try {
          if (record.cleanup === undefined || recovery?.requiresStopProof === true && record.cleanup.stop === null) {
            const proof = await stop();
            record = options.store.get(original.owner, original.botId)!;
            failureCode = "private_cleanup_failed";
            const execution = record.intent === null ? null : options.executions.get(record);
            const targets = await capture(options.homeDirectory, record, execution, signal);
            record = options.store.prepareDeletion(record, proof, targets);
          }
          failureCode = "private_cleanup_failed";
          if (!record.cleanup!.localCompleted) {
            for (const target of record.cleanup!.targets) {
              signal.throwIfAborted();
              if (target.completed) continue;
              await remove(target, signal);
              record = options.store.completeDeletionTarget(record, target.path);
            }
            record = options.store.finishDeletion(record);
          }
        } catch (cause) {
          if (cause instanceof BotExecutionEvidenceMissingError) failureCode = "execution_evidence_missing";
          if (!signal.aborted) {
            const latest = await refresh(options.store.get(original.owner, original.botId)!, signal);
            if (latest.observed.deletion!.workerCleanup.state !== "completed" && !requiresBotDeletionRecovery(latest)) {
              const receipt: BotDeletionReceipt = { deletionId: latest.observed.deletion!.deletionId,
                stop: latest.cleanup?.stop ?? null, result: { state: "failed", code: failureCode } };
              try { options.store.observe(latest.owner, await options.sessionApi.completeDeletion(latest, receipt, signal), now()); }
              catch (failure) { throw new AggregateError([cause, failure], "Bot cleanup failed and its failure report is unconfirmed; local responsibility is retained."); }
            }
          }
          throw cause;
        }
        // The original proof and completed result survive local erasure. A lost
        // POST response leaves them unchanged; the next advance reads authority.
        const deletion = record.observed.deletion!;
        if (deletion.workerCleanup.state === "completed" && deletion.serverCleanup.state === "completed") return;
        const receipt: BotDeletionReceipt = { deletionId: deletion.deletionId, stop: record.cleanup!.stop,
          result: { state: "completed", code: null } };
        try {
          const result = await options.sessionApi.completeDeletion(record, receipt, signal);
          options.onReceiptConfirmed?.();
          options.store.observe(record.owner, result, now());
        } catch (cause) {
          // Old services reject a bound Session's null proof with this code.
          // Report the existing recovery reason instead of replaying that receipt.
          if (cause instanceof ApiError && cause.code === "session_conflict" && (receipt.stop === null || receipt.stop.stopProof.kind === "never_started")) {
            const latest = await refresh(record, signal);
            if (receipt.stop !== null) {
              const checked = await options.remote.readDeletionRecovery?.(latest.botId, signal, latest.owner);
              if (checked == null) throw cause;
              checkBotDeletionRecovery(latest, checked);
              if (checked.decision !== null || checked.hostingWorkerId !== options.remote.owner.workerId) return;
              if (!checked.requiresStopProof) throw cause;
            }
            if (latest.observed.deletion!.workerCleanup.state !== "completed") await reportMissing(latest);
            return;
          }
          throw cause;
        }
      });
    },
  };
};
export type BotDeletionManager = ReturnType<typeof createBotDeletion>;
