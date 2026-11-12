import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ open: vi.fn(), times: vi.fn(), query: vi.fn(), close: vi.fn(), terminate: vi.fn(), wait: vi.fn(), load: vi.fn(), pointerSize: 8, error: 5, now: 0 }));
vi.mock("koffi", () => ({
  load: f.load, sizeof: () => f.pointerSize, address: () => 0x100000n,
}));
const handle = {}, pid = 4101, parentPid = 4000;
const command = '"C:\\Program Files\\node.exe" "C:\\controller 📖.mjs" --role "a  b"';
const fileTime = 134067744001234567n;
let stop: typeof import("../../../src/commands/controller/windows-process-proof.js").stopWindowsBootstrapProcess;
let capture: typeof import("../../../src/commands/controller/windows-process-proof.js").captureWindowsProcessProof;
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
    if (declaration.includes("CloseHandle")) return f.close;
    if (declaration.includes("GetLastError")) return () => f.error;
    throw new Error(`Unexpected native declaration: ${declaration}`);
  } }));
  f.open.mockReturnValue(handle); f.close.mockReturnValue(1); f.terminate.mockReturnValue(1); f.wait.mockReset().mockReturnValueOnce(258).mockReturnValue(0);
  f.times.mockImplementation((observed, creation: Buffer) => { expect(observed).toBe(handle); creation.writeBigUInt64LE(fileTime); return 1; });
  f.query.mockImplementation((observed, kind, data: Buffer, size, returned: Buffer) => {
    expect(observed).toBe(handle); expect(size).toBe(data.length);
    if (kind === 0) basic(data, returned); else if (kind === 60) commandLine(data, returned); else throw new Error("Unexpected information class");
    return 0;
  });
  ({ captureWindowsProcessProof: capture, stopWindowsBootstrapProcess: stop } = await import("../../../src/commands/controller/windows-process-proof.js"));
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
  it("retains wait and close failures", async () => {
    f.wait.mockReset().mockReturnValue(258); f.close.mockReturnValue(0);
    const error = await stop(proof, Date.now() + 5000).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].message).toMatch(/deadline/);
    expect(error.errors[1]).toMatchObject({ stage: "close-process-handle" });
  });
});
