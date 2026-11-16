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
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const mapNativeLaunch = (value: unknown): unknown => {
  if (!object(value) || !Array.isArray(value.processes) || !value.processes.every(object) || !object(value.run) || !Array.isArray(value.run.segmentIds)) return value;
  const nativeLaunch = value.processes.some(process => process.role === "agent") ? "observed" : value.phase === "launch_requested" ? "requested"
    : value.phase === "prepared" && Object.hasOwn(value, "daemon") && value.daemon !== null && value.processes.length === 1 && value.processes[0]!.role === "shell" && value.stopOperationId === null && value.admission === null && value.run.segmentIds.length === 0 ? "not_submitted" : "unknown";
  return value.nativeLaunch === nativeLaunch ? value : { ...value, nativeLaunch };
};
const mapLifecycleData = (data: string): string => {
  let value: unknown;
  try { value = JSON.parse(data); }
  catch (error) { if (error instanceof SyntaxError) return data; throw error; }
  if (!object(value) || !Array.isArray(value.runs)) return data;
  const original = value.runs, runs = original.map(mapNativeLaunch);
  return runs.some((run, index) => run !== original[index]) ? JSON.stringify({ ...value, runs }) : data;
};
const migrateNativeLaunch = (db: Database.Database): void => {
  for (const table of ["executions", "never_started_retirements"] as const) {
    const rows = db.prepare(`SELECT identity, data FROM ${table} ORDER BY identity`).all() as { identity: string; data: string }[];
    const update = db.prepare(`UPDATE ${table} SET data = ? WHERE identity = ?`);
    for (const row of rows) {
      const data = mapLifecycleData(row.data);
      if (data !== row.data) update.run(data, row.identity);
    }
  }
};
export const herdrLifecycleStoreFormat: SqliteFormat = {
  name: "Herdr lifecycle state",
  baseline: { version: baseline.version, create: db => { db.exec(baseline.sql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => {
    if (step.version === 3) migrateNativeLaunch(db);
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
};
