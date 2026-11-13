import type Database from "better-sqlite3";

/** Called only by migration 011, within its existing reserved write transaction. */
export const initializeOutboxAccounting = (db: Database.Database, sql: string): undefined => {
  db.exec(sql);
  let total = 0;
  for (const row of db.prepare("SELECT value FROM outbox ORDER BY sequence").iterate() as Iterable<{ value: string }>) {
    total += Buffer.byteLength(row.value, "utf8");
    if (!Number.isSafeInteger(total)) throw new Error("Outbox byte total exceeds the safe integer range.");
  }
  if (db.prepare("UPDATE outbox_totals SET byte_length=? WHERE id=1").run(total).changes !== 1) throw new Error("Missing migrated outbox byte total.");
};
