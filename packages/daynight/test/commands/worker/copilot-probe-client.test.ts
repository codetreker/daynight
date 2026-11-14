import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { withCopilotProbeClient } from "../../../src/commands/worker/copilot-probe-client.js";

const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), forceStop: vi.fn(), shutdown: vi.fn(), runtimeStart: vi.fn(), runtimeClose: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/copilot-owned-process.js", async original => ({
  ...await original<object>(), startCopilotProcess: mocks.runtimeStart,
}));
vi.mock("@github/copilot-sdk", () => ({
  RuntimeConnection: { forUri: (uri: string, options: object) => ({ uri, ...options }) },
  CopilotClient: class {
    start = mocks.start;
    stop = mocks.stop;
    forceStop = mocks.forceStop;
    rpc = { runtime: { shutdown: mocks.shutdown } };
  },
}));

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  mocks.start.mockResolvedValue(undefined); mocks.stop.mockResolvedValue([]);
  mocks.forceStop.mockResolvedValue(undefined); mocks.shutdown.mockResolvedValue({});
  mocks.runtimeClose.mockResolvedValue(undefined);
  mocks.runtimeStart.mockReturnValue({ ready: Promise.resolve({ port: 12345, token: "fixture-token" }), failed: new Promise(() => {}), close: mocks.runtimeClose });
});
afterEach(() => vi.useRealTimers());

it("keeps a successful read only after forced transport and owned native cleanup confirm a timed-out shutdown", async () => {
  const operation = createOperation({ limits: { totalMs: 10_000 } });
  const shutdownStarted = Promise.withResolvers<void>(), nativeClosed = Promise.withResolvers<void>();
  mocks.shutdown.mockImplementation(() => { shutdownStarted.resolve(); return new Promise(() => {}); });
  mocks.runtimeClose.mockReturnValue(nativeClosed.promise);
  const value = { version: "1.0.105" };
  const pending = withCopilotProbeClient({ cwd: process.cwd(), environment: {} }, operation, async () => value);
  const observed = pending.then(result => ({ result }), error => ({ error }));
  let settled = false; void observed.then(() => { settled = true; });
  try {
    await shutdownStarted.promise;
    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.forceStop).toHaveBeenCalledOnce();
    expect(mocks.runtimeClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(settled).toBe(false);
    nativeClosed.resolve();
    expect(await observed).toEqual({ result: value });
  } finally { nativeClosed.resolve(); await observed; operation.dispose(); }
});

it("preserves the original read failure after forced cleanup succeeds", async () => {
  const operation = createOperation(), failure = new Error("status failed");
  mocks.shutdown.mockRejectedValue(new Error("shutdown response lost"));
  try {
    await expect(withCopilotProbeClient({ cwd: process.cwd(), environment: {} }, operation, async () => { throw failure; })).rejects.toBe(failure);
    expect(mocks.forceStop).toHaveBeenCalledOnce();
    expect(mocks.runtimeClose).toHaveBeenCalledExactlyOnceWith(false);
  } finally { operation.dispose(); }
});

it.each(["native", "transport"] as const)("keeps %s cleanup failure blocking a successful read", async owner => {
  const operation = createOperation(), graceful = new Error("shutdown response lost"), cleanup = new Error(`${owner} cleanup unknown`);
  mocks.shutdown.mockRejectedValue(graceful);
  (owner === "native" ? mocks.runtimeClose : mocks.forceStop).mockRejectedValue(cleanup);
  try {
    await expect(withCopilotProbeClient({ cwd: process.cwd(), environment: {} }, operation, async () => ({ version: "1.0.105" }))).rejects.toMatchObject({ code: "cleanup_unknown", errors: [graceful, cleanup] });
    expect(mocks.forceStop).toHaveBeenCalledOnce();
    expect(mocks.runtimeClose).toHaveBeenCalledExactlyOnceWith(false);
  } finally { operation.dispose(); }
});

it("retains read, graceful shutdown and final cleanup failures together", async () => {
  const operation = createOperation(), read = new Error("status failed"), graceful = new Error("SDK stop failed"), cleanup = new Error("native cleanup unknown");
  mocks.stop.mockResolvedValue([graceful]); mocks.runtimeClose.mockRejectedValue(cleanup);
  try {
    await expect(withCopilotProbeClient({ cwd: process.cwd(), environment: {} }, operation, async () => { throw read; })).rejects.toMatchObject({ code: "cleanup_unknown", errors: [read, graceful, cleanup] });
    expect(mocks.forceStop).toHaveBeenCalledOnce();
    expect(mocks.runtimeClose).toHaveBeenCalledExactlyOnceWith(true);
  } finally { operation.dispose(); }
});
