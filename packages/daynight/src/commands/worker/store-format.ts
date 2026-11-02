import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../platform/sqlite-format.js";
import { loadSqliteSql, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";

const baselineSql = loadSqliteSql(new URL("./sqlite/baseline-5.sql", import.meta.url));
const adoptionSql = loadSqliteSql(new URL("./sqlite/adopt-six-column.sql", import.meta.url));
const sourceSixColumnSql = loadSqliteSql(new URL("./sqlite/source-six-column.sql", import.meta.url));
const currentSchema = sqliteSchemaSnapshots([{ version: 5, sql: baselineSql }]).get(5)!;
const sixColumnSchema = sqliteSchemaSnapshots([{ version: 0, sql: sourceSixColumnSql }]).get(0)!;

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
const validate = (db: Database.Database, allowSixColumns: boolean): "six" | "seven" => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (matchesSchema(objects, currentSchema)) return "seven";
  if (allowSixColumns && matchesSchema(objects, sixColumnSchema)) return "six";
  return incompatible();
};

export const workerStoreFormat: SqliteFormat = {
  name: "Worker state",
  baseline: {
    version: 5,
    create: db => { db.exec(baselineSql); },
  },
  unversioned: {
    validate: db => { validate(db, true); },
    adopt: db => {
      if (validate(db, true) === "six") db.exec(adoptionSql);
    },
  },
  migrations: [],
  validateVersioned: (db, version) => {
    if (version !== 5) return incompatible();
    validate(db, false);
  },
};
