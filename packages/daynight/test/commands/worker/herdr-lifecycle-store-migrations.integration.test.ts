import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openHerdrLifecycleStore, readHerdrLifecycleRecords } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import { createHerdrLifecycleStoreFixtures } from "./herdr-lifecycle-store.fixtures.js";

const { uuid, identity, open, close, fixture, active, stopped } = createHerdrLifecycleStoreFixtures("file");
const limit = 8 * 1024 * 1024;

it("maps only native launch fields across independent executions and retirements", () => {
  const f = fixture(); close(f.store);
  const observed = { processes: [{ role: "agent", invalidBirthEvidence: true }], phase: "launch_requested", run: { segmentIds: [] }, recipe: "unparsed", observation: null, startupReport: false };
  const requested = { processes: [], phase: "launch_requested", run: { segmentIds: [] } };
  const prepared = { processes: [{ role: "shell" }], phase: "prepared", daemon: {}, stopOperationId: null, admission: null, run: { segmentIds: [] } };
  const unknown = { ...prepared, phase: "stop_unknown" };
  const inaccessible = [null, 1, [], {}, { ...prepared, processes: null }, { ...prepared, processes: [null] }, { ...prepared, run: null }, { ...prepared, run: { segmentIds: null } }];
  const legacy = { owner: "invalid", version: -1, receipt: { broken: true }, runs: [observed, ...inaccessible, requested, prepared, unknown] };
  const retirement = { runs: [{ ...prepared, admission: "unexpected" }], unrelated: ["not", "a", "retirement"] };
  const untouched = ['{bad JSON', 'null', '[]', '{ "unrelated": true }', '{ "runs": {} }', ' { "runs": [] } ', ' { "runs": [null, {}] } '];
  const db = new Database(f.file);
  db.pragma("foreign_keys = OFF"); db.pragma("ignore_check_constraints = ON");
  db.prepare("DELETE FROM executions").run();
  for (const table of ["executions", "never_started_retirements"]) {
    const insert = db.prepare(`INSERT INTO ${table}(identity, version, data) VALUES (?, ?, ?)`);
    insert.run("a-before", 99, JSON.stringify(legacy));
    untouched.forEach((data, index) => insert.run(`b-untouched-${index}`, 7, data));
    insert.run("c-after", 42, JSON.stringify(table === "executions" ? legacy : retirement));
  }
  db.pragma("user_version = 2"); db.close();
  const upgraded = open(f.file); close(upgraded);
  const inspect = new Database(f.file);
  expect(inspect.pragma("user_version", { simple: true })).toBe(4);
  const expected = { ...legacy, runs: [{ ...observed, nativeLaunch: "observed" }, ...inaccessible, { ...requested, nativeLaunch: "requested" }, { ...prepared, nativeLaunch: "not_submitted" }, { ...unknown, nativeLaunch: "unknown" }] };
  for (const table of ["executions", "never_started_retirements"]) {
    const rows = inspect.prepare(`SELECT identity, version, data FROM ${table} ORDER BY identity`).all() as { identity: string; version: number; data: string }[];
    expect(rows[0]).toEqual({ identity: "a-before", version: 99, data: JSON.stringify(expected) });
    expect(rows.slice(1, -1).map(row => row.data)).toEqual(untouched);
    expect(rows.slice(1, -1).map(row => row.version)).toEqual(untouched.map(() => 7));
    expect(rows.at(-1)).toEqual({ identity: "c-after", version: 42, data: JSON.stringify(table === "executions" ? expected : { ...retirement, runs: [{ ...retirement.runs[0], nativeLaunch: "unknown" }] }) });
  }
  inspect.close();
  const reopened = open(f.file); close(reopened);
  expect(() => readHerdrLifecycleRecords(f.file)).toThrow();
});

it("leaves already mapped strings unchanged without issuing an UPDATE", () => {
  const f = fixture(); close(f.store);
  const data = ' { "runs": [{ "processes": [], "run": { "segmentIds": [] }, "nativeLaunch": "unknown" }] } ';
  const db = new Database(f.file);
  db.prepare("UPDATE executions SET data = ?").run(data); db.pragma("user_version = 2");
  db.exec("CREATE TEMP TRIGGER reject_update BEFORE UPDATE ON executions BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END");
  const upgraded = openHerdrLifecycleStore(db, { onMigration: () => {} });
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  upgraded.close();
});

it.each([limit - 8, limit + 8])("converts and reopens a valid %i-byte legacy row while keeping new writes bounded", desired => {
  const f = fixture(); const original = stopped(f, active(f)); close(f.store);
  const legacy = JSON.parse(JSON.stringify(original));
  const template = legacy.runs[0]; delete template.nativeLaunch;
  legacy.runs = Array.from({ length: 600 }, (_, index) => {
    const run = structuredClone(template); run.run.executionGeneration = String(index + 1);
    run.stopOperationId = uuid(1000 + index); run.run.stopProof.recordId = run.stopOperationId;
    run.run.stopProof.executionGeneration = run.run.executionGeneration;
    run.error = "x"; return run;
  });
  legacy.initialPrompt = "x";
  const perRun = Math.floor((desired - Buffer.byteLength(JSON.stringify(legacy))) / legacy.runs.length);
  for (const run of legacy.runs) run.error += "x".repeat(perRun);
  legacy.initialPrompt += "x".repeat(desired - Buffer.byteLength(JSON.stringify(legacy)));
  const data = JSON.stringify(legacy); expect(Buffer.byteLength(data)).toBe(desired);
  const old = new Database(f.file);
  old.prepare("UPDATE executions SET data = ?").run(data); old.pragma("user_version = 2"); old.close();
  const expected = { ...legacy, runs: legacy.runs.map((run: object) => ({ ...run, nativeLaunch: "observed" })) };
  const upgraded = open(f.file);
  expect(upgraded.get(identity)).toEqual(expected);
  expect(() => upgraded.update(expected, draft => { draft.controlEpoch = "1"; })).toThrow("Herdr lifecycle metadata exceeds its size limit.");
  close(upgraded);
  const inspect = new Database(f.file);
  expect(inspect.pragma("user_version", { simple: true })).toBe(4);
  const row = inspect.prepare("SELECT data, version FROM executions").get() as { data: string; version: number };
  expect(Buffer.byteLength(row.data)).toBeGreaterThan(limit);
  expect(JSON.parse(row.data)).toEqual(expected); expect(row.version).toBe(original.version);
  inspect.close();
  const reopened = open(f.file);
  expect(reopened.list()).toEqual([expected]); close(reopened);
  expect(readHerdrLifecycleRecords(f.file)).toEqual([expected]);
}, 30_000);

it("propagates actual SQLite write errors and rolls back earlier row mappings and the version", () => {
  const f = fixture(); close(f.store);
  const data = JSON.stringify({ runs: [{ processes: [], phase: "launch_requested", run: { segmentIds: [] } }] });
  const db = new Database(f.file);
  db.prepare("UPDATE executions SET data = ?").run(data);
  db.prepare("INSERT INTO executions(identity, version, data) VALUES (?, ?, ?)").run("later", 1, data);
  db.pragma("user_version = 2");
  db.exec("CREATE TEMP TRIGGER reject_later_update BEFORE UPDATE ON executions WHEN OLD.identity = 'later' BEGIN SELECT RAISE(ABORT, 'native launch write failed'); END");
  let failure: unknown;
  try { openHerdrLifecycleStore(db, { onMigration: () => {} }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ kind: "migration-failed", outcome: "rolled-back", cause: { cause: { code: "SQLITE_CONSTRAINT_TRIGGER", message: "native launch write failed" } } });
  expect(db.open).toBe(false);
  const inspect = new Database(f.file);
  expect(inspect.pragma("user_version", { simple: true })).toBe(2);
  expect(inspect.prepare("SELECT data FROM executions ORDER BY identity").all()).toEqual([{ data }, { data }]);
  inspect.close();
});
