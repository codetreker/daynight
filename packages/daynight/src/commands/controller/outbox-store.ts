import type Database from "better-sqlite3";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";

export type OutboxRow = { readonly sequence: string; readonly value: string };
export type OutboxWriteContext = { readonly assertWrite: () => void };
type Phase = "outbox-read" | "outbox-append" | "outbox-ack" | "outbox-clear";

const invalid = (phase: Phase, message: string): never => {
  throw new SqliteAccessError("invalid-format", { database: "controller-journal", phase }, { cause: new Error(message), outcome: "unknown" });
};

/** Only the owning transaction boundary can establish the operation's outcome. */
export const withOutboxTransactionOutcome = (error: unknown, outcome: SqliteOutcome): unknown => {
  if (!(error instanceof SqliteAccessError) || !["outbox-read", "outbox-append", "outbox-ack", "outbox-clear"].includes(error.context.phase) || outcome === "unknown") return error;
  return new SqliteAccessError(error.kind, error.context, { cause: error, outcome, connectionClosed: error.connectionClosed });
};

const readByteLength = (db: Database.Database, phase: Phase): number => {
  const row = db.prepare("SELECT byte_length, typeof(byte_length) AS type FROM outbox_totals WHERE id=1").get() as { byte_length: number; type: string } | undefined;
  if (row === undefined || row.type !== "integer" || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0) return invalid(phase, "Invalid outbox byte total.");
  const hasRows = db.prepare("SELECT 1 FROM outbox LIMIT 1").get() !== undefined;
  if (hasRows !== (row.byte_length > 0)) return invalid(phase, "Outbox total disagrees with queue emptiness.");
  return row.byte_length;
};

export const readControllerOutboxByteLength = (db: Database.Database): number => readByteLength(db, "outbox-read");

export const openControllerOutbox = (db: Database.Database, context: OutboxWriteContext) => {
  const setTotal = (value: number, phase: Phase): void => {
    if (db.prepare("UPDATE outbox_totals SET byte_length=? WHERE id=1").run(value).changes !== 1) invalid(phase, "Missing outbox byte total.");
  };
  const clear = (): void => {
    context.assertWrite();
    readByteLength(db, "outbox-clear");
    db.prepare("DELETE FROM outbox").run();
    setTotal(0, "outbox-clear");
  };
  return {
    byteLength: (): number => readControllerOutboxByteLength(db),
    append: (sequence: bigint, encoded: string): void => {
      context.assertWrite();
      const current = readByteLength(db, "outbox-append");
      const added = Buffer.byteLength(encoded, "utf8");
      if (added === 0 || !Number.isSafeInteger(current + added)) invalid("outbox-append", "Invalid outbox byte increment.");
      db.prepare("INSERT INTO outbox(sequence,value) VALUES(?,?)").run(sequence, encoded);
      setTotal(current + added, "outbox-append");
    },
    acknowledgeThrough: (sequence: bigint): void => {
      context.assertWrite();
      const current = readByteLength(db, "outbox-ack");
      const last = db.prepare("SELECT sequence FROM outbox ORDER BY sequence DESC LIMIT 1").safeIntegers().get() as { sequence: bigint } | undefined;
      if (last === undefined) return;
      if (sequence >= last.sequence) {
        db.prepare("DELETE FROM outbox").run();
        setTotal(0, "outbox-ack");
        return;
      }
      let removed = 0;
      for (const row of db.prepare("SELECT value FROM outbox WHERE sequence<=? ORDER BY sequence").iterate(sequence) as Iterable<{ value: string }>) {
        removed += Buffer.byteLength(row.value, "utf8");
        if (!Number.isSafeInteger(removed) || removed > current) invalid("outbox-ack", "Outbox byte decrement exceeds its total.");
      }
      if (removed === 0) return;
      if (removed >= current) invalid("outbox-ack", "Outbox byte decrement leaves an invalid total.");
      db.prepare("DELETE FROM outbox WHERE sequence<=?").run(sequence);
      setTotal(current - removed, "outbox-ack");
    },
    clear,
    pending: (after: bigint | null, limit: number): readonly OutboxRow[] => after === null
      ? db.prepare("SELECT CAST(sequence AS TEXT) AS sequence,value FROM outbox ORDER BY outbox.sequence LIMIT ?").all(limit) as OutboxRow[]
      : db.prepare("SELECT CAST(sequence AS TEXT) AS sequence,value FROM outbox WHERE sequence>? ORDER BY outbox.sequence LIMIT ?").all(after, limit) as OutboxRow[],
    valueAt: (sequence: bigint): string | undefined => (db.prepare("SELECT value FROM outbox WHERE sequence=?").get(sequence) as { value: string } | undefined)?.value,
  };
};
