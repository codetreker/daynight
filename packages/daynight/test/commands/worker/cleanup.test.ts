import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrOwnedWorkspace, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { Operation } from "../../../src/api/operation.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: { directory: string; store: WorkerStore }[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const { directory, store } of roots.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-cleanup-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "cleanup-"));
  const store = openWorkerStore(path.join(directory, "state.sqlite")); roots.push({ directory, store });
  const project = store.registerProject({ projectId: uuid(1), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(directory, "repo") });
  const owner: ResourceOwner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const task = store.activateTask(store.registerPending({ ...owner, agent: "codex" }));
  const binding = { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" };
  const observation = (status: string, stateChangeSeq: number | null, completionSeq: number | null, interactiveReady = true): HerdrAgentObservation => ({ binding, kind: "codex", name: "managed", status, launchPending: false, interactiveReady, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(5) }, stateChangeSeq, completionSeq });
  const resources = (current: HerdrAgentObservation): HerdrOwnedWorkspace[] => [{ owner, workspaceId: binding.workspaceId, panes: [{ ...current, kind: "codex", cwd: path.join(project.localPath, ".worktrees", "daynight", task.taskId) }] }];
  const order: string[] = [];
  const events: WorkerEvent[] = [];
  const submitPrompt = vi.fn<WorkerHerdrAdapter["tasks"]["submitPrompt"]>(async () => ({ submission: "submitted" as const, observation: observation("idle", 11, 5) }));
  const stopAndClose = vi.fn<WorkerHerdrAdapter["tasks"]["stopAndClose"]>(async () => { order.push("stop-close"); });
  const removeWorktree = vi.fn<WorkerGitManager["removeWorktree"]>(async () => { expect(stopAndClose).toHaveBeenCalledOnce(); order.push("delete"); });
  const herdr = { tasks: { pendingStops: vi.fn(() => []), submitPrompt, stopAndClose } } as unknown as WorkerHerdrAdapter;
  const git = { removeWorktree } as unknown as WorkerGitManager;
  let time = 1_000;
  const deps: Parameters<typeof createCleanupDriver>[0] = { store, git, herdr, platform: "linux", serverOrigin: "https://daynight.example", workerId: uuid(6), buildPrompt: () => "managed", emit: (event) => events.push(event), now: () => time };
  const driver = createCleanupDriver(deps);
  const advance = (current: HerdrAgentObservation) => driver.advance({ owner, project, task }, resources(current), true);
  return { store, task, owner, driver, advance, observation, submitPrompt, stopAndClose, removeWorktree, order, events, clock: (value: number) => { time = value; } };
};

describe("cleanup polling after notification", () => {
  it("waits for a later patrol even when the pre-submit snapshot was already idle", async () => {
    const f = fixture();
    expect(await f.advance(f.observation("idle", 11, 5))).toBe(false);
    expect(f.stopAndClose).not.toHaveBeenCalled(); expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(await f.advance(f.observation("idle", 11, 5))).toBe(true);
    expect(f.submitPrompt).toHaveBeenCalledOnce();
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("closes on a later idle patrol after sending the cleanup prompt to a working agent", async () => {
    const f = fixture();
    f.submitPrompt.mockResolvedValueOnce({ submission: "submitted", observation: f.observation("working", 11, 5) });
    expect(await f.advance(f.observation("working", 10, 4))).toBe(false);
    expect(await f.advance(f.observation("working", 12, 5))).toBe(false);
    expect(f.stopAndClose).not.toHaveBeenCalled();
    expect(await f.advance(f.observation("idle", 13, 6))).toBe(true);
    expect(f.submitPrompt).toHaveBeenCalledOnce(); expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it.each(["working", "blocked", "unknown", "done"])("keeps the original deadline while status remains %s", async (status) => {
    const f = fixture();
    expect(await f.advance(f.observation(status, 10, 4))).toBe(false);
    f.clock(301_000);
    expect(await f.advance(f.observation(status, 11, 5))).toBe(false);
    expect(f.driver.remaining(f.owner)).toBe(300_000);
    f.clock(600_999);
    expect(await f.advance(f.observation(status, 12, 6))).toBe(false);
    expect(f.driver.remaining(f.owner)).toBe(1); expect(f.stopAndClose).not.toHaveBeenCalled();
    f.clock(601_000);
    expect(await f.advance(f.observation(status, 13, 7))).toBe(true);
    expect(f.submitPrompt).toHaveBeenCalledOnce(); expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it.each(["unknown", "rejected"] as const)("keeps the deadline and does not replay a %s notification", async (submission) => {
    const f = fixture(); const failed = new HerdrAgentActionError("Notification failed", "agent.prompt", submission);
    f.submitPrompt.mockRejectedValueOnce(failed);
    expect(await f.advance(f.observation("working", 10, 4))).toBe(false);
    expect(await f.advance(f.observation("idle", 11, 5))).toBe(false);
    expect(f.stopAndClose).not.toHaveBeenCalled(); expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-notification-error", error: failed }));
    f.clock(601_000);
    expect(await f.advance(f.observation("idle", 11, 5))).toBe(true);
    expect(f.submitPrompt).toHaveBeenCalledOnce();
  });

  it.each([[null, 5], [11, null], [null, null]])("closes on later idle without requiring sequence counters %s/%s or input readiness", async (stateChangeSeq, completionSeq) => {
    const f = fixture();
    f.submitPrompt.mockResolvedValueOnce({ submission: "submitted", observation: f.observation("working", stateChangeSeq, completionSeq, false) });
    expect(await f.advance(f.observation("working", 10, 4))).toBe(false);
    expect(await f.advance(f.observation("idle", stateChangeSeq, completionSeq, false))).toBe(true);
    expect(f.order).toEqual(["stop-close", "delete"]);
    expect(Object.keys(f.store.getTask(f.task)!).sort()).toEqual(["agent", "agentControlMode", "claimId", "projectId", "sessionId", "status", "taskId"]);
  });

  it("stops an already inactive pane without sending a cleanup prompt", async () => {
    const f = fixture();
    const pane = { ...f.observation("idle", null, null, false), kind: null };
    const resources: HerdrOwnedWorkspace[] = [{ owner: f.owner, workspaceId: pane.binding.workspaceId, panes: [{ ...pane, cwd: null }] }];
    expect(await f.driver.advance({ owner: f.owner, project: f.store.getProject(f.owner)!, task: f.task }, resources, true)).toBe(true);
    expect(f.submitPrompt).not.toHaveBeenCalled(); expect(f.order).toEqual(["stop-close", "delete"]);
  });
});

const cleanupClock = () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return async (milliseconds: number): Promise<void> => { now += milliseconds; await vi.advanceTimersByTimeAsync(milliseconds); };
};
const waitForCleanup = (operation: Operation, milliseconds: number): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { operation.signal.removeEventListener("abort", cancel); operation.check(); resolve(); }, milliseconds);
  const cancel = (): void => { clearTimeout(timer); reject(operation.signal.reason); };
  operation.signal.addEventListener("abort", cancel, { once: true });
});

describe("cleanup operation budgets", () => {
  it("allows four minutes each for stopping and deletion without shortening the ten-minute agent grace", async () => {
    const f = fixture();
    const advanceTime = cleanupClock();
    f.submitPrompt.mockImplementationOnce(async (_context, _binding, _prompt, operation) => {
      expect(operation.limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 });
      await waitForCleanup(operation, 240_000);
      return { submission: "submitted", observation: f.observation("working", 10, 4) };
    });
    const notification = f.advance(f.observation("working", 10, 4));
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(240_000);
    expect(await notification).toBe(false);
    f.clock(241_000);
    expect(f.driver.remaining(f.owner)).toBe(360_000);
    f.stopAndClose.mockImplementationOnce(async (_context, _binding, operation) => { await waitForCleanup(operation, 240_000); f.order.push("stop-close"); });
    f.removeWorktree.mockImplementationOnce(async (_project, _owner, operation) => { await waitForCleanup(operation, 240_000); f.order.push("delete"); });
    const completion = f.advance(f.observation("idle", 11, 5));
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(240_000);
    expect(f.removeWorktree).toHaveBeenCalledOnce();
    await advanceTime(240_000);
    expect(await completion).toBe(true);
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("retains cleanup responsibility at the five-minute deletion deadline and retries from the existing attempt", async () => {
    const f = fixture();
    const advanceTime = cleanupClock();
    await f.advance(f.observation("working", 10, 4));
    f.removeWorktree.mockImplementationOnce(async (_project, _owner, operation) => waitForCleanup(operation, 300_001));
    const result = f.advance(f.observation("idle", 11, 5)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(299_999);
    expect(f.events.some(event => event.kind === "cleaned")).toBe(false);
    await advanceTime(1);
    expect(await result).toMatchObject({ stage: "worktree-removal", cause: { name: "OperationError", kind: "deadline" } });
    expect(f.store.getTask(f.task)?.status).toBe("active");
    f.clock(301_000);
    expect(f.driver.remaining(f.owner)).toBe(300_000);
    f.removeWorktree.mockImplementationOnce(async () => { f.order.push("delete"); });
    expect(await f.driver.advance({ owner: f.owner, project: f.store.getProject(f.owner)!, task: f.task }, [], true)).toBe(true);
    expect(f.submitPrompt).toHaveBeenCalledOnce();
  });

  it("cancels the five-minute stop operation without deleting its worktree", async () => {
    const f = fixture();
    const advanceTime = cleanupClock();
    await f.advance(f.observation("working", 10, 4));
    f.stopAndClose.mockImplementationOnce(async (_context, _binding, operation) => waitForCleanup(operation, 300_001));
    const controller = new AbortController();
    const result = f.driver.advance({ owner: f.owner, project: f.store.getProject(f.owner)!, task: f.task }, [{ owner: f.owner, workspaceId: "workspace", panes: [{ ...f.observation("idle", 11, 5), kind: "codex", cwd: null }] }], true, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(181_000);
    controller.abort(new Error("stop requested"));
    expect(await result).toMatchObject({ stage: "agent-stop", cause: { kind: "cancelled", cause: controller.signal.reason } });
    expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.events.some(event => event.kind === "cleaned")).toBe(false);
  });
});
