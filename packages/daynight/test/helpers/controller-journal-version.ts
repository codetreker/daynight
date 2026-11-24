import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";

/** Restore the exact shipped schema for read-only and migration fixtures. */
export const dropBotHistoryCacheSchema = (db: Database.Database): void => {
  db.exec("DROP INDEX bot_history_image_positions; DROP INDEX bot_history_capture_entry; DROP TABLE bot_history_identity; DROP TABLE bot_history_state; DROP TABLE bot_resource_retirement");
};

export const restoreControllerJournalVersion = (db: Database.Database, version: 15 | 16 | 17 | 18 | 19 | 20): void => {
  dropBotHistoryCacheSchema(db);
  if (version < 18) db.exec("DROP TABLE timeline_source_revisions; ALTER TABLE execution DROP COLUMN online_mode; ALTER TABLE image_occurrences DROP COLUMN part_index");
  if (version < 17) db.exec("DROP TABLE stopped_generations");
  if (version >= 16 && version < 20 && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='worker_lifecycle_bindings'").get() === undefined) {
    db.exec(readFileSync(new URL("../../src/commands/controller/sqlite/journal/016-worker-lifecycle.sql", import.meta.url), "utf8"));
  }
  db.pragma(`user_version=${version}`);
};
