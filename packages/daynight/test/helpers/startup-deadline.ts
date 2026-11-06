import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setImmediate, setTimeout as delay } from "node:timers/promises";

const startupTimeoutMs = 30_000;

export const stopStartupChildren = async (children: readonly ChildProcess[]): Promise<void> => {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let timer: NodeJS.Timeout;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native startup fixture did not stop after SIGKILL.")), 5_000);
        child.once("close", () => resolve());
        child.kill("SIGKILL");
      });
    } finally { clearTimeout(timer!); }
  }));
};

export const captureStartupDeadline = () => {
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  const pending = new Map<NodeJS.Timeout, () => void>();
  const capturedSchedule = ((callback: (...args: unknown[]) => void, milliseconds: number | undefined, ...args: unknown[]) => {
    if (milliseconds !== startupTimeoutMs) return schedule(callback, milliseconds, ...args);
    const timer = schedule(() => {
      pending.delete(timer);
      callback(...args);
    }, milliseconds);
    pending.set(timer, () => callback(...args));
    return timer;
  }) as typeof globalThis.setTimeout;
  const capturedCancel: typeof globalThis.clearTimeout = timer => {
    if (typeof timer === "object" && timer !== null) pending.delete(timer);
    cancel(timer);
  };
  globalThis.setTimeout = capturedSchedule;
  globalThis.clearTimeout = capturedCancel;

  return {
    expireAfterRequest: async (log: string, received: (requests: string[]) => boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (true) {
        let requests: string[];
        try { requests = (await readFile(log, "utf8")).trim().split("\n"); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          requests = [];
        }
        if (received(requests)) break;
        assert.ok(Date.now() < deadline, "Native fixture did not receive its startup request.");
        await delay(5);
      }
      assert.equal(pending.size, 1, "Expected one pending 30000 ms startup deadline after native request receipt.");
      const [timer, callback] = pending.entries().next().value!;
      pending.delete(timer);
      cancel(timer);
      // The native request must reach real I/O before its own deadline expires.
      await setImmediate();
      callback();
    },
    restore: (): void => {
      const currentSchedule = globalThis.setTimeout, currentCancel = globalThis.clearTimeout;
      globalThis.setTimeout = schedule;
      globalThis.clearTimeout = cancel;
      assert.equal(currentSchedule, capturedSchedule);
      assert.equal(currentCancel, capturedCancel);
    },
  };
};
