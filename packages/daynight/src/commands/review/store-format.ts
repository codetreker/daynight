import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";

const steps = loadSqliteSequence(new URL("./sqlite/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);

const sqlTokens = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\s]/g);
  if (tokens === null) throw new Error("Review schema contains an empty SQL definition.");
  const normalized = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"))
    .map(token => /^[A-Za-z_]/.test(token) ? token.toLowerCase() : token);
  if (normalized.at(-1) === ";") normalized.pop();
  return JSON.stringify(normalized);
};

const validateReviewVersion = (db: Database.Database, version: number): undefined => {
  const expected = schemas.get(version);
  if (expected === undefined) throw new Error(`Unsupported Review schema version ${version}.`);
  const actual = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (actual.length !== expected.length || actual.some((object, index) => {
    const definition = expected[index]!;
    return object.name !== definition.name || object.type !== definition.type || object.sql === null || definition.sql === null || sqlTokens(object.sql) !== sqlTokens(definition.sql);
  })) throw new Error(`Review SQLite structure does not match schema version ${version}.`);
};

export const reviewFormat: SqliteFormat = {
  name: "Review",
  baseline: {
    version: baseline.version,
    create: db => { db.exec(baseline.sql); },
  },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
  validateVersioned: validateReviewVersion,
};
