import { buildHerdrAgentArguments } from "../../../src/commands/worker/herdr/arguments.js";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import * as configurationFiles from "../../../src/config/files.js";
import * as configurationSource from "../../../src/commands/worker/configuration-source.js";
import { ApiError } from "../../../src/api/client.js";
import { createOperation } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, WorkerCloudResource } from "../../../src/api/worker-configuration.js";
import { runWorker as runWorkerRuntime } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { createWorkerReporter } from "../../../src/commands/worker/reporter.js";

type ReporterOptions = Parameters<typeof createWorkerReporter>[0];
const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), reporter: vi.fn(), probe: vi.fn(), emit: vi.fn(), bots: vi.fn(), hostCollector: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/runtime.js", () => ({ createManagedAssistantRuntime: mocks.bots }));
vi.mock("../../../src/commands/worker/bots/host-capabilities.js", () => ({ createAssistantHostCollector: mocks.hostCollector }));
vi.mock("../../../src/commands/worker/reporter.js", () => ({ createWorkerReporter: mocks.reporter }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", () => ({ createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/diagnostics.js", async original => ({
  ...await original<object>(), createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, filename: "worker.jsonl" }),
}));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const workerId = uuid(4);
const remoteUrl = "https://git.example/team/repo.git";
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const cancellations = new Set<AbortController>();
const executions = new Set<Promise<void>>();
const runWorker: typeof runWorkerRuntime = options => {
  const running = runWorkerRuntime(options); executions.add(running); void running.catch(() => {}); return running;
};
const desired = (projects: readonly string[] = [uuid(1)], maxConcurrent = 1): WorkerCloudDesired => ({
  revision: "1", updatedAt: "2026-11-04T00:00:00Z",
  value: { maxConcurrent, pollIntervalMs: 1000, recoveryLimit: 3, native: { agent: "codex", model: "cloud-model", args: [] }, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) },
});
const resource = (target: WorkerCloudDesired | null): WorkerCloudResource => ({ desired: target, observationRevision: "0", observation: null });
const fixture = async (warm = false, configured = true) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-startup-tests");
  await mkdir(parent, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(parent, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(warm ? paths.workerDirectory : paths.stateDirectory, { recursive: true });
  const repository = { remote: remoteUrl, path: path.join(homeDirectory, "repo"), projectId: uuid(1) };
  const document = { serverUrl: origin, serverToken: token, workerId, worker: { repositories: configured ? [repository] : [], maxConcurrent: 7 } };
  const source = stringify(document);
  await writeFile(paths.configFile, source);
  let store: WorkerStore | undefined;
  if (warm) { store = openWorkerStore(paths.databaseFile); stores.add(store); }
  return { homeDirectory, version: "0.41.0", workingDirectory: homeDirectory, packageDirectory: path.resolve("package"), paths, source, document, repository, store };
};
const coordinator = (tick: () => Promise<void>) => ({ tick: vi.fn(tick), updateConfiguration: vi.fn(), stopProject: vi.fn(async () => {}), shutdown: vi.fn(async () => true) });
const reporter = () => ({ trigger: vi.fn(), publishInventory: vi.fn(), recordClaim: vi.fn(), stop: vi.fn(async () => {}) });
const start = (f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof runWorker>[0]> = {}) => {
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const running = runWorker({ ...f, signal: cancellation.signal, ...extra }); executions.add(running);
  void running.catch(() => {});
  return { cancellation, running };
};
const finishAtTick = (cancellation: AbortController, check: (options: WorkerCoordinatorOptions) => void = () => {}) => {
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
    let current = options;
    return {
      updateConfiguration: vi.fn(value => { current = { ...current, ...value }; }),
      tick: vi.fn(async () => {
        if (!current.readyProjectIds?.includes(uuid(1))) return;
        try { check(current); } finally { cancellation.abort(); }
      }),
      shutdown: vi.fn(async () => true),
    };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emit.mockReset();
  mocks.bots.mockReturnValue({ run: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) });
  mocks.hostCollector.mockReturnValue({ collect: vi.fn(async () => undefined) });
  mocks.reporter.mockImplementation(reporter);
  mocks.remote.mockReturnValue({
    currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => resource(desired())),
    resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    reportConfiguration: vi.fn(), report: vi.fn(),
  });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}), listWorktrees: vi.fn(async () => []) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.probe.mockResolvedValue("0.164.0");
  mocks.coordinator.mockReturnValue(coordinator(async () => {}));
});
afterEach(async () => {
  for (const cancellation of cancellations) cancellation.abort(); cancellations.clear();
  await Promise.allSettled(executions); executions.clear();
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});


it("keeps cloud configuration current for new sessions and resumes the same native session after a Worker restart", async () => {
  const f = await fixture();
  const document = { ...f.document, worker: { ...f.document.worker, agent: "codex", model: "stale-local-model", args: ["--search"] } };
  const source = stringify(document);
  await writeFile(f.paths.configFile, source);
  const remote = mocks.remote(); mocks.remote.mockClear();
  const target = (model: string): WorkerCloudDesired => ({ ...desired(), value: { ...desired().value, native: { agent: "codex", model, args: ["--search"] } } });
  remote.configuration.mockResolvedValue(resource(target("previous-cloud-model")));
  const savedSession = uuid(800);
  const cwd = path.join(f.repository.path, ".worktrees", "daynight", uuid(801));
  const firstCancel = new AbortController(); cancellations.add(firstCancel);
  finishAtTick(firstCancel, options => {
    const configuration = options.repositories[0]!.configuration;
    expect(configuration.model).toBe("previous-cloud-model");
    const fresh = buildHerdrAgentArguments(configuration, cwd);
    expect(fresh.slice(0, 4)).toEqual(["--no-daemon", "--model", "previous-cloud-model", "--search"]);
    const resumed = buildHerdrAgentArguments(configuration, cwd, savedSession);
    expect(resumed.slice(0, 3)).toEqual(["--no-daemon", "resume", savedSession]);
    expect(resumed).toContain("--search");
  });
  await runWorker({ ...f, signal: firstCancel.signal });
  remote.configuration.mockResolvedValue(resource(target("current-cloud-model")));
  const restartedCancel = new AbortController(); cancellations.add(restartedCancel);
  finishAtTick(restartedCancel, options => {
    const configuration = options.repositories[0]!.configuration;
    expect(configuration.model).toBe("current-cloud-model");
    const fresh = buildHerdrAgentArguments(configuration, cwd);
    expect(fresh.slice(0, 4)).toEqual(["--no-daemon", "--model", "current-cloud-model", "--search"]);
    expect(fresh).not.toContain("stale-local-model");
    expect(fresh).not.toContain("previous-cloud-model");
    const resumed = buildHerdrAgentArguments(configuration, cwd, savedSession);
    expect(resumed.slice(0, 3)).toEqual(["--no-daemon", "resume", savedSession]);
    expect(resumed).toContain("--search");
  });
  await runWorker({ ...f, signal: restartedCancel.signal });
  expect(remote.configuration).toHaveBeenCalledTimes(2);
  expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
}, 30_000);
