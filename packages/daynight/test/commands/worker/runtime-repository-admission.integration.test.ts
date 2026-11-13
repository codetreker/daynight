import { scanFromList } from "../../helpers/worker-git-scan.js";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => ({
  createWorkerToolSelectionRuntime: (await import("../../helpers/worker-tool-runtime-fixture.js")).createWorkerToolSelectionFixture,
}));
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: () => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, requiresCopilot: () => false, activeToolSelections: () => [], close: () => {},
}) }));

const mocks = vi.hoisted(() => ({ git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), probe: vi.fn(), telemetry: vi.fn(), backend: vi.fn(), launcher: vi.fn(), emit: vi.fn(), verify: vi.fn() }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: mocks.backend }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: mocks.launcher }));
vi.mock("../../../src/commands/worker/backends/session-api.js", () => ({ createWorkerSessionApi: () => ({ verifySupport: mocks.verify, verifyUnregistered: vi.fn(async () => {}) }) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", async original => ({ ...await original<object>(), createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, close: async () => {}, filename: "worker.jsonl" }) }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const serverOrigin = "https://daynight.example";
const workerId = uuid(1), userId = uuid(2), retainedProjectId = uuid(3), selectedProjectId = uuid(4), taskId = uuid(5), claimId = uuid(6), worktreeId = uuid(7);
const directories: string[] = [];
const stores = new Set<{ close(): void }>();
const running = new Set<Promise<void>>();
const cancellations = new Set<AbortController>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.prompt.mockReturnValue("prompt"); mocks.verify.mockResolvedValue(undefined); mocks.probe.mockResolvedValue("0.164.0");
  mocks.telemetry.mockReturnValue({ collect: vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] })) });
});
afterEach(async () => {
  for (const cancellation of cancellations) cancellation.abort(); cancellations.clear();
  await Promise.allSettled(running); running.clear();
  for (const store of stores) store.close(); stores.clear();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it("rejects a selected repository nested in a retained project's worktree while scalars and heartbeats continue", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-repository-admission-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  const retainedProject = { projectId: retainedProjectId, repoUrl: "https://git.example/team/retained.git", localPath: path.join(homeDirectory, "retained") };
  const worktreePath = path.join(retainedProject.localPath, ".worktrees", "daynight", taskId);
  const ownedFile = path.join(worktreePath, "unfinished.txt");
  await mkdir(worktreePath, { recursive: true }); await writeFile(ownedFile, "retained unfinished work\n");
  const selectedProject = { projectId: selectedProjectId, repoUrl: "https://git.example/team/selected.git", localPath: path.join(worktreePath, "nested-repository") };
  const source = stringify({ serverUrl: serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId, worker: {
    agentControlMode: "web", agent: "invalid-stale-local-agent", maxConcurrent: 0, args: false,
    repositories: [{ projectId: selectedProjectId, remote: selectedProject.repoUrl, path: selectedProject.localPath }],
  } });
  await writeFile(paths.configFile, source);
  const store = openWorkerStore(paths.databaseFile); stores.add(store); store.registerProject(retainedProject);
  const localTask = store.activateTask(store.registerPending({ projectId: retainedProjectId, taskId, claimId, agent: "codex", agentControlMode: "web" }));
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); stores.add(webStore);
  const frozen = webStore.register({ projectId: retainedProjectId, taskId, claimId, worktreeId, project: retainedProject, serverOrigin, workerId, userId,
    configuration: { agent: "codex", agentControlMode: "web", model: "retained-model", args: [], recoveryLimit: 2 } }, Date.now());
  const task: Task = { type: "task", parentId: null,
    id: taskId, projectId: retainedProjectId, title: "Retained unfinished task", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId,
    requiredPlatform: null, startedAt: workerTelemetryTime, completedAt: null, cancelledAt: null, version: 1n,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime,
    properties: { worker: { claimId, state: "active", userId, workerId, machine: { id: uuid(8), name: "original" }, platform: "linux", agent: "codex", agentControlMode: "web", worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } },
  };
  const originalClaim = readWorkerClaim(task.properties);
  const target: WorkerCloudDesired = { revision: "2", updatedAt: workerTelemetryTime, value: { maxConcurrent: 4, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false,
    native: { agent: "codex", model: "cloud-model", args: [] }, projects: [{ projectId: selectedProjectId, nativeOverrides: {} }] } };
  let observationRevision = 0n;
  const report = vi.fn(async (_workerId: string, _body: unknown, configuration: WorkerCloudReport) => {
    const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
    if (observationAccepted) observationRevision++;
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(observationRevision), observationAccepted } };
  });
  const remote = {
    serverOrigin, currentUserId: vi.fn(async () => userId), configuration: vi.fn(async () => ({ desired: target, observationRevision: "0", observation: null })), reportConfiguration: report, report: vi.fn(),
    project: vi.fn(async () => ({ id: selectedProjectId, repoUrl: selectedProject.repoUrl })), resolveProject: vi.fn(async () => ({ id: selectedProjectId, repoUrl: selectedProject.repoUrl })),
    ownInventory: vi.fn(async () => [task]), readTask: vi.fn(async () => task), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => task),
  };
  mocks.remote.mockReturnValue(remote);
  const prepareRepository = vi.fn(async () => {}), dispose = vi.fn(async () => {});
  mocks.git.mockReturnValue(Object.assign({ prepareRepository, listWorktrees: vi.fn(async () => []), dispose }, { scanWorktrees: scanFromList }));
  const advance = vi.fn(async (record: WebTask) => record), cleanup = vi.fn(async (record: WebTask) => ({ task: record, complete: true }));
  mocks.backend.mockReturnValue({ advance, cleanup });
  const launch = vi.fn(); mocks.launcher.mockReturnValue({ launch });
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const execution = runWorker({ homeDirectory, packageDirectory: path.resolve("package"), workingDirectory: homeDirectory, version: "0.41.0", signal: cancellation.signal });
  running.add(execution); void execution.catch(() => {});
  let settled = false; void execution.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(report.mock.calls.at(-1)?.[2].observation?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "maxConcurrent" }, targetRevision: "2", appliedValue: 4, state: "applied" }),
      expect.objectContaining({ key: { kind: "projectPreparation", projectId: selectedProjectId }, targetRevision: "2", appliedValue: null, state: "error", error: expect.objectContaining({ category: "repository", phase: "prepare" }) }),
    ]));
  }, { timeout: 3500, interval: 10 });
  expect(store.getProject({ projectId: selectedProjectId })).toBeNull(); expect(prepareRepository).not.toHaveBeenCalled();
  expect(store.listProjects()).toEqual([retainedProject]); expect(store.getTask(localTask)).toEqual(localTask);
  expect(webStore.getTask(localTask)).toEqual(frozen); expect(await readFile(ownedFile, "utf8")).toBe("retained unfinished work\n");
  expect(task.status).toBe("in_progress"); expect(readWorkerClaim(task.properties)).toEqual(originalClaim);
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ projectId: retainedProjectId, taskId, claimId, worktreeId }), { kind: "shutdown", deadline: expect.any(Number), signal: expect.any(AbortSignal), immediateStop: true }), { timeout: 3500, interval: 10 });
  const before = report.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000); await vi.waitFor(() => expect(report.mock.calls.length).toBeGreaterThan(before));
  expect(settled).toBe(false); expect(await readFile(paths.configFile, "utf8")).toBe(source);
  cancellation.abort(); await execution;
  expect(advance).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled(); expect(remote.candidates).not.toHaveBeenCalled(); expect(remote.claim).not.toHaveBeenCalled();
  expect(store.getTask(localTask)).toEqual(localTask); expect(webStore.getTask(localTask)).toEqual(frozen);
  expect(await readFile(ownedFile, "utf8")).toBe("retained unfinished work\n");
});
