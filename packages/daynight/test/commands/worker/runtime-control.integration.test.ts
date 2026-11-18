import { receivedReceipt, receivedResource } from "../../helpers/worker-received-configuration.js";
import path from "node:path";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerControl } from "../../../src/commands/worker/runtime.js";
import { acquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerCloudDesired, WorkerPromptSelector } from "../../../src/api/worker-configuration.js";
import * as telemetryModule from "../../../src/commands/worker/telemetry.js";
import * as webBackendModule from "../../../src/commands/worker/backends/web.js";
import { OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { Task } from "../../../src/api/types.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import { receiveWorkerDesired } from "../../../src/api/worker-configuration-source.js";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), coordinator: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), probe: vi.fn() }));
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => ({
  createWorkerToolSelectionRuntime: (await import("../../helpers/worker-tool-runtime-fixture.js")).createWorkerToolSelectionFixture,
}));
vi.mock("../../../src/commands/worker/control.js", () => ({ submitWorkerControl: mocks.submit }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", async original => ({ ...await original<object>(), buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/native-version.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const resources: (() => Promise<void>)[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  for (const release of resources.splice(0)) await release();
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => (receivedResource({ desired: null, observationRevision: "0", observation: null }))), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(), dispose: vi.fn(async () => {}) });
  mocks.prompt.mockReturnValue("prompt");
  mocks.probe.mockResolvedValue("0.164.0");
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
  const task = store.activateTask(store.registerPending({ projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web" }));
  const sibling = store.registerPending({ projectId: project.projectId, taskId: uuid(12), claimId: uuid(13), agent: "copilot", agentControlMode: "web" });
  const request = { kind: "release" as const, taskId: task.taskId, claimId: task.claimId, version: 5n };
  mocks.submit.mockImplementation(async ({ store: current }: { store: WorkerStore }) => ({ task: current.completeTask(task), message: "release completed" }));
  return { homeDirectory, packageDirectory: path.resolve("package"), version: "0.0.0", workingDirectory: homeDirectory, request, paths, store, project, task, sibling };
};
const staleManagedSource = (mode = "herdr") => `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  agentControlMode: ${mode}\n  agent: invalid-local-agent\n  maxConcurrent: 0\n  args: false\n  repositories: null\n`;
const captureWebOptions = () => {
  const create = webBackendModule.createWebExecutionBackend;
  let captured: webBackendModule.WebBackendOptions | undefined;
  vi.spyOn(webBackendModule, "createWebExecutionBackend").mockImplementation(options => { captured = options; return create(options); });
  return () => { if (captured === undefined) throw new Error("Web backend was not constructed."); return captured; };
};
const cloudTarget = (selected: boolean): WorkerCloudDesired => ({ revision: "8", updatedAt: "2026-11-04T00:00:00Z", value: { toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } }, maxConcurrent: 4, pollIntervalMs: 2000, recoveryLimit: 7, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-global", args: [] }, projects: selected ? [{ projectId: uuid(1), nativeOverrides: { model: "cloud-project" } }] : [] } });

describe("worker synchronous management runtime ownership", () => {
  it("keeps the original Web project binding without resolving unrelated projects", async () => {
    const f = await fixture();
    const unavailable = { projectId: uuid(10), remote: "https://example.test/org/unavailable.git", path: path.join(f.homeDirectory, "unavailable") };
    await writeFile(f.paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  repositories:\n    - projectId: ${unavailable.projectId}\n      remote: ${unavailable.remote}\n      path: ${unavailable.path}\n    - projectId: ${f.project.projectId}\n      remote: ${f.project.repoUrl}\n      path: ${f.project.localPath}\n`);
    const resolveProject = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === unavailable.projectId) throw new Error("Project unavailable");
      return { id: projectId };
    });
    mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => (receivedResource({ desired: null, observationRevision: "0", observation: null }))), resolveProject });
    const request = { kind: "retry" as const, taskId: f.task.taskId, claimId: f.task.claimId };
    await runWorkerControl({ ...f, request });
    expect(resolveProject).not.toHaveBeenCalled();
    expect(f.store.getProject(f.project)).toEqual(f.project);
    expect(mocks.submit).toHaveBeenCalledOnce();
    await expect(runWorkerControl({ ...f, request: { ...request, projectId: unavailable.projectId } })).rejects.toThrow("original unfinished local execution");
    expect(resolveProject).not.toHaveBeenCalled();
  });
  it("submits once under the instance lock and leaves sibling resources intact", async () => {
    const f = await fixture();
    let held = false;
    mocks.submit.mockImplementationOnce(async ({ store, coordinator }: { store: WorkerStore; coordinator: { tick: unknown } }) => {
      expect(coordinator.tick).toBe(mocks.coordinator.mock.results[0]!.value.tick);
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
    expect(f.store.getTask(f.task)?.status).toBe("done"); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("stops the original execution before preparing only its repository for cleanup", async () => {
    const f = await fixture();
    await mkdir(f.project.localPath);
    const unrelated = { projectId: uuid(30), repoUrl: "https://example.test/org/unrelated.git", localPath: path.join(f.homeDirectory, "unrelated") };
    await mkdir(unrelated.localPath); f.store.registerProject(unrelated);
    const events: string[] = [];
    const prepareRepository = vi.fn(async (project: typeof f.project) => { events.push(`prepare:${project.projectId}`); });
    mocks.git.mockReturnValue({ prepareRepository, dispose: vi.fn(async () => {}) });
    const owner = { ...f.task, worktreeId: uuid(9) };
    const cleanupSource = vi.fn(async (_identity: typeof f.task, _settings: { deleteWorktree: boolean }) => { events.push("stop"); return owner; });
    const completeSource = vi.fn(async (_owner: typeof owner) => { events.push("cleanup"); });
    mocks.coordinator.mockReturnValue({ cleanupSource, completeSource, tick: vi.fn(), shutdown: vi.fn() });
    mocks.submit.mockImplementationOnce(async ({ coordinator }: { coordinator: { cleanupSource: typeof cleanupSource; completeSource: typeof completeSource } }) => {
      const observed = await coordinator.cleanupSource(f.task, { deleteWorktree: false });
      events.push("release");
      await coordinator.completeSource(observed);
      return { task: f.task, message: "release completed" };
    });
    await runWorkerControl(f);
    expect(events).toEqual(["stop", "release", `prepare:${f.project.projectId}`, "cleanup"]);
    expect(prepareRepository).toHaveBeenCalledOnce();
    expect(prepareRepository).toHaveBeenCalledWith(f.project, expect.anything());
  });

  it("stops and releases even when the original repository format cannot be prepared", async () => {
    const f = await fixture(); await mkdir(f.project.localPath);
    const failure = new Error("original format unavailable"), events: string[] = [];
    mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => { events.push("prepare"); throw failure; }), dispose: vi.fn(async () => {}) });
    const owner = { ...f.task, worktreeId: uuid(9) };
    const completeSource = vi.fn(async () => { events.push("cleanup"); });
    mocks.coordinator.mockReturnValue({ cleanupSource: vi.fn(async () => { events.push("stop"); return owner; }), completeSource, tick: vi.fn(), shutdown: vi.fn() });
    mocks.submit.mockImplementationOnce(async ({ coordinator }: { coordinator: { cleanupSource: (identity: typeof f.task, settings: { deleteWorktree: boolean }) => Promise<typeof owner>; completeSource: (value: typeof owner) => Promise<void> } }) => {
      const observed = await coordinator.cleanupSource(f.task, { deleteWorktree: false }); events.push("release");
      await coordinator.completeSource(observed);
      return { task: f.task, message: "release completed" };
    });
    await expect(runWorkerControl(f)).rejects.toBe(failure);
    expect(events).toEqual(["stop", "release", "prepare"]);
    expect(completeSource).not.toHaveBeenCalled();
  });

  it("rejects management while run owns the lock before submission or native controller construction", async () => {
    const f = await fixture(); const live = await acquireWorkerInstanceLock(f.paths); resources.push(live.release);
    await expect(runWorkerControl(f)).rejects.toThrow(/stop.*worker run|worker.*already running/i);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled();
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
    expect(mocks.coordinator.mock.results[0]!.value.shutdown).not.toHaveBeenCalled();
    expect(mocks.coordinator.mock.results[0]!.value.tick).not.toHaveBeenCalled();
    const next = await acquireWorkerInstanceLock(f.paths); await next.release();
  });

  it("does not submit a pre-cancelled command and retains the original records", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error("Management cancelled."));
    await expect(runWorkerControl({ ...f, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)).toEqual(f.task);
  });

  it("releases an original execution without fetching cloud configuration or parsing stale managed YAML", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, staleManagedSource());
    await runWorkerControl(f);
    const remote = mocks.remote.mock.results[0]!.value;
    expect(remote.configuration).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(staleManagedSource());
  });

  it.each([false, true, null])("uses persisted applied archive value %s during a real Web release", async value => {
    const { createWorkerCoordinator } = await vi.importActual<typeof import("../../../src/commands/worker/coordinator.js")>("../../../src/commands/worker/coordinator.js");
    const { submitWorkerControl } = await vi.importActual<typeof import("../../../src/commands/worker/control.js")>("../../../src/commands/worker/control.js");
    const f = await fixture(), worktreeId = uuid(9);
    await mkdir(f.project.localPath);
    if (value !== null) {
      const manager = await createWorkerConfigurationManager({ file: f.paths.configurationFile, identity: { serverOrigin: origin, userId: uuid(6), workerId: uuid(4) }, signal: new AbortController().signal, applyNative: async () => {} });
      const target = cloudTarget(false);
      await manager.receive(receiveWorkerDesired(JSON.stringify({ ...target, value: { ...target.value, archiveSessions: value } })));
      await manager.settle();
      expect(manager.current().effective.archiveSessions).toBe(value);
      await manager.stop();
    }
    const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
    const web = openWebExecutionStore(webFile);
    web.register({ ...f.task, worktreeId, project: f.project, serverOrigin: origin, workerId: uuid(4), userId: uuid(6), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    web.close();
    const remoteTask: Task = { type: "task", parentId: null, tags: [], id: f.task.taskId, projectId: f.project.projectId, title: "Original assignment", description: "task", status: "in_progress", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 5n, properties: { worker: { claimId: f.task.claimId, workerId: uuid(4), machine: { id: uuid(5), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "web", worktreeId, userId: uuid(6), state: "active", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-12T00:00:00Z" } }, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false };
    const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => uuid(6)), authorizeControl: vi.fn(async () => {}), readTask: vi.fn(async () => remoteTask), release: vi.fn(async () => remoteTask), configuration: vi.fn() };
    mocks.remote.mockReturnValue(remote);
    mocks.git.mockReturnValue({ dispose: vi.fn(async () => {}), prepareRepository: vi.fn(async () => {}), resolveWorktreeBinding: vi.fn(async () => null), removeUnpublishedReservation: vi.fn(async () => {}) });
    mocks.coordinator.mockImplementation(createWorkerCoordinator); mocks.submit.mockImplementation(submitWorkerControl);
    await runWorkerControl(f);
    expect(remote.configuration).not.toHaveBeenCalled();
    expect(remote.release).toHaveBeenCalledOnce();
    expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).archiveSessions!()).toBe(value);
    const reopened = openWebExecutionStore(webFile);
    try { expect(reopened.getTask(f.task)).toMatchObject({ status: "done", cleanup: { kind: "terminal", discardRecording: value === false } }); }
    finally { reopened.close(); }
    if (value === false) {
      const manager = await createWorkerConfigurationManager({ file: f.paths.configurationFile, identity: { serverOrigin: origin, userId: uuid(6), workerId: uuid(4) }, signal: new AbortController().signal, applyNative: async () => {} });
      const target = cloudTarget(false);
      await manager.receive(receiveWorkerDesired(JSON.stringify({ ...target, revision: "9", value: { ...target.value, archiveSessions: true } })));
      await manager.settle();
      expect(manager.current().effective.archiveSessions).toBe(true);
      await manager.stop();
      const retained = openWebExecutionStore(webFile);
      try { expect(retained.getTask(f.task)?.cleanup?.discardRecording).toBe(true); }
      finally { retained.close(); }
    }
  });

  it("retries a Web execution using its frozen record without fetching current cloud settings", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, staleManagedSource("web"));
    const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-web-model", args: [] as string[], recoveryLimit: 2 };
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"));
    web.register({ ...f.task, worktreeId: uuid(9), project: f.project, serverOrigin: origin, workerId: uuid(4), userId: uuid(6), configuration }, Date.now()); web.close();
    let observed: unknown;
    mocks.submit.mockImplementationOnce(async () => {
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      observed = options.webStore!.getTask(f.task)!.configuration;
      return { task: f.task, message: "retry completed" };
    });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(mocks.remote.mock.results[0]!.value.configuration).not.toHaveBeenCalled();
    expect(observed).toEqual(configuration); expect(f.store.getTask(f.task)).toEqual(f.task);
  });

  it.each(["release", "retry"] as const)("keeps %s management available while the cached tag filter awaits authority synchronization", async kind => {
    const f = await fixture();
    const manager = await createWorkerConfigurationManager({ file: f.paths.configurationFile, identity: { serverOrigin: origin, userId: uuid(6), workerId: uuid(4) }, signal: new AbortController().signal, applyNative: async () => {} });
    const target = cloudTarget(true);
    await manager.receive(receiveWorkerDesired(JSON.stringify({ ...target, value: { ...target.value, taskTagFilter: { names: ["backend"], match: "all" } } })));
    await manager.settle();
    expect(manager.current().effective.taskTagFilterKey).toMatch(/^[a-f0-9]{64}$/);
    await manager.stop();
    const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-model", args: [] as string[], recoveryLimit: 2 };
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"));
    web.register({ ...f.task, worktreeId: uuid(9), project: f.project, serverOrigin: origin, workerId: uuid(4), userId: uuid(6), configuration }, Date.now());
    web.close();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.listCandidates = vi.fn(); remote.reportConfiguration = vi.fn();
    mocks.submit.mockImplementationOnce(async () => {
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      expect(options.taskTagFilterKey).toBeNull();
      expect(options.webStore!.getTask(f.task)!.configuration).toEqual(configuration);
      expect(options.store.getTask(f.task)).toEqual(f.task);
      return { task: f.task, message: "management completed" };
    });
    await runWorkerControl({ ...f, request: kind === "release" ? f.request : { kind, taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(remote.configuration).not.toHaveBeenCalled();
    expect(remote.listCandidates).not.toHaveBeenCalled();
    expect(remote.reportConfiguration).not.toHaveBeenCalled();
    expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
  });

  it("synchronizes one batch only when retry prepares new input", async () => {
    const f = await fixture(); const webOptions = captureWebOptions();
    const collect = vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] }));
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect });
    const remote = mocks.remote(); mocks.remote.mockClear();
    const reportConfiguration = vi.fn(async (_workerId: string, _report: unknown, _native: unknown, _operation: unknown, selectors: readonly WorkerPromptSelector[]) => ({
      observedAt: "2026-11-09T00:00:00Z", lastReportedAt: "2026-11-09T00:00:00Z",
      configuration: receivedReceipt({ desired: { ...cloudTarget(false), value: { ...cloudTarget(false).value, taskTagFilter: { names: ["urgent"], match: "any" } } }, observationRevision: "0", observationAccepted: false }),
      prompts: { ok: true as const, results: selectors.map(({ key }) => ({ key, status: "value" as const, value: { scope: key.scope, scopeId: key.scope === "project" ? key.projectId : key.scope === "user" ? uuid(6) : uuid(4), revision: "0", text: "", updatedAt: null } })) },
    }));
    remote.reportConfiguration = reportConfiguration;
    mocks.submit.mockImplementationOnce(async () => {
      const options = webOptions();
      expect(reportConfiguration).not.toHaveBeenCalled();
      await options.preparePromptSource!(f.project.projectId, new AbortController().signal);
      await options.preparePromptSource!(f.project.projectId, new AbortController().signal);
      expect(options.promptSource!.current(f.project.projectId)).not.toBeNull();
      return { task: f.task, message: "retry completed" };
    });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(collect).toHaveBeenCalledOnce(); expect(reportConfiguration).toHaveBeenCalledOnce();
    const call = reportConfiguration.mock.calls[0]!;
    expect(call[1]).toEqual({ ...workerTelemetry, taskInventory: null });
    expect(call[4]).toEqual([{ key: { scope: "user" }, knownRevision: null }, { key: { scope: "worker" }, knownRevision: null }, { key: { scope: "project", projectId: f.project.projectId }, knownRevision: null }]);
    expect(webOptions().promptSource!.current(f.project.projectId)).toBeNull();
  });

  it("leaves new input unknown after a failed retry sync without replaying it", async () => {
    const f = await fixture(); const webOptions = captureWebOptions();
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] })) });
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.reportConfiguration = vi.fn().mockRejectedValue(new Error("network failed"));
    mocks.submit.mockImplementationOnce(async () => {
      const options = webOptions();
      await options.preparePromptSource!(f.project.projectId, new AbortController().signal);
      await options.preparePromptSource!(f.project.projectId, new AbortController().signal);
      expect(options.promptSource!.current(f.project.projectId)).toBeNull();
      return { task: f.task, message: "retry waiting" };
    });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(remote.reportConfiguration).toHaveBeenCalledOnce();
  });

  it("does not hide an unconfirmed telemetry probe cleanup during retry", async () => {
    const f = await fixture(); const webOptions = captureWebOptions();
    const failure = new OwnedCommandCleanupError([], new Error("probe cleanup"));
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [{ component: "codex" as const, code: "unavailable" as const, error: failure }] })) });
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.reportConfiguration = vi.fn();
    mocks.submit.mockImplementationOnce(async () => {
      const options = webOptions();
      await options.preparePromptSource!(f.project.projectId, new AbortController().signal);
      return { task: f.task, message: "unexpected" };
    });
    await expect(runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } })).rejects.toBe(failure);
    expect(remote.reportConfiguration).not.toHaveBeenCalled();
  });


});


it("can release an existing execution when its configured alias target no longer exists", async () => {
  const f = await fixture();
  await appendFile(f.paths.configFile, "\nagentCliAliases:\n  daynight: /missing/removed-development-launcher\n");
  mocks.submit.mockResolvedValueOnce({ task: null, message: "release completed" });
  await runWorkerControl(f);
  expect(mocks.submit).toHaveBeenCalledOnce();
});
