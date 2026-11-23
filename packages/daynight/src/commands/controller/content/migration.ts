import { sqliteDisplayFilename } from "../../../platform/sqlite-filename.js";
import type Database from "better-sqlite3";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalId } from "../../../api/parse.js";
import type { JournalMigrationContext } from "../journal-format.js";
import { migrationDirectoryExists, readMigrationSource } from "../pending-content.js";
import { assertControllerStoragePermit } from "../storage-lock.js";

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
export const importControllerTimeline = (db: Database.Database, context: JournalMigrationContext, schemaSql: string): undefined => {
  const assertMigration = (): void => {
    if (!db.inTransaction) throw new Error("Timeline import requires the journal migration transaction.");
    assertControllerStoragePermit(context.storagePermit, context.storagePermit.journalFile);
    if (!db.memory && sqliteDisplayFilename(db.name) !== context.storagePermit.journalFile) throw new Error("Timeline import permit belongs to another database.");
  };
  assertMigration();
  // Capture committed pointers before the DDL drops their table. The body and
  // SQL metadata remain independent; only kind is needed by the target schema.
  const pointers = db.prepare("SELECT id,revision,entry_seq,content_hash,content_file FROM content_index ORDER BY id").all() as { id: unknown; revision: unknown; entry_seq: unknown; content_hash: unknown; content_file: unknown }[];
  const root = `${sqliteDisplayFilename(db.name)}.pending-content`;
  let sourceExists: boolean | undefined;
  db.exec(schemaSql);
  const insert = db.prepare("INSERT INTO timeline_entries(id,entry_seq,revision,kind,value,content_hash,byte_length) VALUES(?,?,?,?,?,?,?)");
  const sequences = new Set<string>();
  let count = 0, bytes = 0;
  const numeric = db.prepare("SELECT CAST(? AS NUMERIC) AS value").safeIntegers();
  const integer = (value: unknown): bigint | undefined => {
    if (typeof value !== "string" || !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(value)) return undefined;
    const parsed = (numeric.get(value) as { value: number | bigint }).value;
    return typeof parsed === "bigint" && parsed > 0n ? parsed : undefined;
  };
  for (const pointer of pointers) {
    const seq = integer(pointer.entry_seq), revision = integer(pointer.revision);
    if (typeof pointer.id !== "string" || typeof pointer.content_hash !== "string" || typeof pointer.content_file !== "string"
      || (pointer.content_file === "." || pointer.content_file === ".." || /[/\\\0]/.test(pointer.content_file) || pointer.content_file.length === 0)
      || seq === undefined || revision === undefined || sequences.has(seq.toString())) continue;
    sourceExists ??= migrationDirectoryExists(root) && migrationDirectoryExists(join(root, "entries"));
    if (!sourceExists) continue;
    const source = readMigrationSource(join(root, "entries", pointer.content_file));
    if (source === undefined || source.length === 0) continue;
    let value: string;
    try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source); }
    catch (error) { if (error instanceof TypeError) continue; throw error; }
    let body: unknown;
    try { body = JSON.parse(value); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (body === null || typeof body !== "object" || Array.isArray(body) || !("kind" in body)) continue;
    const kind = body.kind;
    if (typeof kind !== "string" && typeof kind !== "number" && typeof kind !== "boolean") continue;
    insert.run(pointer.id, seq, revision, typeof kind === "boolean" ? BigInt(Number(kind)) : typeof kind === "number" && Number.isSafeInteger(kind) ? BigInt(kind) : kind, value, pointer.content_hash, source.length);
    sequences.add(seq.toString()); count++; bytes += source.length;
  }
  db.prepare("UPDATE timeline_totals SET entry_count=?,byte_length=? WHERE id=1").run(count, bytes);
  db.prepare("UPDATE execution SET legacy_timeline_cleanup_pending=1 WHERE id=1").run();
};
