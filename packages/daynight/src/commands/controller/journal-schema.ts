import type Database from "better-sqlite3";

/** Structure only; callers own the transaction and any writer-lease changes. */
export const migrateControllerJournalSchema = (db: Database.Database): void => {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > 6) throw new Error("Unsupported controller journal version.");
  if (version === 0) db.exec("CREATE TABLE execution (id INTEGER PRIMARY KEY CHECK(id=1), ticket_hash TEXT NOT NULL, owner_pid INTEGER, snapshot TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;");
  if (version < 2) db.exec("ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0; CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL); PRAGMA user_version=2;");
  if (version < 3) db.exec("ALTER TABLE operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;");
  if (version < 4) db.exec("ALTER TABLE execution ADD COLUMN projection_gap TEXT; PRAGMA user_version=4;");
  if (version < 5) db.exec("ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0; CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB); PRAGMA user_version=5;");
};
