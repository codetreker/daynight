import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export type SqliteSchemaObject = { readonly name: string; readonly type: string; readonly sql: string | null };
export type SqliteSchemaStep = { readonly version: number; readonly sql: string };

export const loadSqliteSql = (resource: URL): string => {
  const sql = readFileSync(resource, "utf8");
  if (sql.trim().length === 0) throw new Error(`SQLite SQL resource is empty: ${resource.href}`);
  return sql;
};

export const loadSqliteSequence = (directory: URL): readonly [SqliteSchemaStep, ...SqliteSchemaStep[]] => {
  const files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.toLowerCase().endsWith(".sql")).sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  if (files.length === 0) throw new Error(`SQLite SQL sequence is empty: ${directory.href}`);
  let width: number | undefined, previous: number | undefined;
  const resources = files.map(entry => {
    const resource = pathToFileURL(path.join(fileURLToPath(directory), entry.name));
    const match = /^([0-9]{3,})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.sql$/.exec(entry.name);
    if (!entry.isFile() || match === null) throw new Error(`Invalid SQLite SQL filename: ${resource.href}`);
    const prefix = match[1]!, version = Number(prefix);
    if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) throw new Error(`SQLite SQL version must be a positive signed 32-bit integer: ${resource.href}`);
    if (width !== undefined && prefix.length !== width) throw new Error(`SQLite SQL version prefixes must use the same zero-padding width: ${resource.href}`);
    if (version === previous) throw new Error(`Duplicate SQLite SQL version: ${resource.href}`);
    if (previous !== undefined && version !== previous + 1) throw new Error(`SQLite SQL versions must be consecutive after the baseline: ${resource.href}`);
    width = prefix.length; previous = version;
    return { version, resource };
  });
  const steps = resources.map(({ version, resource }) => Object.freeze({ version, sql: loadSqliteSql(resource) }));
  return Object.freeze(steps) as readonly [SqliteSchemaStep, ...SqliteSchemaStep[]];
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
