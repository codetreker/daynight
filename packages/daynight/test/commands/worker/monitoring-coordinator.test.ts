import { scanFromList } from "../../helpers/worker-git-scan.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { ApiError } from "../../../src/api/client.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { Task } from "../../../src/api/types.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let project = { projectId: uuid(10), repoUrl: "https://example.test/a/b.git", localPath: "" };
const stores: ReturnType<typeof openWorkerStore>[] = [];
const webStores: ReturnType<typeof openWebExecutionStore>[] = [];
const roots: string[] = [];
afterEach(() => { for (const store of webStores.splice(0)) store.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = (settings: { prepareProject?: () => Promise<void> } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/monitoring-coordinator"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  project = { ...project, localPath: root };
  const store = openWorkerStore(createMemoryDatabase()); stores.push(store); store.registerProject(project);
  let clock = 1_000;
  const monitor = createMonitoringObserver({ now: () => clock, reservationKey: new Uint8Array(32) });
  const git = { scanWorktrees: scanFromList, listWorktrees: vi.fn(async () => []), listWorktreeManifests: vi.fn(async () => []) } as unknown as WorkerGitManager;
  const ownInventory = vi.fn(async () => ({ tasks: [], coveredProjectIds: [project.projectId], unavailableProjectIds: [] as string[] }));
  const candidates = vi.fn(async function* (): AsyncGenerator<Task> { /* Full successful search has no candidates. */ });
  const claim = vi.fn();
  const remote = { serverOrigin: "https://example.test", currentUserId: vi.fn(async () => uuid(2)), ownInventory, candidates, claim } as unknown as WorkerRemote;
  const webStore = openWebExecutionStore(createMemoryDatabase()); webStores.push(webStore);
  const unexpectedBackendCall = async (): Promise<never> => { throw new Error("Unexpected Web backend call in monitoring fixture."); };
  const webBackend = { advance: unexpectedBackendCall, cleanup: unexpectedBackendCall, observeExecutionStop: unexpectedBackendCall };
  const coordinator = createWorkerCoordinator({ store, webStore, webBackend, git, remote, serverOrigin: remote.serverOrigin, workerId: uuid(1), platform: "linux", machine: { id: uuid(3), name: "host" }, repositories: [{ project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 } }], globalConfiguration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 }, maxConcurrent: 1, preferPlatformSpecificTasks: false, emit: () => {}, now: () => clock, monitoring: monitor, ...(settings.prepareProject === undefined ? {} : { prepareProject: settings.prepareProject }) });
  return { coordinator, monitor, ownInventory, candidates, claim, clock: (value: number) => { clock = value; } };
};

describe("coordinator monitoring", () => {
  it("records complete empty search, but neither a failed search nor a skipped tick advances success", async () => {
    const f = fixture();
    await f.coordinator.tick();
    const first = f.monitor.capture();
    expect(first.scheduler).toMatchObject({ coverage: "complete", lastOutcome: "completed", lastSuccessfulAt: new Date(1_000).toISOString() });
    expect(first.admission.reasons).toEqual([expect.objectContaining({ code: "no-ready-tasks" })]);
    f.clock(2_000);
    f.candidates.mockImplementationOnce(async function* () { throw new Error("fixture search failure"); });
    await expect(f.coordinator.tick()).rejects.toThrow("fixture search failure");
    const failed = f.monitor.capture();
    expect(failed.scheduler).toMatchObject({ lastOutcome: "failed", lastSuccessfulAt: first.scheduler.lastSuccessfulAt });
    expect(failed.admission.reasons.some(reason => reason.code === "no-ready-tasks")).toBe(false);
    let release!: () => void, entered!: () => void;
    const enteredBarrier = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.ownInventory.mockImplementationOnce(async () => { entered(); await barrier; return { tasks: [], coveredProjectIds: [project.projectId], unavailableProjectIds: [] }; });
    f.clock(3_000); const pending = f.coordinator.tick(); await enteredBarrier;
    const active = f.monitor.capture(); await f.coordinator.tick();
    expect(f.monitor.capture().scheduler).toEqual(active.scheduler);
    release(); await pending;
    expect(f.monitor.capture().scheduler.lastSuccessfulAt).toBe(new Date(3_000).toISOString());
  });

  it("marks an in-flight candidate search partial when configuration changes before its page arrives", async () => {
    const f = fixture();
    await f.coordinator.tick();
    const first = f.monitor.capture();
    expect(first.scheduler.lastSuccessfulAt).toBe(new Date(1_000).toISOString());
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.candidates.mockImplementationOnce(async function* () { enter(); await gate; });
    f.clock(2_000);
    const pending = f.coordinator.tick();
    try {
      await entered;
      f.coordinator.updateConfiguration({ repositories: [{ project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 } }], globalConfiguration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 }, maxConcurrent: 2, preferPlatformSpecificTasks: false });
      release(); await pending;
      const current = f.monitor.capture();
      expect(current.scheduler).toMatchObject({ coverage: "partial", lastOutcome: "completed", lastSuccessfulAt: first.scheduler.lastSuccessfulAt });
      expect(current.admission.reasons.some(reason => reason.code === "no-ready-tasks")).toBe(false);
      expect(f.claim).not.toHaveBeenCalled();
    } finally { release(); await pending; }
  });

  it("retains stale capacity when project inventory becomes inaccessible", async () => {
    const f = fixture();
    await f.coordinator.tick();
    const initial = f.monitor.capture().capacity;
    expect(initial).toMatchObject({ quality: "current", observedAt: new Date(1_000).toISOString() });
    f.clock(2_000);
    f.ownInventory.mockResolvedValueOnce({ tasks: [], coveredProjectIds: [], unavailableProjectIds: [project.projectId] });
    await f.coordinator.tick();
    expect(f.monitor.capture().capacity).toEqual({ ...initial, quality: "stale" });
  });

  it("does not report idle or success for an inaccessible project encountered during search", async () => {
    const f = fixture();
    f.candidates.mockImplementationOnce(async function* () { throw new ApiError({ operation: "candidate" }, "response", { status: 404, serverError: { code: "not_found", message: "private", requestId: uuid(4) }, cause: new Error("private") }); });
    await f.coordinator.tick();
    const result = f.monitor.capture();
    expect(result.scheduler).toMatchObject({ coverage: "partial", lastSuccessfulAt: null });
    expect(result.admission).toMatchObject({ coverage: "partial", reasons: [expect.objectContaining({ code: "project-unavailable", scope: { kind: "project", projectId: project.projectId } })] });
    expect(result.admission.reasons.some(reason => reason.code === "no-ready-tasks")).toBe(false);
  });

  it("keeps an unconfirmed claim from becoming a successful search", async () => {
    const f = fixture();
    const task: Task = { type: "task", parentId: null, id: uuid(20), projectId: project.projectId, title: "fixture", description: "", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: {}, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
    f.candidates.mockImplementationOnce(async function* () { yield task; });
    f.claim.mockRejectedValueOnce(new Error("unconfirmed"));
    await f.coordinator.tick();
    const result = f.monitor.capture();
    expect(f.claim).toHaveBeenCalledOnce();
    expect(result.scheduler).toMatchObject({ coverage: "partial", lastSuccessfulAt: null });
    expect(result.admission).toMatchObject({ coverage: "partial", reasons: [{ code: "claim-unconfirmed", scope: { kind: "project", projectId: project.projectId } }] });
  });

  it("keeps project preparation failures scoped and does not report an empty search", async () => {
    const f = fixture({ prepareProject: async () => { throw new Error("private project path"); } });
    await f.coordinator.tick();
    const result = f.monitor.capture();
    expect(result.scheduler).toMatchObject({ coverage: "partial", lastSuccessfulAt: null });
    expect(result.admission).toMatchObject({ coverage: "partial", reasons: [{ code: "project-preparation-failed", scope: { kind: "project", projectId: project.projectId } }] });
    expect(result.currentFailures).toMatchObject([{ component: "project", scope: { kind: "project", projectId: project.projectId }, error: { code: "unknown" } }]);
    expect(JSON.stringify(result)).not.toContain("private project path");
  });
});
