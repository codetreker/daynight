import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runSqliteImmediate } from "../../../src/platform/sqlite-access.js";
import { createGuardianErrorReporter, createWindowsJobGuardian, openWindowsGuardianJob, recoverWindowsGuardianJob, WindowsGuardianLeaseError, WindowsGuardianReleaseError, WindowsGuardianTemporaryHandleError } from "../../../src/commands/controller/windows-job-guardian.js";
import { WindowsGuardianDuplicateDecodeError } from "../../../src/platform/windows-controller-guardian.js";
import type { WindowsControllerGuardianKernel } from "../../../src/platform/windows-controller-guardian.js";
import type { ProcessProof } from "../../../src/commands/controller/process-proof.js";
import type { WindowsJobAssignedSource, WindowsJobPreparedSource, WindowsJobSource, WindowsJobStopReceipt } from "../../../src/commands/controller/windows-job-evidence.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const birth = 116444736000000000n + 17000000000000000n;
const controller: ProcessProof = { pid: 1234, parentPid: 100, processGroupId: null, startedAt: "2023-11-14T22:13:20.0000000Z", commandHash: "a".repeat(64) };
const guardian: ProcessProof = { ...controller, pid: process.pid, parentPid: controller.pid, commandHash: "b".repeat(64) };
const fields = { launchId: uuid(1), executionId: uuid(2), executionGeneration: "1", controllerInstanceId: uuid(3), ticketHash: "c".repeat(64), controller };
const setup = () => {
  const handles = { controller: { name: "controller" }, guardian: { name: "guardian" }, job: { name: "job" }, wake: { name: "wake" }, duplicate: { name: "duplicate" }, second: { name: "second" } };
  const state = { controllerStopped: false, guardianStopped: false, sealed: false, active: 1, members: [controller.pid], wake: false, equal: true };
  const trace: string[] = [];
  const api = {
    open: vi.fn(() => handles.controller), openGuardian: vi.fn(() => handles.guardian),
    captureProof: vi.fn(async (pid: number) => pid === controller.pid ? controller : guardian),
    identity: vi.fn((handle: unknown) => handle === handles.controller ? { pid: controller.pid, parentPid: controller.parentPid, birth } : { pid: guardian.pid, parentPid: guardian.parentPid, birth }),
    signaled: vi.fn((handle: unknown) => handle === handles.controller ? state.controllerStopped : state.guardianStopped),
    create: vi.fn(() => handles.job), killOnCloseConfirmed: vi.fn(), hasKillOnClose: vi.fn(() => true), createWake: vi.fn(() => handles.wake), handleValue: vi.fn(() => "123"),
    assignHandle: vi.fn(() => { trace.push("assign"); }), contains: vi.fn(() => true),
    duplicateJob: vi.fn().mockReturnValueOnce(handles.duplicate).mockReturnValue(handles.second), decodeDuplicatedJob: vi.fn(() => handles.duplicate), sameJob: vi.fn(() => state.equal),
    close: vi.fn(), closeProcess: vi.fn(), isSealed: vi.fn(() => state.sealed), active: vi.fn(() => state.active), inspect: vi.fn(() => state.members),
    terminate: vi.fn(), sealAdmissions: vi.fn(() => { state.sealed = true; }), consumeWake: vi.fn(() => state.wake), wake: vi.fn(),
  } as unknown as WindowsControllerGuardianKernel;
  let source: WindowsJobSource | null = null, receipt: WindowsJobStopReceipt | null = null;
  const journal = {
    prepare: vi.fn((value: WindowsJobPreparedSource) => { trace.push("prepare"); source = value; }),
    assign: vi.fn((_prepared: WindowsJobPreparedSource, value: WindowsJobAssignedSource) => { trace.push("assigned"); source = value; }),
    readSource: vi.fn(() => source), readReceipt: vi.fn(() => receipt),
  };
  const setReceipt = (value: WindowsJobStopReceipt) => { receipt = value; };
  const result = () => source as WindowsJobAssignedSource;
  const stoppedReceipt = () => ({ version: 1, source: result(), sealed: true, empty: true, controllerStopped: true, nativeProcessesStopped: true, snapshot: {} } as unknown as WindowsJobStopReceipt);
  return { handles, state, trace, api, journal, setReceipt, result, stoppedReceipt };
};

it("publishes preparation before assignment and releases only after an exact committed stop receipt", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  expect(await owner.start()).toMatchObject({ phase: "assigned", jobHandle: "123" });
  expect(f.trace).toEqual(["prepare", "assign", "assigned"]);
  vi.useFakeTimers();
  try {
    const running = owner.runUntilReleased(error => { throw error; });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.api.sealAdmissions).not.toHaveBeenCalled(); expect(f.api.close).not.toHaveBeenCalled();
    f.state.controllerStopped = true; f.state.active = 0; f.state.members = []; f.state.wake = true;
    f.setReceipt(f.stoppedReceipt());
    await vi.advanceTimersByTimeAsync(500); await running;
    expect(f.api.sealAdmissions).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledWith(f.handles.job);
    expect(f.api.closeProcess).toHaveBeenCalledWith(f.handles.controller);
  } finally { vi.useRealTimers(); }
});

it("holds original resources after an uncertain assignment write and never replays startup", async () => {
  const f = setup(); const failure = new Error("unknown assignment result");
  f.journal.assign.mockImplementationOnce((_prepared, value) => { f.journal.readSource.mockReturnValue(value); throw failure; });
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  await expect(owner.start()).rejects.toBe(failure);
  await expect(owner.start()).rejects.toThrow("must not be replayed");
  expect(f.api.close).not.toHaveBeenCalled(); expect(f.api.closeProcess).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    f.state.controllerStopped = true; f.state.active = 0; f.state.members = []; f.state.wake = true;
    f.setReceipt({ ...f.stoppedReceipt(), source: owner.assigned });
    const running = owner.runUntilReleased(error => { throw error; });
    await vi.advanceTimersByTimeAsync(500); await running;
    expect(f.api.close).toHaveBeenCalledWith(f.handles.job);
  } finally { vi.useRealTimers(); }
});

it("duplicates the verified guardian object and retains it when its guardian exits", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api);
  expect(f.api.openGuardian).toHaveBeenCalledWith(guardian.pid);
  expect(f.api.duplicateJob).toHaveBeenCalledWith(f.handles.guardian, "123");
  expect(lease.inspect()).toEqual({ sealed: false, active: 1, members: [controller.pid] });
  f.state.guardianStopped = true;
  expect(() => lease.close()).toThrow("must be retained");
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
  f.state.active = 0; f.state.members = [];
  expect(lease.sealAndObserveEmpty()).toEqual({ sealed: true, active: 0, members: [] });
  lease.closeAfterCommit(f.stoppedReceipt());
  expect(f.api.close).toHaveBeenCalledWith(f.handles.duplicate);
});

it("retains a duplicated object if querying it fails after guardian exit", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  vi.mocked(f.api.active).mockImplementationOnce(() => { f.state.guardianStopped = true; throw new Error("query failed"); });
  const error = await openWindowsGuardianJob(source, f.api).catch(value => value);
  expect(error).toBeInstanceOf(WindowsGuardianLeaseError);
  expect(error.retained).toMatchObject({ job: f.handles.duplicate, guardian: f.handles.guardian });
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
  const recovered = recoverWindowsGuardianJob(error.retained);
  expect(recovered.inspect()).toMatchObject({ active: 1 });
  expect(f.api.duplicateJob).toHaveBeenCalledOnce();
});

it("does not report an occupied sealed Job as empty", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api);
  expect(() => lease.sealAndObserveEmpty()).toThrow("not sealed and empty");
  expect(lease.inspect()).toMatchObject({ sealed: true, active: 1 });
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
});


it("rejects a replaced guardian before duplicating any Job handle", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  vi.mocked(f.api.captureProof).mockResolvedValueOnce({ ...guardian, commandHash: "d".repeat(64) });
  await expect(openWindowsGuardianJob(source, f.api)).rejects.toThrow("identity could not be confirmed");
  expect(f.api.duplicateJob).not.toHaveBeenCalled();
  expect(f.api.closeProcess).toHaveBeenCalledWith(f.handles.guardian);
});

it("does not return a handle if the guardian no longer owns the same Job", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api); f.state.equal = false;
  expect(() => lease.close()).toThrow("no longer owns the original Job object");
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
  expect(f.api.close).toHaveBeenCalledWith(f.handles.second);
});

it("refuses a receipt for a different source without releasing the original Job", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api); f.state.active = 0; f.state.members = []; lease.sealAndObserveEmpty();
  const receipt = f.stoppedReceipt(); receipt.source = { ...receipt.source, executionGeneration: "2" };
  expect(() => lease.closeAfterCommit(receipt)).toThrow("does not identify this original Job");
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
});


it("retains a duplicated Job whose kill-on-close policy is missing", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  vi.mocked(f.api.hasKillOnClose).mockReturnValueOnce(false);
  const error = await openWindowsGuardianJob(source, f.api).catch(value => value);
  expect(error).toBeInstanceOf(WindowsGuardianLeaseError);
  expect(error.cause).toHaveProperty("message", "The original Windows Job lost kill-on-close.");
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
});


it("exposes seal failure before termination and retains the original object", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api), failure = new Error("seal denied");
  vi.mocked(f.api.sealAdmissions).mockImplementationOnce(() => { throw failure; });
  expect(() => lease.seal()).toThrow(failure);
  expect(f.api.terminate).not.toHaveBeenCalled();
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.duplicate);
  lease.seal(); lease.terminate();
  expect(lease.inspect().sealed).toBe(true);
  expect(f.api.terminate).toHaveBeenCalledWith(f.handles.duplicate);
});

it("rejects a guardian not descended from the held Controller before creating a Job", async () => {
  const f = setup();
  vi.mocked(f.api.captureProof).mockImplementation(async pid => pid === controller.pid ? controller : { ...guardian, parentPid: controller.pid + 1 });
  await expect(createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api })).rejects.toThrow("not a child");
  expect(f.api.create).not.toHaveBeenCalled();
  expect(f.api.closeProcess).toHaveBeenCalledWith(f.handles.controller);
});

it("keeps the original handle on an unconfirmed preparation and refuses automatic replay", async () => {
  const f = setup(); const failure = new Error("preparation response lost");
  f.journal.prepare.mockImplementationOnce(() => { throw failure; });
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  await expect(owner.start()).rejects.toBe(failure);
  await expect(owner.start()).rejects.toThrow("must not be replayed");
  expect(f.api.assignHandle).not.toHaveBeenCalled();
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.job);
});


it("retains the raw duplicated handle if native pointer decoding fails", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  vi.mocked(f.api.duplicateJob).mockReset().mockImplementationOnce(() => { throw new WindowsGuardianDuplicateDecodeError("987", { cause: new Error("decode failed") }); });
  const error = await openWindowsGuardianJob(source, f.api).catch(value => value);
  expect(error).toBeInstanceOf(WindowsGuardianLeaseError);
  expect(error.retained.rawJob).toBe("987");
  expect(f.api.closeProcess).not.toHaveBeenCalledWith(f.handles.guardian);
  const lease = recoverWindowsGuardianJob(error.retained);
  expect(lease.inspect().active).toBe(1);
  expect(f.api.decodeDuplicatedJob).toHaveBeenCalledOnce();
  expect(f.api.duplicateJob).toHaveBeenCalledOnce();
});

it("retains partial release details and never replays an unconfirmed handle close", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api); f.state.active = 0; f.state.members = []; lease.seal();
  const failure = new Error("job close failed");
  vi.mocked(f.api.close).mockImplementationOnce(() => { throw failure; });
  const receipt = f.stoppedReceipt();
  let original: unknown;
  try { lease.closeAfterCommit(receipt); } catch (error) { original = error; }
  expect(original).toBeInstanceOf(WindowsGuardianReleaseError);
  expect(original).toMatchObject({ errors: [failure], retained: { job: f.handles.duplicate, guardian: f.handles.guardian, jobCloseConfirmed: false, guardianCloseConfirmed: true } });
  expect(f.api.closeProcess).toHaveBeenCalledWith(f.handles.guardian);
  expect(() => lease.closeAfterCommit(receipt)).toThrow(original as Error);
  expect(f.api.close).toHaveBeenCalledTimes(1);
});

it("deduplicates and bounds guardian diagnostic output", () => {
  const output: string[] = [], report = createGuardianErrorReporter(message => output.push(message), 3);
  report(new Error("first")); report(new Error("first"));
  for (let i = 0; i < 50; i++) report(new Error(`failure ${i}`));
  expect(output).toHaveLength(4);
  expect(output.at(-1)).toContain("suppressed");
});


it("releases an empty guardian when preparation is definitively rolled back", async () => {
  const f = setup(), db = new Database(":memory:"), failure = new Error("prepare rolled back");
  f.state.active = 0; f.state.members = []; vi.mocked(f.api.contains).mockReturnValue(false);
  f.journal.prepare.mockImplementationOnce(() => runSqliteImmediate(db, () => { throw failure; }));
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  try {
    await expect(owner.start()).rejects.toBe(failure);
    expect(f.api.assignHandle).not.toHaveBeenCalled();
    expect(f.api.close).toHaveBeenCalledWith(f.handles.job);
    expect(f.api.close).toHaveBeenCalledWith(f.handles.wake);
    expect(f.api.closeProcess).toHaveBeenCalledWith(f.handles.controller);
    await owner.runUntilReleased(() => { throw new Error("Unexpected guardian loop"); });
  } finally { db.close(); }
});

it("retains the guardian if preparation rolls back but Job emptiness is unconfirmed", async () => {
  const f = setup(), db = new Database(":memory:"), failure = new Error("prepare rolled back");
  f.journal.prepare.mockImplementationOnce(() => runSqliteImmediate(db, () => { throw failure; }));
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  try {
    await expect(owner.start()).rejects.toBe(failure);
    expect(f.api.assignHandle).not.toHaveBeenCalled();
    expect(f.api.close).not.toHaveBeenCalledWith(f.handles.job);
    expect(f.api.closeProcess).not.toHaveBeenCalled();
  } finally { db.close(); }
});


it("retains an uncertain temporary duplicate close without opening another handle", async () => {
  const f = setup(); const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api }); const source = await owner.start();
  const lease = await openWindowsGuardianJob(source, f.api), failure = new Error("temporary close failed");
  vi.mocked(f.api.close).mockImplementationOnce(() => { throw failure; });
  let original: unknown;
  try { lease.close(); } catch (error) { original = error; }
  expect(original).toBeInstanceOf(WindowsGuardianTemporaryHandleError);
  expect(original).toMatchObject({ errors: [failure], retained: { guardian: f.handles.guardian, job: f.handles.duplicate, temporary: f.handles.second } });
  expect(() => lease.close()).toThrow(original as Error);
  expect(f.api.duplicateJob).toHaveBeenCalledTimes(2);
  expect(f.api.closeProcess).not.toHaveBeenCalledWith(f.handles.guardian);
});

it("retains a prepared original Job if Controller revalidation fails before assignment", async () => {
  const f = setup(), failure = new Error("Controller observation unavailable");
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  vi.mocked(f.api.captureProof).mockRejectedValueOnce(failure);
  await expect(owner.start()).rejects.toBe(failure);
  expect(f.journal.readSource()).toMatchObject({ phase: "prepared", jobHandle: "123" });
  expect(f.api.assignHandle).not.toHaveBeenCalled(); expect(f.journal.assign).not.toHaveBeenCalled();
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.job);
  await expect(owner.start()).rejects.toThrow("must not be replayed");
});

it("retains a prepared original Job when native assignment is unconfirmed", async () => {
  const f = setup(), failure = new Error("assignment outcome unknown");
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  vi.mocked(f.api.assignHandle).mockImplementationOnce(() => { throw failure; });
  await expect(owner.start()).rejects.toBe(failure);
  expect(f.journal.readSource()).toMatchObject({ phase: "prepared", jobHandle: "123" });
  expect(f.journal.assign).not.toHaveBeenCalled(); expect(f.api.close).not.toHaveBeenCalledWith(f.handles.job);
  await expect(owner.start()).rejects.toThrow("must not be replayed");
});

it("does not replay an unknown assigned-source write while preparation remains current", async () => {
  const f = setup(), failure = new Error("assignment receipt lost");
  const owner = await createWindowsJobGuardian({ identity: fields, journal: f.journal, kernel: f.api });
  f.journal.assign.mockImplementationOnce(() => { throw failure; });
  await expect(owner.start()).rejects.toBe(failure);
  expect(f.journal.readSource()).toMatchObject({ phase: "prepared", jobHandle: "123" });
  expect(f.api.close).not.toHaveBeenCalledWith(f.handles.job);
  await expect(owner.start()).rejects.toThrow("must not be replayed");
  expect(f.journal.assign).toHaveBeenCalledOnce();
});
