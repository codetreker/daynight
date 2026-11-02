import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../../platform/sqlite-sql.js";
import { parseWebTaskV1, webClaimKey } from "./web-record.js";
import type { LocalTask } from "./web-types.js";

const steps = loadSqliteSequence(new URL("./sqlite/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);
const baselineSchema = schemas.get(baseline.version)!;
const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify a known format.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
const validateSchema = (db: Database.Database, expected: readonly SqliteSchemaObject[]): undefined => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (objects.length !== expected.length || objects.some((object, index) => {
    const known = expected[index]!;
    return object.type !== known.type || object.name !== known.name || object.sql === null || known.sql === null || definition(object.sql) !== definition(known.sql);
  })) throw new Error("The Web execution SQLite schema is incompatible with its known state format.");
};

export const webExecutionStoreFormat: SqliteFormat = {
  name: "Web execution state",
  baseline: { version: baseline.version, create: db => { db.exec(baseline.sql); } },
  unversioned: {
    validate: db => {
      validateSchema(db, baselineSchema);
      for (const row of db.prepare("SELECT identity, data FROM executions").iterate() as Iterable<{ identity: string; data: string }>) {
        const task = parseWebTaskV1(JSON.parse(row.data) as LocalTask);
        if (row.identity !== webClaimKey(task)) throw new Error("The Web execution row does not match its stored claim identity.");
      }
    },
    adopt: () => {},
  },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
  validateVersioned: (db, version) => {
    const expected = schemas.get(version);
    if (expected === undefined) throw new Error("Unsupported Web execution SQLite version.");
    validateSchema(db, expected);
  },
};
