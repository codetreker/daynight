import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerControl } from "../../../src/commands/worker/runtime.js";
import { acquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { workspaceMigrationFile } from "../../../src/commands/worker/migration-state.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn() }));
vi.mock("../../../src/commands/worker/control.js", () => ({ submitWorkerControl: mocks.submit }));
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
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(), dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn() });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockReturnValue({ tick: vi.fn(), shutdown: vi.fn() });
});
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-control-runtime-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "home-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  await writeFile(paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  repositories: []\n`);
  const store = openWorkerStore(paths.databaseFile); stores.add(store);
  const project = { projectId: uuid(1), repoUrl: "https://example.test/org/repo.git", localPath: path.join(homeDirectory, "repo") };
  store.registerProject(project);
  const task = store.activateTask(store.registerPending({ projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), agent: "codex" }));
  const sibling = store.registerPending({ projectId: project.projectId, taskId: uuid(12), claimId: uuid(13), agent: "copilot" });
  const request = { kind: "release" as const, taskId: task.taskId, claimId: task.claimId, version: 5n };
  mocks.submit.mockImplementation(async ({ store: current }: { store: WorkerStore }) => ({ task: current.completeTask(task), message: "release completed" }));
  return { homeDirectory, packageDirectory: path.resolve("package"), request, paths, store, project, task, sibling };
};

describe("worker synchronous management runtime ownership", () => {
  it("blocks incomplete workspace migration before management reads or task mutation", async () => {
    const f = await fixture();
    await writeFile(workspaceMigrationFile(f.paths), "{}\n");
    await expect(runWorkerControl(f)).rejects.toThrow("workspace migration is incomplete");
    for (const factory of [mocks.submit, mocks.coordinator, mocks.herdr, mocks.git, mocks.remote, mocks.prompt]) expect(factory).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)).toEqual(f.task); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const lock = await acquireWorkerInstanceLock(f.paths); await lock.release();
  });

  it("submits once under the instance lock and leaves sibling resources and shared Herdr intact", async () => {
    const f = await fixture();
    let held = false;
    mocks.submit.mockImplementationOnce(async ({ store, coordinator }: { store: WorkerStore; coordinator: unknown }) => {
      expect(coordinator).toBe(mocks.coordinator.mock.results[0]!.value);
      let competing: Awaited<ReturnType<typeof acquireWorkerInstanceLock>> | undefined;
      try { competing = await acquireWorkerInstanceLock(f.paths); }
      catch { held = true; }
      finally { await competing?.release(); }
      expect(held).toBe(true);
      return { task: store.completeTask(f.task), message: "release completed" };
    });
    await runWorkerControl(f);
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(mocks.coordinator.mock.results[0]!.value.tick).not.toHaveBeenCalled();
    expect(mocks.coordinator.mock.results[0]!.value.shutdown).not.toHaveBeenCalled();
    expect(mocks.herdr.mock.results[0]!.value.stopInstance).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)?.status).toBe("done"); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("rejects management while run owns the lock before submission or native controller construction", async () => {
    const f = await fixture(); const live = await acquireWorkerInstanceLock(f.paths); resources.push(live.release);
    await expect(runWorkerControl(f)).rejects.toThrow(/stop.*worker run|worker.*already running/i);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)).toEqual(f.task); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
  });

  it("returns the original management failure without retaining an intent or replaying submission", async () => {
    const f = await fixture(); const unknown = new Error(`Unknown remote result for claim ${f.task.claimId}; reconcile before restarting run.`);
    mocks.submit.mockRejectedValueOnce(unknown);
    await expect(runWorkerControl(f)).rejects.toBe(unknown);
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(f.store.getTask(f.task)).toEqual(f.task);
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("lets a successful one-shot retry leave its managed agent for the next run to connect", async () => {
    const f = await fixture();
    mocks.submit.mockImplementationOnce(async ({ store }: { store: WorkerStore }) => ({ task: store.setSessionId(f.task, uuid(21)), message: "retry completed" }));
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(f.store.getTask(f.task)).toMatchObject({ status: "active", sessionId: uuid(21) });
    expect(mocks.herdr.mock.results[0]!.value.stopInstance).not.toHaveBeenCalled();
    expect(mocks.coordinator.mock.results[0]!.value.shutdown).not.toHaveBeenCalled();
    expect(mocks.coordinator.mock.results[0]!.value.tick).not.toHaveBeenCalled();
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("does not submit a pre-cancelled command and retains the original records", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error("Management cancelled."));
    await expect(runWorkerControl({ ...f, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)).toEqual(f.task);
  });
});
