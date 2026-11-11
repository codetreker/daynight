import { describe, expect, it, vi } from "vitest";
import { createReconcileWake } from "../../../src/commands/worker/reconcile-wake.js";

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
});
