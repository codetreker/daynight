import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchingWatchdogRule, matchWatchdogRegex } from "../../../../src/commands/worker/bots/apps/watchdog-rules.js";

const { workers } = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, value: unknown) => boolean;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      terminate = vi.fn(async () => 0);
      constructor() {
        super();
        workers.push(this);
      }
    },
  };
});

describe("Watchdog regex worker lifecycle", () => {
  beforeEach(() => { workers.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps startup separate from the 250 ms matching budget", async () => {
    const result = matchWatchdogRegex("^a\\{01\\}$", "a{01}", new AbortController().signal);
    const worker = workers[0]!;
    await vi.advanceTimersByTimeAsync(400);
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit("message", "ready");
    expect(worker.postMessage).toHaveBeenCalledWith({ source: "^a\\{01\\}(?![\\s\\S])", text: "a{01}" });
    await vi.advanceTimersByTimeAsync(249);
    worker.emit("message", true);
    await expect(result).resolves.toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("refuses a match after 250 ms of execution and terminates the worker", async () => {
    const rules = [{ id: "bounded", category: "stalled", match: { regex: "^(a+)+$" }, action: { kind: "send_message", message: "Continue." } }];
    const result = matchingWatchdogRule(rules, "project", "a", new AbortController().signal);
    const worker = workers[0]!;
    worker.emit("message", "ready");
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("exposes an exit after readiness without authorizing a rule", async () => {
    const rules = [{ id: "rule", category: "stalled", match: { regex: "a" }, action: { kind: "send_message", message: "Continue." } }];
    const result = matchingWatchdogRule(rules, "project", "a", new AbortController().signal);
    const assertion = expect(result).rejects.toThrow("Watchdog regex worker exited before returning a result (code 1).");
    const worker = workers[0]!;
    worker.emit("message", "ready");
    worker.emit("exit", 1);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("exposes startup timeout and premature exit and terminates each worker", async () => {
    const startup = matchWatchdogRegex("a", "a", new AbortController().signal);
    const startupAssertion = expect(startup).rejects.toThrow("Watchdog regex worker startup timed out.");
    await vi.advanceTimersByTimeAsync(5_000);
    await startupAssertion;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();

    const exit = matchWatchdogRegex("a", "a", new AbortController().signal);
    const exitAssertion = expect(exit).rejects.toThrow("Watchdog regex worker exited before returning a result (code 0).");
    workers[1]!.emit("exit", 0);
    await exitAssertion;
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });

  it.each(["starting", "matching"])("propagates cancellation while %s and terminates the worker", async stage => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const result = matchWatchdogRegex("a", "a", controller.signal);
    const assertion = expect(result).rejects.toBe(reason);
    const worker = workers[0]!;
    if (stage === "matching") worker.emit("message", "ready");
    controller.abort(reason);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("ignores late readiness while cancellation waits for termination", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const result = matchWatchdogRegex("a", "a", controller.signal);
    const assertion = expect(result).rejects.toBe(reason);
    const worker = workers[0]!;
    let finishTermination!: (value: number) => void;
    worker.terminate.mockImplementationOnce(() => new Promise<number>(resolve => { finishTermination = resolve; }));
    controller.abort(reason);
    await Promise.resolve();
    worker.emit("message", "ready");
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    finishTermination(0);
    await assertion;
  });
});
