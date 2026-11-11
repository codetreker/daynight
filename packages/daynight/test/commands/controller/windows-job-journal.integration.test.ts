import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { assignWindowsJobSource, commitWindowsJobStop, openControllerLifecycleStore, prepareWindowsJobSource, readControllerSnapshot, readWindowsJobReceipt, readWindowsJobSource } from "../../../src/commands/controller/lifecycle-store.js";
import { WindowsJobEvidenceConflictError, type WindowsJobPreparedSource, type WindowsJobAssignedSource } from "../../../src/commands/controller/windows-job-evidence.js";

const fault = vi.hoisted(() => ({ skipSchemaCheck: false }));
vi.mock("../../../src/platform/sqlite-format.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/platform/sqlite-format.js")>();
  return { ...actual, assertCurrentSqlite: (...args: Parameters<typeof actual.assertCurrentSqlite>) => { if (!fault.skipSchemaCheck) return actual.assertCurrentSqlite(...args); } };
});
const roots: string[] = [];
afterEach(async () => { fault.skipSchemaCheck = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/windows-job-journal");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const controller = { pid: 1234, parentPid: 12, processGroupId: null, startedAt: "2026-11-11T00:00:00.1234560Z", commandHash: "a".repeat(64) };
  const guardian = { ...controller, pid: 1235, parentPid: controller.pid, commandHash: "b".repeat(64) };
  const native = { ...controller, pid: 1236, parentPid: controller.pid, commandHash: "c".repeat(64) };
  const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), guardian, jobHandle: "18446744073709551615", controller };
  const assigned: WindowsJobAssignedSource = { ...prepared, phase: "assigned" };
  const file = path.join(home, "state.sqlite"), store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: { ...controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  return { file, ticket, prepared, assigned, controller, native, store };
};

test("independent guardian commits a fenced source and a stopped generation with its immutable receipt", async () => {
  const f = await fixture();
  try {
    prepareWindowsJobSource(f.file, f.ticket, f.prepared);
    expect(readWindowsJobSource(f.file, f.ticket)).toEqual(f.prepared);
    expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
    expect(() => prepareWindowsJobSource(f.file, f.ticket, f.prepared)).toThrow("observe");
    expect(() => assignWindowsJobSource(f.file, f.ticket, { ...f.prepared, jobHandle: "3" }, f.assigned)).toThrow();
    assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned);
    expect(readWindowsJobSource(f.file, f.ticket)).toEqual(f.assigned);
    expect(() => assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned)).toThrow();
    f.store.patchSnapshot({ nativeProcesses: [f.native] });
  } finally { f.store.close(); }
  const observed = readControllerSnapshot(f.file)!;
  const stopped = commitWindowsJobStop(f.file, f.ticket, observed, f.assigned);
  const receipt = readWindowsJobReceipt(f.file, f.ticket)!;
  expect(stopped).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: f.controller, nativeProcesses: [f.native] });
  expect(receipt).toMatchObject({ version: 1, source: f.assigned, observedSnapshot: observed, snapshot: stopped, sealed: true, empty: true, controllerStopped: true, nativeProcessesStopped: true });
  expect(readControllerSnapshot(f.file)).toEqual(stopped);
  expect(() => commitWindowsJobStop(f.file, f.ticket, stopped, f.assigned)).toThrow();
  expect(() => readWindowsJobReceipt(f.file, { ...f.ticket, initialPrompt: "changed" })).toThrow();
});

test("v8 legacy stopped state remains readable without inventing a source or receipt", async () => {
  const f = await fixture();
  const nativeSessionId = randomUUID();
  const legacy = f.store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, nativeSessionId, stoppedAt: new Date().toISOString() }); f.store.close();
  const oldFile = path.join(path.dirname(f.file), "old.sqlite"), db = new Database(oldFile);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 8)) db.exec(step.sql);
  db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,NULL,?)").run(controllerPayloadHash(f.ticket), JSON.stringify(legacy));
  db.pragma("user_version=8"); db.close();
  expect(readControllerSnapshot(oldFile)).toEqual(legacy);
  expect(readWindowsJobSource(oldFile, f.ticket)).toBeNull();
  expect(readWindowsJobReceipt(oldFile, f.ticket)).toBeNull();
  expect(() => commitWindowsJobStop(oldFile, f.ticket, readControllerSnapshot(oldFile)!, f.assigned)).toThrow();
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (process.platform !== "win32") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try { expect(() => openControllerLifecycleStore(oldFile, next, { previousWindowsTicket: f.ticket })).toThrow("Job stop receipt"); }
  finally { Object.defineProperty(process, "platform", platform); }
  expect(readControllerSnapshot(oldFile)).toEqual(legacy);
});

test("the Controller display name must match the launch and cannot replace its native identity", async () => {
  const f = await fixture();
  try {
    f.store.patchSnapshot({ controllerProcess: { ...f.controller, jobObjectName: `Local\\Daynight-${randomUUID()}` } });
    expect(() => prepareWindowsJobSource(f.file, f.ticket, f.prepared)).toThrow("current generation");
    f.store.patchSnapshot({ controllerProcess: { ...f.controller, pid: f.controller.pid + 1, jobObjectName: `Local\\Daynight-${f.ticket.launchId}` } });
    expect(() => prepareWindowsJobSource(f.file, f.ticket, f.prepared)).toThrow("current generation");
    expect(readWindowsJobSource(f.file, f.ticket)).toBeNull();
  } finally { f.store.close(); }
});

test("Job preparation cannot adopt an unrelated guardian or start after native execution", async () => {
  const f = await fixture();
  try {
    expect(() => prepareWindowsJobSource(f.file, f.ticket, { ...f.prepared, guardian: { ...f.prepared.guardian, parentPid: 99 } })).toThrow("independent child");
    f.store.patchSnapshot({ nativeProcesses: [f.native] });
    expect(() => prepareWindowsJobSource(f.file, f.ticket, f.prepared)).toThrow("current generation");
    expect(readWindowsJobSource(f.file, f.ticket)).toBeNull();
  } finally { f.store.close(); }
});

test("a changed snapshot or source and malformed persisted evidence cannot authorize a stop", async () => {
  const f = await fixture();
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned);
  f.store.patchSnapshot({ nativeProcesses: [f.native] });
  const observed = f.store.getSnapshot(); f.store.patchSnapshot({ error: "changed" }); f.store.close();
  expect(() => commitWindowsJobStop(f.file, f.ticket, observed, f.assigned)).toThrow(WindowsJobEvidenceConflictError);
  expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
  const db = new Database(f.file); db.prepare("UPDATE windows_job_evidence SET source=?").run('{"version":1}'); db.close();
  expect(() => readWindowsJobSource(f.file, f.ticket)).toThrow(expect.objectContaining({ cause: expect.any(WindowsJobEvidenceConflictError) }));
  expect(() => readWindowsJobReceipt(f.file, f.ticket)).toThrow(expect.objectContaining({ cause: expect.any(WindowsJobEvidenceConflictError) }));
  expect(() => commitWindowsJobStop(f.file, f.ticket, readControllerSnapshot(f.file)!, f.assigned)).toThrow();
});

test("failure between the receipt and snapshot updates rolls back both", async () => {
  const f = await fixture();
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned); f.store.patchSnapshot({ nativeProcesses: [f.native] }); f.store.close();
  const observed = readControllerSnapshot(f.file)!;
  const db = new Database(f.file);
  db.exec("CREATE TRIGGER reject_stop BEFORE UPDATE OF snapshot ON execution BEGIN SELECT RAISE(ABORT, 'injected stop failure'); END"); db.close();
  // The trigger is the controlled SQLite failure boundary; schema admission is
  // bypassed only for this call so the real transaction reaches that boundary.
  fault.skipSchemaCheck = true;
  expect(() => commitWindowsJobStop(f.file, f.ticket, observed, f.assigned)).toThrow("injected stop failure");
  fault.skipSchemaCheck = false;
  const check = new Database(f.file);
  try {
    expect(check.prepare("SELECT receipt FROM windows_job_evidence").get()).toEqual({ receipt: null });
    expect(JSON.parse((check.prepare("SELECT snapshot FROM execution").get() as { snapshot: string }).snapshot)).toEqual(observed);
    check.exec("DROP TRIGGER reject_stop");
  } finally { check.close(); }
  expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
});

test("an assigned source repairs only the unpublished Controller identity in the stop transaction", async () => {
  const f = await fixture();
  f.store.patchSnapshot({ controllerProcess: null });
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned); f.store.close();
  const observed = readControllerSnapshot(f.file)!;
  const stopped = commitWindowsJobStop(f.file, f.ticket, observed, f.assigned);
  expect(stopped.controllerProcess).toEqual({ ...f.controller, jobObjectName: `Local\\Daynight-${f.ticket.launchId}` });
  expect(readWindowsJobReceipt(f.file, f.ticket)).toMatchObject({ observedSnapshot: { controllerProcess: null }, snapshot: stopped });
});

test.each([
  { nativeProcesses: [{ pid: 987, parentPid: 1, processGroupId: null, startedAt: "2026-11-11T00:00:00.1234560Z", commandHash: "c".repeat(64) }] },
  { initialInputState: "dispatching" as const }, { lifecycle: "ready" as const },
  { nativeStopped: true }, { stoppedAt: "2026-11-11T00:00:00.000Z" },
])("an unpublished Controller proof cannot be repaired after conflicting execution evidence %#", async patch => {
  const f = await fixture();
  f.store.patchSnapshot({ controllerProcess: null });
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned);
  f.store.patchSnapshot(patch); f.store.close();
  const observed = readControllerSnapshot(f.file)!;
  expect(() => commitWindowsJobStop(f.file, f.ticket, observed, f.assigned)).toThrow("incomplete Controller proof");
  expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
  expect(readControllerSnapshot(f.file)).toEqual(observed);
});

test("receipt readback rejects changes to the persisted process list or current snapshot", async () => {
  const f = await fixture();
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned); f.store.patchSnapshot({ nativeProcesses: [f.native] }); f.store.close();
  commitWindowsJobStop(f.file, f.ticket, readControllerSnapshot(f.file)!, f.assigned);
  const db = new Database(f.file);
  const row = db.prepare("SELECT receipt FROM windows_job_evidence").get() as { receipt: string };
  const receipt = JSON.parse(row.receipt); receipt.snapshot.nativeProcesses = [];
  db.prepare("UPDATE windows_job_evidence SET receipt=?").run(JSON.stringify(receipt)); db.close();
  expect(() => readWindowsJobReceipt(f.file, f.ticket)).toThrow();
});

test("Windows provenance requires the original receipt across generation recovery", async () => {
  const f = await fixture(), nativeSessionId = randomUUID();
  f.store.patchSnapshot({ nativeSessionId });
  prepareWindowsJobSource(f.file, f.ticket, f.prepared); assignWindowsJobSource(f.file, f.ticket, f.prepared, f.assigned); f.store.patchSnapshot({ nativeProcesses: [f.native] }); f.store.close();
  const stopped = commitWindowsJobStop(f.file, f.ticket, readControllerSnapshot(f.file)!, f.assigned);
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (process.platform !== "win32") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  let nextStore: ReturnType<typeof openControllerLifecycleStore>;
  try {
    expect(() => openControllerLifecycleStore(f.file, next)).toThrow("original ticket");
    expect(() => openControllerLifecycleStore(f.file, next, { previousWindowsTicket: { ...f.ticket, initialPrompt: "changed" } })).toThrow(expect.objectContaining({ cause: expect.any(WindowsJobEvidenceConflictError) }));
    nextStore = openControllerLifecycleStore(f.file, next, { previousWindowsTicket: f.ticket });
  } finally { Object.defineProperty(process, "platform", platform); }
  try {
    expect(nextStore!.getSnapshot().executionGeneration).toBe("2");
    expect(readWindowsJobReceipt(f.file, f.ticket)?.snapshot).toEqual(stopped);
    expect(readWindowsJobSource(f.file, next)).toBeNull();
  } finally { nextStore!.close(); }
});
