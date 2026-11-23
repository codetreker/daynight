import type Database from "better-sqlite3";

/** Restore the exact shipped schema for read-only and migration fixtures. */
export const restoreControllerJournalVersion = (db: Database.Database, version: 15 | 16 | 17 | 18): void => {
  if (version < 18) db.exec("DROP TABLE timeline_source_revisions; ALTER TABLE execution DROP COLUMN online_mode; ALTER TABLE image_occurrences DROP COLUMN part_index");
  if (version < 17) db.exec("DROP TABLE stopped_generations");
  if (version < 16) db.exec("DROP TABLE worker_lifecycle_bindings");
  db.pragma(`user_version=${version}`);
};
