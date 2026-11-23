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
    const wake = createReconcileWake();
    const controller = new AbortController();
    const first = wake.waitAfter(wake.snapshot(), 1000, controller.signal);
    wake.request();
    await first;

    const expiry = Promise.withResolvers<void>();
    const timer = vi.mocked(timers.setTimeout);
    const callsBefore = timer.mock.calls.length;
    timer.mockImplementationOnce(async (milliseconds, value, options) => {
      expect(milliseconds).toBe(1_000);
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      const abort = () => expiry.reject(signal!.reason);
      signal!.throwIfAborted();
      signal!.addEventListener("abort", abort, { once: true });
      try { await expiry.promise; signal!.throwIfAborted(); return value; }
      finally { signal!.removeEventListener("abort", abort); }
    });
    let settled = false;
    const second = wake.waitAfter(wake.snapshot(), 1_000, controller.signal).then(() => { settled = true; });
    try {
      expect(timer).toHaveBeenCalledTimes(callsBefore + 1);
      await Promise.resolve();
      expect(settled).toBe(false);
      expiry.resolve();
      await second;
      expect(settled).toBe(true);
    } finally {
      controller.abort(); expiry.resolve();
      await Promise.allSettled([second]);
      timer.mockReset();
    }
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
