import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { withNativeFixtureExit } from "./claude-live-loss-cleanup.js";

const kernel = vi.hoisted(() => ({ load: vi.fn(), open: vi.fn(), times: vi.fn(), query: vi.fn(), wait: vi.fn(), exitCode: vi.fn(), close: vi.fn(), terminate: vi.fn(), observe: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ inspectBootstrapProcessProof: kernel.observe }));
vi.mock("koffi", () => ({
  sizeof: () => 8, address: () => 0x100000n,
  load: () => { kernel.load(); return { func: (declaration: string) => {
    if (declaration.includes("OpenProcess")) return kernel.open;
    if (declaration.includes("GetProcessTimes")) return kernel.times;
    if (declaration.includes("NtQueryInformationProcess")) return kernel.query;
    if (declaration.includes("WaitForSingleObject")) return kernel.wait;
    if (declaration.includes("GetExitCodeProcess")) return kernel.exitCode;
    if (declaration.includes("CloseHandle")) return kernel.close;
    if (declaration.includes("TerminateProcess")) return kernel.terminate;
    if (declaration.includes("GetLastError")) return () => 5;
    throw new Error(`Unexpected native declaration: ${declaration}`);
  } }; },
}));

const original = {}, command = 'node "fixture.mjs"', birth = 134067744001234567n;
const proof = { pid: 4101, parentPid: 4000, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };

beforeEach(() => {
  vi.clearAllMocks();
  kernel.open.mockReturnValue(original);
  kernel.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(birth); return 1; });
  kernel.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(259); return 1; });
  kernel.query.mockImplementation((_handle, kind: number, data: Buffer, _size: number, returned: Buffer) => {
    if (kind === 0) {
      data.writeBigUInt64LE(BigInt(proof.pid), 32); data.writeBigUInt64LE(BigInt(proof.parentPid), 40); returned.writeUInt32LE(data.length);
    } else if (kind === 60) {
      const text = Buffer.from(command, "utf16le"); data.writeUInt16LE(text.length); data.writeUInt16LE(text.length + 2, 2);
      data.writeBigUInt64LE(0x100010n, 8); text.copy(data, 16); returned.writeUInt32LE(16 + text.length + 2);
    } else throw new Error("Unexpected information class.");
    return 0;
  });
  kernel.close.mockReturnValue(1);
  kernel.terminate.mockReturnValue(1);
});

test("Windows fixture exit pins the running original through exiting until its handle is signaled", async () => {
  let state = "running";
  kernel.wait.mockImplementation((handle, timeout) => {
    expect(handle).toBe(original);
    if (timeout === 0) return state === "signaled" ? 0 : 258;
    if (state === "exiting") state = "signaled";
    expect(state).toBe("signaled"); return 0;
  });
  kernel.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(state === "running" ? 259 : 1); return 1; });
  const stop = vi.fn();
  await withNativeFixtureExit(proof, async () => { expect(kernel.open).toHaveBeenCalledOnce(); state = "exiting"; }, stop, true);
  expect(state).toBe("signaled");
  expect(kernel.open).toHaveBeenCalledTimes(2); expect(kernel.wait).toHaveBeenCalledTimes(3);
  expect(kernel.close).toHaveBeenCalledTimes(2);
  expect(kernel.terminate).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
});

test("Windows fixture exit waits for an already exiting original without signaling it", async () => {
  kernel.exitCode.mockImplementation((_handle, code: Buffer) => { code.writeUInt32LE(1); return 1; });
  kernel.wait.mockImplementation((handle, timeout) => { expect(handle).toBe(original); return timeout === 0 ? 258 : 0; });
  const stop = vi.fn(), action = vi.fn(async () => {});
  await withNativeFixtureExit(proof, action, stop, true);
  expect(action).toHaveBeenCalledOnce(); expect(kernel.query).not.toHaveBeenCalled();
  expect(kernel.wait).toHaveBeenCalledTimes(3); expect(kernel.close).toHaveBeenCalledTimes(2);
  expect(kernel.terminate).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
});

test("Windows fixture exit starts its completion budget after the helper action", async () => {
  let now = 100_000; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    kernel.wait.mockImplementation((_handle, timeout) => timeout === 0 ? 258 : 0);
    await withNativeFixtureExit(proof, async () => { now += 5000; }, vi.fn(), true);
    expect(kernel.wait.mock.calls.filter(call => call[1] > 0).every(call => call[1] === 1000)).toBe(true);
  } finally { clock.mockRestore(); }
});

test("Windows fixture exit does not signal a different process at the same PID", async () => {
  kernel.times.mockImplementation((_handle, creation: Buffer) => { creation.writeBigUInt64LE(birth + 100_000n); return 1; });
  const stop = vi.fn(), action = vi.fn(async () => {});
  await expect(withNativeFixtureExit(proof, action, stop, true)).rejects.toThrow();
  expect(action).toHaveBeenCalledOnce(); expect(kernel.wait).not.toHaveBeenCalled();
  expect(kernel.close).toHaveBeenCalledOnce();
  expect(kernel.terminate).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
});

test("Windows fixture exit does not accept a handle that remains unsignaled", async () => {
  kernel.wait.mockReturnValue(258);
  const stop = vi.fn();
  const error = await withNativeFixtureExit(proof, async () => {}, stop, true).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors.every((item: Error) => /deadline/.test(item.message))).toBe(true);
  expect(kernel.close).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled();
});

test("Windows fixture exit retains an action failure while stopping and waiting for the original", async () => {
  const failure = new Error("helper failed");
  kernel.wait.mockReturnValueOnce(258).mockReturnValueOnce(0).mockReturnValueOnce(0);
  await expect(withNativeFixtureExit(proof, async () => { throw failure; }, vi.fn(), true)).rejects.toBe(failure);
  expect(kernel.terminate).toHaveBeenCalledExactlyOnceWith(original, 1);
  expect(kernel.wait.mock.calls.every(call => call[0] === original)).toBe(true);
  expect(kernel.wait).toHaveBeenCalledTimes(3); expect(kernel.close).toHaveBeenCalledTimes(2);
});

test("Windows fixture exit retains action and original-handle wait failures", async () => {
  const failure = new Error("helper failed"); kernel.wait.mockReturnValue(258);
  const error = await withNativeFixtureExit(proof, async () => { throw failure; }, vi.fn(), true).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure);
  expect(error.errors.slice(1).every((item: Error) => /deadline/.test(item.message))).toBe(true);
  expect(kernel.close).toHaveBeenCalledTimes(2);
});

test("Windows fixture exit retains action and handle-close failures", async () => {
  const failure = new Error("helper failed");
  kernel.wait.mockReturnValueOnce(258).mockReturnValueOnce(0).mockReturnValueOnce(0);
  kernel.close.mockReturnValueOnce(1).mockReturnValueOnce(0);
  const error = await withNativeFixtureExit(proof, async () => { throw failure; }, vi.fn(), true).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure);
  expect(error.errors[1].message).toContain("CloseHandle failed");
});

test("Windows fixture exit still runs cleanup when handle acquisition fails", async () => {
  kernel.open.mockReturnValue(null);
  const action = vi.fn(async () => {});
  await expect(withNativeFixtureExit(proof, action, vi.fn(), true)).rejects.toThrow("OpenProcess failed");
  expect(action).toHaveBeenCalledOnce(); expect(kernel.close).not.toHaveBeenCalled();
});

test("Windows fixture exit retains handle-load and action failures", async () => {
  const loadFailure = new Error("library failed"), actionFailure = new Error("helper failed");
  kernel.load.mockImplementationOnce(() => { throw loadFailure; });
  const error = await withNativeFixtureExit(proof, async () => { throw actionFailure; }, vi.fn(), true).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([loadFailure, actionFailure]);
});

test("POSIX fixture exit stops the native fixture even when the action fails", async () => {
  const failure = new Error("helper failed"), stop = vi.fn();
  kernel.observe.mockResolvedValueOnce("running").mockResolvedValueOnce("stopped");
  await expect(withNativeFixtureExit(proof, async () => { throw failure; }, stop, false)).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledOnce(); expect(kernel.observe).toHaveBeenCalledTimes(2);
});
