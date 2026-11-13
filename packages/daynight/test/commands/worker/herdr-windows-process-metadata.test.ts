import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";

const f = vi.hoisted(() => ({ load: vi.fn(), open: vi.fn(), image: vi.fn(), times: vi.fn(), wait: vi.fn(), close: vi.fn(), snapshot: vi.fn(), first: vi.fn(), next: vi.fn(), pointerSize: 8, error: 18, now: 0 }));
vi.mock("koffi", () => ({ load: f.load, sizeof: () => f.pointerSize, address: (handle: unknown) => handle === -1 ? (1n << BigInt(f.pointerSize * 8)) - 1n : 0x3000n }));
const processHandle = {}, snapshotHandle = {};
const image = "C:\\Program Files\\PowerShell 📖\\powershell.exe";
const fileTime = 134067744001234567n;
let metadata: typeof import("../../../src/commands/worker/herdr/windows-process-metadata.js");
const operations: Operation[] = [];
const operation = (signal?: AbortSignal) => {
  const active = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 2000, requestMs: 1000 } });
  operations.push(active); return active;
};
const entry = (data: Buffer, pid: number, parentPid: number) => {
  expect(data.readUInt32LE()).toBe(f.pointerSize === 8 ? 568 : 556);
  data.writeUInt32LE(pid, 8); data.writeUInt32LE(parentPid, f.pointerSize === 8 ? 32 : 24);
};
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); f.pointerSize = 8; f.error = 18; f.now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => f.now);
  f.load.mockImplementation(() => ({ func: (declaration: string) => {
    for (const [name, value] of Object.entries({ OpenProcess: f.open, QueryFullProcessImageNameW: f.image, GetProcessTimes: f.times, WaitForSingleObject: f.wait, CloseHandle: f.close, CreateToolhelp32Snapshot: f.snapshot, Process32FirstW: f.first, Process32NextW: f.next })) if (declaration.includes(name)) return value;
    if (declaration.includes("GetLastError")) return () => f.error;
    throw new Error(`Unexpected native declaration: ${declaration}`);
  } }));
  f.open.mockReturnValue(processHandle); f.close.mockReturnValue(1); f.wait.mockReturnValue(258);
  f.image.mockImplementation((handle, flags, output: Buffer, size: Buffer) => {
    expect(handle).toBe(processHandle); expect(flags).toBe(0); expect(size.readUInt32LE()).toBe(output.length / 2);
    Buffer.from(image, "utf16le").copy(output); size.writeUInt32LE(image.length); return 1;
  });
  f.times.mockImplementation((handle, creation: Buffer) => { expect(handle).toBe(processHandle); creation.writeBigUInt64LE(fileTime); return 1; });
  f.snapshot.mockReturnValue(snapshotHandle);
  f.first.mockImplementation((handle, data: Buffer) => { expect(handle).toBe(snapshotHandle); entry(data, 0, 0); return 1; });
  f.next.mockImplementationOnce((handle, data: Buffer) => { expect(handle).toBe(snapshotHandle); entry(data, 4101, 4000); return 1; }).mockReturnValue(0);
  metadata = await import("../../../src/commands/worker/herdr/windows-process-metadata.js");
});
afterEach(() => { operations.splice(0).forEach(active => active.dispose()); vi.restoreAllMocks(); });

describe("Herdr native Windows process metadata", () => {
  it("keeps the complete Win32 executable and every 100ns digit from one live process object", async () => {
    expect(await metadata.readWindowsProcessMetadata(4101, operation())).toEqual({ executable: image, startToken: "638978976001234567" });
    expect(f.open).toHaveBeenCalledExactlyOnceWith(0x00101000, 0, 4101);
    expect(f.wait.mock.calls).toEqual([[processHandle, 0], [processHandle, 0]]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("cannot splice a reused PID into a retained process object", async () => {
    f.times.mockImplementation((handle, creation: Buffer) => { expect(handle).toBe(processHandle); creation.writeBigUInt64LE(fileTime); f.open.mockReturnValue({ replacement: true }); return 1; });
    expect((await metadata.readWindowsProcessMetadata(4101, operation())).startToken).toBe("638978976001234567");
    expect(f.open).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it.each([87, 5])("rejects an unavailable or denied root (Win32 %i) without fabricating identity", async code => {
    f.error = code; f.open.mockReturnValue(null);
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ stage: "OpenProcess", code });
    expect(f.image).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Infinity])("rejects invalid PID %s before acquiring native resources", async pid => {
    await expect(metadata.readWindowsProcessMetadata(pid, operation())).rejects.toThrow(/process identifier/i);
    expect(f.load).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("rejects a root that signals exit %s acquisition", async phase => {
    if (phase === "before") f.wait.mockReturnValueOnce(0); else f.wait.mockReturnValueOnce(258).mockReturnValueOnce(0);
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toThrow(/exited/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("preserves an indeterminate wait failure", async () => {
    f.error = 6; f.wait.mockReturnValue(0xffff_ffff);
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ stage: "WaitForSingleObject", code: 6 });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it.each(["image", "times"])("preserves the %s Win32 failure and releases the retained root", async stage => {
    f.error = 5; (stage === "image" ? f.image : f.times).mockReturnValue(0);
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ stage: stage === "image" ? "QueryFullProcessImageNameW" : "GetProcessTimes", code: 5 });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it.each(["empty", "relative", "native", "embedded-null", "overflow"])("rejects %s executable output without publishing a partial identity", async kind => {
    f.image.mockImplementation((_handle, _flags, output: Buffer, size: Buffer) => {
      const value = kind === "relative" ? "powershell.exe" : kind === "native" ? "\\Device\\HarddiskVolume1\\powershell.exe" : kind === "embedded-null" ? "C:\\bad\0.exe" : "";
      Buffer.from(value, "utf16le").copy(output); size.writeUInt32LE(kind === "overflow" ? output.length / 2 : value.length); return 1;
    });
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toThrow(/executable/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it.each([0n, 0xffff_ffff_ffff_ffffn])("rejects an invalid FILETIME %s without losing ownership", async birth => {
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(birth); return 1; });
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toThrow(/creation time/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("joins a native call that consumes the deadline and closes before rejecting its late result", async () => {
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); f.now = 2001; return 1; });
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ kind: "deadline" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("does not acquire a process after library loading consumes the deadline", async () => {
    const load = f.load.getMockImplementation()!; f.load.mockImplementation((...args) => { f.now = 2001; return load(...args); });
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ kind: "deadline" });
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each(["request", "ten-second-cap"])("rejects a late %s acquisition even while the parent operation has time remaining", async limit => {
    const active = createOperation({ limits: { totalMs: 20_000, requestMs: limit === "request" ? 1000 : 15_000 } });
    operations.push(active);
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); f.now = limit === "request" ? 1001 : 10_001; return 1; });
    await expect(metadata.readWindowsProcessMetadata(4101, active)).rejects.toMatchObject({ name: "HerdrCommandDeadlineError" });
    expect(active.remainingMs()).toBeGreaterThan(0);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("cancels after a joined native call while still closing its process handle", async () => {
    const controller = new AbortController();
    f.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(fileTime); controller.abort("cancel-metadata"); return 1; });
    await expect(metadata.readWindowsProcessMetadata(4101, operation(controller.signal))).rejects.toMatchObject({ kind: "cancelled", cause: "cancel-metadata" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(processHandle);
  });

  it("retains the original acquisition error and close error in order", async () => {
    const original = new Error("native acquisition failed"); f.times.mockImplementation(() => { throw original; }); f.error = 6; f.close.mockReturnValue(0);
    const failure = await metadata.readWindowsProcessMetadata(4101, operation()).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(original); expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toMatchObject({ stage: "CloseHandle", code: 6 });
  });

  it("rejects a close failure instead of publishing otherwise valid metadata", async () => {
    f.error = 6; f.close.mockReturnValue(0);
    await expect(metadata.readWindowsProcessMetadata(4101, operation())).rejects.toMatchObject({ stage: "CloseHandle", code: 6 });
  });
});

describe("Herdr native Windows process inventory", () => {
  it.each([4, 8])("decodes a complete %i-byte-pointer snapshot as candidates without invented ownership", async size => {
    f.pointerSize = size;
    expect(await metadata.captureWindowsProcessInventory(operation())).toEqual([{ pid: 4101, parentPid: 4000, group: null }]);
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(2, 0);
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it.each([null, -1])("rejects an invalid snapshot handle %s without closing it", async handle => {
    f.error = 5; f.snapshot.mockReturnValue(handle);
    await expect(metadata.captureWindowsProcessInventory(operation())).rejects.toMatchObject({ stage: "CreateToolhelp32Snapshot", code: 5 });
    expect(f.close).not.toHaveBeenCalled();
  });

  it("rejects a partial snapshot when enumeration fails instead of treating its prefix as complete", async () => {
    f.error = 5;
    await expect(metadata.captureWindowsProcessInventory(operation())).rejects.toMatchObject({ stage: "Process32NextW", code: 5 });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it("preserves a failed first enumeration rather than returning an empty inventory", async () => {
    f.error = 5; f.first.mockReturnValue(0);
    await expect(metadata.captureWindowsProcessInventory(operation())).rejects.toMatchObject({ stage: "Process32FirstW", code: 5 });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it.each(["empty", "idle-only", "duplicate"])("rejects %s snapshots without emitting incomplete candidates", async kind => {
    f.first.mockImplementation((_handle, data: Buffer) => { entry(data, kind === "duplicate" ? 4101 : 0, 0); return kind === "empty" ? 0 : 1; });
    if (kind !== "duplicate") f.next.mockReset().mockReturnValue(0);
    await expect(metadata.captureWindowsProcessInventory(operation())).rejects.toThrow(/inventory/);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it("closes a snapshot after cancellation during enumeration without returning a prefix", async () => {
    const controller = new AbortController();
    f.next.mockReset().mockImplementation((_handle, data: Buffer) => { entry(data, 4101, 4000); controller.abort("cancel-inventory"); return 1; });
    await expect(metadata.captureWindowsProcessInventory(operation(controller.signal))).rejects.toMatchObject({ kind: "cancelled", cause: "cancel-inventory" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it("rejects a late final enumeration even when the complete prefix looked valid", async () => {
    f.next.mockReset().mockImplementationOnce((_handle, data: Buffer) => { entry(data, 4101, 4000); return 1; }).mockImplementation(() => { f.now = 2001; return 0; });
    await expect(metadata.captureWindowsProcessInventory(operation())).rejects.toMatchObject({ kind: "deadline" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it("rejects a snapshot's late request result before the total operation expires", async () => {
    f.next.mockReset().mockImplementationOnce((_handle, data: Buffer) => { entry(data, 4101, 4000); return 1; }).mockImplementation(() => { f.now = 1001; return 0; });
    const active = operation();
    await expect(metadata.captureWindowsProcessInventory(active)).rejects.toMatchObject({ name: "HerdrCommandDeadlineError" });
    expect(active.remainingMs()).toBeGreaterThan(0);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(snapshotHandle);
  });

  it("retains enumeration and snapshot close failures with the original cause", async () => {
    const original = new Error("enumeration failed"); f.next.mockReset().mockImplementation(() => { throw original; }); f.error = 6; f.close.mockReturnValue(0);
    const failure = await metadata.captureWindowsProcessInventory(operation()).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(original); expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toMatchObject({ stage: "CloseHandle", code: 6 });
  });
});
