import { scanFromList } from "../../helpers/worker-git-scan.js";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { Task } from "../../../src/api/types.js";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, WorkerCloudReport, WorkerPromptSelector } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationManager, type WorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import type { ExecutionInput } from "../../../src/commands/worker/execution.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

// These Task/configuration fixtures do not own a Bot service or native execution.
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => ({
  createWorkerToolSelectionRuntime: (await import("../../helpers/worker-tool-runtime-fixture.js")).createWorkerToolSelectionFixture,
}));
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: () => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, requiresCopilot: () => false, activeToolSelections: () => [], close: () => {},
}) }));

const mocks = vi.hoisted(() => ({ durable: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), probe: vi.fn(), telemetry: vi.fn(), webBackend: vi.fn(), launcher: vi.fn(), emit: vi.fn(), verify: vi.fn(), configuration: vi.fn(), nativeAdvance: vi.fn(), managerOptions: vi.fn(), disableReporter: vi.fn() }));
vi.mock("../../../src/commands/worker/execution.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/execution.js")>();
  return { ...actual, createExecutionDriver: (...args: Parameters<typeof actual.createExecutionDriver>) => ({ ...actual.createExecutionDriver(...args), advance: mocks.nativeAdvance }) };
});
vi.mock("../../../src/commands/worker/configuration.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/configuration.js")>();
  return { ...actual, createWorkerConfigurationManager: async (...args: Parameters<typeof actual.createWorkerConfigurationManager>) => {
    const manager = await actual.createWorkerConfigurationManager({ ...args[0], ...mocks.managerOptions() }); mocks.configuration(manager); return manager;
  } };
});
vi.mock("../../../src/commands/worker/reporter.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/reporter.js")>();
  return { ...actual, createWorkerReporter: (...args: Parameters<typeof actual.createWorkerReporter>) => mocks.disableReporter() ? { trigger: () => {}, publishInventory: () => {}, recordClaim: () => {}, demandChanged: () => {}, stop: async () => {} } : actual.createWorkerReporter(...args) };
});
vi.mock("../../../src/commands/worker/herdr/durable.js", () => ({ createDurableWorkerHerdr: mocks.durable }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: mocks.webBackend }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: mocks.launcher }));
vi.mock("../../../src/commands/worker/backends/session-api.js", () => ({ createWorkerSessionApi: () => ({ verifySupport: mocks.verify, verifyUnregistered: vi.fn(async () => {}) }) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", async original => ({ ...await original<object>(), createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, close: async () => {}, filename: "worker.jsonl" }) }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const serverOrigin = "https://daynight.example";
const workerId = uuid(1), userId = uuid(2), projectId = uuid(3), taskId = uuid(4), claimId = uuid(5), worktreeId = uuid(6);
const directories: string[] = [];
const stores = new Set<{ close(): void }>();
const running = new Set<Promise<void>>();
const cancellations = new Set<AbortController>();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.managerOptions.mockReturnValue({}); mocks.disableReporter.mockReturnValue(false);
  // Platform selection is simulated; native processes and macOS process-control behavior are outside this regression.
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  mocks.prompt.mockReturnValue("prompt");
  mocks.verify.mockResolvedValue(undefined);
  mocks.telemetry.mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] })) });
});
afterEach(async () => {
  for (const cancellation of cancellations) cancellation.abort(); cancellations.clear();
  await Promise.allSettled(running); running.clear();
  for (const store of stores) store.close(); stores.clear();
  Object.defineProperty(process, "platform", platformDescriptor);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.each([false, true])("keeps retained Herdr and frozen Web execution responsibility when native defaults are unavailable (reset to null: %s)", async resetToNull => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-retained-resources-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const project = { projectId, repoUrl: "https://git.example/team/repo.git", localPath: path.join(homeDirectory, "repo") };
  await mkdir(project.localPath);
  await writeFile(paths.configFile, stringify({ serverUrl: serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId, worker: { agentControlMode: "web", repositories: [{ remote: project.repoUrl, path: project.localPath, projectId }] } }));
  const retainedJournal = path.join(paths.workerDirectory, "herdr-executions.sqlite");
  await writeFile(retainedJournal, "retained Herdr journal marker");
  await expect(access(paths.configurationFile)).rejects.toMatchObject({ code: "ENOENT" });
  const store = openWorkerStore(paths.databaseFile); stores.add(store); store.registerProject(project);
  const localTask = store.activateTask(store.registerPending({ projectId, taskId, claimId, agent: "codex", agentControlMode: "web" }));
  const frozen = { agent: "codex" as const, agentControlMode: "web" as const, model: "original-frozen-model", args: [] as string[], recoveryLimit: 2 };
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); stores.add(webStore);
  const original = webStore.register({ projectId, taskId, claimId, worktreeId, project, serverOrigin, workerId, userId, configuration: frozen }, Date.now());
  const task: Task = { type: "task", parentId: null,
    id: taskId, projectId, title: "Retained Web execution", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(7), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "web", worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } },
  };
  const originalClaim = readWorkerClaim(task.properties);
  const target: WorkerCloudDesired = { revision: "10", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "new-unavailable-model", args: ["--search"] }, projects: [{ projectId, nativeOverrides: {} }] } };
  let canonical: WorkerCloudDesired | null = target;
  let observationRevision = 0n;
  const report = vi.fn(async (_workerId: string, _body: unknown, configuration: WorkerCloudReport) => {
    const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
    if (observationAccepted) observationRevision++;
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: canonical, observationRevision: String(observationRevision), observationAccepted } };
  });
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => ({ desired: canonical, observationRevision: String(observationRevision), observation: null })), reportConfiguration: report, report: vi.fn(),
    project: vi.fn(async () => ({ id: projectId, repoUrl: project.repoUrl })), resolveProject: vi.fn(async (_repository: unknown, _signal: AbortSignal) => ({ id: projectId, repoUrl: project.repoUrl })),
    ownInventory: vi.fn(async () => ({ tasks: [task], coveredProjectIds: [projectId], unavailableProjectIds: [] })), readTask: vi.fn(async () => task), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => task),
  };
  mocks.remote.mockReturnValue(remote);
  const lifecycle = { responsibilities: vi.fn(() => []), isStopped: vi.fn(() => false), close: vi.fn(), registerClaim: vi.fn(), assertCanAdvance: vi.fn(), hasPreparedRun: vi.fn(() => false), stop: vi.fn(async () => {}) };
  mocks.durable.mockReturnValue({ lifecycle, tasks: { pendingStops: vi.fn(() => []), listResources: vi.fn(async () => []) }, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn(), attachment: {} });
  const dispose = vi.fn(async () => {}), prepareRepository = vi.fn(async () => {});
  mocks.git.mockReturnValue(Object.assign({ prepareRepository, listWorktrees: vi.fn(async () => []), dispose }, { scanWorktrees: scanFromList }));
  const advance = vi.fn(async (record: WebTask) => record), cleanup = vi.fn(async (record: WebTask) => ({ task: record, complete: true }));
  mocks.webBackend.mockReturnValue({ advance, cleanup });
  const launch = vi.fn(); mocks.launcher.mockReturnValue({ launch });
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const execution = runWorker({ homeDirectory, packageDirectory: path.resolve("package"), workingDirectory: homeDirectory, version: "0.41.0", signal: cancellation.signal });
  running.add(execution); void execution.catch(() => {});
  await vi.waitFor(() => expect(advance).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
  expect(advance.mock.calls[0]![0].configuration).toEqual(frozen);
  expect(lifecycle.responsibilities).toHaveBeenCalled(); expect(mocks.durable).toHaveBeenCalledOnce();
  expect(mocks.probe).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(remote.claim).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalled(); expect(prepareRepository).toHaveBeenCalledWith(project, expect.anything());
  const cache = JSON.parse(await readFile(paths.configurationFile, "utf8")) as { currentItems: { value: { key: { kind: string }; state: string; appliedValue: unknown } }[] };
  expect(cache.currentItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: expect.objectContaining({ key: { kind: "native" }, state: "error", appliedValue: null }) }),
    expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectNative", projectId }, state: "error", appliedValue: null }) }),
  ]));
  if (resetToNull) {
    const manager = mocks.configuration.mock.calls[0]![0] as WorkerConfigurationManager;
    const advances = advance.mock.calls.length, inventories = remote.ownInventory.mock.calls.length;
    canonical = null; observationRevision = 0n;
    remote.resolveProject.mockImplementation(async (_repository, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      return { id: projectId, repoUrl: project.repoUrl };
    });
    await manager.receive(null, "0");
    await vi.waitFor(() => expect(advance.mock.calls.length).toBeGreaterThan(advances), { timeout: 3500, interval: 10 });
    expect(remote.ownInventory.mock.calls.length).toBeGreaterThan(inventories);
    expect(manager.current().desired).toBeNull();
    expect(advance.mock.calls.slice(advances).every(([record]) => record.configuration !== null)).toBe(true);
    expect(advance.mock.calls.slice(advances).every(([record]) => record.configuration!.model === frozen.model && record.claimId === claimId && record.worktreeId === worktreeId)).toBe(true);
    expect(remote.claim).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(original);
  }
  cancellation.abort(); await execution;
  expect(lifecycle.close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ projectId, taskId, claimId, worktreeId }), { kind: "shutdown", deadline: expect.any(Number), immediateStop: true });
  expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(original);
  expect(task.status).toBe("in_progress"); expect(readWorkerClaim(task.properties)).toEqual(originalClaim);
  expect(await readFile(retainedJournal, "utf8")).toBe("retained Herdr journal marker");
});

it.each(["null", "unread", "unsupported"] as const)("cold-resumes an original frozen Herdr claim with its retained recovery policy while authority is %s", async authority => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-retained-resources-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const project = { projectId, repoUrl: "https://git.example/team/repo.git", localPath: path.join(homeDirectory, "repo") };
  await mkdir(project.localPath);
  await writeFile(paths.configFile, stringify({ serverUrl: serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId, worker: { agentControlMode: "web", recoveryLimit: 1, repositories: [{ remote: project.repoUrl, path: project.localPath, projectId }] } }));
  const retainedJournal = path.join(paths.workerDirectory, "herdr-executions.sqlite");
  await writeFile(retainedJournal, "retained Herdr journal marker");
  const store = openWorkerStore(paths.databaseFile); stores.add(store); store.registerProject(project);
  const pending = store.registerPending({ projectId, taskId, claimId, agent: "codex", agentControlMode: "herdr" });
  const frozen = store.freezeNativeConfiguration(pending, { agent: "codex", model: "original-frozen-model", args: ["--effort", "low"] });
  store.activateTask(pending);
  const localTask = store.setSessionId(pending, uuid(8));
  const target: WorkerCloudDesired = { revision: "10", updatedAt: workerTelemetryTime, value: { agentControlMode: "herdr", maxConcurrent: 2, pollIntervalMs: 1000, recoveryLimit: 6, preferPlatformSpecificTasks: false, native: { agent: "codex", model: frozen.model, args: frozen.args }, projects: [{ projectId, nativeOverrides: {} }] } };
  const seed = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin, userId, workerId }, signal: new AbortController().signal, applyNative: async () => {} });
  await seed.configureProjectAdapters({ prepare: async () => {} });
  await seed.receive(target, "9"); await seed.settle();
  if (authority === "null") await seed.receive(null, "0");
  await seed.stop();
  const canonical = authority === "null" ? null : authority === "unsupported" ? { ...target, revision: "11", value: { ...target.value, maxConcurrent: 65, recoveryLimit: 1 } } : target;
  const task: Task = { type: "task", parentId: null,
    id: taskId, projectId, title: "Retained Herdr execution", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(7), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "herdr", worktreeId, phase: "executing", herdr: null, nativeSessionId: localTask.sessionId, claimedAt: workerTelemetryTime } },
  };
  const originalClaim = readWorkerClaim(task.properties);
  const resolveProject = vi.fn(async (_repository: unknown, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
    return { id: projectId, repoUrl: project.repoUrl };
  });
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => {
      if (authority === "unread") throw new OperationError("request_timeout");
      return { desired: canonical, observationRevision: "0", observation: null };
    }), reportConfiguration: vi.fn(async () => { throw new OperationError("request_timeout"); }), report: vi.fn(),
    project: vi.fn(async () => ({ id: projectId, repoUrl: project.repoUrl })), resolveProject,
    ownInventory: vi.fn(async () => ({ tasks: [task], coveredProjectIds: [projectId], unavailableProjectIds: [] })), readTask: vi.fn(async () => task), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => task),
  };
  mocks.remote.mockReturnValue(remote);
  const lifecycle = { responsibilities: vi.fn(() => [{ projectId, taskId, claimId, worktreeId }]), isStopped: vi.fn(() => true), close: vi.fn(), registerClaim: vi.fn(), assertCanAdvance: vi.fn(), hasPreparedRun: vi.fn(() => false), stop: vi.fn(async () => {}) };
  mocks.durable.mockReturnValue({ lifecycle, tasks: { pendingStops: vi.fn(() => []), listResources: vi.fn(async () => []) }, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn(), attachment: {} });
  const binding = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", worktreeId), branch: "original-branch" };
  const dispose = vi.fn(async () => {}), prepareRepository = vi.fn(async () => {});
  mocks.git.mockReturnValue(Object.assign({ prepareRepository, listWorktrees: vi.fn(async () => []), resolveWorktreeBinding: vi.fn(async () => binding), dispose }, { scanWorktrees: scanFromList }));
  mocks.webBackend.mockReturnValue({ advance: vi.fn(), cleanup: vi.fn() });
  const launch = vi.fn(); mocks.launcher.mockReturnValue({ launch });
  mocks.nativeAdvance.mockImplementation(async (_input: ExecutionInput) => ({ kind: "waiting_input", reason: "configuration_pending", observation: null }));
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const execution = runWorker({ homeDirectory, packageDirectory: path.resolve("package"), workingDirectory: homeDirectory, version: "0.41.0", signal: cancellation.signal });
  running.add(execution); void execution.catch(() => {});
  await vi.waitFor(() => expect(remote.configuration).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
  if (authority === "null") await vi.waitFor(() => expect(resolveProject).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
  await vi.waitFor(() => expect(mocks.nativeAdvance).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
  const input = mocks.nativeAdvance.mock.calls[0]![0] as ExecutionInput;
  expect(input).toMatchObject({ task: localTask, owner: { projectId, taskId, claimId, worktreeId }, project, configuration: { ...frozen, agentControlMode: "herdr", recoveryLimit: 6 } });
  expect(input.canAdmitNewExecution!()).toBe(false);
  const snapshot = (mocks.configuration.mock.calls.at(-1)![0] as WorkerConfigurationManager).current();
  expect(snapshot.retainedRecoveryLimit).toBe(6);
  expect(snapshot.effective.recoveryLimit).toBeNull();
  expect(snapshot.desired).toEqual(canonical);
  expect(store.getNativeConfiguration(localTask)).toEqual(frozen);
  expect(store.getNativeConfiguration(localTask)).not.toHaveProperty("recoveryLimit");
  expect(remote.claim).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled();
  cancellation.abort(); await execution;
  expect(store.getTask(localTask)).toEqual(localTask);
  expect(readWorkerClaim(task.properties)).toEqual(originalClaim);
  expect(await readFile(retainedJournal, "utf8")).toBe("retained Herdr journal marker");
  expect(lifecycle.close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
});

it("registers fresh stop verification after a failed startup read even when the previous removal was acknowledged", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-retained-resources-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const selectedProjectId = uuid(9);
  const retained = { projectId, repoUrl: "https://git.example/team/retained.git", localPath: path.join(homeDirectory, "retained") };
  const selected = { projectId: selectedProjectId, repoUrl: "https://git.example/team/selected.git", localPath: path.join(homeDirectory, "selected") };
  const owner = { projectId, taskId, claimId, worktreeId };
  const binding = { repositoryPath: retained.localPath, commonDirectory: path.join(retained.localPath, ".git"), worktreePath: path.join(retained.localPath, ".worktrees", "daynight", worktreeId), branch: "original-branch" };
  const marker = path.join(binding.worktreePath, "unfinished.txt");
  await mkdir(binding.worktreePath, { recursive: true }); await mkdir(selected.localPath);
  await writeFile(marker, "original unfinished work\n");
  await writeFile(paths.configFile, stringify({ serverUrl: serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId, worker: { agentControlMode: "web", repositories: [{ remote: selected.repoUrl, path: selected.localPath, projectId: selectedProjectId }] } }));
  const store = openWorkerStore(paths.databaseFile); stores.add(store); store.registerProject(retained); store.registerProject(selected);
  const localTask = store.activateTask(store.registerPending({ projectId, taskId, claimId, agent: "codex", agentControlMode: "web" }));
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); stores.add(webStore);
  const frozen = { agent: "codex" as const, agentControlMode: "web" as const, model: "original-frozen-model", args: [] as string[], recoveryLimit: 2 };
  webStore.register({ ...owner, project: retained, serverOrigin, workerId, userId, configuration: frozen }, Date.now());
  const original = webStore.bindWorktree(owner, binding, Date.now());
  const target: WorkerCloudDesired = { revision: "2", updatedAt: workerTelemetryTime, value: { agentControlMode: "web", maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "current-cloud-model", args: [] }, projects: [{ projectId: selectedProjectId, nativeOverrides: {} }] } };
  const seed = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin, userId, workerId }, signal: new AbortController().signal, applyNative: async () => {} });
  await seed.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
  await seed.receive({ ...target, revision: "1", value: { ...target.value, projects: [{ projectId, nativeOverrides: {} }] } }, "0"); await seed.settle();
  await seed.receive(target, "0"); await seed.settle();
  await seed.acknowledge(seed.report(), { desired: target, observationRevision: "1", observationAccepted: true }); await seed.stop();
  const saved = JSON.parse(await readFile(paths.configurationFile, "utf8")) as WorkerConfigurationCache;
  expect([...saved.currentItems, ...saved.retainedItems].some(item => "projectId" in item.value.key && item.value.key.projectId === projectId)).toBe(false);
  const task: Task = { type: "task", parentId: null,
    id: taskId, projectId, title: "Retained Web execution", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(7), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "web", worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } },
  };
  const originalClaim = readWorkerClaim(task.properties);
  let releaseRead!: () => void, reads = 0, observationRevision = 1n;
  const readAllowed = new Promise<void>(resolve => { releaseRead = resolve; });
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => {
      if (++reads === 1) throw new OperationError("request_timeout");
      await readAllowed;
      return { desired: target, observationRevision: String(observationRevision), observation: null };
    }), reportConfiguration: vi.fn(async (_workerId: string, _report: unknown, configuration: WorkerCloudReport, _operation: unknown, selectors: readonly WorkerPromptSelector[] = []) => {
      const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
      if (observationAccepted) observationRevision++;
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(observationRevision), observationAccepted },
        prompts: { ok: true, results: selectors.map(({ key }) => ({ key, status: "value", value: { scope: key.scope, scopeId: key.scope === "project" ? key.projectId : key.scope === "user" ? userId : workerId, revision: "0", text: "", updatedAt: null } })) } };
    }), report: vi.fn(),
    project: vi.fn(async (id: string) => ({ id, repoUrl: id === projectId ? retained.repoUrl : selected.repoUrl })), resolveProject: vi.fn(async () => ({ id: selectedProjectId, repoUrl: selected.repoUrl })),
    ownInventory: vi.fn(async () => ({ tasks: [task], coveredProjectIds: [projectId, selectedProjectId], unavailableProjectIds: [] })), readTask: vi.fn(async () => task), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => task),
  };
  mocks.remote.mockReturnValue(remote); mocks.probe.mockResolvedValue("0.164.0");
  const lifecycle = { responsibilities: vi.fn(() => []), isStopped: vi.fn(() => false), close: vi.fn(), registerClaim: vi.fn(), assertCanAdvance: vi.fn(), hasPreparedRun: vi.fn(() => false), stop: vi.fn(async () => {}) };
  mocks.durable.mockReturnValue({ lifecycle, tasks: { pendingStops: vi.fn(() => []), listResources: vi.fn(async () => []) }, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn(), attachment: {} });
  const dispose = vi.fn(async () => {}), prepareRepository = vi.fn(async () => {});
  const retainedBindings = async (project: { projectId: string }) => project.projectId === projectId ? [{ owner, binding }] : [];
  mocks.git.mockReturnValue(Object.assign({ prepareRepository, listWorktrees: vi.fn(retainedBindings), listWorktreeManifests: vi.fn(retainedBindings), resolveWorktreeBinding: vi.fn(async () => binding), dispose }, { scanWorktrees: scanFromList }));
  const advance = vi.fn(async (record: WebTask) => record), cleanup = vi.fn(async (record: WebTask) => ({ task: record, complete: true }));
  mocks.webBackend.mockReturnValue({ advance, cleanup });
  const launch = vi.fn(); mocks.launcher.mockReturnValue({ launch });
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const execution = runWorker({ homeDirectory, packageDirectory: path.resolve("package"), workingDirectory: homeDirectory, version: "0.41.0", signal: cancellation.signal });
  running.add(execution); void execution.catch(() => {});
  try {
    await vi.waitFor(() => expect(remote.configuration).toHaveBeenCalledTimes(2), { timeout: 3500, interval: 10 });
    await vi.waitFor(() => expect(remote.ownInventory).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
    expect(cleanup).not.toHaveBeenCalled(); expect(remote.candidates).not.toHaveBeenCalled();
  } finally { releaseRead(); }
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(expect.objectContaining(owner), { kind: "shutdown", deadline: expect.any(Number), signal: expect.any(AbortSignal), immediateStop: true }), { timeout: 3500, interval: 10 });
  await vi.waitFor(() => {
    const snapshot = (mocks.configuration.mock.calls.at(-1)![0] as WorkerConfigurationManager).current();
    const warnings = mocks.emit.mock.calls.map(([event]) => ({ kind: event.kind, message: event.message, error: event.error instanceof Error ? event.error.message : undefined })).filter(event => event.error !== undefined || event.kind === "warning");
    expect(remote.candidates, JSON.stringify({ effective: snapshot.effective, warnings })).toHaveBeenCalledWith(selectedProjectId, "macos", expect.any(AbortSignal));
  }, { timeout: 3500, interval: 10 });
  expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(original);
  expect(readWorkerClaim(task.properties)).toEqual(originalClaim); expect(await readFile(marker, "utf8")).toBe("original unfinished work\n");
  expect(remote.claim).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  cancellation.abort(); await execution;
});

it("counts removal registration only when usable authority still owns its queued checkpoint", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-retained-resources-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "registration-")); directories.push(directory);
  let hold = false, entered!: () => void, release!: () => void;
  const writeEntered = new Promise<void>(resolve => { entered = resolve; }), writeAllowed = new Promise<void>(resolve => { release = resolve; });
  const manager = await createWorkerConfigurationManager({ file: path.join(directory, "configuration.json"), identity: { serverOrigin, userId, workerId }, signal: new AbortController().signal, applyNative: async () => {}, persist: async (file, chunks) => {
    if (hold) { hold = false; entered(); await writeAllowed; }
    await replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
  } });
  const target: WorkerCloudDesired = { revision: "2", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-model", args: [] }, projects: [{ projectId: uuid(9), nativeOverrides: {} }] } };
  try {
    expect(await manager.ensureProjectRemoval(projectId)).toBe(false);
    await manager.receive(target, "0"); await manager.settle();
    hold = true;
    const resetting = manager.receive(null, "0");
    await writeEntered;
    const registering = manager.ensureProjectRemoval(projectId);
    release(); await resetting;
    expect(await registering).toBe(false);
    expect(manager.current().items).toEqual([]);
    await manager.receive(target, "0"); await manager.settle();
    expect(await manager.ensureProjectRemoval(uuid(9))).toBe(true);
    expect(await manager.ensureProjectRemoval(projectId)).toBe(true);
    expect(manager.current().items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId }, targetRevision: "2", state: "pending" }));
  } finally { release(); await manager.stop(); }
});

it("re-registers original stops after a null reset interrupts an accepted initial pass", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-retained-resources-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "aba-")); directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const projectQ = { projectId: uuid(9), repoUrl: "https://git.example/team/q.git", localPath: path.join(homeDirectory, "q") };
  const retained = { projectId, repoUrl: "https://git.example/team/retained.git", localPath: path.join(homeDirectory, "retained") };
  const owner = { projectId, taskId, claimId, worktreeId };
  const binding = { repositoryPath: retained.localPath, commonDirectory: path.join(retained.localPath, ".git"), worktreePath: path.join(retained.localPath, ".worktrees", "daynight", worktreeId), branch: "original-branch" };
  const marker = path.join(binding.worktreePath, "unfinished.txt");
  await mkdir(binding.worktreePath, { recursive: true }); await mkdir(projectQ.localPath);
  await writeFile(marker, "original unfinished work\n");
  await writeFile(paths.configFile, stringify({ serverUrl: serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId, worker: { agentControlMode: "web", repositories: [], repositoryRoot: path.join(homeDirectory, "repositories") } }));
  const store = openWorkerStore(paths.databaseFile); stores.add(store); store.registerProject(retained); store.registerProject(projectQ);
  const localTask = store.activateTask(store.registerPending({ projectId, taskId, claimId, agent: "codex", agentControlMode: "web" }));
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); stores.add(webStore);
  const frozen = { agent: "codex" as const, agentControlMode: "web" as const, model: "original-frozen-model", args: [] as string[], recoveryLimit: 2 };
  webStore.register({ ...owner, project: retained, serverOrigin, workerId, userId, configuration: frozen }, Date.now());
  const original = webStore.bindWorktree(owner, binding, Date.now());
  const holderIds = Array.from({ length: 16 }, (_, index) => uuid(100 + index));
  const target: WorkerCloudDesired = { revision: "2", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-model", args: [] }, projects: holderIds.map(projectId => ({ projectId, nativeOverrides: {} })) } };
  const seed = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin, userId, workerId }, signal: new AbortController().signal, applyNative: async () => {} });
  await seed.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
  await seed.receive({ ...target, revision: "1", value: { ...target.value, projects: [{ projectId, nativeOverrides: {} }] } }, "0"); await seed.settle();
  await seed.receive(target, "0"); await seed.settle();
  await seed.acknowledge(seed.report(), { desired: target, observationRevision: "1", observationAccepted: true }); await seed.stop();
  const seedCache = JSON.parse(await readFile(paths.configurationFile, "utf8")) as WorkerConfigurationCache;
  expect([...seedCache.currentItems, ...seedCache.retainedItems].some(item => "projectId" in item.value.key && item.value.key.projectId === projectId)).toBe(false);
  const task: Task = { type: "task", parentId: null,
    id: taskId, projectId, title: "Retained Web execution", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(7), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "web", worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } },
  };
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => ({ desired: target, observationRevision: "1", observation: null })), reportConfiguration: vi.fn(), report: vi.fn(),
    project: vi.fn(async (id: string) => ({ id, repoUrl: `https://git.example/team/${id}.git` })), resolveProject: vi.fn(async () => { throw new Error("No local bootstrap is used."); }),
    ownInventory: vi.fn(async () => ({ tasks: [task], coveredProjectIds: store.listProjects().map(project => project.projectId), unavailableProjectIds: [] })), readTask: vi.fn(async () => task), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => task),
  };
  mocks.remote.mockReturnValue(remote);
  const lifecycle = { responsibilities: vi.fn(() => []), isStopped: vi.fn(() => false), close: vi.fn(), registerClaim: vi.fn(), assertCanAdvance: vi.fn(), hasPreparedRun: vi.fn(() => false), stop: vi.fn(async () => {}) };
  mocks.durable.mockReturnValue({ lifecycle, tasks: { pendingStops: vi.fn(() => []), listResources: vi.fn(async () => []) }, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn(), attachment: {} });
  const retainedBindings = async (project: { projectId: string }) => project.projectId === projectId ? [{ owner, binding }] : [];
  mocks.git.mockReturnValue(Object.assign({ prepareRepository: vi.fn(async (project: { localPath: string }) => { await mkdir(project.localPath, { recursive: true }); }), listWorktrees: vi.fn(retainedBindings), listWorktreeManifests: vi.fn(retainedBindings), resolveWorktreeBinding: vi.fn(async () => binding), dispose: vi.fn(async () => {}) }, { scanWorktrees: scanFromList }));
  const cleanup = vi.fn(async (record: WebTask) => ({ task: record, complete: true }));
  mocks.webBackend.mockReturnValue({ advance: vi.fn(async (record: WebTask) => record), cleanup });
  mocks.launcher.mockReturnValue({ launch: vi.fn() });
  let releaseJobs!: () => void, releaseWrite!: () => void, enteredWrite!: () => void, enteredJobs!: () => void;
  const jobsAllowed = new Promise<void>(resolve => { releaseJobs = resolve; }), writeAllowed = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; }), jobsEntered = new Promise<void>(resolve => { enteredJobs = resolve; });
  let heldCalls = 0, holdingJobs = true, heldWrite = false, nullCheckpoint: WorkerConfigurationCache | undefined;
  mocks.disableReporter.mockReturnValue(true);
  mocks.managerOptions.mockReturnValue({ applyNative: async () => { if (!holdingJobs) return; if (++heldCalls === 16) enteredJobs(); await jobsAllowed; }, persist: async (file: string, chunks: () => Iterable<string>) => {
    const snapshot = JSON.parse([...chunks()].join("")) as WorkerConfigurationCache;
    if (!heldWrite && snapshot.currentItems.some(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId)) { heldWrite = true; enteredWrite(); await writeAllowed; }
    await replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
    if (snapshot.authority.desired === null) nullCheckpoint = JSON.parse(await readFile(file, "utf8")) as WorkerConfigurationCache;
  } });
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const execution = runWorker({ homeDirectory, packageDirectory: path.resolve("package"), workingDirectory: homeDirectory, version: "0.41.0", signal: cancellation.signal });
  running.add(execution); void execution.catch(() => {});
  try {
    await jobsEntered; await writeEntered;
    const manager = mocks.configuration.mock.calls.at(-1)![0] as WorkerConfigurationManager;
    expect(heldCalls).toBe(16);
    const sent = manager.report(), operation = createOperation({ limits: { totalMs: 20 } });
    const accepting = manager.acknowledge(sent, { desired: null, observationRevision: "0", observationAccepted: false }, operation.signal).catch(error => error);
    expect(await accepting).toMatchObject({ name: "OperationError", kind: "deadline" }); operation.dispose();
    const resource = await remote.configuration();
    const nextRead = manager.receive(resource.desired, resource.observationRevision);
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseWrite(); await nextRead;
    expect(nullCheckpoint?.authority.desired).toBeNull();
    expect([...nullCheckpoint!.currentItems, ...nullCheckpoint!.retainedItems].some(item => "projectId" in item.value.key && item.value.key.projectId === projectId)).toBe(false);
    holdingJobs = false; releaseJobs(); await manager.settle();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(expect.objectContaining(owner), expect.objectContaining({ kind: "shutdown", signal: expect.any(AbortSignal) })), { timeout: 3500, interval: 10 });
    await vi.waitFor(() => expect(remote.candidates).toHaveBeenCalled(), { timeout: 3500, interval: 10 });
    expect(manager.current().effective.projects).toHaveLength(16);
    expect(manager.current().effective.projects.every(project => project.ready && project.native !== null)).toBe(true);
    expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(original); expect(await readFile(marker, "utf8")).toBe("original unfinished work\n");
    expect(remote.claim).not.toHaveBeenCalled();
    const cleanupCalls = cleanup.mock.calls.length, rounds = remote.ownInventory.mock.calls.length;
    await manager.acknowledge(manager.report(), { desired: target, observationRevision: "2", observationAccepted: true }); await manager.settle();
    await vi.waitFor(() => expect(remote.ownInventory.mock.calls.length).toBeGreaterThan(rounds), { timeout: 3500, interval: 10 });
    expect(cleanup).toHaveBeenCalledTimes(cleanupCalls);
    cancellation.abort(); await execution;
  } finally { holdingJobs = false; releaseJobs(); releaseWrite(); }
}, 15_000);
