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
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), probe: vi.fn() }));
vi.mock("../../../src/commands/worker/control.js", () => ({ submitWorkerControl: mocks.submit }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of resources.splice(0)) await release();
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => ({ desired: null, observationRevision: "0", observation: null })), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(), dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn() });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.probe.mockResolvedValue("0.164.0");
  mocks.coordinator.mockReturnValue({ tick: vi.fn(), shutdown: vi.fn() });
});
const fixture = async (mode: "herdr" | "web" = "herdr") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-control-runtime-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "home-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  await writeFile(paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  repositories: []\n`);
  const store = openWorkerStore(paths.databaseFile); stores.add(store);
  const project = { projectId: uuid(1), repoUrl: "https://example.test/org/repo.git", localPath: path.join(homeDirectory, "repo") };
  store.registerProject(project);
  const task = store.activateTask(store.registerPending({ projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), agent: "codex", ...(mode === "web" ? { agentControlMode: mode } : {}) }));
  const sibling = store.registerPending({ projectId: project.projectId, taskId: uuid(12), claimId: uuid(13), agent: "copilot" });
  const request = { kind: "release" as const, taskId: task.taskId, claimId: task.claimId, version: 5n };
  mocks.submit.mockImplementation(async ({ store: current }: { store: WorkerStore }) => ({ task: current.completeTask(task), message: "release completed" }));
  return { homeDirectory, packageDirectory: path.resolve("package"), version: "0.0.0", workingDirectory: homeDirectory, request, paths, store, project, task, sibling };
};
const staleManagedSource = (mode = "herdr") => `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  agentControlMode: ${mode}\n  agent: invalid-local-agent\n  maxConcurrent: 0\n  args: false\n  repositories: null\n`;
const cloudTarget = (selected: boolean): WorkerCloudDesired => ({ revision: "8", updatedAt: "2026-11-04T00:00:00Z", value: { maxConcurrent: 4, pollIntervalMs: 2000, recoveryLimit: 7, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-global", args: [] }, projects: selected ? [{ projectId: uuid(1), nativeOverrides: { model: "cloud-project" } }] : [] } });

describe("worker synchronous management runtime ownership", () => {
  it("resolves only the target Project when an unrelated explicit Project is unavailable", async () => {
    const f = await fixture();
    const unavailable = { projectId: uuid(10), remote: "https://example.test/org/unavailable.git", path: path.join(f.homeDirectory, "unavailable") };
    await writeFile(f.paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  repositories:\n    - projectId: ${unavailable.projectId}\n      remote: ${unavailable.remote}\n      path: ${unavailable.path}\n    - projectId: ${f.project.projectId}\n      remote: ${f.project.repoUrl}\n      path: ${f.project.localPath}\n`);
    const resolveProject = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === unavailable.projectId) throw new Error("Project unavailable");
      return { id: projectId };
    });
    mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => ({ desired: null, observationRevision: "0", observation: null })), resolveProject });
    const request = { kind: "retry" as const, taskId: f.task.taskId, claimId: f.task.claimId };
    await runWorkerControl({ ...f, request });
    expect(resolveProject).toHaveBeenCalledOnce();
    expect(resolveProject.mock.calls[0]![0].projectId).toBe(f.project.projectId);
    expect(mocks.submit).toHaveBeenCalledOnce();
    await expect(runWorkerControl({ ...f, request: { ...request, projectId: unavailable.projectId } })).rejects.toThrow("Project unavailable");
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
    for (const result of mocks.herdr.mock.results) expect(result.value.stopInstance).not.toHaveBeenCalled();
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
    for (const result of mocks.herdr.mock.results) expect(result.value.stopInstance).not.toHaveBeenCalled();
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

  it("releases an original execution without fetching cloud configuration or parsing stale managed YAML", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, staleManagedSource());
    await runWorkerControl(f);
    const remote = mocks.remote.mock.results[0]!.value;
    expect(remote.configuration).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(staleManagedSource());
  });

  it("retries a Web execution using its frozen record without fetching current cloud settings", async () => {
    const f = await fixture("web");
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

  it.each(["retry", "resume"] as const)("uses applied cloud settings for Herdr %s even when its project is excluded from automatic selection", async kind => {
    const f = await fixture();
    await writeFile(f.paths.configFile, staleManagedSource());
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue({ desired: cloudTarget(false), observationRevision: "0", observation: null });
    mocks.submit.mockResolvedValueOnce({ task: f.task, message: `${kind} completed` });
    const request = kind === "resume" ? { kind, taskId: f.task.taskId, claimId: f.task.claimId, version: 5n } : { kind, taskId: f.task.taskId, claimId: f.task.claimId };
    await runWorkerControl({ ...f, request });
    expect(remote.configuration).toHaveBeenCalledExactlyOnceWith(uuid(4), expect.any(AbortSignal));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.maxConcurrent).toBe(4);
    expect(options.globalConfiguration).toEqual({ agent: "codex", agentControlMode: "herdr", model: "cloud-global", args: [], recoveryLimit: 7 });
    expect(options.repositories).toEqual([{ project: f.project, configuration: options.globalConfiguration }]);
    expect(mocks.probe).toHaveBeenCalled(); expect(f.store.getTask(f.task)).toEqual(f.task);
    expect(await readFile(path.join(f.paths.workerDirectory, "configuration.json"), "utf8")).toContain("cloud-global");
  });

  it("uses a selected project's applied native override for a manual Herdr retry", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, staleManagedSource());
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue({ desired: cloudTarget(true), observationRevision: "0", observation: null });
    mocks.submit.mockResolvedValueOnce({ task: f.task, message: "retry completed" });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.repositories[0]!.configuration).toEqual({ agent: "codex", agentControlMode: "herdr", model: "cloud-project", args: [], recoveryLimit: 7 });
    expect(options.globalConfiguration).toMatchObject({ model: "cloud-global" });
  });

  it("uses validated local runtime settings only when the Worker has no cloud target", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, `serverUrl: ${origin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${uuid(4)}\nworker:\n  agent: codex\n  model: local-unenrolled\n  recoveryLimit: 2\n  repositories: []\n`);
    mocks.submit.mockResolvedValueOnce({ task: f.task, message: "retry completed" });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(mocks.remote.mock.results[0]!.value.configuration).toHaveBeenCalledOnce();
    expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).globalConfiguration).toMatchObject({ agent: "codex", model: "local-unenrolled", recoveryLimit: 2 });
  });

  it("synchronizes one batch only when retry prepares new input", async () => {
    const f = await fixture();
    const collect = vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] }));
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect });
    const remote = mocks.remote(); mocks.remote.mockClear();
    const reportConfiguration = vi.fn(async (_workerId: string, _report: unknown, _native: unknown, _operation: unknown, selectors: readonly WorkerPromptSelector[]) => ({
      observedAt: "2026-11-09T00:00:00Z", lastReportedAt: "2026-11-09T00:00:00Z",
      configuration: { desired: null, observationRevision: "0", observationAccepted: false },
      prompts: { ok: true as const, results: selectors.map(({ key }) => ({ key, status: "value" as const, value: { scope: key.scope, scopeId: key.scope === "project" ? key.projectId : key.scope === "user" ? uuid(6) : uuid(4), revision: "0", text: "", updatedAt: null } })) },
    }));
    remote.reportConfiguration = reportConfiguration;
    mocks.submit.mockImplementationOnce(async () => {
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      expect(reportConfiguration).not.toHaveBeenCalled();
      await options.preparePromptSource!(f.project.projectId);
      await options.preparePromptSource!(f.project.projectId);
      expect(options.promptSource!.current(f.project.projectId)).not.toBeNull();
      return { task: f.task, message: "retry completed" };
    });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(collect).toHaveBeenCalledOnce(); expect(reportConfiguration).toHaveBeenCalledOnce();
    const call = reportConfiguration.mock.calls[0]!;
    expect(call[1]).toEqual({ ...workerTelemetry, taskInventory: null });
    expect(call[4]).toEqual([{ key: { scope: "user" }, knownRevision: null }, { key: { scope: "worker" }, knownRevision: null }, { key: { scope: "project", projectId: f.project.projectId }, knownRevision: null }]);
    expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).promptSource!.current(f.project.projectId)).toBeNull();
  });

  it("leaves new input unknown after a failed retry sync without replaying it", async () => {
    const f = await fixture();
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] })) });
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.reportConfiguration = vi.fn().mockRejectedValue(new Error("network failed"));
    mocks.submit.mockImplementationOnce(async () => {
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      await options.preparePromptSource!(f.project.projectId);
      await options.preparePromptSource!(f.project.projectId);
      expect(options.promptSource!.current(f.project.projectId)).toBeNull();
      return { task: f.task, message: "retry waiting" };
    });
    await runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } });
    expect(remote.reportConfiguration).toHaveBeenCalledOnce();
  });

  it("does not hide an unconfirmed telemetry probe cleanup during retry", async () => {
    const f = await fixture();
    const failure = new HerdrCommandCleanupError([], new Error("probe cleanup"));
    vi.spyOn(telemetryModule, "createWorkerTelemetryCollector").mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [{ component: "codex" as const, code: "unavailable" as const, error: failure }] })) });
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.reportConfiguration = vi.fn();
    mocks.submit.mockImplementationOnce(async () => {
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      await options.preparePromptSource!(f.project.projectId);
      return { task: f.task, message: "unexpected" };
    });
    await expect(runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } })).rejects.toBe(failure);
    expect(remote.reportConfiguration).not.toHaveBeenCalled();
  });

  it("preserves a Herdr retry lookup failure without using stale local settings or submitting task changes", async () => {
    const f = await fixture();
    const failure = new Error("Current cloud settings unavailable.");
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.configuration.mockRejectedValue(failure);
    await expect(runWorkerControl({ ...f, request: { kind: "retry", taskId: f.task.taskId, claimId: f.task.claimId } })).rejects.toBe(failure);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(f.store.getTask(f.task)).toEqual(f.task); expect(f.store.getTask(f.sibling)).toEqual(f.sibling);
  });
});


it("can release an existing execution when its configured alias target no longer exists", async () => {
  const f = await fixture();
  await appendFile(f.paths.configFile, "\nagentCliAliases:\n  daynight: /missing/removed-development-launcher\n");
  mocks.submit.mockResolvedValueOnce({ task: null, message: "release completed" });
  await runWorkerControl(f);
  expect(mocks.submit).toHaveBeenCalledOnce();
});
