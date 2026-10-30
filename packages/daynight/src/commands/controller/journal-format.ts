import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import type { SqliteFormat, SqliteSource } from "../../platform/sqlite-format.js";

const executionColumns = (version: number): string => [
  "id INTEGER PRIMARY KEY CHECK(id=1)", "ticket_hash TEXT NOT NULL", "owner_pid INTEGER", "snapshot TEXT NOT NULL", "last_sequence INTEGER NOT NULL DEFAULT 0",
  ...(version >= 2 ? ["last_acknowledged INTEGER NOT NULL DEFAULT 0"] : []),
  ...(version >= 4 ? ["projection_gap TEXT"] : []),
  ...(version >= 5 ? ["source_floor INTEGER NOT NULL DEFAULT 0"] : []),
].join(", ");
const schema = (version: number): readonly { name: string; sql: string }[] => [
  { name: "execution", sql: `CREATE TABLE execution (${executionColumns(version)})` },
  { name: "operations", sql: `CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL${version >= 3 ? ", acknowledged INTEGER NOT NULL DEFAULT 0" : ""})` },
  { name: "outbox", sql: "CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)" },
  ...(version >= 2 ? [{ name: "projection", sql: "CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL)" }] : []),
  ...(version >= 5 ? [{ name: "resources", sql: "CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB)" }] : []),
];
// These shipped definitions contain no string literals; whitespace and case do
// not distinguish their finite CREATE/ALTER layouts.
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const validateVersioned = (db: Database.Database, version: number): undefined => {
  const expected = [...schema(version)].sort((a, b) => a.name.localeCompare(b.name));
  const actual = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string; type: string; sql: string | null }[];
  if (actual.length !== expected.length || actual.some((row, index) => row.type !== "table" || row.name !== expected[index]!.name || row.sql === null || normalized(row.sql) !== normalized(expected[index]!.sql))) throw new Error("Controller journal does not match its declared schema version.");
};

export const controllerJournalFormat: SqliteFormat = {
  name: "controller-journal",
  baseline: { version: 1, create: (db) => { for (const table of schema(1)) db.exec(table.sql); } },
  migrations: [
    { toVersion: 2, up: (db) => { db.exec("ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0; CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL)"); } },
    { toVersion: 3, up: (db) => { db.exec("ALTER TABLE operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0"); } },
    { toVersion: 4, up: (db) => { db.exec("ALTER TABLE execution ADD COLUMN projection_gap TEXT"); } },
    { toVersion: 5, up: (db) => { db.exec("ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0; CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB)"); } },
  ],
  validateVersioned,
};

export const assertJournalMigrationAllowed = (db: Database.Database, source: SqliteSource): undefined => {
  if (source.kind === "empty") return;
  const owner = db.prepare("SELECT owner_pid FROM execution WHERE id=1").get() as { owner_pid: number | null } | undefined;
  if (owner === undefined || owner.owner_pid === null) return;
  try { process.kill(owner.owner_pid, 0); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: 5 }, { cause });
  }
  throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: 5 });
};
