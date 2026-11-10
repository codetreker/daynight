import { scanFromList } from "../../helpers/worker-git-scan.js";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { Task } from "../../../src/api/types.js";
import type { WorkerCloudDesired, WorkerCloudReport } from "../../../src/api/worker-configuration.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

// These Task/configuration fixtures do not own a Bot service or native execution.
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: () => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, close: () => {},
}) }));

const mocks = vi.hoisted(() => ({ durable: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), probe: vi.fn(), telemetry: vi.fn(), webBackend: vi.fn(), launcher: vi.fn(), emit: vi.fn(), verify: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/durable.js", () => ({ createDurableWorkerHerdr: mocks.durable }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: mocks.webBackend }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: mocks.launcher }));
vi.mock("../../../src/commands/worker/backends/session-api.js", () => ({ createWorkerSessionApi: () => ({ verifySupport: mocks.verify, verifyUnregistered: vi.fn(async () => {}) }) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", async original => ({ ...await original<object>(), createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, filename: "worker.jsonl" }) }));

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
  // Platform selection is simulated; native processes and macOS process-control behavior are outside this regression.
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  mocks.prompt.mockResolvedValue(() => "prompt");
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

it("inspects retained Herdr responsibility and advances a frozen Web execution when new native defaults are unavailable", async () => {
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
  const task: Task = {
    id: taskId, projectId, title: "Retained Web execution", description: "", status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(7), name: "original" }, platform: "macos", agent: "codex", agentControlMode: "web", worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } },
  };
  const originalClaim = readWorkerClaim(task.properties);
  const target: WorkerCloudDesired = { revision: "1", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "new-unavailable-model", args: ["--search"] }, projects: [{ projectId, nativeOverrides: {} }] } };
  let observationRevision = 0n;
  const report = vi.fn(async (_workerId: string, _body: unknown, configuration: WorkerCloudReport) => {
    const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
    if (observationAccepted) observationRevision++;
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(observationRevision), observationAccepted } };
  });
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => ({ desired: target, observationRevision: "0", observation: null })), reportConfiguration: report, report: vi.fn(),
    project: vi.fn(async () => ({ id: projectId, repoUrl: project.repoUrl })), resolveProject: vi.fn(async () => ({ id: projectId, repoUrl: project.repoUrl })),
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
  expect(report).toHaveBeenCalled(); expect(prepareRepository).toHaveBeenCalledOnce();
  const cache = JSON.parse(await readFile(paths.configurationFile, "utf8")) as { items: { value: { key: { kind: string }; state: string; appliedValue: unknown } }[] };
  expect(cache.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: expect.objectContaining({ key: { kind: "native" }, state: "error", appliedValue: null }) }),
    expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectNative", projectId }, state: "error", appliedValue: null }) }),
  ]));
  cancellation.abort(); await execution;
  expect(lifecycle.close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ projectId, taskId, claimId, worktreeId }), "shutdown", expect.any(Number), undefined, true);
  expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(original);
  expect(task.status).toBe("in_progress"); expect(readWorkerClaim(task.properties)).toEqual(originalClaim);
  expect(await readFile(retainedJournal, "utf8")).toBe("retained Herdr journal marker");
});
