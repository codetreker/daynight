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
const mapNativeLaunch = (value: unknown): string | undefined => {
  if (!object(value) || !Array.isArray(value.processes) || !value.processes.every(object) || !object(value.run) || !Array.isArray(value.run.segmentIds)) return;
  const nativeLaunch = value.processes.some(process => process.role === "agent") ? "observed" : value.phase === "launch_requested" ? "requested"
    : value.phase === "prepared" && Object.hasOwn(value, "daemon") && value.daemon !== null && value.processes.length === 1 && value.processes[0]!.role === "shell" && value.stopOperationId === null && value.admission === null && value.run.segmentIds.length === 0 ? "not_submitted" : "unknown";
  return value.nativeLaunch === nativeLaunch ? undefined : nativeLaunch;
};
type JsonSpan = { start: number; end: number };
const skipSpace = (source: string, start: number): number => {
  let at = start;
  while (at < source.length && " \t\r\n".includes(source[at]!)) at++;
  return at;
};
// These scans follow JSON.parse syntax validation; source tokens are never re-encoded.
const stringEnd = (source: string, start: number): number => {
  let at = start + 1;
  while (source[at] !== '"') { if (source[at] === "\\") at++; at++; }
  return at + 1;
};
const valueEnd = (source: string, start: number): number => {
  if (source[start] === '"') return stringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") {
    let at = start + 1, depth = 1;
    while (depth !== 0) {
      const token = source[at];
      if (token === '"') { at = stringEnd(source, at); continue; }
      if (token === "{" || token === "[") depth++;
      else if (token === "}" || token === "]") depth--;
      at++;
    }
    return at;
  }
  let at = start;
  while (at < source.length && !",]} \t\r\n".includes(source[at]!)) at++;
  return at;
};
const propertySpan = (source: string, container: JsonSpan, name: string): JsonSpan | undefined => {
  let at = skipSpace(source, container.start + 1), result: JsonSpan | undefined;
  while (at < container.end - 1) {
    const keyEnd = stringEnd(source, at), key: unknown = JSON.parse(source.slice(at, keyEnd));
    const start = skipSpace(source, skipSpace(source, keyEnd) + 1), end = valueEnd(source, start);
    // The last decoded key is the effective property, matching JSON.parse without collapsing duplicates.
    if (key === name) result = { start, end };
    at = skipSpace(source, end);
    if (source[at] === ",") at = skipSpace(source, at + 1);
  }
  return result;
};
const mapLifecycleData = (data: string): string => {
  let value: unknown;
  try { value = JSON.parse(data); }
  catch (error) { if (error instanceof SyntaxError) return data; throw error; }
  if (!object(value) || !Array.isArray(value.runs)) return data;
  const rootStart = skipSpace(data, 0), runs = propertySpan(data, { start: rootStart, end: valueEnd(data, rootStart) }, "runs")!;
  const edits: (JsonSpan & { text: string })[] = [];
  let at = skipSpace(data, runs.start + 1);
  for (const run of value.runs) {
    const end = valueEnd(data, at), nativeLaunch = mapNativeLaunch(run);
    if (nativeLaunch !== undefined) {
      const existing = propertySpan(data, { start: at, end }, "nativeLaunch");
      edits.push(existing === undefined
        ? { start: end - 1, end: end - 1, text: `,"nativeLaunch":${JSON.stringify(nativeLaunch)}` }
        : { ...existing, text: JSON.stringify(nativeLaunch) });
    }
    at = skipSpace(data, end);
    if (data[at] === ",") at = skipSpace(data, at + 1);
  }
  if (edits.length === 0) return data;
  const parts: string[] = [];
  let copied = 0;
  for (const edit of edits) { parts.push(data.slice(copied, edit.start), edit.text); copied = edit.end; }
  parts.push(data.slice(copied));
  return parts.join("");
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
