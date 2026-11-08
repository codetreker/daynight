import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../../platform/sqlite-sql.js";

const steps = loadSqliteSequence(new URL("./sqlite/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);
const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify Herdr lifecycle state.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
export const createHerdrLifecycleStoreFormat = (migrateNativeLaunch?: (db: Database.Database) => void): SqliteFormat => ({
  name: "Herdr lifecycle state",
  baseline: { version: baseline.version, create: db => { db.exec(baseline.sql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => {
    if (step.version === 3) {
      if (!migrateNativeLaunch) throw new Error("Native launch provenance requires the lifecycle owner migration.");
      migrateNativeLaunch(db);
    }
    db.exec(step.sql);
  } })),
  validateVersioned: (db, version) => {
    const expected = schemas.get(version);
    if (expected === undefined) throw new Error("Unsupported Herdr lifecycle SQLite version.");
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
    if (objects.length !== expected.length || objects.some((object, index) => {
      const known = expected[index]!;
      return object.type !== known.type || object.name !== known.name || object.sql === null || known.sql === null || definition(object.sql) !== definition(known.sql);
    })) throw new Error("The Herdr lifecycle SQLite schema does not match its stored version.");
  },
});
export const herdrLifecycleStoreFormat = createHerdrLifecycleStoreFormat();
