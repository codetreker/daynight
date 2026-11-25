import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readCurrentControllerSnapshot, recordStoppedControllerGeneration, readBotInitializationRetryEvidence, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { LEGACY_CODEX_INITIALIZATION_GATE } from "../../../src/commands/controller/bot-initialization-evidence.js";
import { parseNativeInitialization } from "../../../src/commands/controller/native-initialization.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async (legacy = false) => {
  const base = path.resolve(process.cwd(), ".tmp", "bot-initialization-tests"); await mkdir(base, { recursive: true });
  const home = await realpath(await mkdtemp(path.join(base, "case-"))); roots.push(home);
  const executionId = randomUUID(), botId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, testExecutionId: executionId, botId,
    controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1",
    ownerUserId: randomUUID(), serverOrigin: "https://daynight.example", provider: "codex", cwd: home, nativeHome: path.join(home, "native-home"),
    codexBotRecovery: { botId, directory: path.join(home, "recovery") },
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
    initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
    credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: { pid: 987654, parentPid: 1, processGroupId: null, startedAt: "original-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` },
    nativeProcesses: [{ pid: 987655, parentPid: 987654, processGroupId: null, startedAt: "original-native", commandHash: "b".repeat(64) }],
    lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString(),
    startup: { state: "unknown", reasonCode: "native_transport_unknown" }, error: LEGACY_CODEX_INITIALIZATION_GATE });
  let snapshot = store.getSnapshot(); store.close();
  if (legacy) { delete snapshot.nativeInitialization; const db = new Database(file); try { db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot)); } finally { db.close(); } }
  const rewrite = (action: (db: Database.Database, snapshot: ControllerSnapshot) => void): ControllerSnapshot => {
    const db = new Database(file);
    try { action(db, snapshot); db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot)); }
    finally { db.close(); }
    return snapshot;
  };
  const commitStop = async () => {
    const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    try { snapshot = await recordStoppedControllerGeneration(file, ticket, { ...(process.platform === "win32" ? { jobLease: {} as ControllerJobLease } : {}) }); }
    finally { confirm.mockRestore(); }
    return snapshot;
  };
  return { home, file, ticket, snapshot, rewrite, commitStop };
};

test("new Codex Bot non-dispatch evidence survives closing and cannot be reset", async () => {
  const f = await fixture();
  expect(readCurrentControllerSnapshot(f.file, f.ticket).nativeInitialization).toEqual({ version: 1, state: "not_dispatched" });
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toMatchObject({ kind: "native_initialization_not_dispatched" });
  f.rewrite((_db, snapshot) => { snapshot.nativeInitialization = { version: 1, state: "dispatching" }; });
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toBeNull();
});

test.each([null, {}, { version: 2, state: "not_dispatched" }, { version: 1, state: "ready" }, { version: 1, state: "not_dispatched", extra: true }])("rejects malformed initialization evidence %j", value => {
  expect(() => parseNativeInitialization(value)).toThrow("dispatch evidence is invalid");
});

test("recognizes the exact legacy local version gate without rewriting unknown history", async () => {
  const f = await fixture(true), before = JSON.stringify(f.snapshot);
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toEqual({ version: 1, kind: "legacy_codex_version_gate", ticketHash: controllerPayloadHash(f.ticket), snapshotHash: controllerPayloadHash(f.snapshot) });
  expect(JSON.stringify(readCurrentControllerSnapshot(f.file, f.ticket))).toBe(before);
  await f.commitStop();
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, readCurrentControllerSnapshot(f.file, f.ticket))).toMatchObject({ kind: "legacy_codex_version_gate" });
});

test("reads the shipped v20 journal with the incident's structure without upgrading it", async () => {
  const f = await fixture(true), stopped = await f.commitStop(), file = path.join(f.home, "legacy-v20.sqlite");
  const db = new Database(file);
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 20)) db.exec(step.sql);
    db.pragma("user_version = 20");
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,history_content_policy,online_mode,last_sequence,last_acknowledged) VALUES(1,?,NULL,?,'legacy','relay',3,3)").run(controllerPayloadHash(f.ticket), JSON.stringify(stopped));
    db.prepare("INSERT INTO stopped_generations(ticket_hash,snapshot) VALUES(?,?)").run(controllerPayloadHash(f.ticket), JSON.stringify(stopped));
  } finally { db.close(); }
  expect(readBotInitializationRetryEvidence(file, f.ticket, stopped)).toMatchObject({ kind: "legacy_codex_version_gate" });
  const observed = new Database(file, { readonly: true });
  try {
    expect(observed.pragma("user_version", { simple: true })).toBe(20);
    expect(observed.prepare("SELECT name FROM sqlite_master WHERE name='bot_history_state'").get()).toBeUndefined();
    const row = observed.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
    expect(JSON.parse(row.snapshot)).toEqual(stopped);
  } finally { observed.close(); }
});

test.each(["rpc-rejection", "other-message", "dispatching", "native-id", "projection-gap", "history-incomplete", "unacknowledged", "accounting", "operation", "prior-generation"])("legacy %s cannot authorize another initialization", async mode => {
  const f = await fixture(true);
  f.rewrite((db, snapshot) => {
    if (mode === "rpc-rejection") snapshot.startup = { state: "failed", reasonCode: "native_rejected" };
    if (mode === "other-message") snapshot.error = "Native transport ended; unconfirmed operations remain unknown.";
    if (mode === "dispatching") snapshot.nativeInitialization = { version: 1, state: "dispatching" };
    if (mode === "native-id") snapshot.nativeSessionId = randomUUID();
    if (mode === "projection-gap") db.exec("UPDATE execution SET projection_gap='native error',archive_incomplete=1");
    if (mode === "history-incomplete") db.exec("UPDATE execution SET archive_incomplete=1");
    if (mode === "unacknowledged") db.exec("UPDATE execution SET last_sequence=1");
    if (mode === "accounting") db.exec("UPDATE outbox_totals SET byte_length=1");
    if (mode === "operation") db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(randomUUID(), JSON.stringify({ state: "unknown" }));
    if (mode === "prior-generation") db.prepare("INSERT INTO stopped_generations(ticket_hash,snapshot) VALUES(?,?)").run("a".repeat(64), JSON.stringify(snapshot));
  });
  if (mode === "accounting") { expect(() => readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toThrow("invalid-format"); return; }
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toBeNull();
});

test("a legacy recovery artifact and a changed ticket or stopped snapshot block initialization", async () => {
  const f = await fixture(true);
  await mkdir(f.ticket.codexBotRecovery!.directory);
  await writeFile(path.join(f.ticket.codexBotRecovery!.directory, "manifest.json"), "{}");
  expect(readBotInitializationRetryEvidence(f.file, f.ticket, f.snapshot)).toBeNull();
  expect(() => readBotInitializationRetryEvidence(f.file, { ...f.ticket, ownerUserId: randomUUID() }, f.snapshot)).toThrow("original ticket");
  expect(() => readBotInitializationRetryEvidence(f.file, f.ticket, { ...f.snapshot, error: "changed" })).toThrow("original stopped generation");
});

test.each([false, true])("a new generation revalidates its exact stopped predecessor (legacy=%s)", async legacy => {
  const f = await fixture(legacy), stopped = await f.commitStop();
  const evidence = readBotInitializationRetryEvidence(f.file, f.ticket, stopped)!;
  const next: ControllerLaunchTicket = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2",
    initializationRetry: { previousLaunchId: f.ticket.launchId, ticketHash: evidence.ticketHash, snapshotHash: evidence.snapshotHash } };
  expect(() => openControllerLifecycleStore(path.join(f.home, "missing-original.sqlite"), next, { initializationPredecessor: f.ticket })).toThrow("original stopped journal");
  expect(() => openControllerLifecycleStore(f.file, next)).toThrow("original ticket");
  expect(() => openControllerLifecycleStore(f.file, { ...next, initializationRetry: { ...next.initializationRetry!, snapshotHash: "a".repeat(64) } }, { initializationPredecessor: f.ticket })).toThrow("original ticket");
  const reopened = openControllerLifecycleStore(f.file, next, { initializationPredecessor: f.ticket });
  try { expect(reopened.getSnapshot()).toMatchObject({ executionGeneration: "2", nativeSessionId: null, nativeInitialization: { version: 1, state: "not_dispatched" } });
    reopened.markNativeInitializationDispatching();
    expect(() => reopened.patchSnapshot({ nativeInitialization: { version: 1, state: "not_dispatched" } })).toThrow("cannot be introduced or reset");
    expect(() => reopened.patchSnapshot({ nativeInitialization: undefined } as unknown as Parameters<typeof reopened.patchSnapshot>[0])).toThrow("dispatch evidence is invalid");
  } finally { reopened.close(); }
  const db = new Database(f.file, { readonly: true });
  try { const old = db.prepare("SELECT snapshot FROM stopped_generations WHERE ticket_hash=?").get(evidence.ticketHash) as { snapshot: string }; expect(JSON.parse(old.snapshot)).toEqual(stopped); }
  finally { db.close(); }
  expect(readCurrentControllerSnapshot(f.file, next).nativeInitialization).toEqual({ version: 1, state: "dispatching" });
});

test("retry ticket evidence is restricted to a new Codex Bot generation", async () => {
  const f = await fixture();
  const retry = { previousLaunchId: randomUUID(), ticketHash: "a".repeat(64), snapshotHash: "b".repeat(64) };
  expect(() => parseLaunchTicket({ ...f.ticket, initializationRetry: retry })).toThrow("retry ticket evidence");
  expect(() => parseLaunchTicket({ ...f.ticket, executionGeneration: "2", initializationRetry: { ...retry, ticketHash: "bad" } })).toThrow("retry ticket evidence");
});
