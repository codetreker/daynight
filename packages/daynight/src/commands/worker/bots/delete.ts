import type { BotExecutionStore } from "./execution-store.js";
import type { BotProcess } from "./process.js";
import type { BotRemote } from "./remote.js";
import type { BotSessionApi, BotDeletionReceipt } from "./session-api.js";
import type { BotStore } from "./store.js";
import type { BotRecord } from "./types.js";
import { captureBotDeletionFiles, removeBotDeletionFile } from "./delete-files.js";

/** Owns local deletion and receipt reconciliation while the caller holds the Worker lock. */
export const createBotDeletion = (options: {
  homeDirectory: string; store: BotStore; executions: BotExecutionStore;
  process: BotProcess; sessionApi: BotSessionApi; remote: BotRemote; now?: () => number;
  dependencies?: { capture?: typeof captureBotDeletionFiles; remove?: typeof removeBotDeletionFile };
}) => {
  const now = options.now ?? Date.now;
  const capture = options.dependencies?.capture ?? captureBotDeletionFiles;
  const remove = options.dependencies?.remove ?? removeBotDeletionFile;
  const refresh = async (input: BotRecord, signal: AbortSignal): Promise<BotRecord> => {
    const bot = await options.remote.read(input.botId, signal);
    if (bot === null) throw new Error("Bot deletion authority is missing; local responsibility is retained.");
    const record = options.store.observe(input.owner, bot, now());
    if (record.observed.deletion === null || input.observed.deletion === null
      || record.observed.deletion.deletionId !== input.observed.deletion.deletionId
      || record.observed.deletion.requestedVersion !== input.observed.deletion.requestedVersion) throw new Error("Bot deletion authority changed; original local responsibility is retained.");
    return record;
  };
  return {
    advance: async (input: BotRecord, signal: AbortSignal): Promise<void> => {
      // An unavailable inventory/detail must not trigger destructive work or a
      // replacement receipt. Every retry observes the original deletion first.
      const original = await refresh(input, signal);
      await options.process.withDeletion(original, signal, async stop => {
        let record = options.store.get(original.owner, original.botId)!;
        let failureCode = "execution_stop_unproven";
        try {
          if (record.cleanup === undefined) {
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
          if (!signal.aborted) {
            const latest = await refresh(options.store.get(original.owner, original.botId)!, signal);
            if (latest.observed.deletion!.workerCleanup.state !== "completed") {
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
        const result = await options.sessionApi.completeDeletion(record, receipt, signal);
        options.store.observe(record.owner, result, now());
      });
    },
  };
};
export type BotDeletionManager = ReturnType<typeof createBotDeletion>;
