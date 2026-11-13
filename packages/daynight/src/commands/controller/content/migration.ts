import type Database from "better-sqlite3";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalId } from "../../../api/parse.js";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { loadSqliteSql } from "../../../platform/sqlite-sql.js";
import { controllerJournalFormatWithExtension, type JournalMigrationContext } from "../journal-format.js";
import { captureCommittedPendingTimeline } from "../pending-content.js";
import { assertControllerStoragePermit } from "../storage-lock.js";
import { openTimelineStore } from "./timeline-store.js";

const timelineSql = loadSqliteSql(new URL("./timeline-schema.sql", import.meta.url));

/** Empty SQL cannot establish ownership of a retained file archive. */
export const assertNoOrphanTimelineSource = (journal: string): void => {
  const root = `${journal}.pending-content`;
  let rootStat;
  try { rootStat = lstatSync(root); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || process.platform !== "win32" && (rootStat.mode & 0o077) !== 0) throw new Error("Pending archive source is not a private directory.");
  for (const name of readdirSync(root)) {
    const file = join(root, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Pending archive source has no original controller execution.");
    if (stat.isDirectory() && ["entries", "timeline", "resources", "blobs", "legacy-resources", "legacy-sql"].includes(name) && readdirSync(file).length === 0) continue;
    if (stat.isFile() && name === "manifest.json") {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: unknown; sessionId: unknown };
      if (manifest.schemaVersion === 1 && typeof manifest.sessionId === "string" && canonicalId(manifest.sessionId) === manifest.sessionId) continue;
    }
    if (stat.isFile() && name === "index.json") {
      const index = JSON.parse(readFileSync(file, "utf8")) as { entries: unknown; resources: unknown };
      if (Array.isArray(index.entries) && Array.isArray(index.resources) && index.entries.length === 0 && index.resources.length === 0) continue;
    }
    if (stat.isFile() && name === "resource-pins.json") {
      const pins: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof pins === "object" && pins !== null && !Array.isArray(pins) && Object.keys(pins).length === 0) continue;
    }
    throw new Error("Pending archive source has no original controller execution.");
  }
};

/** Import is part of the caller's original immediate versioned migration transaction. */
export const importControllerTimeline = (db: Database.Database, context: JournalMigrationContext): undefined => {
  const assertWrite = (additionalBytes: number): void => {
    if (!db.inTransaction) throw new Error("Timeline import requires the journal migration transaction.");
    assertControllerStoragePermit(context.storagePermit, context.storagePermit.journalFile);
    if (!db.memory && db.name !== context.storagePermit.journalFile) throw new Error("Timeline import permit belongs to another database.");
    context.assertReservedWrite(additionalBytes);
  };
  assertWrite(0);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
  let sessionId: string | undefined;
  if (row === undefined) {
    if (db.prepare("SELECT 1 FROM content_index LIMIT 1").get() !== undefined) throw new Error("Legacy archive content has no original controller execution.");
    assertNoOrphanTimelineSource(db.name);
  } else {
    const snapshot = JSON.parse(row.snapshot) as { executionId?: unknown; sessionId?: unknown };
    if (typeof snapshot.executionId !== "string" || canonicalId(snapshot.executionId) !== snapshot.executionId || typeof snapshot.sessionId !== "string" || canonicalId(snapshot.sessionId) !== snapshot.sessionId) throw new Error("Legacy journal execution or session identity is invalid.");
    sessionId = snapshot.sessionId;
  }
  const source = sessionId === undefined ? undefined : captureCommittedPendingTimeline(db, sessionId);
  db.exec(timelineSql);
  const store = openTimelineStore(db, { assertWrite });
  let count = 0, bytes = 0;
  source?.iterate(entry => {
    const length = Buffer.byteLength(JSON.stringify(entry));
    store.save(entry);
    count++; bytes += length;
  });
  const totals = store.totals();
  if (totals.entryCount !== count || totals.byteLength !== bytes) throw new Error("Imported timeline totals differ from the committed source.");
  const actual = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes FROM timeline_entries").get() as { count: number; bytes: number };
  if (actual.count !== count || actual.bytes !== bytes) throw new Error("Imported timeline totals differ from the stored rows.");
  db.prepare("UPDATE execution SET legacy_timeline_cleanup_pending=1 WHERE id=1").run();
};

/** Production discovery remains the numbered journal; this isolated format is callable by components. */
export const controllerTimelineFormatForMigration = (contextFor: (db: Database.Database) => JournalMigrationContext): SqliteFormat => {
  const format = controllerJournalFormatWithExtension(contextFor, {
    schema: { version: 10, sql: timelineSql },
    migrate: (db, _source, context) => importControllerTimeline(db, context),
  });
  return { ...format, baseline: { ...format.baseline, create: db => {
    assertNoOrphanTimelineSource(db.name);
    return format.baseline.create(db);
  } } };
};

export const controllerTimelineFormat = controllerTimelineFormatForMigration(() => { throw new Error("Timeline migration requires its original storage permit and reserved-write context."); });
