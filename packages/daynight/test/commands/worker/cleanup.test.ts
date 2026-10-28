import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { ExecutionDependencies, WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrOwnedWorkspace, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: { directory: string; store: WorkerStore }[] = [];
afterEach(() => {
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
  const submitPrompt = vi.fn(async () => ({ submission: "submitted" as const, observation: observation("idle", 11, 5) }));
  const stopAndClose = vi.fn(async () => { order.push("stop-close"); });
  const removeWorktree = vi.fn(async () => { expect(stopAndClose).toHaveBeenCalledOnce(); order.push("delete"); });
  const herdr = { tasks: { pendingStops: vi.fn(() => []), submitPrompt, stopAndClose } } as unknown as WorkerHerdrAdapter;
  const git = { removeWorktree } as unknown as WorkerGitManager;
  let time = 1_000;
  const deps: ExecutionDependencies = { store, git, herdr, platform: "linux", serverOrigin: "https://daynight.example", workerId: uuid(6), buildPrompt: () => "managed", emit: (event) => events.push(event), now: () => time };
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
    expect(Object.keys(f.store.getTask(f.task)!).sort()).toEqual(["agent", "claimId", "projectId", "sessionId", "status", "taskId"]);
  });

  it("stops an already inactive pane without sending a cleanup prompt", async () => {
    const f = fixture();
    const pane = { ...f.observation("idle", null, null, false), kind: null };
    const resources: HerdrOwnedWorkspace[] = [{ owner: f.owner, workspaceId: pane.binding.workspaceId, panes: [{ ...pane, cwd: null }] }];
    expect(await f.driver.advance({ owner: f.owner, project: f.store.getProject(f.owner)!, task: f.task }, resources, true)).toBe(true);
    expect(f.submitPrompt).not.toHaveBeenCalled(); expect(f.order).toEqual(["stop-close", "delete"]);
  });
});
