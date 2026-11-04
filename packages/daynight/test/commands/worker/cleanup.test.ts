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

const wait = vi.hoisted(() => vi.fn(async (_milliseconds: number, _value?: unknown, options?: { signal?: AbortSignal }) => { options?.signal?.throwIfAborted(); }));
vi.mock("node:timers/promises", () => ({ setTimeout: wait }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: { directory: string; store: WorkerStore }[] = [];
afterEach(() => {
  wait.mockReset();
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const { directory, store } of roots.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-cleanup-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "cleanup-"));
  const store = openWorkerStore(path.join(directory, "state.sqlite"), { onMigration: () => {} }); roots.push({ directory, store });
  const project = store.registerProject({ projectId: uuid(1), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(directory, "repo") });
  const owner: ResourceOwner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const task = store.activateTask(store.registerPending({ ...owner, agent: "codex" }));
  const binding = { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" };
  const observation = (status: string): HerdrAgentObservation => ({ binding, kind: "codex", name: "managed", status, launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(5) }, stateChangeSeq: null, completionSeq: null });
  const resources = (current: HerdrAgentObservation): HerdrOwnedWorkspace[] => [{ owner, workspaceId: binding.workspaceId, panes: [{ ...current, kind: "codex", cwd: path.join(project.localPath, ".worktrees", "daynight", task.taskId) }] }];
  let current = resources(observation("idle"));
  let worktree = true;
  const order: string[] = [];
  const events: WorkerEvent[] = [];
  const listResources = vi.fn<WorkerHerdrAdapter["tasks"]["listResources"]>(async () => current);
  const submitPrompt = vi.fn<WorkerHerdrAdapter["tasks"]["submitPrompt"]>(async () => ({ submission: "submitted" as const, observation: observation("idle") }));
  const stopAndClose = vi.fn<WorkerHerdrAdapter["tasks"]["stopAndClose"]>(async () => { order.push("stop-close"); current = []; });
  const removeWorktree = vi.fn<WorkerGitManager["removeWorktree"]>(async () => { expect(current).toEqual([]); order.push("delete"); worktree = false; });
  const findWorktree = vi.fn(async () => worktree ? { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", task.taskId), branch: `daynight/${task.taskId}` } : null);
  const pendingStops = vi.fn(() => []);
  const herdr = { tasks: { pendingStops, listResources, submitPrompt, stopAndClose } } as unknown as WorkerHerdrAdapter;
  const git = { removeWorktree, findWorktree } as unknown as WorkerGitManager;
  let time = 1_000;
  const deps: Parameters<typeof createCleanupDriver>[0] = { store, git, herdr, platform: "linux", serverOrigin: "https://daynight.example", workerId: uuid(6), buildPrompt: () => "managed", emit: (event) => events.push(event), now: () => time };
  const driver = () => createCleanupDriver(deps);
  const advance = (deleteWorktree = true, signal?: AbortSignal) => driver().advance({ owner, project, task }, deleteWorktree, signal);
  return { store, task, owner, herdr, driver, advance, observation, resources, listResources, submitPrompt, stopAndClose, removeWorktree, findWorktree, order, events, clock: (value: number) => { time = value; }, state: (pane: HerdrAgentObservation | null) => { current = pane === null ? [] : resources(pane); } };
};

describe("cleanup from resource observations", () => {
  it.each([true, false])("requires durable stop proof without a pane and retains the worktree (terminal %s)", async terminal => {
    const f = fixture(); const reasons: string[] = []; let stopped = false;
    Object.assign(f.herdr, { lifecycle: { stop: async (_owner: ResourceOwner, reason: string, operation: Operation) => { expect(operation.limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 }); reasons.push(reason); stopped = true; }, isStopped: () => stopped } });
    f.state(null);
    await f.advance(terminal);
    expect(reasons).toEqual([terminal ? "terminal" : "shutdown"]);
    expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.stopAndClose).not.toHaveBeenCalled();
    expect(f.submitPrompt).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "agent-stopped" }));
  });

  it("does not treat an unconfirmed durable stop as permission to delete or finish", async () => {
    const f = fixture();
    Object.assign(f.herdr, { lifecycle: { stop: async () => {}, isStopped: () => false } });
    await expect(f.advance()).rejects.toThrow("not confirmed");
    expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.events.some(event => event.kind === "agent-stopped" || event.kind === "cleaned")).toBe(false);
  });

  it("reobserves after advisory input and confirms resources absent before worktree removal", async () => {

    const f = fixture();
    await f.advance();
    expect(f.submitPrompt).toHaveBeenCalledOnce();
    expect(f.listResources.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.order).toEqual(["stop-close", "delete"]);
    expect(f.findWorktree).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1000, undefined, {});
    expect(f.store.getCleanupSchedule(f.owner)).not.toHaveProperty("submitted");
    expect(f.store.getCleanupSchedule(f.owner)).not.toHaveProperty("notified");
  });

  it("cleans an already absent pane without requiring a previous stop operation", async () => {
    const f = fixture(); f.state(null);
    await f.advance();
    expect(f.submitPrompt).not.toHaveBeenCalled(); expect(f.stopAndClose).not.toHaveBeenCalled();
    expect(f.order).toEqual(["delete"]);
  });

  it("uses the observation after input when a working agent becomes idle", async () => {
    const f = fixture(); f.state(f.observation("working"));
    f.submitPrompt.mockImplementationOnce(async () => { f.state(f.observation("idle")); return { submission: "submitted", observation: f.observation("working") }; });
    await f.advance();
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it.each(["working", "blocked", "unknown", "done"])("stops a remaining %s agent once its original deadline expires", async status => {
    const f = fixture(); f.state(f.observation(status));
    f.submitPrompt.mockImplementationOnce(async () => { f.clock(601_000); return { submission: "submitted", observation: f.observation(status) }; });
    await f.advance();
    expect(f.store.getCleanupSchedule(f.owner)?.deadline).toBe(601_000);
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("polls changing resource state through the original bounded deadline", async () => {
    const f = fixture(); f.state(f.observation("working"));
    wait.mockImplementationOnce(async () => { f.clock(2000); }).mockImplementationOnce(async () => { f.state(f.observation("idle")); });
    await f.advance();
    expect(wait).toHaveBeenCalledTimes(2);
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("reconciles a lost close response through actual resource absence", async () => {
    const f = fixture();
    f.stopAndClose.mockImplementationOnce(async () => { f.state(null); throw new Error("Lost close response"); });
    await f.advance();
    expect(f.removeWorktree).toHaveBeenCalledOnce();
  });

  it("retains a genuinely remaining pane and retries it after recreating the driver", async () => {
    const f = fixture();
    f.stopAndClose.mockImplementationOnce(async () => { throw new Error("Close failed"); });
    await expect(f.advance()).rejects.toThrow("Close failed");
    expect(f.removeWorktree).not.toHaveBeenCalled();
    await f.advance();
    expect(f.submitPrompt).toHaveBeenCalledTimes(2);
    expect(f.store.getCleanupSchedule(f.owner)?.deadline).toBe(601_000);
    expect(f.removeWorktree).toHaveBeenCalledOnce();
  });

  it.each(["unknown", "rejected"] as const)("does not interpret a %s notification as resource state", async submission => {
    const f = fixture(), failed = new HerdrAgentActionError("Notification failed", "agent.prompt", submission);
    f.submitPrompt.mockRejectedValueOnce(failed);
    await f.advance();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-notification-error", error: failed }));
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("refuses worktree removal when a close acknowledgement leaves the pane present", async () => {
    const f = fixture(); f.stopAndClose.mockImplementationOnce(async () => {});
    await expect(f.advance()).rejects.toThrow("pane still exists");
    expect(f.removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses completion when Git acknowledges removal but the worktree remains", async () => {
    const f = fixture(); f.removeWorktree.mockImplementationOnce(async () => {});
    await expect(f.advance()).rejects.toThrow("worktree resources still exist");
  });

  it("observes a reappearing original resource after a previous successful cleanup", async () => {
    const f = fixture(); await f.advance(); f.state(f.observation("idle"));
    await f.advance();
    expect(f.stopAndClose).toHaveBeenCalledTimes(2);
  });

  it("preserves Git resources for execution-only shutdown", async () => {
    const f = fixture(); await f.advance(false);
    expect(f.stopAndClose).toHaveBeenCalledOnce(); expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.findWorktree).not.toHaveBeenCalled();
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
    f.state(f.observation("working"));
    f.submitPrompt.mockImplementationOnce(async (_context, _binding, _prompt, operation) => {
      expect(operation.limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 });
      await waitForCleanup(operation, 240_000);
      f.clock(241_000); f.state(f.observation("idle"));
      return { submission: "submitted", observation: f.observation("working") };
    });
    const stop = f.stopAndClose.getMockImplementation()!;
    f.stopAndClose.mockImplementationOnce(async (...args) => {
      expect(args[2].limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 });
      await waitForCleanup(args[2], 240_000); f.clock(481_000); await stop(...args);
    });
    const remove = f.removeWorktree.getMockImplementation()!;
    f.removeWorktree.mockImplementationOnce(async (...args) => {
      expect(args[2].limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 });
      await waitForCleanup(args[2], 240_000); f.clock(721_000); await remove(...args);
    });
    const completion = f.advance();
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(240_000);
    expect(f.store.getCleanupSchedule(f.owner)?.deadline).toBe(601_000);
    expect(f.stopAndClose).toHaveBeenCalledOnce(); expect(f.removeWorktree).not.toHaveBeenCalled();
    await advanceTime(240_000);
    expect(f.removeWorktree).toHaveBeenCalledOnce();
    await advanceTime(240_000);
    expect(await completion).toBeUndefined();
    expect(f.order).toEqual(["stop-close", "delete"]);
    expect(f.findWorktree).toHaveBeenCalledOnce();
  });

  it("retains cleanup responsibility at the five-minute deletion deadline and retries from the existing attempt", async () => {
    const f = fixture();
    const advanceTime = cleanupClock();
    f.removeWorktree.mockImplementationOnce(async (_project, _owner, operation) => waitForCleanup(operation, 300_001));
    const result = f.advance().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(299_999);
    expect(f.events.some(event => event.kind === "cleaned")).toBe(false);
    await advanceTime(1);
    expect(await result).toMatchObject({ stage: "worktree-removal", cause: { name: "OperationError", kind: "deadline" } });
    expect(f.store.getTask(f.task)?.status).toBe("active");
    f.clock(301_000);
    expect(f.store.getCleanupSchedule(f.owner)?.deadline).toBe(601_000);
    expect(await f.advance()).toBeUndefined();
    expect(f.submitPrompt).toHaveBeenCalledOnce();
    expect(f.findWorktree).toHaveBeenCalledOnce();
    expect(f.order).toEqual(["stop-close", "delete"]);
  });

  it("cancels the five-minute stop operation without deleting its worktree", async () => {
    const f = fixture();
    const advanceTime = cleanupClock();
    f.stopAndClose.mockImplementationOnce(async (_context, _binding, operation) => waitForCleanup(operation, 300_001));
    const controller = new AbortController();
    const result = f.advance(true, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await advanceTime(181_000);
    controller.abort(new Error("stop requested"));
    expect(await result).toMatchObject({ stage: "agent-stop", cause: controller.signal.reason });
    expect(f.removeWorktree).not.toHaveBeenCalled();
    expect(f.events.some(event => event.kind === "cleaned")).toBe(false);
  });
});
