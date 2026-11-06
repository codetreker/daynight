import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import type { ReviewState } from "../../../src/commands/review/model.js";

const native = vi.hoisted(() => ({ stop: vi.fn<() => Promise<void>>() }));
vi.mock("../../../src/commands/review/windows-process-stop.js", () => ({ stopWindowsProcessTree: native.stop }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers(); native.stop.mockReset();
});
const attempt = { reviewId: "review", attempt: 1 };
const review = { id: "review", attemptCount: 1 } as ReviewState;
const fixture = () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const supervisor = createProcessSupervisor({ graceMs: 100 });
  supervisor.onProcess(child, attempt);
  let settled = false;
  const stop = () => supervisor.stop(child, attempt).then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  return { child, supervisor, stop, get settled() { return settled; } };
};
const causes = (error: unknown): unknown[] => [error,
  ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
  ...(error instanceof Error && error.cause !== undefined ? causes(error.cause) : [])];

describe("Windows supervisor direct closure after native failure", () => {
  it("joins the original close event after native observation rejects, preserving unsafe exclusion", async () => {
    const f = fixture(), nativeFailure = new Error("Native root already signaled before Node close");
    native.stop.mockRejectedValue(nativeFailure);
    const stopped = f.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.stop).toHaveBeenCalledOnce();
    expect(f.settled).toBe(false);
    expect(f.supervisor.safeToReleaseLock).toBe(false);
    f.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(25);
    const result = await stopped;
    expect(causes(result)).toContain(nativeFailure);
    expect(f.supervisor.safeToReleaseLock).toBe(false);
    await expect(f.supervisor.exclude(review)).rejects.toBe(result);
  });

  it("preserves both native failure and a bounded direct-close timeout", async () => {
    const f = fixture(), nativeFailure = new Error("Native wait failed");
    native.stop.mockRejectedValue(nativeFailure);
    const stopped = f.stop();
    await vi.advanceTimersByTimeAsync(100);
    const result = await stopped, errors = causes(result);
    expect(errors).toContain(nativeFailure);
    expect(errors.some(error => error instanceof Error && error.message.includes("did not close its process and streams"))).toBe(true);
    expect(f.settled).toBe(true);
    expect(f.supervisor.safeToReleaseLock).toBe(false);
    await expect(f.supervisor.exclude(review)).rejects.toBe(result);
  });

  it("still requires direct closure after native confirmation succeeds", async () => {
    const f = fixture(); native.stop.mockResolvedValue(undefined);
    const stopped = f.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.settled).toBe(false);
    f.child.emit("close", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    expect(await stopped).toBeUndefined();
    expect(f.supervisor.safeToReleaseLock).toBe(true);
    await expect(f.supervisor.exclude(review)).resolves.toEqual({ processesExcluded: true });
  });
});
