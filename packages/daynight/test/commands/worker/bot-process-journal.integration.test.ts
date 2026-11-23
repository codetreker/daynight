import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
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
  const controller = { ...f.executions.get(f.current())!.controllerProcess!, processGroupId: null, jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  let snapshot = journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeSessionId: id(9), nativeStopped: true,
    stoppedAt: "2026-11-19T00:00:00Z", controllerProcess: controller });
  journal.close();
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
  try { expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); }
  finally { db.close(); }
  expect(f.leases.release).toHaveBeenCalledWith(f.ticket.launchId);
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
