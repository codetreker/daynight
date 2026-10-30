import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { parseWebTaskV1, webClaimKey } from "./web-record.js";
import type { LocalTask } from "./web-types.js";

const schema = "CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT";
const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify a known format.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
const validateSchema = (db: Database.Database): undefined => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as { type: string; name: string; sql: string | null }[];
  if (objects.length !== 1 || objects[0]!.type !== "table" || objects[0]!.name !== "executions" || objects[0]!.sql === null || definition(objects[0]!.sql) !== definition(schema)) throw new Error("The Web execution SQLite schema is incompatible with its known state format.");
};

export const webExecutionStoreFormat: SqliteFormat = {
  name: "Web execution state",
  baseline: { version: 1, create: db => { db.exec(schema); } },
  unversioned: {
    validate: db => {
      validateSchema(db);
      for (const row of db.prepare("SELECT identity, data FROM executions").iterate() as Iterable<{ identity: string; data: string }>) {
        const task = parseWebTaskV1(JSON.parse(row.data) as LocalTask);
        if (row.identity !== webClaimKey(task)) throw new Error("The Web execution row does not match its stored claim identity.");
      }
    },
    adopt: () => {},
  },
  migrations: [],
  validateVersioned: (db, version) => {
    if (version !== 1) throw new Error("Unsupported Web execution SQLite version.");
    validateSchema(db);
  },
};
