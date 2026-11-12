import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  create: vi.fn(), open: vi.fn(), openProcess: vi.fn(), assign: vi.fn(), query: vi.fn(), terminate: vi.fn(), close: vi.fn(), contains: vi.fn(), verify: vi.fn(),
  load: vi.fn(), setLastError: vi.fn(), pointerSize: 8, error: 0, now: 0,
}));
vi.mock("koffi", () => ({ load: f.load, sizeof: () => f.pointerSize }));
vi.mock("../../../src/commands/controller/windows-process-proof.js", () => ({ verifyWindowsJobMember: f.verify }));
const launchId = "11111111-1111-4111-8111-111111111111", name = `Local\\Daynight-${launchId}`;
const job = { kind: "job" }, processHandle = { kind: "process" }, pid = 4101;
const proof = { pid, parentPid: 4000, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
let create: typeof import("../../../src/commands/controller/windows-job.js").createControllerJob;
let inspect: typeof import("../../../src/commands/controller/windows-job.js").inspectControllerJob;
const members = (data: Buffer, pids: readonly bigint[] = [4101n, 4202n]) => {
  data.writeUInt32LE(pids.length, 0); data.writeUInt32LE(pids.length, 4);
  for (const [index, pid] of pids.entries()) {
    if (f.pointerSize === 8) data.writeBigUInt64LE(pid, 8 + index * 8);
    else data.writeUInt32LE(Number(pid), 8 + index * 4);
  }
};
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); f.pointerSize = 8; f.error = 0; f.now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => f.now);
  f.load.mockImplementation(() => ({ func: (declaration: string) => {
    if (declaration.includes("CreateJobObjectW")) return f.create;
    if (declaration.includes("OpenJobObjectW")) return f.open;
    if (declaration.includes("OpenProcess")) return f.openProcess;
    if (declaration.includes("AssignProcessToJobObject")) return f.assign;
    if (declaration.includes("QueryInformationJobObject")) return f.query;
    if (declaration.includes("IsProcessInJob")) return f.contains;
    if (declaration.includes("TerminateJobObject")) return f.terminate;
    if (declaration.includes("CloseHandle")) return f.close;
    if (declaration.includes("SetLastError")) return f.setLastError;
    if (declaration.includes("GetLastError")) return () => f.error;
    throw new Error(`Unexpected native declaration: ${declaration}`);
  } }));
  f.create.mockReturnValue(job); f.open.mockReturnValue(job); f.openProcess.mockReturnValue(processHandle);
  f.assign.mockReturnValue(1); f.terminate.mockReturnValue(1); f.close.mockReturnValue(1);
  f.query.mockImplementation((_job, _kind, data: Buffer) => { members(data, f.terminate.mock.calls.length ? [] : [4101n, 4202n]); return 1; });
  f.contains.mockImplementation((_process, _job, result: Buffer) => { result.writeInt32LE(1); return 1; });
  f.verify.mockImplementation(async (_proof, _deadline, belongs) => belongs(processHandle));
  ({ createControllerJob: create, inspectControllerJob: inspect } = await import("../../../src/commands/controller/windows-job.js"));
});
afterEach(() => vi.restoreAllMocks());

describe("native Controller Job Objects", () => {
  it("creates one noninheritable Job membership and releases both handles in ownership order", async () => {
    expect(await create(launchId, pid)).toBe(name);
    expect(f.setLastError).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(null, name);
    expect(f.openProcess).toHaveBeenCalledExactlyOnceWith(0x101, 0, pid);
    expect(f.assign).toHaveBeenCalledExactlyOnceWith(job, processHandle);
    expect(f.close.mock.calls).toEqual([[processHandle], [job]]);
    expect(f.assign.mock.invocationCallOrder[0]).toBeLessThan(f.close.mock.invocationCallOrder[0]!);
  });

  it("loads the kernel once while opening each observation independently", async () => {
    await create(launchId, pid); await inspect(name); await inspect(name);
    expect(f.load).toHaveBeenCalledExactlyOnceWith("kernel32.dll"); expect(f.open).toHaveBeenCalledTimes(2);
  });

  it.each([4, 8])("decodes every member using a %i-byte ULONG_PTR layout", async size => {
    f.pointerSize = size;
    expect(await inspect(name)).toEqual([4101, 4202]);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(4, 0, name);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(job, 3, expect.any(Buffer), 262_144, null);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("authenticates a member and waits for an empty inventory on the original Job handle", async () => {
    expect(await inspect(name, true, Date.now() + 5000, [proof])).toEqual([]);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(12, 0, name);
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith(job, 1);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.terminate.mock.invocationCallOrder[0]!);
    expect(f.contains).toHaveBeenCalledExactlyOnceWith(processHandle, job, expect.any(Buffer));
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("does not terminate a same-name Job without a verified original member", async () => {
    f.verify.mockResolvedValue(false);
    await expect(inspect(name, true, Date.now() + 5000, [proof])).rejects.toThrow(/no verified original/);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("keeps the same Job handle open until termination empties the inventory", async () => {
    f.query.mockImplementation((_job, _kind, data: Buffer) => {
      expect(f.close).not.toHaveBeenCalled();
      members(data, f.query.mock.calls.length < 4 ? [4101n] : []);
      return 1;
    });
    expect(await inspect(name, true, Date.now() + 5000, [proof])).toEqual([]);
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(f.query.mock.calls.every(call => call[0] === job)).toBe(true);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("closes the Job if its members do not exit before the deadline", async () => {
    const deadline = Date.now() + 100, clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    f.query.mockImplementation((_job, _kind, data: Buffer) => {
      members(data, [4101n]);
      if (f.terminate.mock.calls.length) clock.mockReturnValue(deadline);
      return 1;
    });
    await expect(inspect(name, true, deadline, [proof])).rejects.toThrow(/deadline/);
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("does not terminate an empty Job", async () => {
    f.query.mockImplementation((_job, _kind, data: Buffer) => { members(data, []); return 1; });
    expect(await inspect(name, true, Date.now() + 5000, [proof])).toEqual([]);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("maps only a missing named Job to an empty inventory without inventing a handle", async () => {
    f.open.mockReturnValue(null); f.error = 2;
    expect(await inspect(name)).toEqual([]);
    expect(f.query).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("rejects an existing identity and closes its handle without assigning another process", async () => {
    f.create.mockImplementation(() => { f.error = 183; return job; });
    await expect(create(launchId, pid)).rejects.toMatchObject({ stage: "identity-already-exists", win32Code: 183 });
    expect(f.openProcess).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("preserves create failure without closing an unopened handle", async () => {
    f.create.mockImplementation(() => { f.error = 5; return null; });
    await expect(create(launchId, pid)).rejects.toMatchObject({ stage: "create", win32Code: 5 });
    expect(f.close).not.toHaveBeenCalled();
  });

  it("closes the Job if opening its target process fails", async () => {
    f.openProcess.mockReturnValue(null); f.error = 5;
    await expect(create(launchId, pid)).rejects.toMatchObject({ stage: "open-process", win32Code: 5 });
    expect(f.assign).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("preserves assignment failure and closes both acquired handles", async () => {
    f.assign.mockReturnValue(0); f.error = 5;
    await expect(create(launchId, pid)).rejects.toMatchObject({ stage: "assign-process", win32Code: 5 });
    expect(f.close.mock.calls).toEqual([[processHandle], [job]]);
  });

  it.each([5, 6, 123])("propagates OpenJobObject error %i instead of reporting stopped", async code => {
    f.open.mockReturnValue(null); f.error = code;
    await expect(inspect(name)).rejects.toMatchObject({ stage: "open", win32Code: code });
    expect(f.query).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("propagates query failure and closes its acquired handle", async () => {
    f.query.mockReturnValue(0); f.error = 234;
    await expect(inspect(name)).rejects.toMatchObject({ stage: "query-members", win32Code: 234 });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("propagates termination failure without claiming a stopped inventory", async () => {
    f.terminate.mockReturnValue(0); f.error = 5;
    await expect(inspect(name, true, Date.now() + 5000, [proof])).rejects.toMatchObject({ stage: "terminate-members", win32Code: 5 });
    expect(f.query).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("preserves an exact thrown native error while releasing its handle", async () => {
    const failure = new Error("native query failed"); f.query.mockImplementation(() => { throw failure; });
    await expect(inspect(name)).rejects.toBe(failure);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("retains both the original operation and release error in their causal order", async () => {
    const failure = new Error("native query failed"); f.query.mockImplementation(() => { throw failure; });
    f.close.mockReturnValue(0); f.error = 6;
    const error = await inspect(name).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(failure);
    expect(error.errors[0]).toBe(failure); expect(error.errors[1]).toMatchObject({ stage: "close-job-handle", win32Code: 6 });
  });

  it("still releases the Job when releasing the assigned process handle fails", async () => {
    f.close.mockImplementation(handle => { f.error = 6; return handle === processHandle ? 0 : 1; });
    await expect(create(launchId, pid)).rejects.toMatchObject({ stage: "close-process-handle", win32Code: 6 });
    expect(f.close.mock.calls).toEqual([[processHandle], [job]]);
  });

  it("reports failed handle release after an otherwise successful inspection", async () => {
    f.close.mockReturnValue(0); f.error = 6;
    await expect(inspect(name)).rejects.toMatchObject({ stage: "close-job-handle", win32Code: 6 });
  });

  it.each([
    ["count beyond assigned processes", (data: Buffer) => data.writeUInt32LE(1, 0)],
    ["inventory beyond allocated memory", (data: Buffer) => { data.writeUInt32LE(40_000, 0); data.writeUInt32LE(40_000, 4); }],
    ["zero process identity", (data: Buffer) => data.writeBigUInt64LE(0n, 8)],
    ["unsafe process identity", (data: Buffer) => data.writeBigUInt64LE(0x20_0000_0000_0000n, 8)],
  ] as const)("rejects %s and releases the Job handle", async (_name, damage) => {
    f.query.mockImplementation((_job, _kind, data: Buffer) => { members(data); damage(data); return 1; });
    await expect(inspect(name)).rejects.toThrow(/Invalid controller Job Object/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("returns the actual empty inventory", async () => {
    f.query.mockImplementation((_job, _kind, data: Buffer) => { members(data, []); return 1; });
    expect(await inspect(name)).toEqual([]); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("rejects an unsupported pointer layout before acquiring a Job handle", async () => {
    f.pointerSize = 16;
    await expect(inspect(name)).rejects.toThrow("Unsupported Windows Job Object pointer size");
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-uuid", "11111111-1111-4111-8111-111111111111'; bad"])('rejects invalid launch identity "%s" before loading the kernel', async value => {
    await expect(create(value, pid)).rejects.toThrow("Invalid controller Job Object identity");
    await expect(inspect(value)).rejects.toThrow("Invalid controller Job Object identity");
    expect(f.load).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity, 2_147_483_648])("rejects invalid process identity %s before loading the kernel", async value => {
    await expect(create(launchId, value)).rejects.toThrow("Invalid controller process ID");
    expect(f.load).not.toHaveBeenCalled();
  });

  it("preserves the exact native library error before acquiring resources", async () => {
    const failure = new Error("kernel32 unavailable"); f.load.mockImplementation(() => { throw failure; });
    await expect(inspect(name)).rejects.toBe(failure);
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("does not acquire a handle when library initialization consumes the budget", async () => {
    const original = f.load.getMockImplementation()!;
    f.load.mockImplementation((...args) => { f.now = 15_000; return original(...args); });
    await expect(inspect(name)).rejects.toThrow(/deadline/);
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("joins an expired native query and closes its handle without returning late inventory", async () => {
    f.query.mockImplementation((_job, _kind, data: Buffer) => { members(data); f.now = 15_000; return 1; });
    await expect(inspect(name)).rejects.toThrow(/deadline/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("does not open or terminate a Job after the caller's deadline", async () => {
    await expect(inspect(name, true, Date.now() - 1)).rejects.toThrow(/deadline/);
    expect(f.open).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled();
  });

  it("closes a Job whose open call consumes the caller's deadline without terminating it", async () => {
    const deadline = Date.now() + 100;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    f.open.mockImplementation(() => { clock.mockReturnValue(deadline); return job; });
    await expect(inspect(name, true, deadline)).rejects.toThrow(/deadline/);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("joins a Job termination that crosses the caller's deadline and closes its handle", async () => {
    const deadline = Date.now() + 100;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    f.terminate.mockImplementation(() => { clock.mockReturnValue(deadline); return 1; });
    await expect(inspect(name, true, deadline, [proof])).rejects.toThrow(/deadline/);
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.query).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("retains termination and close failures when a native call crosses the deadline", async () => {
    const deadline = Date.now() + 100, clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    f.terminate.mockImplementation(() => { f.error = 5; clock.mockReturnValue(deadline); return 0; });
    f.close.mockReturnValue(0);
    const error = await inspect(name, true, deadline, [proof]).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.message).toMatch(/deadline/);
    expect(error.errors[0]).toBeInstanceOf(AggregateError);
    expect(error.errors[0].errors.map((failure: { stage: string }) => failure.stage)).toEqual(["terminate-members", "close-job-handle"]);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("closes an acquired Job even when creation consumes the budget", async () => {
    f.create.mockImplementation(() => { f.now = 15_000; return job; });
    await expect(create(launchId, pid)).rejects.toThrow(/deadline/);
    expect(f.openProcess).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("joins both handle releases when assignment consumes the budget", async () => {
    f.assign.mockImplementation(() => { f.now = 15_000; return 1; });
    await expect(create(launchId, pid)).rejects.toThrow(/deadline/);
    expect(f.close.mock.calls).toEqual([[processHandle], [job]]);
  });
});
