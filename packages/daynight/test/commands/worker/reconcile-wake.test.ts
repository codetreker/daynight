import * as timers from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createReconcileWake } from "../../../src/commands/worker/reconcile-wake.js";

vi.mock("node:timers/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});

describe("reconcile wake", () => {
  it("retains and coalesces requests during a round", async () => {
    const wake = createReconcileWake();
    const revision = wake.snapshot();
    wake.request();
    wake.request();
    await wake.waitAfter(revision, 60_000, new AbortController().signal);
    expect(wake.snapshot()).toBe(2n);
  });

  it("wakes an existing wait, then waits for a new request or poll", async () => {
    vi.useFakeTimers();
    try {
      const wake = createReconcileWake();
      const signal = new AbortController().signal;
      const first = wake.waitAfter(wake.snapshot(), 1000, signal);
      wake.request();
      await first;
      let settled = false;
      const second = wake.waitAfter(wake.snapshot(), 1000, signal).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await second;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("propagates cancellation even when a request is pending", async () => {
    const wake = createReconcileWake();
    const revision = wake.snapshot();
    wake.request();
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    await expect(wake.waitAfter(revision, 1000, controller.signal)).rejects.toThrow("shutdown");
  });

  it("preserves the worker stop reason when a wake precedes stop", async () => {
    const wake = createReconcileWake();
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const waiting = wake.waitAfter(wake.snapshot(), 60_000, controller.signal);
    wake.request();
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it("preserves the worker stop reason during a wait", async () => {
    const wake = createReconcileWake();
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const waiting = wake.waitAfter(wake.snapshot(), 60_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it("propagates an unrelated timer failure", async () => {
    const error = new Error("timer failed");
    vi.mocked(timers.setTimeout).mockRejectedValueOnce(error);
    const wake = createReconcileWake();
    await expect(wake.waitAfter(wake.snapshot(), 1000, new AbortController().signal)).rejects.toBe(error);
  });
});
