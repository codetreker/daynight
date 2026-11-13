import { ArchiveRepairRequiredError, archiveRepairCode } from "./archive-error.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { controllerJournalFormat } from "./journal-format.js";
import { runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import path from "node:path";
import { withStoppedControllerStorage } from "./stopped-storage.js";
import { assertCurrentSqlite, inspectSqlite } from "../../platform/sqlite-format.js";
import { parseSourceEvent, RELAY_LIMITS, type SourceEvent } from "../../session/controller-protocol.js";
import { sessionBinding } from "../../session/protocol.js";
import { controllerMetadataBudget } from "./media/metadata-budget.js";
import { openControllerOutbox, withOutboxTransactionOutcome } from "./outbox-store.js";

export type StoppedSourceTail = { sourceEpoch: string; batchId: string; events: readonly SourceEvent[] };
export type StoppedSourceTailReceipt = { sourceEpoch: string; batchId: string; lastAckedSourceSeq: string };

/** Deliver only the original stopped writer's durable tail; no native writer is opened. */
export const replayStoppedControllerHistory = async (options: {
  journalPath: string; ticket: ControllerLaunchTicket; stateDirectory?: string; signal?: AbortSignal;
  send(batch: StoppedSourceTail, signal: AbortSignal): Promise<StoppedSourceTailReceipt>;
}): Promise<void> => {
  const { ticket, journalPath } = options;
  const identity = { fence: { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration }, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const initial = new Database(journalPath, { readonly: true, fileMustExist: true });
  let original!: string;
  const assertStopped = (db: Database.Database): void => {
    const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null } | undefined;
    const s = row ? JSON.parse(row.snapshot) as ControllerSnapshot : null;
    if (!row || !s || row.owner_pid !== null || !s.nativeStopped || s.lifecycle !== "stopped" || s.executionId !== ticket.executionId || s.sessionId !== ticket.sessionId || s.claimId !== ticket.claimId || s.testExecutionId !== ticket.testExecutionId || s.executionGeneration !== ticket.executionGeneration || s.controllerInstanceId !== ticket.controllerInstanceId || row.ticket_hash !== controllerPayloadHash(ticket) || original !== undefined && row.snapshot !== original) throw new Error("Source replay requires the unchanged original stopped controller generation.");
    original = row.snapshot;
  };
  try { initial.transaction(() => { inspectSqlite(initial, controllerJournalFormat); assertStopped(initial); }).deferred(); }
  finally { initial.close(); }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const stateKey = "stopped_source_tail";
  let originalThrough: string | undefined;
  const local = <T>(action: (db: Database.Database) => T): T => withStoppedControllerStorage({ journalPath, ticket, stateDirectory: options.stateDirectory ?? path.dirname(journalPath), assertOriginal: assertStopped }, action);
  const settle = <T>(db: Database.Database, action: () => T): T => {
    try { return runSqliteImmediate(db, action); }
    catch (error) { throw withOutboxTransactionOutcome(error, sqliteTransactionOutcome(error)); }
  };
  for (;;) {
    signal.throwIfAborted();
    const batch = local(db => runSqliteImmediate(db, (): StoppedSourceTail | null => {
      assertCurrentSqlite(db, controllerJournalFormat); assertStopped(db);
      const outbox = openControllerOutbox(db, { assertWrite: () => { throw new Error("Stopped source batch construction cannot mutate the outbox."); } });
      const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack,CAST(source_floor AS TEXT) AS floor,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { through: string; ack: string; floor: string; projection_gap: string | null; archive_incomplete: number };
      if (originalThrough !== undefined && source.through !== originalThrough) throw new Error("The stopped source cutoff changed during replay.");
      originalThrough = source.through;
      const repairCode = archiveRepairCode(source);
      if (repairCode !== null) throw new ArchiveRepairRequiredError(repairCode);
      if (BigInt(source.floor) > BigInt(source.ack)) throw new Error("Stopped source floor has no complete unacknowledged event tail.");
      if (source.ack === source.through) return null;
      const existing = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(stateKey) as { value: string } | undefined;
      if (existing) {
        const batch = JSON.parse(existing.value) as StoppedSourceTail;
        if (batch.sourceEpoch !== ticket.executionId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(batch.batchId) || !Array.isArray(batch.events) || !batch.events.length || batch.events.length > RELAY_LIMITS.maxBatchEvents || Buffer.byteLength(JSON.stringify({ ...identity, ...batch })) > 2_097_152) throw new Error("Stopped source batch identity is corrupt.");
        let previous = BigInt(source.ack);
        for (const raw of batch.events) {
          const event = parseSourceEvent(raw);
          if (event.kind === "gap" || BigInt(event.sourceSeq) > BigInt(source.through)) throw new Error("Stopped history contains an invalid source event.");
          const value = outbox.valueAt(BigInt(event.sourceSeq));
          if (BigInt(event.sourceSeq) !== ++previous || value === undefined || JSON.stringify(parseSourceEvent({ ...(JSON.parse(value) as object), sourceSeq: event.sourceSeq })) !== JSON.stringify(event)) throw new Error("Stopped source batch differs from the original durable tail.");
        }
        return batch;
      }
      const events: SourceEvent[] = [], batchId = randomUUID();
      let previous = BigInt(source.ack);
      for (const row of outbox.pending(previous, RELAY_LIMITS.maxBatchEvents)) {
        if (BigInt(row.sequence) !== previous + 1n) throw new Error("Stopped history source sequence is incomplete.");
        const event = parseSourceEvent({ ...(JSON.parse(row.value) as object), sourceSeq: row.sequence });
        if (event.kind === "gap") throw new Error("Stopped history contains an explicit projection gap.");
        const candidate = { ...identity, sourceEpoch: ticket.executionId, batchId, events: [...events, event] };
        if (Buffer.byteLength(JSON.stringify(candidate)) > 2_097_152) { if (!events.length) throw new Error("Stopped source event exceeds the bounded replay profile."); break; }
        events.push(event); previous++;
      }
      if (!events.length) throw new Error("Stopped history has no complete unacknowledged event tail.");
      const batch = { sourceEpoch: ticket.executionId, batchId, events };
      const encoded = JSON.stringify(batch);
      // The stopped tail is a settlement copy; keep room for SQLite pages
      // and their durability journal without discarding the original outbox.
      controllerMetadataBudget(journalPath, db).assert(Buffer.byteLength(encoded) * 2 + 65536, true);
      db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(stateKey, encoded);
      return batch;
    }));
    if (!batch) return;
    const receipt = await options.send(batch, signal);
    signal.throwIfAborted();
    if (!receipt || Object.keys(receipt).sort().join() !== "batchId,lastAckedSourceSeq,sourceEpoch" || receipt.sourceEpoch !== batch.sourceEpoch || receipt.batchId !== batch.batchId || receipt.lastAckedSourceSeq !== batch.events.at(-1)!.sourceSeq) throw new Error("Stopped history source acknowledgement conflicts with its original batch.");
    local(db => settle(db, () => {
      assertCurrentSqlite(db, controllerJournalFormat); assertStopped(db);
      const cutoff = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through FROM execution WHERE id=1").get() as { through: string };
      if (cutoff.through !== originalThrough) throw new Error("The stopped source cutoff changed before acknowledgement.");
      const current = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(stateKey) as { value: string } | undefined;
      if (!current || current.value !== JSON.stringify(batch)) throw new Error("Stopped source batch changed before acknowledgement.");
      // This callback runs under the stopped-storage permit and its immediate
      // transaction, after the original generation and batch were verified.
      const outbox = openControllerOutbox(db, { assertWrite: () => {
        if (!db.inTransaction) throw new Error("Stopped source acknowledgement requires its original write transaction.");
        assertStopped(db);
      } });
      outbox.acknowledgeThrough(BigInt(receipt.lastAckedSourceSeq));
      db.prepare("UPDATE image_occurrences SET acknowledged=1 WHERE CAST(source_sequence AS INTEGER)<=?").run(BigInt(receipt.lastAckedSourceSeq));
      db.prepare("UPDATE execution SET last_acknowledged=MAX(last_acknowledged,?) WHERE id=1").run(BigInt(receipt.lastAckedSourceSeq));
      db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(stateKey);
    }));
  }
};
