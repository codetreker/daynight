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
  const lost = vi.fn();
  const runtime = startCopilotRuntime({ cwd: process.cwd(), model: null, args: [], executable: "/controlled/copilot", resumeNativeSessionId: null, onSpawn() {}, onState() {}, onTimeline() {} }, lost);
  return { runtime, child, shutdown, stop, forceStop, closeBridge, exit, lost };
};

test("an exit during the acknowledged SDK shutdown does not report unexpected native loss", async () => {
  const f = fixture(); await f.runtime.ready;
  f.shutdown.mockImplementation(async () => { f.exit(); return {}; });
  await f.runtime.close();
  expect(f.lost).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.closeBridge).toHaveBeenCalledOnce();
});

test("runtime cleanup retries a failed bridge release after joining native without repeating the native stop request", async () => {
  const f = fixture(), failure = new Error("Fixture bridge spool removal failed"); await f.runtime.ready; vi.useFakeTimers();
  f.closeBridge.mockRejectedValueOnce(failure);
  const first = f.runtime.close(); expect(f.runtime.close()).toBe(first);
  const rejected = expect(first).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.closeBridge).toHaveBeenCalledOnce();
  expect(f.child.kill).not.toHaveBeenCalled(); f.exit();
  await rejected; expect(f.child.exitCode).toBe(0);
  await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.closeBridge).toHaveBeenCalledTimes(2); expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  expect(f.child.kill).not.toHaveBeenCalled(); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("runtime waits for the original native exit after the graceful acknowledgment and bridge cleanup", async () => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers();
  let completed = false;
  const closing = f.runtime.close(); expect(f.runtime.close()).toBe(closing);
  void closing.then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(1499);
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.closeBridge).toHaveBeenCalledOnce();
  expect(completed).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  f.exit(); await closing;
  await f.runtime.close();
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.shutdown).toHaveBeenCalledOnce(); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("runtime escalates once when native does not exit before the graceful deadline", async () => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers();
  f.child.kill.mockImplementation(signal => { if (signal === "SIGKILL") f.exit(); return true; });
  const closing = f.runtime.close();
  await vi.advanceTimersByTimeAsync(1499); expect(f.child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM"]);
  await vi.advanceTimersByTimeAsync(2000); await closing;
  expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  await f.runtime.close();
  expect(f.child.kill).toHaveBeenCalledTimes(2); expect(f.shutdown).toHaveBeenCalledOnce(); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("a successful shutdown acknowledgment still waits for native exit when SDK transport cleanup fails", async () => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers();
  f.stop.mockRejectedValueOnce(new Error("SDK transport cleanup failed"));
  const closing = f.runtime.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.forceStop).toHaveBeenCalledOnce(); expect(f.closeBridge).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled();
  f.exit(); await closing;
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled();
});

test.each(["shutdown failure", "forced cleanup"])("runtime starts forced native cleanup immediately after %s", async mode => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers();
  if (mode === "shutdown failure") f.shutdown.mockRejectedValueOnce(new Error("Shutdown failed"));
  const closing = f.runtime.close(mode === "forced cleanup");
  await vi.advanceTimersByTimeAsync(0); await closing;
  expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM"]);
  expect(f.shutdown).toHaveBeenCalledTimes(mode === "forced cleanup" ? 0 : 1);
  expect(f.forceStop).toHaveBeenCalledOnce();
});

test("runtime retries an unconfirmed exit observation without sending either native termination signal again", async () => {
  const f = fixture(); await f.runtime.ready; vi.useFakeTimers(); f.child.kill.mockReturnValue(true);
  f.child.kill.mockImplementation(() => true);
  const first = f.runtime.close(), rejected = expect(first).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5501); await rejected;
  expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  const second = f.runtime.close(), retryRejected = expect(second).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(2001); await retryRejected;
  expect(f.child.kill).toHaveBeenCalledTimes(2); expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  f.exit(); await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.child.kill).toHaveBeenCalledTimes(2); expect(controlled.spawn).toHaveBeenCalledOnce();
});

test("runtime cleanup preserves both bridge removal and native termination errors", async () => {
  const f = fixture(), bridgeError = new Error("Fixture bridge release failed"), nativeError = new Error("Fixture native termination failed"); await f.runtime.ready; vi.useFakeTimers();
  f.closeBridge.mockRejectedValueOnce(bridgeError); f.child.kill.mockImplementation(() => { throw nativeError; });
  const closing = f.runtime.close().catch(error => error);
  await vi.advanceTimersByTimeAsync(1500); const error = await closing;
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual(expect.arrayContaining([bridgeError, nativeError]));
  expect(f.child.exitCode).toBeNull();
  f.exit(); await expect(f.runtime.close()).resolves.toBeUndefined();
  expect(f.shutdown).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.child.kill).toHaveBeenCalledTimes(2);
});
