import { sqliteFilename } from "../../platform/sqlite-filename.js";
import { ArchiveRepairRequiredError, ArchiveRequestError, archiveRepairCode } from "./archive-error.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { controllerJournalFormat } from "./journal-format.js";
import { runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { withStoppedControllerStorage } from "./stopped-storage.js";
import { assertCurrentSqlite, inspectSqlite } from "../../platform/sqlite-format.js";
import { parseSourceEvent, RELAY_LIMITS, type SourceEvent } from "../../session/controller-protocol.js";
import { sessionBinding } from "../../session/protocol.js";
import { openControllerOutbox, withOutboxTransactionOutcome } from "./outbox-store.js";
import { clearSourceWireThrough, sourceWireEvent, UnprovenSourceWireError } from "./source-wire.js";

export type StoppedSourceTail = { sourceEpoch: string; batchId: string; events: readonly SourceEvent[] };
export type StoppedSourceTailReceipt = { sourceEpoch: string; batchId: string; lastAckedSourceSeq: string };
export type StoppedSourceRecovery = { sourceEpoch: string; oldBatchId: string; recoveryId: string; cutoff: string; events: readonly SourceEvent[] };
export type StoppedSourceRecoveryReceipt = { sourceEpoch: string; recoveryId: string; verifiedThrough: string; currentThrough: string };
type RecoveryState = { version: 1; batchHash: string; cutoff: string; originalAck: string; verifiedThrough: string; inFlight: StoppedSourceRecovery | null };
const tailKey = "stopped_source_tail", recoveryKey = "stopped_source_recovery", limit = 2_097_152;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const conflict = (error: unknown): boolean => error instanceof ArchiveRequestError && error.status === 409 && error.code === "session_conflict";

/** Deliver only the original stopped writer's durable tail; no native writer is opened. */
export const replayStoppedControllerHistory = async (options: {
  journalPath: string; ticket: ControllerLaunchTicket; signal?: AbortSignal;
  send(batch: StoppedSourceTail, signal: AbortSignal): Promise<StoppedSourceTailReceipt>;
  recover?(batch: StoppedSourceRecovery, signal: AbortSignal): Promise<StoppedSourceRecoveryReceipt>;
}): Promise<void> => {
  const { ticket, journalPath } = options;
  const identity = { fence: { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration }, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const initial = new Database(sqliteFilename(journalPath), { readonly: true, fileMustExist: true });
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
  let originalThrough: string | undefined;
  const local = <T>(action: (db: Database.Database) => T): T => withStoppedControllerStorage({ journalPath, ticket, assertOriginal: assertStopped }, action);
  const settle = <T>(db: Database.Database, action: () => T): T => {
    try { return runSqliteImmediate(db, action); }
    catch (error) { throw withOutboxTransactionOutcome(error, sqliteTransactionOutcome(error)); }
  };
  const load = (db: Database.Database) => {
    assertCurrentSqlite(db, controllerJournalFormat); assertStopped(db);
    const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack,CAST(source_floor AS TEXT) AS floor,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { through: string; ack: string; floor: string; projection_gap: string | null; archive_incomplete: number };
    if (originalThrough !== undefined && source.through !== originalThrough) throw new Error("The stopped source cutoff changed during replay.");
    originalThrough = source.through;
    const repairCode = archiveRepairCode(source); if (repairCode !== null) throw new ArchiveRepairRequiredError(repairCode);
    if (BigInt(source.floor) > BigInt(source.ack)) throw new Error("Stopped source floor has no complete unacknowledged event tail.");
    const batchRow = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(tailKey) as { value: string } | undefined;
    const recoveryRow = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(recoveryKey) as { value: string } | undefined;
    return { source, batchRow, recoveryRow, outbox: openControllerOutbox(db, { assertWrite: () => { if (!db.inTransaction) throw new Error("Stopped source acknowledgement requires its original write transaction."); assertStopped(db); } }) };
  };
  const validateBatch = (db: Database.Database, loaded: ReturnType<typeof load>, encoded: string): { batch: StoppedSourceTail; actual: SourceEvent[]; changed: boolean; unproven: boolean } => {
    const batch = JSON.parse(encoded) as StoppedSourceTail;
    if (batch.sourceEpoch !== ticket.executionId || !uuid(batch.batchId) || !Array.isArray(batch.events) || !batch.events.length || batch.events.length > RELAY_LIMITS.maxBatchEvents || Buffer.byteLength(JSON.stringify({ ...identity, ...batch })) > limit) throw new Error("Stopped source batch identity is corrupt.");
    let previous = BigInt(loaded.source.ack), changed = false, unproven = false;
    const actual: SourceEvent[] = [];
    for (const raw of batch.events) {
      const event = parseSourceEvent(raw);
      if (event.kind === "gap" || BigInt(event.sourceSeq) > BigInt(loaded.source.through) || BigInt(event.sourceSeq) !== ++previous) throw new Error("Stopped history contains an invalid source event.");
      const value = loaded.outbox.valueAt(BigInt(event.sourceSeq));
      if (value === undefined) throw new Error("Stopped source batch differs from the original durable tail.");
      const source = { ...(JSON.parse(value) as object), sourceSeq: event.sourceSeq } as SourceEvent;
      let wire: SourceEvent;
      try { wire = sourceWireEvent(db, source, null); } catch (error) {
        if (!(error instanceof UnprovenSourceWireError)) throw error;
        wire = source; unproven = true;
      }
      if (JSON.stringify(wire) !== JSON.stringify(raw) && !isDeepStrictEqual(parseSourceEvent(source), event)) throw new Error("Stopped source batch differs from the original durable tail.");
      if (JSON.stringify(wire) !== JSON.stringify(raw)) changed = true;
      actual.push(wire);
    }
    return { batch, actual, changed, unproven };
  };
  const validateRecovery = (loaded: ReturnType<typeof load>, encodedBatch: string, value: string, actual: SourceEvent[]): RecoveryState => {
    const state = JSON.parse(value) as RecoveryState;
    if (Object.keys(state).sort().join() !== "batchHash,cutoff,inFlight,originalAck,verifiedThrough,version" || state.version !== 1 || state.batchHash !== digest(encodedBatch) || state.cutoff !== loaded.source.through || state.originalAck !== loaded.source.ack || !decimal(state.verifiedThrough) || BigInt(state.verifiedThrough) < BigInt(state.originalAck) || BigInt(state.verifiedThrough) > BigInt(actual.at(-1)!.sourceSeq)) throw new Error("Stopped source recovery state conflicts with its original batch.");
    if (state.verifiedThrough !== state.originalAck && !actual.some(event => event.sourceSeq === state.verifiedThrough)) throw new Error("Stopped source recovery prefix is invalid.");
    if (state.inFlight !== null) {
      const segment = state.inFlight, index = actual.findIndex(event => BigInt(event.sourceSeq) > BigInt(state.verifiedThrough));
      if (Object.keys(segment).sort().join() !== "cutoff,events,oldBatchId,recoveryId,sourceEpoch" || segment.sourceEpoch !== ticket.executionId || segment.oldBatchId !== (JSON.parse(encodedBatch) as StoppedSourceTail).batchId || segment.cutoff !== state.cutoff || !uuid(segment.recoveryId) || !Array.isArray(segment.events) || !segment.events.length || segment.events.length > RELAY_LIMITS.maxBatchEvents || index < 0 || JSON.stringify(segment.events) !== JSON.stringify(actual.slice(index, index + segment.events.length)) || Buffer.byteLength(JSON.stringify({ ...identity, ...segment })) > limit) throw new Error("Stopped source recovery segment conflicts with its original batch.");
    }
    if (Buffer.byteLength(value) > limit) throw new Error("Stopped source recovery record exceeds its storage budget.");
    return state;
  };
  const settleBatch = (batch: StoppedSourceTail, expectedRecovery: string | undefined): void => local(db => settle(db, () => {
    const loaded = load(db);
    if (!loaded.batchRow || loaded.batchRow.value !== JSON.stringify(batch) || loaded.recoveryRow?.value !== expectedRecovery) throw new Error("Stopped source batch changed before acknowledgement.");
    validateBatch(db, loaded, loaded.batchRow.value);
    if (expectedRecovery !== undefined) validateRecovery(loaded, loaded.batchRow.value, expectedRecovery, validateBatch(db, loaded, loaded.batchRow.value).actual);
    const end = BigInt(batch.events.at(-1)!.sourceSeq);
    loaded.outbox.acknowledgeThrough(end); clearSourceWireThrough(db, end);
    db.prepare("UPDATE image_occurrences SET acknowledged=1 WHERE CAST(source_sequence AS INTEGER)<=?").run(end);
    db.prepare("UPDATE execution SET last_acknowledged=MAX(last_acknowledged,?) WHERE id=1").run(end);
    db.prepare("DELETE FROM image_runtime_state WHERE key IN (?,?)").run(tailKey, recoveryKey);
  }));
  const readOriginalReceipt = async (batch: StoppedSourceTail): Promise<void> => {
    const receipt = await options.send(batch, signal); signal.throwIfAborted();
    if (!receipt || Object.keys(receipt).sort().join() !== "batchId,lastAckedSourceSeq,sourceEpoch" || receipt.sourceEpoch !== batch.sourceEpoch || receipt.batchId !== batch.batchId || !decimal(receipt.lastAckedSourceSeq) || BigInt(receipt.lastAckedSourceSeq) < BigInt(batch.events.at(-1)!.sourceSeq) || BigInt(receipt.lastAckedSourceSeq) > BigInt(originalThrough!)) throw new Error("Stopped history source acknowledgement conflicts with its original batch.");
  };
  const sendOriginal = async (batch: StoppedSourceTail, recovery: string | undefined): Promise<void> => {
    await readOriginalReceipt(batch);
    settleBatch(batch, recovery);
  };
  for (;;) {
    signal.throwIfAborted();
    const pending = local(db => settle(db, () => {
      const loaded = load(db);
      if (loaded.source.ack === loaded.source.through) { if (loaded.batchRow || loaded.recoveryRow) throw new Error("Stopped source state remains after its cutoff."); return null; }
      if (loaded.batchRow) {
        const checked = validateBatch(db, loaded, loaded.batchRow.value);
        if (loaded.recoveryRow) { if (checked.unproven) throw new Error("The original source wire projection cannot be proven."); validateRecovery(loaded, loaded.batchRow.value, loaded.recoveryRow.value, checked.actual); }
        return { ...checked, encoded: loaded.batchRow.value, recovery: loaded.recoveryRow?.value };
      }
      if (loaded.recoveryRow) throw new Error("Stopped source recovery lost its original batch.");
      const events: SourceEvent[] = [], batchId = randomUUID(); let previous = BigInt(loaded.source.ack);
      for (const row of loaded.outbox.pending(previous, RELAY_LIMITS.maxBatchEvents)) {
        if (BigInt(row.sequence) !== previous + 1n) throw new Error("Stopped history source sequence is incomplete.");
        const source = { ...(JSON.parse(row.value) as object), sourceSeq: row.sequence } as SourceEvent;
        if (parseSourceEvent(source).kind === "gap") throw new Error("Stopped history contains an explicit projection gap.");
        const event = sourceWireEvent(db, source, null);
        if (Buffer.byteLength(JSON.stringify({ ...identity, sourceEpoch: ticket.executionId, batchId, events: [...events, event] })) > limit) { if (!events.length) throw new Error("Stopped source event exceeds the bounded replay profile."); break; }
        events.push(event); previous++;
      }
      if (!events.length) throw new Error("Stopped history has no complete unacknowledged event tail.");
      const batch = { sourceEpoch: ticket.executionId, batchId, events }, encoded = JSON.stringify(batch);
      db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(tailKey, encoded);
      return { batch, actual: events, changed: false, unproven: false, encoded, recovery: undefined };
    }));
    if (!pending) return;
    if (pending.recovery === undefined) {
      try { await sendOriginal(pending.batch, undefined); continue; }
      catch (error) {
        if (!conflict(error) || !pending.changed || pending.unproven || !options.recover) throw error;
        local(db => settle(db, () => {
          const loaded = load(db);
          if (loaded.batchRow?.value !== pending.encoded || loaded.recoveryRow) throw new Error("Stopped source batch changed before recovery.");
          const checked = validateBatch(db, loaded, pending.encoded);
          if (!checked.changed || checked.unproven) throw new Error("Stopped source recovery has no proven wire difference.");
          const state: RecoveryState = { version: 1, batchHash: digest(pending.encoded), cutoff: loaded.source.through, originalAck: loaded.source.ack, verifiedThrough: loaded.source.ack, inFlight: null };
          db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(recoveryKey, JSON.stringify(state));
        }));
      }
      continue;
    }
    const segment = local(db => settle(db, () => {
      const loaded = load(db);
      if (loaded.batchRow?.value !== pending.encoded || loaded.recoveryRow?.value !== pending.recovery) throw new Error("Stopped source recovery changed before dispatch.");
      const checked = validateBatch(db, loaded, pending.encoded), state = validateRecovery(loaded, pending.encoded, pending.recovery!, checked.actual);
      if (state.verifiedThrough === checked.actual.at(-1)!.sourceSeq) return { state: pending.recovery!, request: null };
      if (state.inFlight) return { state: pending.recovery!, request: state.inFlight };
      const request: StoppedSourceRecovery = { sourceEpoch: ticket.executionId, oldBatchId: pending.batch.batchId, recoveryId: randomUUID(), cutoff: state.cutoff, events: [] };
      const events: SourceEvent[] = [];
      for (const event of checked.actual.filter(event => BigInt(event.sourceSeq) > BigInt(state.verifiedThrough))) {
        const candidate = { ...request, events: [...events, event] }, encoded = JSON.stringify({ ...state, inFlight: candidate });
        if (Buffer.byteLength(JSON.stringify({ ...identity, ...candidate })) > limit || Buffer.byteLength(encoded) > limit) { if (!events.length) throw new Error("Stopped source recovery event exceeds its bounded request or record budget."); break; }
        events.push(event);
      }
      const next = JSON.stringify({ ...state, inFlight: { ...request, events } });
      db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(next, recoveryKey);
      return { state: next, request: { ...request, events } };
    }));
    if (segment.request === null) { settleBatch(pending.batch, segment.state); continue; }
    if (!options.recover) throw new Error("Stopped source recovery requires a compatible service.");
    let receipt: StoppedSourceRecoveryReceipt;
    try { receipt = await options.recover(segment.request, signal); }
    catch (error) {
      if (!conflict(error)) throw error;
      // A concurrent original batch may have committed; preserve the recovery
      // intent unless its exact original request receives a valid receipt.
      try { await readOriginalReceipt(pending.batch); } catch { throw error; }
      settleBatch(pending.batch, segment.state);
      continue;
    }
    signal.throwIfAborted();
    if (!receipt || Object.keys(receipt).sort().join() !== "currentThrough,recoveryId,sourceEpoch,verifiedThrough" || receipt.sourceEpoch !== segment.request.sourceEpoch || receipt.recoveryId !== segment.request.recoveryId || receipt.verifiedThrough !== segment.request.events.at(-1)!.sourceSeq || !decimal(receipt.currentThrough) || BigInt(receipt.currentThrough) < BigInt(receipt.verifiedThrough) || BigInt(receipt.currentThrough) > BigInt(segment.request.cutoff)) throw new Error("Stopped source recovery acknowledgement conflicts with its verified segment.");
    local(db => settle(db, () => {
      const loaded = load(db);
      if (loaded.batchRow?.value !== pending.encoded || loaded.recoveryRow?.value !== segment.state) throw new Error("Stopped source recovery changed before acknowledgement.");
      const checked = validateBatch(db, loaded, pending.encoded), state = validateRecovery(loaded, pending.encoded, segment.state, checked.actual);
      if (JSON.stringify(state.inFlight) !== JSON.stringify(segment.request)) throw new Error("Stopped source recovery segment changed before acknowledgement.");
      db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(JSON.stringify({ ...state, verifiedThrough: receipt.verifiedThrough, inFlight: null }), recoveryKey);
    }));
  }
};
