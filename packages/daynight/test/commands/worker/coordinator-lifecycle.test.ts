import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type { Task } from "../../../src/api/types.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const fixtures: {
  coordinator: ReturnType<typeof createWorkerCoordinator>;
  store: ReturnType<typeof openWorkerStore>;
  webStore: ReturnType<typeof openWebExecutionStore>;
}[] = [];
const fixture = () => {
  const root = new AbortController();
  const store = openWorkerStore(createMemoryDatabase());
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const unexpected = () => { throw new Error("Unexpected external operation."); };
  const remote = { currentUserId: vi.fn(async (_signal: AbortSignal) => id(2)) };
  const options: WorkerCoordinatorOptions = {
    store, webStore, signal: root.signal, serverOrigin: "https://daynight.example", workerId: id(1), userId: id(2),
    platform: "windows", machine: { id: id(3), name: "fixture" }, repositories: [], globalConfiguration: null,
    maxConcurrent: 1, platformTaskMode: "all" as const,
    git: new Proxy({}, { get: () => unexpected }) as WorkerCoordinatorOptions["git"],
    remote: remote as unknown as WorkerCoordinatorOptions["remote"],
    webBackend: { advance: unexpected, cleanup: unexpected, observeExecutionStop: unexpected }, emit: vi.fn(),
  };
  const coordinator = createWorkerCoordinator(options);
  const value = { root, store, webStore, coordinator, remote, options };
  fixtures.push(value); return value;
};
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.coordinator.shutdown({ deadline: Date.now() + 100 });
    f.webStore.close(); f.store.close();
  }
});

test("closing task admission cancels its reconciliation while preserving the management signal", async () => {
  const f = fixture();
  let observed!: AbortSignal;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.remote.currentUserId.mockImplementation(signal => new Promise((_resolve, reject) => {
    observed = signal; entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const tick = f.coordinator.tick().catch(error => error);
  await started;
  const reason = new Error("Execution stopped.");
  f.coordinator.closeAdmission(reason);
  expect(await tick).toBe(reason);
  expect(observed.aborted).toBe(true);
  expect(f.root.signal.aborted).toBe(false);
  expect(f.coordinator.executionSnapshot()).toMatchObject({ admissionClosed: true, reconciling: false, jobs: [] });
  expect(() => f.coordinator.assertCanAcquire({ projectId: id(10), taskId: id(11) })).toThrow(reason);
  await f.coordinator.tick();
  expect(f.remote.currentUserId).toHaveBeenCalledTimes(1);
  expect(await f.coordinator.shutdown()).toBe(true);
});

test("an unjoined reconciliation blocks bounded shutdown and remains observable until it settles", async () => {
  const f = fixture();
  let reject!: (error: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.remote.currentUserId.mockImplementation(() => new Promise((_resolve, rejectWork) => { reject = rejectWork; entered(); }));
  const tick = f.coordinator.tick().catch(error => error);
  await started;
  const stopped = f.coordinator.shutdown({ deadline: Date.now() + 40 });
  expect(f.coordinator.shutdown()).toBe(stopped);
  expect(await stopped).toBe(false);
  expect(f.coordinator.executionSnapshot()).toMatchObject({ admissionClosed: true, reconciling: true });
  expect(f.root.signal.aborted).toBe(false);
  reject(new Error("Original request settled."));
  await tick;
  expect(await f.coordinator.shutdown()).toBe(true);
});

test("shutdown retains an original pending claim when native launch evidence is unavailable", async () => {
  const f = fixture();
  const projectId = id(10), taskId = id(11), claimId = id(12);
  f.store.registerProject({ projectId, repoUrl: "https://example.test/owner/repo.git", localPath: path.resolve("../../.tmp/coordinator-retained-claim") });
  f.store.registerPending({ projectId, taskId, claimId, agent: "codex", agentControlMode: "web" });
  const before = f.store.getTask({ projectId, taskId, claimId });
  expect(await f.coordinator.shutdown({ deadline: Date.now() + 100 })).toBe(false);
  expect(f.store.getTask({ projectId, taskId, claimId })).toEqual(before);
  expect(f.coordinator.executionSnapshot().claims).toEqual([{ projectId, taskId, claimId, status: "pending" }]);
});

test("an unresolved claim request retains its frozen reservation and blocks a complete stop result", async () => {
  const f = fixture();
  const projectId = id(10);
  f.store.registerProject({ projectId, repoUrl: "https://example.test/owner/repo.git", localPath: path.resolve("../../.tmp/coordinator-retained-request") });
  const reservation = f.store.reserveClaimTools({ projectId, taskId: id(11), claimId: id(12), worktreeId: id(13), workerId: id(1),
    version: 1n, agentControlMode: "web", nativeConfiguration: { agent: "codex", model: null, args: [] } });
  expect(await f.coordinator.shutdown()).toBe(false);
  expect(f.coordinator.executionSnapshot().claimReservations).toEqual([{ ...reservation, version: reservation.version.toString() }]);
  expect(() => JSON.stringify(f.coordinator.executionSnapshot())).not.toThrow();
});

test("shutdown requests the original native stop while a cancelled Task writer remains unjoined", async () => {
  const f = fixture();
  const project = { projectId: id(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.resolve("../../.tmp/coordinator-retained-writer") };
  const owner = { projectId: project.projectId, taskId: id(11), claimId: id(12), worktreeId: id(13) };
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  f.store.registerProject(project);
  const local = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  f.webStore.register({ ...owner, project, serverOrigin: f.options.serverOrigin, workerId: id(1), userId: id(2), configuration }, Date.now());
  const record = f.webStore.initializeWebExecution(owner, Date.now());
  const task = { id: owner.taskId, projectId: owner.projectId, status: "in_progress", allowAgents: true, properties: { worker: {
    claimId: owner.claimId, worktreeId: owner.worktreeId, state: "active", userId: id(2), workerId: id(1), machine: { id: id(3), name: "fixture" }, platform: "windows", agent: "codex", agentControlMode: "web",
    phase: "executing", herdr: null, nativeSessionId: null, claimedAt: new Date().toISOString(),
  } } } as unknown as Task;
  Object.assign(f.options.remote, { readTask: vi.fn(async () => task) });
  f.coordinator.updateConfiguration({ repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, platformTaskMode: "all" as const });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.options.webBackend.advance = vi.fn(async () => { entered(); await gate; return record; });
  const cleanup = vi.fn(async () => ({ task: record, complete: true }));
  const nativeStop = vi.fn(async () => {});
  f.options.webBackend.cleanup = cleanup; f.options.webBackend.requestExecutionStop = nativeStop;
  const writer = f.coordinator.advanceRetry(owner).catch(error => error);
  await Promise.race([started, writer.then(error => { throw error ?? new Error("Task writer completed before entering the backend."); })]);
  const before = f.webStore.getTask(owner);
  try {
    expect(await f.coordinator.shutdown({ deadline: Date.now() + 100 })).toBe(false);
    expect(nativeStop).toHaveBeenCalledWith(before, expect.any(Number));
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.coordinator.executionSnapshot().taskWriters).toEqual([`${owner.projectId}/${owner.taskId}`]);
    expect(f.webStore.getTask(owner)).toEqual(before); expect(f.store.getTask(owner)).toEqual(local);
    expect(f.root.signal.aborted).toBe(false);
  } finally { release(); await writer; }
  expect(await f.coordinator.shutdown()).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
});
