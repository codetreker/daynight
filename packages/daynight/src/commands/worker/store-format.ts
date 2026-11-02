import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";

const steps = loadSqliteSequence(new URL("./sqlite/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);

const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify a known format.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
const incompatible = (): never => { throw new Error("The Worker SQLite schema is incompatible with its known minimal index formats."); };

const matchesSchema = (objects: readonly SqliteSchemaObject[], expected: readonly SqliteSchemaObject[]): boolean => objects.length === expected.length && objects.every((object, index) => {
  const known = expected[index]!;
  return object.name === known.name && object.type === known.type && object.sql !== null && known.sql !== null && definition(object.sql) === definition(known.sql);
});

export const workerStoreFormat: SqliteFormat = {
  name: "Worker state",
  baseline: {
    version: baseline.version,
    create: db => { db.exec(baseline.sql); },
  },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
  validateVersioned: (db, version) => {
    const expected = schemas.get(version);
    if (expected === undefined) return incompatible();
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
    if (!matchesSchema(objects, expected)) return incompatible();
  },
};
