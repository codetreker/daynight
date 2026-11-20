import { describe, expect, it } from "vitest";
import { createExecutionScopeManager } from "../../../src/commands/worker/execution-scope.js";

describe("Worker execution scopes", () => {
  it("joins two generations while retaining the management signal and replacing cancelled objects", async () => {
    const root = new AbortController();
    const manager = createExecutionScopeManager(root.signal);
    const signals: AbortSignal[] = [];
    const runtimes: object[] = [];
    for (let round = 0; round < 2; round++) {
      const scope = manager.create();
      const runtime = { closed: false };
      runtimes.push(runtime); signals.push(scope.signal);
      scope.register({ resourceId: "task", ownerKind: "task", stop: async () => { runtime.closed = true; } });
      expect(scope.generation).toBe(String(round + 1));
      expect(scope.signal.aborted).toBe(false);
      expect(await scope.stop()).toEqual([expect.objectContaining({ stop: "confirmed", save: "durable" })]);
      expect(runtime.closed).toBe(true);
      expect(root.signal.aborted).toBe(false);
    }
    expect(signals[0]).not.toBe(signals[1]);
    expect(runtimes[0]).not.toBe(runtimes[1]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("attempts every owner and retains failed responsibility instead of admitting a replacement", async () => {
    const manager = createExecutionScopeManager(new AbortController().signal);
    const scope = manager.create();
    const attempted: string[] = [];
    scope.register({ resourceId: "probe", ownerKind: "probe", stop: async () => { attempted.push("probe"); throw new Error("lease unknown"); } });
    scope.register({ resourceId: "bot", ownerKind: "bot", stop: async () => { attempted.push("bot"); } });
    const results = await scope.stop();
    expect(attempted).toEqual(["probe", "bot"]);
    expect(results.map(result => result.stop)).toEqual(["unknown", "confirmed"]);
    expect(scope.snapshot().resources[0]?.result?.error).toBeInstanceOf(Error);
    expect(() => manager.create()).toThrow("unconfirmed resources");
    expect(await scope.stop()).toBe(results);
  });

  it("bounds an uncooperative owner without treating a late join as permission to rebuild", async () => {
    const root = new AbortController();
    const manager = createExecutionScopeManager(root.signal);
    const scope = manager.create();
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    scope.register({ resourceId: "repository", ownerKind: "repository", stop: () => work });
    try {
      const stopping = scope.stop({ deadline: Date.now() });
      expect(() => manager.create()).toThrow("unconfirmed resources");
      expect((await stopping)[0]?.stop).toBe("unknown");
      finish(); await work;
      expect(() => manager.create()).toThrow("unconfirmed resources");
      expect(root.signal.aborted).toBe(false);
    } finally { finish(); }
  });

  it("closes every admission callback even if one closure fails", async () => {
    const manager = createExecutionScopeManager(new AbortController().signal);
    const scope = manager.create();
    let otherClosed = false;
    scope.register({ resourceId: "configuration", ownerKind: "configuration", closeAdmission: () => { throw new Error("close failed"); }, stop: async () => {} });
    scope.register({ resourceId: "tasks", ownerKind: "task", closeAdmission: () => { otherClosed = true; }, stop: async () => {} });
    scope.closeAdmission();
    expect(otherClosed).toBe(true);
    expect((await scope.stop()).at(-1)?.resourceId).toBe("admission");
    expect(() => manager.create()).toThrow("unconfirmed resources");
  });

  it("joins the original timed-out attempt before permitting a replacement scope", async () => {
    const manager = createExecutionScopeManager(new AbortController().signal);
    const scope = manager.create();
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    let attempts = 0;
    scope.register({ resourceId: "writer", ownerKind: "configuration", stop: () => {
      attempts++;
      return attempts === 1 ? work : Promise.resolve();
    } });
    try {
      expect((await scope.stop({ deadline: Date.now() }))[0]?.stop).toBe("unknown");
      expect((await scope.reconcile({ deadline: Date.now() }))[0]?.stop).toBe("unknown");
      expect(attempts).toBe(1);
      expect(() => manager.create()).toThrow("unconfirmed resources");
      finish();
      expect((await scope.reconcile())[0]?.stop).toBe("confirmed");
      expect(attempts).toBe(1);
      expect(manager.create().signal.aborted).toBe(false);
    } finally { finish(); await work; }
  });

  it("re-observes only retained owners without repeating completed cleanup", async () => {
    const manager = createExecutionScopeManager(new AbortController().signal);
    const scope = manager.create();
    let known = false, stableStops = 0;
    scope.register({ resourceId: "stable", ownerKind: "task", stop: async () => { stableStops++; } });
    scope.register({ resourceId: "retained", ownerKind: "probe", stop: async () => { if (!known) throw new Error("boundary still occupied"); } });
    expect((await scope.stop())[1]?.stop).toBe("unknown");
    known = true;
    expect((await scope.reconcile()).every(result => result.stop === "confirmed")).toBe(true);
    expect(stableStops).toBe(1);
    expect(manager.create().signal.aborted).toBe(false);
  });
});
