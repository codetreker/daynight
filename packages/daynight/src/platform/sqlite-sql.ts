import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

export type SqliteSchemaObject = { readonly name: string; readonly type: string; readonly sql: string | null };
type SqliteSchemaStep = { readonly version: number; readonly sql: string };

export const loadSqliteSql = (resource: URL): string => {
  const sql = readFileSync(resource, "utf8");
  if (sql.trim().length === 0) throw new Error(`SQLite SQL resource is empty: ${resource.href}`);
  return sql;
};

export const sqliteSchemaSnapshots = (steps: readonly SqliteSchemaStep[]): ReadonlyMap<number, readonly SqliteSchemaObject[]> => {
  const db = new Database(":memory:"), snapshots = new Map<number, readonly SqliteSchemaObject[]>();
  let failed = false, failure: unknown;
  try {
    for (const step of steps) {
      db.exec(step.sql);
      const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
      snapshots.set(step.version, Object.freeze(objects.map(object => Object.freeze(object))));
    }
  } catch (cause) { failed = true; failure = cause; }
  try { db.close(); }
  catch (close) { throw failed ? new AggregateError([failure, close], "SQLite reference schema construction and connection shutdown failed.") : close; }
  if (failed) throw failure;
  return snapshots;
};
