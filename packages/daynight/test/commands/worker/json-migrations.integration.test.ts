import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { webExecutionStoreFormat } from "../../../src/commands/worker/backends/web-store-format.js";
import { openSqliteDatabase } from "../../../src/platform/sqlite-access.js";

const root = path.resolve(import.meta.dirname, "../../../../../.tmp/json-migrations");
const directories: string[] = [];
const connections: Database.Database[] = [];
const worker9 = { ...workerStoreFormat, migrations: workerStoreFormat.migrations.filter(step => step.toVersion <= 9) };
const worker10 = { ...workerStoreFormat, migrations: workerStoreFormat.migrations.filter(step => step.toVersion <= 10) };
const web1 = { ...webExecutionStoreFormat, migrations: [] };
const web2 = { ...webExecutionStoreFormat, migrations: webExecutionStoreFormat.migrations.filter(step => step.toVersion <= 2) };

function fixture(format: typeof workerStoreFormat) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "case-")); directories.push(dir);
  const file = path.join(dir, "state.sqlite");
  const db = openSqliteDatabase({ file, format, allowCreate: true, onMigration: () => {} }); connections.push(db);
  return { file, db };
}
function upgrade(file: string, format: typeof workerStoreFormat) {
  const db = openSqliteDatabase({ file, format, allowCreate: false, onMigration: () => {} }); connections.push(db);
  return db;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("maps only accessible Worker JSON, preserving bad and unchanged rows across owners", () => {
  const { file, db } = fixture(worker9);
  const insertBot = db.prepare("INSERT INTO bots VALUES (?,?,?,?,?)");
  const insertExecution = db.prepare("INSERT INTO bot_executions VALUES (?,?,?,?,?)");
  const bots = [
    ["a", "same", '{ "intent": { "registration": { "controllerInstanceId": "one" }, "other": 1 }, "unrelated": [1] }'],
    ["b", "bad", '{invalid'],
    ["c", "same", '{"intent":{"registration":{"controllerInstanceId":"two"}}}'],
    ["k", "escaped", '{"intent":{"registration":{"controllerInstanceId":"a\\u0000b"}}}'],
    ["j", "nul", '{"intent":{"registration":{"controllerInstanceId":"id"}}}\u0000trailing'],
    ["d", "missing", '{ "intent": { "registration": {} } }'],
    ["e", "registration", '{ "intent": { "registration": [] } }'],
    ["f", "intent", '{ "intent": 3 }'],
    ["g", "root", '[1,2]'],
    ["h", "null", '{"intent":{"registration":{"controllerInstanceId":null}}}'],
    ["i", "unchanged", '{ "intent": { "registration": { "controllerInstanceId": "same" }, "controllerInstanceId": "same" } }'],
  ];
  const executions = [
    ["a", "same", '{"other":{"brokenRelationship":"missing"}}'],
    ["b", "bad", '{invalid'],
    ["c", "same", '{"recoveryCount":5,"previous":{"keep":false},"other":true}'],
    ["f", "nul", '{}\u0000trailing'],
    ["d", "array", '[1,2]'],
    ["e", "unchanged", '{ "recoveryCount":0, "restartAfterShutdown":false, "recoveryBlocked":null, "previous":null, "retainedLaunchIds":[], "retainedAliasDirectories":[] }'],
  ];
  db.pragma("ignore_check_constraints=ON");
  for (const [owner, bot, value] of bots) insertBot.run("server", owner, "worker", bot, value);
  for (const [owner, bot, value] of executions) insertExecution.run("server", owner, "worker", bot, value);
  db.pragma("ignore_check_constraints=OFF");
  const migrated = upgrade(file, worker10);
  const rows = (table: string) => Object.fromEntries((migrated.prepare(`SELECT owner_user_id, record FROM ${table}`).all() as { owner_user_id: string; record: string }[]).map(row => [row.owner_user_id, row.record]));
  const result = rows("bots"), executionResult = rows("bot_executions");
  expect(JSON.parse(result.a!)).toEqual({ intent: { registration: { controllerInstanceId: "one" }, other: 1, controllerInstanceId: "one" }, unrelated: [1] });
  expect(JSON.parse(result.c!).intent.controllerInstanceId).toBe("two");
  expect(JSON.parse(result.h!).intent.controllerInstanceId).toBeNull();
  expect(JSON.parse(result.k!).intent.controllerInstanceId).toBe("a\u0000b");
  for (const [owner, , value] of bots.filter(([owner]) => !["a", "c", "h", "k"].includes(owner!))) expect(result[owner!]).toBe(value);
  const recovery = { recoveryCount: 0, restartAfterShutdown: false, recoveryBlocked: null, previous: null, retainedLaunchIds: [], retainedAliasDirectories: [] };
  expect(JSON.parse(executionResult.a!)).toEqual({ other: { brokenRelationship: "missing" }, ...recovery });
  expect(JSON.parse(executionResult.c!)).toEqual({ ...recovery, other: true });
  for (const [owner, , value] of executions.filter(([owner]) => !["a", "c"].includes(owner!))) expect(executionResult[owner!]).toBe(value);
  expect(migrated.pragma("user_version", { simple: true })).toBe(10);
});

it("maps Web cleanup paths while retaining bad, inapplicable and unchanged data", () => {
  const { file, db } = fixture(web1);
  const rows = [
    ["a", '{"cleanup":{"kind":"terminal","input":1,"baseline":2,"result":3,"error":4,"agentStopped":true,"workspaceClosed":true,"backendResourcesClosed":true,"worktreeDeleted":true,"mode":"web","keep":9},"relationship":"missing"}'],
    ["b", '{invalid'],
    ["c", '{"cleanup":{"mode":"web","keep":2},"other":true}'],
    ["h", '{"cleanup":{"mode":"web"}}\u0000trailing'],
    ["d", '{ "cleanup": [] }'],
    ["e", '{ "cleanup": { "keep": 1 } }'],
    ["f", '[1,2]'],
    ["g", '{ "other": true }'],
  ];
  db.pragma("ignore_check_constraints=ON");
  const insert = db.prepare("INSERT INTO executions VALUES (?,?)");
  for (const row of rows) insert.run(...row);
  db.pragma("ignore_check_constraints=OFF");
  const migrated = upgrade(file, web2);
  const result = Object.fromEntries((migrated.prepare("SELECT identity, data FROM executions").all() as { identity: string; data: string }[]).map(row => [row.identity, row.data]));
  expect(JSON.parse(result.a!)).toEqual({ cleanup: { kind: "terminal", keep: 9 }, relationship: "missing" });
  expect(JSON.parse(result.c!)).toEqual({ cleanup: { keep: 2 }, other: true });
  for (const [identity, value] of rows.filter(([identity]) => !["a", "c"].includes(identity!))) expect(result[identity!]).toBe(value);
  expect(migrated.pragma("user_version", { simple: true })).toBe(2);
});

it("does not alter existing Web blocker rows or relationships", () => {
  const { db } = fixture(webExecutionStoreFormat);
  db.prepare("INSERT INTO executions VALUES (?,?)").run("execution", '{"cleanup":{"mode":"web"}}');
  db.prepare("INSERT INTO orchestration_blockers VALUES (?,?)").run("unrelated", '{broken');
  const sql = readFileSync(new URL("../../../src/commands/worker/backends/sqlite/002-resource-observations.sql", import.meta.url), "utf8");
  db.exec(sql);
  expect(db.prepare("SELECT * FROM orchestration_blockers").all()).toEqual([{ identity: "unrelated", data: "{broken" }]);
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data: '{"cleanup":{}}' });
});

it.each(["worker", "web"] as const)("rolls back %s mapping and version after a real SQLite constraint failure", kind => {
  const { file, db } = fixture(kind === "worker" ? worker9 : web1);
  if (kind === "worker") {
    db.prepare("INSERT INTO bots VALUES (?,?,?,?,?)").run("server", "owner", "worker", "bot", '{"intent":{"registration":{"controllerInstanceId":"id"}}}');
    db.prepare("INSERT INTO bot_executions VALUES (?,?,?,?,?)").run("server", "owner", "worker", "bot", '{}');
  } else db.prepare("INSERT INTO executions VALUES (?,?)").run("id", '{"cleanup":{"mode":"web"}}');
  const tables = kind === "worker" ? ["bots", "bot_executions"] : ["executions"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const original = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    const result = original.call(this, sql);
    if (kind === "worker" && sql.includes("UPDATE bot_executions SET")) original.call(this, "INSERT INTO bots SELECT * FROM bots");
    if (kind === "web" && sql.includes("UPDATE executions SET")) original.call(this, "INSERT INTO executions SELECT * FROM executions");
    return result;
  });
  expect(() => upgrade(file, kind === "worker" ? worker10 : web2)).toThrow(/migration/);
  expect(db.pragma("user_version", { simple: true })).toBe(kind === "worker" ? 9 : 1);
  expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
});
