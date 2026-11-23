import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ open: vi.fn(), times: vi.fn(), query: vi.fn(), close: vi.fn(), terminate: vi.fn(), wait: vi.fn(), exitCode: vi.fn(), load: vi.fn(), pointerSize: 8, error: 5, now: 0 }));
vi.mock("koffi", () => ({
  load: f.load, sizeof: () => f.pointerSize, address: () => 0x100000n,
}));
const handle = {}, pid = 4101, parentPid = 4000;
const command = '"C:\\Program Files\\node.exe" "C:\\controller 📖.mjs" --role "a  b"';
const fileTime = 134067744001234567n;
let ControllerBootstrapReplacedError: typeof import("../../../src/commands/controller/bootstrap-error.js").ControllerBootstrapReplacedError;
let stop: typeof import("../../../src/commands/controller/windows-process-proof.js").stopWindowsBootstrapProcess;
let capture: typeof import("../../../src/commands/controller/windows-process-proof.js").captureWindowsProcessProof;
let verifyMember: typeof import("../../../src/commands/controller/windows-process-proof.js").verifyWindowsJobMember;
let inspect: typeof import("../../../src/commands/controller/windows-process-proof.js").inspectWindowsProcessProof;
let withStopHandles: typeof import("../../../src/commands/controller/windows-process-proof.js").withWindowsProcessStopHandles;
const writePointer = (data: Buffer, offset: number, value: bigint) => f.pointerSize === 8 ? data.writeBigUInt64LE(value, offset) : data.writeUInt32LE(Number(value), offset);
const basic = (data: Buffer, returned: Buffer) => {
  writePointer(data, f.pointerSize * 4, BigInt(pid)); writePointer(data, f.pointerSize * 5, BigInt(parentPid));
  returned.writeUInt32LE(data.length);
};
const commandLine = (data: Buffer, returned: Buffer) => {
  const header = f.pointerSize * 2, text = Buffer.from(command, "utf16le");
  data.writeUInt16LE(text.length); data.writeUInt16LE(text.length + 2, 2);
  writePointer(data, f.pointerSize, 0x100000n + BigInt(header));
  text.copy(data, header); returned.writeUInt32LE(header + text.length + 2);
};
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); f.pointerSize = 8; f.error = 5; f.now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => f.now);
  f.load.mockImplementation(() => ({ func: (declaration: string) => {
    if (declaration.includes("OpenProcess")) return f.open;
    if (declaration.includes("GetProcessTimes")) return f.times;
    if (declaration.includes("NtQueryInformationProcess")) return f.query;
    if (declaration.includes("TerminateProcess")) return f.terminate;
    if (declaration.includes("WaitForSingleObject")) return f.wait;
    if (declaration.includes("GetExitCodeProcess")) return f.exitCode;
    if (declaration.includes("CloseHandle")) return f.close;
    if (declaration.includes("GetLastError")) return () => f.error;
    throw new Error(`Unexpected native declaration: ${declaration}`);
  } }));
  f.open.mockReset().mockReturnValue(handle); f.close.mockReset().mockReturnValue(1); f.terminate.mockReset().mockReturnValue(1); f.wait.mockReset().mockImplementation((_handle, timeout) => timeout === 0 ? 258 : 0);
  f.exitCode.mockReset().mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(259); return 1; });
  f.times.mockImplementation((observed, creation: Buffer) => { expect(observed).toBe(handle); creation.writeBigUInt64LE(fileTime); return 1; });
  f.query.mockImplementation((observed, kind, data: Buffer, size, returned: Buffer) => {
    expect(observed).toBe(handle); expect(size).toBe(data.length);
    if (kind === 0) basic(data, returned); else if (kind === 60) commandLine(data, returned); else throw new Error("Unexpected information class");
    return 0;
  });
  ({ captureWindowsProcessProof: capture, stopWindowsBootstrapProcess: stop, verifyWindowsJobMember: verifyMember, inspectWindowsProcessProof: inspect, withWindowsProcessStopHandles: withStopHandles } = await import("../../../src/commands/controller/windows-process-proof.js"));
  ({ ControllerBootstrapReplacedError } = await import("../../../src/commands/controller/bootstrap-error.js"));
});
afterEach(() => vi.restoreAllMocks());

describe("Windows native process identity", () => {
  it.each([4, 8])("retains one %i-byte-pointer handle for birth, parent and complete UTF-16 command line", async size => {
    f.pointerSize = size;
    const proof = await capture(pid, 15_000);
    expect(proof).toEqual({ pid, parentPid, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") });
    expect(f.open).toHaveBeenCalledExactlyOnceWith(0x1000, 0, pid);
    expect(f.times.mock.calls[0]?.[0]).toBe(handle);
    expect(f.query.mock.calls.map(call => [call[0], call[1]])).toEqual([[handle, 0], [handle, 60]]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("cannot splice a reused PID into an observation of the retained original handle", async () => {
    f.times.mockImplementationOnce((observed, creation: Buffer) => { expect(observed).toBe(handle); creation.writeBigUInt64LE(fileTime); f.open.mockReturnValue({ replacement: true }); return 1; });
    expect((await capture(pid, 15_000)).parentPid).toBe(parentPid);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.every(call => call[0] === handle)).toBe(true);
  });

  it("preserves Win32 access denial without inventing a proof or closing an unopened handle", async () => {
    f.open.mockReturnValue(null);
    await expect(capture(pid, 15_000)).rejects.toMatchObject({ stage: "open-process", code: 5, domain: "Win32" });
    expect(f.times).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("preserves native creation-time failure and closes the original handle", async () => {
    f.times.mockReturnValue(0);
    await expect(capture(pid, 15_000)).rejects.toMatchObject({ stage: "creation-time", code: 5, domain: "Win32" });
    expect(f.query).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("preserves the exact library load error before acquiring a handle", async () => {
    const failure = new Error("Native library unavailable"); f.load.mockImplementation(() => { throw failure; });
    await expect(capture(pid, 15_000)).rejects.toBe(failure);
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity, 2_147_483_648])("rejects invalid PID %s before loading native libraries", async invalid => {
    await expect(capture(invalid, 15_000)).rejects.toThrow("Invalid process identity");
    expect(f.load).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });

  it.each([0, 60])("preserves original NTSTATUS for failed information class %i and closes the handle", async kind => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === kind ? -1073741790 : original(...args));
    await expect(capture(pid, 15_000)).rejects.toMatchObject({ stage: kind === 0 ? "basic-information" : "command-line", code: -1073741790, domain: "NTSTATUS" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("preserves the exact thrown acquisition object when handle release succeeds", async () => {
    const failure = new Error("original native failure"); f.times.mockImplementation(() => { throw failure; });
    await expect(capture(pid, 15_000)).rejects.toBe(failure);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("retains acquisition and close failures in their original order and cause", async () => {
    const failure = new Error("original native failure"); f.times.mockImplementation(() => { throw failure; }); f.close.mockReturnValue(0);
    const error = await capture(pid, 15_000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(failure);
    expect(error.errors[0]).toBe(failure); expect(error.errors[1]).toMatchObject({ stage: "close-process-handle", code: 5 });
  });

  it("reports handle release failure after successful acquisition", async () => {
    f.close.mockReturnValue(0);
    await expect(capture(pid, 15_000)).rejects.toMatchObject({ stage: "close-process-handle", code: 5 });
  });

  it.each([
    ["short basic size", (kind: number, data: Buffer, returned: Buffer) => { if (kind === 0) returned.writeUInt32LE(data.length - 1); }],
    ["different process", (kind: number, data: Buffer) => { if (kind === 0) writePointer(data, f.pointerSize * 4, 4102n); }],
    ["invalid parent", (kind: number, data: Buffer) => { if (kind === 0) writePointer(data, f.pointerSize * 5, 0x100000000n); }],
    ["short command header", (kind: number, _data: Buffer, returned: Buffer) => { if (kind === 60) returned.writeUInt32LE(1); }],
    ["excessive returned size", (kind: number, data: Buffer, returned: Buffer) => { if (kind === 60) returned.writeUInt32LE(data.length + 1); }],
    ["odd UTF-16 length", (kind: number, data: Buffer) => { if (kind === 60) data.writeUInt16LE(1); }],
    ["empty command line", (kind: number, data: Buffer) => { if (kind === 60) data.writeUInt16LE(0); }],
    ["length exceeds maximum", (kind: number, data: Buffer) => { if (kind === 60) data.writeUInt16LE(0, 2); }],
    ["odd maximum", (kind: number, data: Buffer) => { if (kind === 60) data.writeUInt16LE(65535, 2); }],
    ["pointer before allocation", (kind: number, data: Buffer) => { if (kind === 60) writePointer(data, f.pointerSize, 0xfffffn); }],
    ["pointer inside header", (kind: number, data: Buffer) => { if (kind === 60) writePointer(data, f.pointerSize, 0x100000n); }],
    ["unaligned UTF-16 pointer", (kind: number, data: Buffer) => { if (kind === 60) writePointer(data, f.pointerSize, 0x100001n + BigInt(f.pointerSize * 2)); }],
    ["pointer after allocation", (kind: number, data: Buffer) => { if (kind === 60) writePointer(data, f.pointerSize, 0x200000n); }],
    ["truncated command", (kind: number, _data: Buffer, returned: Buffer) => { if (kind === 60) returned.writeUInt32LE(f.pointerSize * 2 + 2); }],
  ] as const)("rejects %s without decoding unrelated memory or leaking the handle", async (_name, damage) => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => { const value = original(...args); damage(args[1], args[2], args[4]); return value; });
    await expect(capture(pid, 15_000)).rejects.toThrow(/Invalid Windows|identity cannot/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("rejects an invalid birth timestamp while retaining ownership until close", async () => {
    f.times.mockImplementation((_observed, creation: Buffer) => { creation.writeBigUInt64LE(0n); return 1; });
    await expect(capture(pid, 15_000)).rejects.toThrow("Invalid Windows process creation time");
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("joins a native call that consumes the budget, then closes without publishing a late proof", async () => {
    f.times.mockImplementation((_observed, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); f.now = 5001; return 1; });
    await expect(capture(pid, 5000)).rejects.toThrow(/deadline/);
    expect(f.query).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("does not open a process when library initialization consumes the observation budget", async () => {
    f.load.mockImplementation(() => { f.now = 5001; return { func: () => vi.fn() }; });
    await expect(capture(pid, 5000)).rejects.toThrow(/deadline/);
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
});


describe("Windows bootstrap stop handle", () => {
  const proof = { pid, parentPid, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };
  it("checks identity, terminates and waits on the same handle", async () => {
    await stop(proof, Date.now() + 5000);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(0x101001, 0, pid);
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith(handle, 1);
    expect(f.wait.mock.calls).toHaveLength(2);
    expect(f.wait.mock.calls.every(call => call[0] === handle)).toBe(true);
    expect(f.wait.mock.calls[0]?.[1]).toBe(0);
    expect(f.wait.mock.calls[1]?.[1]).toBeGreaterThan(0);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not terminate a different instance", async () => {
    await expect(stop({ ...proof, commandHash: "replacement" }, Date.now() + 5000)).rejects.toThrow(/identity mismatch/);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("distinguishes a different birth from conflicting identity at the same birth", async () => {
    const replaced = await stop({ ...proof, startedAt: "older" }, Date.now() + 5000).catch(error => error);
    expect(replaced).toBeInstanceOf(ControllerBootstrapReplacedError); expect(f.terminate).not.toHaveBeenCalled();
    const conflict = await stop({ ...proof, commandHash: "replacement" }, Date.now() + 5000).catch(error => error);
    expect(conflict).toBeInstanceOf(Error); expect(conflict).not.toBeInstanceOf(ControllerBootstrapReplacedError);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("retains wait and close failures", async () => {
    f.wait.mockReset().mockReturnValue(258); f.close.mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].message).toMatch(/deadline/);
    expect(error.errors[1]).toMatchObject({ stage: "close-process-handle" });
  });
  it("waits on a birth-matching terminating process without requiring its command or terminating it again", async () => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === 60 ? -1073741558 : original(...args));
    await stop(proof, Date.now() + 5000);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.wait.mock.calls.map(call => call[0])).toEqual([handle, handle]);
    expect(f.wait.mock.calls[1]?.[1]).toBeGreaterThan(0);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not confuse a changed exit code with a completed exit", async () => {
    f.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    f.wait.mockReturnValue(258);
    await expect(stop(proof, Date.now() + 5000)).rejects.toThrow(/deadline/);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.wait).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("accepts completed original exit without querying a discarded command line", async () => {
    f.wait.mockReturnValue(0);
    await stop(proof, Date.now() + 5000);
    expect(f.times).toHaveBeenCalledOnce();
    expect(f.query).not.toHaveBeenCalled(); expect(f.exitCode).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("is idempotent when the original PID is authoritatively absent", async () => {
    f.open.mockReturnValue(null); f.error = 87;
    await stop(proof, Date.now() + 5000);
    expect(f.times).not.toHaveBeenCalled(); expect(f.wait).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it("preserves unknown native command failures instead of classifying their text as termination", async () => {
    const failure = new Error("STATUS_PROCESS_IS_TERMINATING");
    f.query.mockImplementation(() => { throw failure; });
    await expect(stop(proof, Date.now() + 5000)).rejects.toBe(failure);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(handle, 0);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains terminating wait failure and original handle close failure", async () => {
    f.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    f.wait.mockReturnValueOnce(258).mockReturnValue(0xffff_ffff); f.close.mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toMatchObject([{ stage: "wait-process" }, { stage: "close-process-handle" }]);
    expect(error.cause).toBe(error.errors[0]); expect(f.terminate).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("confirms the same original handle when exit wins the race with TerminateProcess", async () => {
    f.terminate.mockReturnValue(0);
    f.wait.mockReturnValueOnce(258).mockReturnValue(0);
    await stop(proof, Date.now() + 5000);
    expect(f.wait.mock.calls).toEqual([[handle, 0], [handle, 0]]);
    expect(f.open).toHaveBeenCalledOnce(); expect(f.times).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.map(call => call[1])).toEqual([0, 60]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("waits for a racing unsignaled original transition using the same handle and deadline", async () => {
    f.terminate.mockReturnValue(0);
    f.exitCode.mockImplementationOnce((_handle, code: Buffer) => { code.writeUInt32LE(259); return 1; }).mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
    f.terminate.mockImplementation(() => { now = 3000; return 0; });
    await stop(proof, 5000);
    expect(f.wait.mock.calls).toEqual([[handle, 0], [handle, 0], [handle, 2000]]);
    expect(f.open).toHaveBeenCalledOnce(); expect(f.times).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.map(call => call[1])).toEqual([0, 60]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("preserves access denial for a still-live original after the same-handle recheck", async () => {
    f.terminate.mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ stage: "terminate-process", domain: "Win32", code: 5 });
    expect(f.wait.mock.calls).toEqual([[handle, 0], [handle, 0]]);
    expect(f.exitCode).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains the original termination failure and exit-status recheck failure", async () => {
    f.terminate.mockReturnValue(0); f.exitCode.mockImplementationOnce((_handle, code: Buffer) => { code.writeUInt32LE(259); return 1; }).mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toMatchObject([{ stage: "terminate-process", code: 5 }, { stage: "exit-code", code: 5 }]);
    expect(error.cause).toBe(error.errors[0]); expect(f.open).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains the original termination failure and native completion recheck failure", async () => {
    f.terminate.mockReturnValue(0); f.wait.mockReturnValueOnce(258).mockReturnValue(0xffff_ffff);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toMatchObject([{ stage: "terminate-process", code: 5 }, { stage: "wait-process", code: 5 }]);
    expect(error.cause).toBe(error.errors[0]); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains termination, transition timeout and close failures in original order", async () => {
    f.terminate.mockReturnValue(0); f.wait.mockReturnValue(258); f.close.mockReturnValue(0);
    f.exitCode.mockImplementationOnce((_handle, code: Buffer) => { code.writeUInt32LE(259); return 1; }).mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(3); expect(error.errors[0]).toMatchObject({ stage: "terminate-process", code: 5 });
    expect(error.errors[1].message).toMatch(/deadline/); expect(error.errors[2]).toMatchObject({ stage: "close-process-handle" });
    expect(error.cause).toBe(error.errors[0]); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains the recovered termination race when original handle release still fails", async () => {
    f.terminate.mockReturnValue(0); f.wait.mockReturnValueOnce(258).mockReturnValue(0); f.close.mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toMatchObject([{ stage: "terminate-process", code: 5 }, { stage: "close-process-handle", code: 5 }]);
    expect(error.cause).toBe(error.errors[0]); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not classify an unknown termination failure as an exit race", async () => {
    const failure = new Error("termination unavailable"); f.terminate.mockImplementation(() => { throw failure; });
    await expect(stop(proof, Date.now() + 5000)).rejects.toBe(failure);
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(handle, 0); expect(f.exitCode).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
});

describe("Windows Job original member verification", () => {
  const proof = { pid, parentPid, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };
  it("uses the same process handle for birth, command and membership before closing", async () => {
    const membership = vi.fn(() => true);
    expect(await verifyMember(proof, Date.now() + 5000, membership)).toBe(true);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(0x101000, 0, pid);
    expect(f.times.mock.calls[0]?.[0]).toBe(handle);
    expect(f.query.mock.calls.every(call => call[0] === handle)).toBe(true);
    expect(membership).toHaveBeenCalledExactlyOnceWith(handle);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not accept a replacement birth or consult its membership", async () => {
    const membership = vi.fn(() => true);
    expect(await verifyMember({ ...proof, startedAt: "earlier" }, Date.now() + 5000, membership)).toBe(false);
    expect(membership).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains identity and handle close failures together", async () => {
    f.close.mockReturnValue(0);
    const membership = vi.fn(() => { throw new Error("membership failed"); });
    const error = await verifyMember(proof, Date.now() + 5000, membership).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].message).toContain("membership failed");
    expect(error.errors[1]).toMatchObject({ stage: "close-process-handle" });
  });
  it("verifies membership using the pinned original instance even when termination discarded its command", async () => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === 60 ? -1073741558 : original(...args));
    const membership = vi.fn(() => true);
    expect(await verifyMember(proof, Date.now() + 5000, membership)).toBe(true);
    expect(membership).toHaveBeenCalledExactlyOnceWith(handle);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
});

describe("Windows original process completion observation", () => {
  const proof = { pid, parentPid, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };
  it("returns running only after complete identity checks on a synchronizable original handle", async () => {
    expect(await inspect(proof, 5000)).toBe("running");
    expect(f.open).toHaveBeenCalledExactlyOnceWith(0x101000, 0, pid);
    expect(f.query.mock.calls.map(call => call[1])).toEqual([0, 60]);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("returns exiting when exit status changed but the original handle is not signaled", async () => {
    f.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    expect(await inspect(proof, 5000)).toBe("exiting");
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(handle, 0);
    expect(f.query).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("returns stopped only once the original handle is signaled", async () => {
    f.wait.mockReturnValue(0);
    expect(await inspect(proof, 5000)).toBe("stopped");
    expect(f.times).toHaveBeenCalledOnce(); expect(f.exitCode).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("uses authoritative missing-PID status rather than a generic liveness shortcut", async () => {
    f.open.mockReturnValue(null); f.error = 87;
    expect(await inspect(proof, 5000)).toBe("stopped");
    expect(f.times).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it("reports replacement birth without inspecting or signaling its command", async () => {
    const mismatch = vi.fn();
    expect(await inspect({ ...proof, startedAt: "older" }, 5000, mismatch)).toBe("replaced");
    expect(mismatch).toHaveBeenCalledOnce(); expect(mismatch.mock.calls[0]?.[0]).toMatchObject({ sameBirth: false });
    expect(f.wait).not.toHaveBeenCalled(); expect(f.exitCode).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.terminate).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it.each([
    { commandHash: "different" }, { parentPid: parentPid + 1 }, { processGroupId: pid },
  ])("rejects same-birth running identity conflict %j and retains completion responsibility", async conflict => {
    await expect(inspect({ ...proof, ...conflict }, 5000)).rejects.toThrow(/inconsistent identity/);
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it.each([0, 60])("recognizes typed terminating status for native information class %i as wait-only", async kind => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === kind ? -1073741558 : original(...args));
    expect(await inspect(proof, 5000)).toBe("exiting");
    expect(f.terminate).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it.each([0, 60])("preserves unknown NTSTATUS from class %i rather than inferring completed exit", async kind => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === kind ? -1073741790 : original(...args));
    await expect(inspect(proof, 5000)).rejects.toMatchObject({ domain: "NTSTATUS", code: -1073741790, stage: kind === 0 ? "basic-information" : "command-line" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("preserves process access denial without attempting PID liveness or closing an unopened handle", async () => {
    f.open.mockReturnValue(null);
    await expect(inspect(proof, 5000)).rejects.toMatchObject({ stage: "open-process", domain: "Win32", code: 5 });
    expect(f.wait).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it("preserves exit-code acquisition error on the original handle", async () => {
    f.exitCode.mockReturnValue(0);
    await expect(inspect(proof, 5000)).rejects.toMatchObject({ stage: "exit-code", code: 5 });
    expect(f.query).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("preserves native wait failure and closes the original handle once", async () => {
    f.wait.mockReturnValue(0xffff_ffff);
    await expect(inspect(proof, 5000)).rejects.toMatchObject({ stage: "wait-process", code: 5 });
    expect(f.exitCode).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("joins a native birth call that exhausts the observation budget, then closes without publishing state", async () => {
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); f.now = 5000; return 1; });
    await expect(inspect(proof, 5000)).rejects.toThrow(/deadline/);
    expect(f.wait).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
});

describe("Windows original handles through complete Job stop", () => {
  const proof = { pid, parentPid, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };
  const native = { ...proof, pid: pid + 1, parentPid: pid };
  const controllerHandle = {}, nativeHandle = {};
  const originalHandles = () => {
    f.open.mockImplementation((_access, _inherit, openedPid) => openedPid === pid ? controllerHandle : nativeHandle);
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); return 1; });
    f.query.mockImplementation((observed, kind, data: Buffer, _size, returned: Buffer) => {
      if (kind === 0) {
        writePointer(data, f.pointerSize * 4, BigInt(observed === controllerHandle ? pid : native.pid));
        writePointer(data, f.pointerSize * 5, BigInt(observed === controllerHandle ? parentPid : pid));
        returned.writeUInt32LE(data.length);
      } else if (kind === 60) commandLine(data, returned);
      else throw new Error("Unexpected information class");
      return 0;
    });
  };
  it("pins every known original before termination and waits on those handles within the original deadline", async () => {
    originalHandles();
    let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const terminateJob = vi.fn(async () => {
      expect(f.open).toHaveBeenCalledTimes(2); expect(f.close).not.toHaveBeenCalled();
      expect(f.wait.mock.calls).toEqual([[controllerHandle, 0], [nativeHandle, 0]]);
      now = 3000;
    });
    await withStopHandles([proof, native], 5000, terminateJob);
    expect(terminateJob).toHaveBeenCalledOnce();
    expect(f.wait.mock.calls).toEqual([[controllerHandle, 0], [nativeHandle, 0], [controllerHandle, 2000], [nativeHandle, 2000]]);
    expect(f.close.mock.calls).toEqual([[nativeHandle], [controllerHandle]]);
    expect(f.terminate).not.toHaveBeenCalled();
  });
  it("never sends a negative native wait when consecutive clock reads cross the original deadline", async () => {
    originalHandles();
    let stopped = false, completionReads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => !stopped || ++completionReads < 3 ? 4999 : 5001);
    const error = await withStopHandles([proof, native], 5000, async () => { stopped = true; }).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/deadline/);
    expect(f.wait.mock.calls.every(call => call[1] >= 0 && call[1] <= 2_147_483_647)).toBe(true);
    expect(f.wait.mock.calls).toEqual([[controllerHandle, 0], [nativeHandle, 0], [controllerHandle, 1]]);
    expect(f.close.mock.calls).toEqual([[nativeHandle], [controllerHandle]]);
  });
  it("closes all original handles without starting a timed wait when the remaining budget expires", async () => {
    originalHandles();
    let stopped = false, completionReads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => !stopped || ++completionReads < 2 ? 4999 : 5000);
    await expect(withStopHandles([proof, native], 5000, async () => { stopped = true; })).rejects.toThrow(/deadline/);
    expect(f.wait.mock.calls).toEqual([[controllerHandle, 0], [nativeHandle, 0]]);
    expect(f.close.mock.calls).toEqual([[nativeHandle], [controllerHandle]]);
  });
  it("keeps changed-exit-status originals pinned until signaled even after Job stop succeeds", async () => {
    f.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
    f.wait.mockReturnValue(258);
    const terminateJob = vi.fn(async () => { expect(f.close).not.toHaveBeenCalled(); });
    await expect(withStopHandles([proof], Date.now() + 5000, terminateJob)).rejects.toThrow(/deadline/);
    expect(terminateJob).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled();
    expect(f.wait).toHaveBeenCalledTimes(2); expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("retains a typed already-terminating original whose command is unavailable", async () => {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((...args) => args[1] === 60 ? -1073741558 : original(...args));
    const terminateJob = vi.fn(async () => { expect(f.close).not.toHaveBeenCalled(); });
    await withStopHandles([proof], Date.now() + 5000, terminateJob);
    expect(terminateJob).toHaveBeenCalledOnce(); expect(f.wait).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not wait on a replacement handle or treat it as a known original", async () => {
    const terminateJob = vi.fn(async () => { expect(f.close).toHaveBeenCalledExactlyOnceWith(handle); });
    await withStopHandles([{ ...proof, startedAt: "older" }], Date.now() + 5000, terminateJob);
    expect(terminateJob).toHaveBeenCalledOnce(); expect(f.wait).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not terminate the Job when acquisition of a later original is denied, and releases earlier originals", async () => {
    originalHandles(); f.open.mockReturnValueOnce(controllerHandle).mockReturnValueOnce(null);
    const terminateJob = vi.fn(async () => undefined);
    await expect(withStopHandles([proof, native], Date.now() + 5000, terminateJob)).rejects.toMatchObject({ stage: "open-process", code: 5 });
    expect(terminateJob).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(controllerHandle);
  });
  it("retains partial acquisition and earlier original handle close failure", async () => {
    originalHandles(); f.open.mockReturnValueOnce(controllerHandle).mockReturnValueOnce(null); f.close.mockReturnValue(0);
    const error = await withStopHandles([proof, native], Date.now() + 5000, async () => undefined).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toMatchObject([{ stage: "open-process" }, { stage: "close-process-handle" }]);
    expect(error.cause).toBe(error.errors[0]); expect(f.close).toHaveBeenCalledExactlyOnceWith(controllerHandle);
  });
  it("retains the original Job failure and both native handle close failures", async () => {
    originalHandles(); f.close.mockReturnValue(0);
    const failure = new Error("Job stop failed");
    const error = await withStopHandles([proof, native], Date.now() + 5000, async () => { throw failure; }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(failure);
    expect(error.errors[0]).toBe(failure); expect(error.errors.slice(1)).toMatchObject([{ stage: "close-process-handle" }, { stage: "close-process-handle" }]);
    expect(f.close.mock.calls).toEqual([[nativeHandle], [controllerHandle]]);
    expect(f.wait.mock.calls.every(call => call[1] === 0)).toBe(true);
  });
  it("joins a Job operation that exhausts the deadline, closes all handles and starts no late wait", async () => {
    originalHandles(); let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
    await expect(withStopHandles([proof, native], 5000, async () => { now = 5000; })).rejects.toThrow(/deadline/);
    expect(f.wait.mock.calls).toEqual([[controllerHandle, 0], [nativeHandle, 0]]);
    expect(f.close.mock.calls).toEqual([[nativeHandle], [controllerHandle]]);
  });
});
