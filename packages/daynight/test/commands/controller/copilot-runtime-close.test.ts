import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
const controlled = vi.hoisted(() => ({ spawn: vi.fn(), bridge: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: controlled.spawn }));
vi.mock("../../../src/commands/controller/providers/copilot-bridge.js", () => ({ startCopilotBridge: controlled.bridge }));
import { startCopilotRuntime } from "../../../src/commands/controller/providers/copilot-runtime.js";

afterEach(() => vi.useRealTimers());
const fixture = () => {
  const child = Object.assign(new EventEmitter(), { pid: 67890, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const exit = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.kill.mockImplementation(() => { exit(); return true; });
  controlled.spawn.mockReset().mockImplementation(() => { queueMicrotask(() => { child.emit("spawn"); child.stdout.write("Listening on port 23456\n"); }); return child; });
  const shutdown = vi.fn(async () => ({})), stop = vi.fn(async () => []), forceStop = vi.fn(async () => {}), closeBridge = vi.fn(async () => {});
  controlled.bridge.mockReset().mockReturnValue({ ready: Promise.resolve({ rpc: { runtime: { shutdown } }, stop, forceStop }), close: closeBridge });
  const runtime = startCopilotRuntime({ cwd: process.cwd(), model: null, args: [], executable: "/controlled/copilot", resumeNativeSessionId: null, onSpawn() {}, onState() {}, onTimeline() {} }, () => {});
  return { runtime, child, shutdown, stop, forceStop, closeBridge, exit };
};

test("runtime cleanup retries a failed bridge release after joining native without repeating the native stop request", async () => {
  const f = fixture(), failure = new Error("Fixture bridge spool removal failed"); await f.runtime.ready;
  f.closeBridge.mockRejectedValueOnce(failure);
  const first = f.runtime.close(); expect(f.runtime.close()).toBe(first);
  await expect(first).rejects.toBe(failure); expect(f.child.exitCode).toBe(0);
  await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.closeBridge).toHaveBeenCalledTimes(2); expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  expect(f.child.kill).toHaveBeenCalledOnce(); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("runtime retries an unconfirmed exit observation without sending either native termination signal again", async () => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers(); f.child.kill.mockReturnValue(true);
  f.child.kill.mockImplementation(() => true);
  const first = f.runtime.close(), rejected = expect(first).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(4001); await rejected;
  expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  const second = f.runtime.close(), retryRejected = expect(second).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(2001); await retryRejected;
  expect(f.child.kill).toHaveBeenCalledTimes(2); expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  f.exit(); await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.child.kill).toHaveBeenCalledTimes(2); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("runtime cleanup preserves both bridge removal and native termination errors", async () => {
  const f = fixture(), bridgeError = new Error("Fixture bridge release failed"), nativeError = new Error("Fixture native termination failed"); await f.runtime.ready;
  f.closeBridge.mockRejectedValueOnce(bridgeError); f.child.kill.mockImplementation(() => { throw nativeError; });
  const error = await f.runtime.close().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual(expect.arrayContaining([bridgeError, nativeError]));
  expect(f.child.exitCode).toBeNull();
  f.exit(); await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.child.kill).toHaveBeenCalledTimes(2);
});
