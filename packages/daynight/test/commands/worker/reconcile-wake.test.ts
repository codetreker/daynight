import { describe, expect, it } from "vitest";
import { createReconcileWake } from "../../../src/commands/worker/reconcile-wake.js";

describe("reconciliation wake", () => {
  it("preserves and coalesces notifications during a round and wakes an existing wait", async () => {
    const wake = createReconcileWake(), signal = new AbortController().signal;
    const revision = wake.snapshot();
    wake.request(); wake.request();
    await wake.waitAfter(revision, 60_000, signal);
    const next = wake.snapshot();
    let completed = false;
    const waiting = wake.waitAfter(next, 60_000, signal).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    wake.request();
    await waiting;
    expect(completed).toBe(true);
    wake.close();
  });

  it("propagates root cancellation and closes an outstanding wait", async () => {
    const wake = createReconcileWake(), controller = new AbortController();
    const waiting = wake.waitAfter(wake.snapshot(), 60_000, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    const closing = wake.waitAfter(wake.snapshot(), 60_000, new AbortController().signal);
    wake.close();
    await closing;
    const revision = wake.snapshot();
    wake.request();
    expect(wake.snapshot()).toBe(revision);
  });
});
