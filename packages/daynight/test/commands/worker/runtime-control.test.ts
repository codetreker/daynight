import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerControl } from "../../../src/commands/worker/runtime.js";
import { acquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { LocalTask } from "../../../src/commands/worker/types.js";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(), controlDriver: vi.fn(), coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(),
}));
vi.mock("../../../src/commands/worker/control.js", () => ({ submitWorkerControl: mocks.submit, createWorkerControlDriver: mocks.controlDriver }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", () => ({ createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of resources.splice(0)) await release();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)) });
  mocks.git.mockReturnValue({ dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn() });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.controlDriver.mockImplementation(({ store }: { store: WorkerStore }) => ({ advance: vi.fn(async (task: LocalTask) => store.getTask(task)) }));
});
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-control-runtime-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "home-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  await writeFile(paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  repositories: []\n`);
  const store = openWorkerStore(paths.databaseFile); stores.add(store);
  const project = { serverOrigin: origin, projectId: uuid(1), repoUrl: "https://example.test/org/repo.git", localPath: path.join(homeDirectory, "repo") };
  store.registerProject(project);
  const task = store.registerPending({ ...project, taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5) }, { kind: "new", configuration: { agent: "codex", model: null, args: [], recoveryLimit: 2 } }, 1, uuid(6));
  const sibling = store.registerPending({ ...project, taskId: uuid(12), claimId: uuid(13), workerId: uuid(4), worktreeId: uuid(15) }, { kind: "new", configuration: { agent: "copilot", model: null, args: [], recoveryLimit: 2 } }, 1, uuid(6));
  const request = { kind: "release" as const, taskId: task.taskId, claimId: task.claimId, version: 5n };
  mocks.submit.mockImplementation(async ({ store: current }: { store: WorkerStore }) => ({ task: current.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: "5" }, 2), message: "release persisted" }));
  return { homeDirectory, packageDirectory: path.resolve("package"), request, paths, store, task, sibling };
};
const complete = (store: WorkerStore, task: LocalTask) => {
  store.confirmUnstartedControlCleanup(task, { completeHerdrInventory: true, noOwnedResources: true }, 600_002, 2);
  store.markControlSubmitting(task, 5n, 3);
  store.confirmControlApplied(task, 6n, 4);
  store.completeTask(task, 5);
};

describe("worker management runtime ownership", () => {
  it("advances only the target through the locked coordinator and leaves sibling resources and shared Herdr intact", async () => {
    const f = await fixture();
    const advance = vi.fn(async (identity: LocalTask) => { expect(identity.claimId).toBe(f.task.claimId); complete(f.store, f.task); });
    const shutdown = vi.fn(); const tick = vi.fn();
    mocks.coordinator.mockReturnValue({ advanceCommittedCleanups: advance, shutdown, tick });
    await runWorkerControl(f);
    expect(advance).toHaveBeenCalledOnce();
    expect(tick).not.toHaveBeenCalled(); expect(shutdown).not.toHaveBeenCalled();
    expect(mocks.herdr.mock.results[0]!.value.stopInstance).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)?.status).toBe("done");
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("persists a foreground request without creating a second native controller and retains it after interruption", async () => {
    const f = await fixture(); const live = await acquireWorkerInstanceLock(f.paths); resources.push(live.release);
    const cancellation = new AbortController();
    mocks.submit.mockImplementationOnce(async ({ store }: { store: WorkerStore }) => {
      const task = store.recordControlIntent(f.task, { kind: "release", sourceClaimId: f.task.claimId, version: "5" }, 2);
      setTimeout(() => cancellation.abort(new Error("test interruption")), 10);
      return { task, message: "persisted for foreground" };
    });
    await expect(runWorkerControl({ ...f, signal: cancellation.signal })).rejects.toThrow();
    expect(f.store.getTask(f.task)?.control?.submission).toBe("not-submitted");
    expect(mocks.herdr).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
  });

  it("takes the same lock after the foreground exits and continues the persisted target without a business tick", async () => {
    const f = await fixture(); const live = await acquireWorkerInstanceLock(f.paths);
    mocks.submit.mockImplementationOnce(async ({ store }: { store: WorkerStore }) => {
      const task = store.recordControlIntent(f.task, { kind: "release", sourceClaimId: f.task.claimId, version: "5" }, 2);
      await live.release();
      return { task, message: "persisted before foreground exit" };
    });
    const advance = vi.fn(async () => complete(f.store, f.task));
    mocks.coordinator.mockReturnValue({ advanceCommittedCleanups: advance });
    await runWorkerControl(f);
    expect(advance).toHaveBeenCalledOnce(); expect(f.store.getTask(f.task)?.status).toBe("done");
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
  });

  it("surfaces an unknown remote outcome with its original claim and releases only command ownership", async () => {
    const f = await fixture();
    mocks.coordinator.mockReturnValue({ advanceCommittedCleanups: vi.fn(async () => {
      f.store.confirmUnstartedControlCleanup(f.task, { completeHerdrInventory: true, noOwnedResources: true }, 600_002, 2);
      f.store.markControlSubmitting(f.task, 5n, 3);
    }) });
    await expect(runWorkerControl(f)).rejects.toThrow(`unknown for claim ${f.task.claimId}`);
    expect(f.store.getTask(f.task)?.control?.submission).toBe("unknown");
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("reconciles an already cleaned unknown outcome without constructing any native controller", async () => {
    const f = await fixture();
    mocks.submit.mockImplementationOnce(async ({ store }: { store: WorkerStore }) => {
      store.recordControlIntent(f.task, { kind: "release", sourceClaimId: f.task.claimId, version: "5" }, 2);
      store.confirmUnstartedControlCleanup(f.task, { completeHerdrInventory: true, noOwnedResources: true }, 600_002, 2);
      const task = store.markControlSubmitting(f.task, 5n, 3);
      return { task, message: "unknown original write" };
    });
    const reconcile = vi.fn(async () => {
      f.store.confirmControlApplied(f.task, 6n, 4);
      return f.store.completeTask(f.task, 5);
    });
    mocks.controlDriver.mockReturnValueOnce({ advance: reconcile });
    await runWorkerControl(f);
    expect(reconcile).toHaveBeenCalledOnce(); expect(f.store.getTask(f.task)?.status).toBe("done");
    expect(mocks.herdr).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
  });

  it("does not construct resource controllers after permission failure and preserves the original error", async () => {
    const f = await fixture(); const denied = new Error("administrator permission required");
    mocks.submit.mockRejectedValueOnce(denied);
    await expect(runWorkerControl(f)).rejects.toBe(denied);
    expect(mocks.herdr).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)?.control).toBeNull();
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });
});
