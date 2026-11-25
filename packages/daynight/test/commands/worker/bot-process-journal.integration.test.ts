import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";
import { reconcileSubmittedControllerLaunch, hasUnsafeControllerObservationFailure, isControllerJournalIoFailure } from "../../../src/commands/controller/launch-observation.js";
import { prepareControllerStorage } from "../../../src/commands/controller/storage-preparation.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as localClient from "../../../src/commands/controller/local-client.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";
import { ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";

afterEach(() => { vi.restoreAllMocks(); cleanupBotProcesses(); });

const stoppedJournalFixture = async (version: 16 | 17 = 16) => {
  const f = fixture(), signal = new AbortController().signal;
  const launch = f.launch.getMockImplementation()!;
  f.launch.mockImplementationOnce(options => launch({ ...options, onSpawned: (proof: processProof.ProcessProof) => options.onSpawned({ ...proof, processGroupId: null }) }));
  await f.process.advance(f.current(), signal);
  const ticket = f.getTicket(), original = f.current().intent!;
  const journal = openControllerLifecycleStore(original.journalPath, ticket, { onMigration: () => {} });
  journal.markNativeInitializationDispatching();
  const controller = { ...f.executions.get(f.current())!.controllerProcess!, processGroupId: null, jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  let snapshot = journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeSessionId: id(9), nativeStopped: true,
    stoppedAt: "2026-11-19T00:00:00Z", controllerProcess: controller });
  journal.close();
  delete snapshot.nativeInitialization;
  snapshot = { ...snapshot, windowsJobStopProof: { version: 1, ticketHash: controllerPayloadHash(ticket), snapshotHash: controllerPayloadHash(snapshot) } };
  f.executions.update(f.current(), { controllerProcess: controller, snapshot });
  const db = new Database(sqliteFilename(original.journalPath));
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot));
  restoreControllerJournalVersion(db, version);
  db.close();
  vi.spyOn(localClient, "requestController").mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original Controller exited."));
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: vi.fn(async () => {}), adopt: () => { throw new Error("Unexpected native launch ownership."); },
    retain: vi.fn(async () => undefined), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const reconcile = vi.fn<typeof reconcileSubmittedControllerLaunch>(async input => {
    const bytes = readFileSync(input.journalFile);
    const observation = await reconcileSubmittedControllerLaunch(input);
    expect(readFileSync(input.journalFile)).toEqual(bytes);
    return observation;
  });
  const manager = f.createProcess({ reconcileLaunch: reconcile, prepareStorage: prepareControllerStorage, confirmStopped: confirm }, 3, leases);
  return { ...f, signal, ticket, original, snapshot, manager, reconcile, leases };
};

test.skipIf(process.platform !== "linux").each([
  { action: "shutdown", conflict: "snapshot" }, { action: "shutdown", conflict: "owner" },
  { action: "advance", conflict: "snapshot" }, { action: "advance", conflict: "owner" },
] as const)("blocks Bot $action when the same-generation $conflict conflicts with its historical stop", async ({ action, conflict }) => {
  const f = fixture(), signal = new AbortController().signal;
  const stopBootstrap = vi.fn(async () => { throw new Error("Unexpected bootstrap signal"); });
  const stopProcesses = vi.fn(async () => { throw new Error("Unexpected process signal"); });
  const request = vi.fn(async () => { throw new Error("Unexpected Controller request"); });
  const reconcileLaunch = vi.fn(async () => { throw new Error("Unexpected Controller reconciliation"); });
  const leases = { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: vi.fn(async () => {}),
    adopt: () => { throw new Error("Unexpected native launch ownership"); }, retain: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const manager = f.createProcess({ stopBootstrap, stopProcesses, request, reconcileLaunch }, 3, leases);
  f.launch.mockImplementationOnce(async options => {
    const proof = { kind: "linux-controller-launch" as const, pid: 123, launchId: options.ticket.launchId };
    await options.onSubmitting(); await options.onSpawned(proof);
    const snapshot = { ...await f.observe(options.ticket), controllerProcess: proof };
    await options.onObserved(snapshot); return snapshot;
  });
  await manager.advance(f.current(), signal);
  const ticket = await manager.readTicket(f.current()), original = f.current().intent!;
  const launch = f.executions.get(f.current())!.controllerProcess!;
  const journal = openControllerLifecycleStore(original.journalPath, ticket, { controllerProcess: launch });
  journal.markNativeInitializationDispatching();
  journal.patchSnapshot({ nativeSessionId: id(9) }); journal.close();
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const stopped = await recordStoppedControllerGeneration(original.journalPath, ticket, {});
  f.executions.update(f.current(), { snapshot: stopped });
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockClear();

  const db = new Database(sqliteFilename(original.journalPath));
  try {
    if (conflict === "snapshot") db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...stopped, error: "changed after stop" }));
    else db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid);
    const execution = db.prepare("SELECT ticket_hash,owner_pid,snapshot FROM execution WHERE id=1").get();
    const receipt = db.prepare("SELECT ticket_hash,snapshot FROM stopped_generations WHERE ticket_hash=?").get(controllerPayloadHash(ticket));
    expect(receipt).toEqual({ ticket_hash: controllerPayloadHash(ticket), snapshot: JSON.stringify(stopped) });

    await expect(manager[action](f.current(), signal)).rejects.toThrow(/conflict/i);
    expect(f.current().intent).toEqual(original);
    expect(f.executions.get(f.current())!.snapshot).toEqual(stopped);
    expect(db.prepare("SELECT ticket_hash,owner_pid,snapshot FROM execution WHERE id=1").get()).toEqual(execution);
    expect(db.prepare("SELECT ticket_hash,snapshot FROM stopped_generations WHERE ticket_hash=?").get(controllerPayloadHash(ticket))).toEqual(receipt);
    expect(f.release).not.toHaveBeenCalled();
    expect(leases.release).not.toHaveBeenCalled();
    expect(stopBootstrap).not.toHaveBeenCalled();
    expect(stopProcesses).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(reconcileLaunch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.grant).toHaveBeenCalledOnce();
    await expect(manager.close()).rejects.toThrow(/cleanup remains unconfirmed/);
  } finally { db.close(); }
});

test.each(["recovery", "shutdown"] as const)("reconciles an exited ordinary v16 Bot before %s migrates its journal", async action => {
  const f = await stoppedJournalFixture();
  expect(() => readCurrentControllerSnapshot(f.original.journalPath, f.ticket)).toThrow(/current journal format/);
  if (action === "recovery") {
    await expect(f.manager.advance(f.current(), f.signal)).resolves.toMatchObject({ lifecycle: "ready", executionGeneration: "2" });
    expect(f.current().intent).toMatchObject({ executionId: f.original.executionId, executionGeneration: "2", nativeSessionId: f.snapshot.nativeSessionId });
    expect(f.launch).toHaveBeenCalledTimes(2);
  } else {
    await expect(f.manager.shutdown(f.current(), f.signal)).resolves.toBeUndefined();
    expect(f.current().intent).toEqual(f.original);
    expect(f.executions.get(f.current())!.snapshot).toMatchObject({ lifecycle: "stopped", nativeStopped: true });
    expect(f.launch).toHaveBeenCalledOnce();
  }
  expect(f.reconcile).toHaveBeenCalledOnce();
  const db = new Database(sqliteFilename(f.original.journalPath), { readonly: true });
  try { expect(db.pragma("user_version", { simple: true })).toBe(21); }
  finally { db.close(); }
  expect(f.leases.release).toHaveBeenCalledWith(f.ticket.launchId);
});

test("stops the original legacy Bot Controller before recovering the same Session", async () => {
  const f = await stoppedJournalFixture();
  const live = { ...f.snapshot, lifecycle: "ready" as const, activity: "idle" as const, nativeStopped: false, stoppedAt: null,
    startup: { state: "ready" as const, reasonCode: "ready" as const } };
  const response = { kind: "observed" as const, snapshot: live, workerLifecycleProtocol: 1 as const };
  const exited = { kind: "controller-exited" as const, process: f.snapshot.controllerProcess!, snapshot: f.snapshot };
  const reconcile = vi.fn<typeof reconcileSubmittedControllerLaunch>().mockResolvedValue(exited)
    .mockResolvedValueOnce(response).mockResolvedValueOnce(response);
  const stopBootstrap = vi.fn(async () => {});
  const request = vi.fn<typeof localClient.requestController>().mockResolvedValue({ ok: true, requestId: id(91), snapshot: live, workerLifecycleProtocol: 1 });
  const manager = f.createProcess({ reconcileLaunch: reconcile, request, stopBootstrap, prepareStorage: prepareControllerStorage }, 3, f.leases);
  await expect(manager.advance(f.current(), f.signal)).resolves.toMatchObject({
    sessionId: f.ticket.sessionId, executionId: f.original.executionId, nativeSessionId: f.snapshot.nativeSessionId, executionGeneration: "2",
  });
  expect(request).toHaveBeenCalledWith(f.ticket, expect.objectContaining({ kind: "stop" }), expect.anything());
  expect(stopBootstrap).toHaveBeenCalledWith(f.snapshot.controllerProcess, expect.any(Number));
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test.each([
  { version: 16, conflict: "ticket" }, { version: 17, conflict: "ticket" },
  { version: 16, conflict: "process" }, { version: 17, conflict: "process" },
  { version: 16, conflict: "schema" }, { version: 17, conflict: "future" },
] as const)("retains unsafe v$version Bot $conflict conflicts before migration", async ({ version, conflict }) => {
  const f = await stoppedJournalFixture(version), db = new Database(sqliteFilename(f.original.journalPath));
  if (conflict === "ticket") db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64));
  else if (conflict === "process") db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...f.snapshot, controllerProcess: { ...f.snapshot.controllerProcess!, parentPid: 999 } }));
  else if (conflict === "schema") db.exec("DROP TABLE timeline_entries");
  else db.pragma(`user_version=${currentSqliteVersion(controllerJournalFormat) + 1}`);
  db.close();
  const bytes = readFileSync(f.original.journalPath);
  const failure = await f.manager.advance(f.current(), f.signal).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(hasUnsafeControllerObservationFailure(failure)).toBe(true);
  expect(isControllerJournalIoFailure(failure)).toBe(false);
  expect(f.current().intent).toEqual(f.original);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(readFileSync(f.original.journalPath)).toEqual(bytes);
  if (conflict !== "process") expect(() => readProvenWindowsStoppedControllerGeneration(f.original.journalPath, f.ticket)).toThrow();
});

test.each([16, 17] as const)("refuses an altered v%s Windows stop proof before Bot recovery can migrate storage", async version => {
  const f = await stoppedJournalFixture(version), db = new Database(sqliteFilename(f.original.journalPath));
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...f.snapshot,
    windowsJobStopProof: { ...f.snapshot.windowsJobStopProof!, snapshotHash: "b".repeat(64) } }));
  db.close();
  const bytes = readFileSync(f.original.journalPath);
  await expect(f.manager.advance(f.current(), f.signal)).rejects.toThrow(/Windows Job stop proof conflicts/);
  expect(f.current().intent).toEqual(f.original);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(readFileSync(f.original.journalPath)).toEqual(bytes);
  expect(() => readProvenWindowsStoppedControllerGeneration(f.original.journalPath, f.ticket)).toThrow(/Windows Job stop proof conflicts/);
});

test("blocks journal recovery when the original spawn proof is missing",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{
    await options.onSubmitting();
    const journal=openControllerLifecycleStore(f.current().intent!.journalPath,options.ticket);
    journal.patchSnapshot({lifecycle:"failed",startup:{state:"failed",reasonCode:"native_rejected"},error:"native rejected"});journal.close();
    throw new Error("IPC closed before observation");
  });
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("IPC closed");f.observe.mockRejectedValue(new ControllerIpcOutcomeUnknownError("unreachable"));
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toThrow(/spawn proof.*unavailable/);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown");
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("stopped process without native ID never obtains a recovery grant or a blank replacement", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); const ticket = options.ticket; const journal = openControllerLifecycleStore(f.current().intent!.journalPath, ticket); journal.close(); throw new Error("unknown launch"); });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("unknown launch");
  f.observe.mockRejectedValue(new Error("IPC unavailable"));
  await expect(f.createProcess({ confirmStopped: async () => true }).advance(f.current(), signal)).rejects.toThrow();
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});
