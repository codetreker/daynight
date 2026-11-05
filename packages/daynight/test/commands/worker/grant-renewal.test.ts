import * as timers from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { controllerCredentialNeedsRefresh, maintainControllerGrants, maintainWorkerControllerGrants } from "../../../src/commands/worker/backends/grant-renewal.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

vi.mock("node:timers/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const fixture = () => {
  vi.useFakeTimers(); const cancellation = new AbortController();
  vi.mocked(timers.setTimeout).mockImplementation((milliseconds, value, options) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(value); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  }));
  const task = { claimId: "claim", serverOrigin: "https://daynight.example", cleanup: null, webExecution: { executionId: "execution", launchId: "launch", controllerInstanceId: "instance", executionGeneration: "1", ticketPath: "/ticket", launchSubmission: "acknowledged" } } as unknown as LocalTask;
  const readTicket = vi.fn(async (_home: string, _launch: string) => ({ claimId: task.claimId, executionId: "execution", controllerInstanceId: "instance", executionGeneration: "1" } as ControllerLaunchTicket));
  const refreshGrant = vi.fn(async () => {}), onError = vi.fn();
  const store = { listUnfinishedTasks: vi.fn(() => [task]) };
  const run = () => maintainWorkerControllerGrants({ homeDirectory: "/home", serverOrigin: task.serverOrigin, store, launcher: { refreshGrant }, signal: cancellation.signal, onError, readTicket });
  return { cancellation, task, store, refreshGrant, onError, readTicket, run };
};

it("renews independently across intervals longer than the fifteen-minute relay lifetime", async () => {
  const f = fixture(), running = f.run();
  await vi.advanceTimersByTimeAsync(0); expect(f.refreshGrant).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(16 * 60_000); expect(f.refreshGrant).toHaveBeenCalledTimes(33);
  f.cancellation.abort(); await running;
  const count = f.refreshGrant.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
  expect(f.refreshGrant).toHaveBeenCalledTimes(count);
});

it("retries renewal failure without replaying native work and suppresses repeated diagnostics", async () => {
  const f = fixture(); f.refreshGrant.mockRejectedValue(new Error("grant unavailable")); const running = f.run();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.refreshGrant).toHaveBeenCalledTimes(4); expect(f.onError).toHaveBeenCalledOnce();
  f.refreshGrant.mockResolvedValue(); await vi.advanceTimersByTimeAsync(30_000);
  f.cancellation.abort(); await running;
});

it("does not renew another origin, or an unsubmitted launch", async () => {
  const f = fixture();
  f.store.listUnfinishedTasks.mockReturnValue([
    { ...f.task, serverOrigin: "https://other.example" },
    { ...f.task, webExecution: { ...f.task.webExecution!, launchSubmission: "not-submitted" } },
  ]);
  const running = f.run(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.refreshGrant).not.toHaveBeenCalled(); expect(f.readTicket).not.toHaveBeenCalled();
  f.cancellation.abort(); await running;
});

it("keeps grant maintenance eligible while cooperative cleanup observes a live controller", async () => {
  const f = fixture();
  f.task.cleanup = { kind: "terminal", startedAt: 1, deadline: 600_001 };
  const running = f.run(); await vi.advanceTimersByTimeAsync(0);
  expect(f.refreshGrant).toHaveBeenCalledOnce();
  f.cancellation.abort(); await running;
});

it("rejects a stale-generation ticket before asking for a grant", async () => {
  const f = fixture(); f.readTicket.mockResolvedValue({ claimId: f.task.claimId, executionId: "execution", controllerInstanceId: "old-instance", executionGeneration: "0" } as ControllerLaunchTicket);
  const running = f.run(); await vi.advanceTimersByTimeAsync(0);
  expect(f.refreshGrant).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenCalledWith(expect.stringContaining("conflicting"));
  f.cancellation.abort(); await running;
});

it("renews another execution without waiting for a slow grant request", async () => {
  const f = fixture(), second = { ...f.task, claimId: "second", webExecution: { ...f.task.webExecution!, executionId: "second" } };
  f.store.listUnfinishedTasks.mockReturnValue([f.task, second]);
  second.webExecution.launchId = "second-launch";
  f.readTicket.mockImplementation(async (_home, launch) => ({ claimId: launch === "second-launch" ? "second" : "claim", executionId: launch === "second-launch" ? "second" : "execution", controllerInstanceId: "instance", executionGeneration: "1" } as ControllerLaunchTicket));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.refreshGrant.mockImplementationOnce(() => blocked);
  const running = f.run();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.refreshGrant).toHaveBeenCalledTimes(2);
  } finally { release(); f.cancellation.abort(); await running; }
});

it("cancels the native timer before the renewal task finishes", async () => {
  const f = fixture(); vi.useRealTimers();
  const original = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  vi.mocked(timers.setTimeout).mockImplementation(original.setTimeout);
  const running = f.run();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(timers.setTimeout).toHaveBeenCalledWith(30_000, undefined, { signal: f.cancellation.signal });
  f.cancellation.abort();
  await running;
  expect(f.refreshGrant).toHaveBeenCalledOnce();
});


it("isolates grant failures by execution while healthy executions continue each cycle", async () => {
  const f = fixture(), refreshed: string[] = [], diagnostics: string[] = [];
  const running = maintainControllerGrants({
    list: () => ["broken", "healthy"], key: execution => execution, signal: f.cancellation.signal,
    refresh: async execution => { if (execution === "broken") throw new Error("denied"); refreshed.push(execution); },
    onError: message => { diagnostics.push(message); },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refreshed).toEqual(["healthy", "healthy", "healthy"]); expect(diagnostics).toEqual(["denied"]);
  f.cancellation.abort(); await running;
});

it("requires a readable valid credential and renews at the two-minute boundary", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/grant-renewal"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "h-")), file = path.join(directory, "credential.json");
  try {
    await expect(controllerCredentialNeedsRefresh(file, 0)).rejects.toThrow("unavailable");
    await writeFile(file, JSON.stringify({ expiresAt: "invalid" }));
    await expect(controllerCredentialNeedsRefresh(file, 0)).rejects.toThrow("invalid");
    await writeFile(file, JSON.stringify({ expiresAt: new Date(120_001).toISOString() }));
    expect(await controllerCredentialNeedsRefresh(file, 0)).toBe(false);
    expect(await controllerCredentialNeedsRefresh(file, 1)).toBe(true);
    expect(await controllerCredentialNeedsRefresh(file, 120_002)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps each healthy execution on its cadence while one renewal remains in flight, then joins on cancellation", async () => {
  const f = fixture(), renewed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const running = maintainControllerGrants({
    list: () => ["slow", "healthy"], key: execution => execution, signal: f.cancellation.signal,
    refresh: async execution => { renewed.push(execution); if (execution === "slow") await slow; },
    onError: f.onError,
  });
  let finished = false;
  void running.then(() => { finished = true; });
  try {
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renewed.filter(key => key === "slow")).toHaveLength(1);
    expect(renewed.filter(key => key === "healthy")).toHaveLength(4);
    f.cancellation.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
  } finally { f.cancellation.abort(); release(); await running; }
  expect(finished).toBe(true);
  expect(renewed.filter(key => key === "slow")).toHaveLength(1);
});
