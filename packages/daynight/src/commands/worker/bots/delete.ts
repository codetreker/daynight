import { hasNeverStartedDeletionEvidence, type BotExecutionStore } from "./execution-store.js";
import { BotExecutionEvidenceMissingError, type BotProcess } from "./process.js";
import type { BotRemote } from "./remote.js";
import type { BotSessionApi, BotDeletionReceipt } from "./session-api.js";
import type { BotStore } from "./store.js";
import type { BotRecord } from "./types.js";
import { captureBotDeletionFiles, removeBotDeletionFile } from "./delete-files.js";
import { ApiError } from "../../../api/client.js";

export const requiresBotDeletionRecovery = (record: BotRecord): boolean => record.observed.deletion?.workerCleanup.state === "failed"
  && record.observed.deletion.workerCleanup.code === "execution_evidence_missing";

/** Owns local deletion and receipt reconciliation while the caller holds the Worker lock. */
export const createBotDeletion = (options: {
  homeDirectory: string; store: BotStore; executions: BotExecutionStore;
  process: BotProcess; sessionApi: Pick<BotSessionApi, "completeDeletion">; remote: BotRemote; now?: () => number;
  onReceiptConfirmed?(): void;
  recoveryWorkerId?: string;
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
      if (settings.recover === true && !requiresBotDeletionRecovery(original)) throw new Error("Bot deletion no longer requires execution evidence recovery.");
      if (requiresBotDeletionRecovery(original) && settings.recover !== true) return;
      if (requiresBotDeletionRecovery(original) && original.intent === null && original.cleanup?.stop == null) {
        throw new BotExecutionEvidenceMissingError();
      }
      if (requiresBotDeletionRecovery(original) && original.cleanup?.stop?.stopProof.kind === "never_started") {
        const confirmedCleanup = original.cleanup.localCompleted && options.recoveryWorkerId !== undefined
          && original.cleanup.workerId === options.recoveryWorkerId;
        if (!confirmedCleanup && !hasNeverStartedDeletionEvidence(original, original.intent === null ? null : options.executions.get(original))) {
          throw new BotExecutionEvidenceMissingError();
        }
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
        if (execution === null || execution.launchSubmission !== "not-submitted" && !rejected && !hasNeverStartedDeletionEvidence(original, execution)) {
          await reportMissing(original);
          if (settings.recover === true) throw new BotExecutionEvidenceMissingError();
          return;
        }
      }
      if (original.observed.deletion!.workerCleanup.state === "completed" && original.observed.deletion!.serverCleanup.state === "completed") return;
      await options.process.withDeletion(original, signal, async stop => {
        let record = options.store.get(original.owner, original.botId)!;
        let failureCode = "execution_stop_unproven";
        try {
          if (record.cleanup === undefined || record.cleanup.stop === null && (record.intent !== null || record.definition?.sessionId != null)) {
            const proof = await stop();
            record = options.store.get(original.owner, original.botId)!;
            failureCode = "private_cleanup_failed";
            const execution = record.intent === null ? null : options.executions.get(record);
            const targets = await capture(options.homeDirectory, record, execution, signal);
            record = options.store.prepareDeletion(record, proof, targets);
          }
          failureCode = "private_cleanup_failed";
          if (settings.recover === true && options.recoveryWorkerId !== undefined
            && record.cleanup!.stop !== null) {
            record = options.store.bindDeletionWorker(record, options.recoveryWorkerId);
          }
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
          // A conflict alone does not prove the receipt was unapplied. Read its
          // original cleanup state before classifying unsupported stop evidence.
          if (cause instanceof ApiError && cause.phase === "response" && cause.status === 409 && cause.code === "session_conflict"
            && (receipt.stop === null || receipt.stop.stopProof.kind === "never_started" || record.initializationDeletion !== undefined)) {
            const latest = await refresh(record, signal);
            if (latest.observed.deletion!.workerCleanup.state !== "completed") {
              if (latest.cleanup?.stop?.stopProof.kind === "never_started" && latest.cleanup.workerId !== undefined) {
                options.store.rejectNeverStartedDeletion(latest);
              }
              await reportMissing(options.store.get(latest.owner, latest.botId)!);
            }
            return;
          }
          throw cause;
        }
      });
    },
  };
};
export type BotDeletionManager = ReturnType<typeof createBotDeletion>;
