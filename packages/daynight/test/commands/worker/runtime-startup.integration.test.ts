import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import * as configurationFiles from "../../../src/config/files.js";
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
  value: { maxConcurrent, pollIntervalMs: 1, recoveryLimit: 3, native: { agent: "codex", model: "cloud-model", args: [] }, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) },
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

describe("worker cloud-first startup", () => {
  it("keeps pre-cancelled startup before identity, locks, databases and remote requests", async () => {
    const f = await fixture(false, false);
    const before = (await readdir(f.homeDirectory, { recursive: true })).sort();
    const cancellation = new AbortController(); cancellation.abort(new Error("Startup cancelled."));
    await runWorker({ ...f, signal: cancellation.signal });
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(before);
    for (const factory of [mocks.coordinator, mocks.herdr, mocks.git, mocks.remote, mocks.reporter]) expect(factory).not.toHaveBeenCalled();
  });

  it("starts its configuration channel for an empty cloud selection without invoking a picker", async () => {
    const f = await fixture(false, false), cancellation = new AbortController();
    const remote = mocks.remote.mock.results.length === 0 ? mocks.remote() : mocks.remote.mock.results[0]!.value;
    remote.configuration.mockResolvedValue(resource(desired([])));
    mocks.remote.mockClear();
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      expect(remote.configuration).toHaveBeenCalledExactlyOnceWith(workerId, expect.any(AbortSignal));
      expect(options.configuration!.capture().bootstrap).toBeNull();
      cancellation.abort(); return reporter();
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("ignores stale managed YAML when the cloud target already exists", async () => {
    const f = await fixture(false, false), cancellation = new AbortController();
    const source = stringify({ ...f.document, worker: { maxConcurrent: 0, agent: "removed-agent", args: false, repositories: null } });
    await writeFile(f.paths.configFile, source);
    mocks.remote().configuration.mockResolvedValue(resource(desired([], 4)));
    mocks.remote.mockClear();
    mocks.reporter.mockImplementation((options: ReporterOptions) => { expect(options.configuration!.capture().bootstrap).toBeNull(); cancellation.abort(); return reporter(); });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("propagates cloud lookup failures before constructing native or task backends", async () => {
    const f = await fixture();
    const failure = new Error("Configuration service unavailable.");
    mocks.remote().configuration.mockRejectedValue(failure); mocks.remote.mockClear();
    await expect(runWorker(f)).rejects.toBe(failure);
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("passes one raw local bootstrap through the reporter and uses the returned cloud target", async () => {
    const f = await fixture();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockRejectedValue(new ApiError({ operation: "worker.configuration" }, "response", {
      cause: new Error("not found"), status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "bootstrap-test" },
    }));
    const cancellation = new AbortController(); cancellations.add(cancellation);
    let accepted: Promise<void> | undefined;
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      const sent = options.configuration!.capture();
      expect(sent.bootstrap).toMatchObject({ maxConcurrent: 7, projects: [{ projectId: uuid(1), nativeOverrides: {} }] });
      expect(sent.observation).toBeNull();
      accepted = options.configuration!.accept(sent, { desired: desired([uuid(1)], 3), observationRevision: "0", observationAccepted: false });
      return reporter();
    });
    finishAtTick(cancellation, options => { expect(options.maxConcurrent).toBe(3); expect(options.globalConfiguration).not.toBeNull(); expect(options.globalConfiguration!.model).toBe("cloud-model"); });
    const { running } = start(f, { signal: cancellation.signal });
    await running; await accepted;
    expect(remote.reportConfiguration).not.toHaveBeenCalled();
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("prepares a selected local binding before making it available for reconciliation", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    finishAtTick(cancellation, options => {
      expect(options.store.listProjects()).toEqual([{ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }]);
      expect(options.repositories).toHaveLength(1);
      expect(options.repositories[0]!.configuration.model).toBe("cloud-model");
      expect(options.maxConcurrent).toBe(1);
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(
      { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }, expect.anything(),
    );
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("prepares a cloud project without a local mapping under the configured repository root", async () => {
    const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
    const root = path.join(f.homeDirectory, "cloud-repositories");
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [], repositoryRoot: root } }));
    const expected = { projectId: uuid(1), repoUrl: remoteUrl, localPath: path.join(root, "git.example", "team", "repo") };
    finishAtTick(cancellation, options => {
      expect(options.store.getProject({ projectId: uuid(1) })).toEqual(expected);
      expect(options.repositories[0]!.project).toEqual(expected);
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
  });

  it("keeps configuration exchange live without publishing incomplete inventory and publishes after mapping recovers", async () => {
    const f = await fixture(), controller = new AbortController(); cancellations.add(controller);
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockRejectedValue(new Error("Project lookup unavailable"));
    const reported = reporter();
    let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reported; });
    const inventory = { observedAt: "2026-11-04T00:00:00Z", claims: [] };
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      try {
        expect(options.store.getProject({ projectId: uuid(1) })).toBeNull();
        options.onInventory!(inventory);
        expect(reported.publishInventory).not.toHaveBeenCalled();
        const captured = channel!.capture();
        expect(captured.observation).not.toBeNull();
        remote.project.mockResolvedValue({ id: uuid(1), repoUrl: remoteUrl });
        await channel!.accept(captured, { desired: { ...desired(), revision: "2" }, observationRevision: "0", observationAccepted: false });
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(1) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenCalledExactlyOnceWith(inventory);
      } finally { controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
  });

  it("does not publish an in-flight inventory after the cloud target adds an unmapped project", async () => {
    const f = await fixture(), controller = new AbortController(); cancellations.add(controller);
    const second = { projectId: uuid(2), remote: "https://git.example/team/second.git", path: path.join(f.homeDirectory, "second") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, repositories: [f.repository, second] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    let secondAvailable = false;
    remote.project.mockImplementation(async (id: string) => {
      if (id === uuid(2) && !secondAvailable) throw new Error("Project lookup unavailable");
      return { id, repoUrl: id === uuid(1) ? remoteUrl : second.remote };
    });
    const reported = reporter(); let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reported; });
    const inventory = { observedAt: "2026-11-04T00:00:00Z", claims: [] };
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      try {
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(1) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        const captured = channel!.capture();
        await channel!.accept(captured, { desired: { ...desired([uuid(1), uuid(2)]), revision: "2" }, observationRevision: "0", observationAccepted: false });
        options.onInventory!(inventory);
        expect(reported.publishInventory).not.toHaveBeenCalled();
        secondAvailable = true;
        await channel!.accept(channel!.capture(), { desired: { ...desired([uuid(1), uuid(2)]), revision: "3" }, observationRevision: "0", observationAccepted: false });
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(2) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenCalledExactlyOnceWith(inventory);
      } finally { controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
  });

  it("registers every successfully prepared cloud project mapping on an empty database", async () => {
    const f = await fixture(), controller = new AbortController(); cancellations.add(controller);
    const second = { projectId: uuid(2), remote: "https://git.example/team/second.git", path: path.join(f.homeDirectory, "second") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, repositories: [f.repository, second] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(1), uuid(2)])));
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : second.remote }));
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      try {
        await vi.waitFor(() => expect(options.store.listProjects()).toEqual(expect.arrayContaining([
          { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path },
          { projectId: uuid(2), repoUrl: second.remote, localPath: second.path },
        ])), { timeout: 5000, interval: 10 });
        expect(options.store.listProjects()).toHaveLength(2);
      } finally { controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce();
  });

  it("checks the cloud again before reusing a previously applied restart cache", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    finishAtTick(cancellation);
    await runWorker({ ...f, signal: cancellation.signal });
    expect(await readFile(path.join(f.paths.workerDirectory, "configuration.json"), "utf8")).toContain("cloud-model");
    const probes = mocks.probe.mock.calls.length;
    const failure = new Error("Cloud lookup unavailable on restart.");
    mocks.remote.mock.results[0]!.value.configuration.mockRejectedValue(failure);
    mocks.coordinator.mockClear();
    await expect(runWorker(f)).rejects.toBe(failure);
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.probe).toHaveBeenCalledTimes(probes);
  });

  it("retains an existing SSH path mapping and task record while applying cloud runtime settings", async () => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const ssh = "git@git.example:team/repo.git";
    const binding = { projectId: uuid(1), repoUrl: ssh, localPath: f.repository.path };
    f.store!.registerProject(binding);
    const original = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", sessionId: uuid(5) });
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...f.repository, remote: ssh }], maxConcurrent: 9, model: "stale-local-model" } }));
    finishAtTick(cancellation, options => { expect(options.globalConfiguration).not.toBeNull(); expect(options.globalConfiguration!.model).toBe("cloud-model"); });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual(binding);
    expect(f.store!.getProject(binding)).toEqual(binding); expect(f.store!.getTask(original)).toEqual(original);
  });

  it("starts a valid project native override while the independent global native tuple fails", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, agentControlMode: "web" } }));
    const target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: {
      ...target.value, native: { ...target.value.native, args: ["--search"] },
      projects: [{ projectId: uuid(1), nativeOverrides: { args: [] } }],
    } })); mocks.remote.mockClear();
    finishAtTick(cancellation, options => {
      expect(options.globalConfiguration).toBeNull();
      expect(options.repositories).toEqual([{ project: { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }, configuration: { agent: "codex", agentControlMode: "web", model: "cloud-model", args: [], recoveryLimit: 3 } }]);
      const report = (mocks.reporter.mock.calls[0]![0] as ReporterOptions).configuration!.capture();
      expect(report.observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "native" }, state: "error", appliedValue: null }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "applied", appliedValue: { agent: "codex", model: "cloud-model", args: [] } }),
      ]));
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce();
  });

  it("keeps Herdr-only defaults observable while reporting unsupported assistant arguments", async () => {
    const f = await fixture(), target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: { ...target.value, native: { ...target.value.native, args: ["--search"] } } }));
    mocks.remote.mockClear();
    const actual = await vi.importActual<typeof import("../../../src/commands/worker/bots/host-capabilities.js")>("../../../src/commands/worker/bots/host-capabilities.js");
    mocks.hostCollector.mockImplementation((options: Parameters<typeof actual.createAssistantHostCollector>[0]) => actual.createAssistantHostCollector({ ...options,
      resolveExecutable: () => { throw Object.assign(new Error("Fixture has no native assistant executable."), { code: "ENOENT" }); },
    }));
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const coordinator = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      expect(coordinator.globalConfiguration).toMatchObject({ agentControlMode: "herdr", args: ["--search"] });
      const operation = createOperation();
      try {
        const sample = await (mocks.reporter.mock.calls[0]![0] as ReporterOptions).collect(operation);
        expect(sample.telemetry.versions.daynight).toBe(f.version);
        expect(sample.telemetry.assistantHost?.providers.find(provider => provider.provider === "codex")).toEqual({ provider: "codex", available: false, reason: "unsupported_arguments", model: null, args: [] });
        expect(sample.issues).toEqual(expect.arrayContaining([expect.objectContaining({ component: "assistantHost_codex", code: "unavailable" })]));
      } finally { operation.dispose(); }
    } finally { cancellation.abort(); await running; }
  });

  it("keeps a prepared project's frozen Web recovery available when its new native defaults fail", async () => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, agentControlMode: "web" } }));
    const project = f.store!.registerProject({ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path });
    const localTask = f.store!.activateTask(f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web" }));
    const frozen = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-before-change", args: [] as string[], recoveryLimit: 2 };
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"));
    web.register({ ...localTask, worktreeId: uuid(9), project, serverOrigin: origin, workerId, userId: uuid(6), configuration: frozen }, Date.now()); web.close();
    const target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: { ...target.value, native: { ...target.value.native, args: ["--search"] } } })); mocks.remote.mockClear();
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      let current = options;
      return {
        updateConfiguration: vi.fn(value => { current = { ...options, ...value }; }),
        tick: vi.fn(async () => {
          if (!current.readyProjectIds?.includes(uuid(1))) return;
          expect(current.globalConfiguration).toBeNull(); expect(current.repositories).toEqual([]);
          expect(options.webStore!.getTask(localTask)!.configuration).toEqual(frozen);
          cancellation.abort();
        }),
        shutdown: vi.fn(async () => true),
      };
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(f.store!.getTask(localTask)).toEqual(localTask);
  });

  it.each([false, true])("starts an empty cloud selection without repository discovery or interactive preparation (warm: %s)", async warm => {
    const f = await fixture(warm, false), controller = new AbortController();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([])));
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.repositories).toEqual([]);
      expect(options.store.listProjects()).toEqual([]);
      expect(options.store.listTasks()).toEqual([]);
      expect(options.store.listCleanupSchedules()).toEqual([]);
      controller.abort();
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(remote.resolveProject).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("captures service credentials and worker settings from one configuration source", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    const replacement = stringify({ ...f.document, serverUrl: "https://other.example", worker: { repositories: [], maxConcurrent: 7 } });
    const originalRead = configurationFiles.readConfigurationSource;
    let replaced = false;
    const read = vi.spyOn(configurationFiles, "readConfigurationSource").mockImplementation(async (...args) => {
      const source = await originalRead(...args);
      if (!replaced) { await writeFile(`${f.paths.configFile}.next`, replacement); await rename(`${f.paths.configFile}.next`, f.paths.configFile); replaced = true; }
      return source;
    });
    cancellations.add(controller);
    finishAtTick(controller, options => {
      expect(options.serverOrigin).toBe(origin);
      expect(options.maxConcurrent).toBe(1);
      expect(options.repositories).toHaveLength(1);
    });
    try {
      await runWorker({ ...f, signal: controller.signal });
      expect(mocks.remote.mock.calls[0]![0]).toEqual({ serverUrl: origin, serverToken: token });
    } finally { read.mockRestore(); }
  });

  it("rejects a second zero-repository runner under the same worker lock", async () => {
    const f = await fixture(false, false); const controller = new AbortController();
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.coordinator.mockReturnValue(coordinator(async () => { entered(); }));
    const first = runWorker({ ...f, signal: controller.signal });
    try {
      await started;
      await expect(runWorker(f)).rejects.toThrow(/already running|lock/i);
      expect(mocks.coordinator).toHaveBeenCalledOnce();
    } finally { controller.abort(); await first; }
  });

  it("keeps original task and cleanup responsibility with no configured repositories", async () => {
    const f = await fixture(true, false); const controller = new AbortController();
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    const binding = { projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path };
    f.store!.registerProject(binding);
    const pending = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex" });
    f.store!.activateTask(pending);
    const cleanup = f.store!.saveCleanupSchedule({ ...pending, worktreeId: uuid(7) }, { deadline: 100, failures: 2, nextAttemptAt: 50, stage: "stop", lastError: "unconfirmed" });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.repositories).toEqual([]);
      expect(options.store.getTask(pending)?.status).toBe("active");
      expect(options.store.getCleanupSchedule(pending)).toEqual(cleanup);
      expect(options.maxConcurrent).toBe(1);
      controller.abort(new Error("Original inventory observed."));
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(f.store!.getTask(pending)?.status).toBe("active");
    expect(f.store!.getCleanupSchedule(pending)).toEqual(cleanup);
  });

  it("reestablishes removal responsibility for an excluded retained project on restart", async () => {
    const f = await fixture(true, false), controller = new AbortController(); cancellations.add(controller);
    f.store!.registerProject({ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path });
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reporter(); });
    const stopped = vi.fn(async () => {});
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({
      ...coordinator(async () => {
        await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 5000, interval: 10 });
        expect(channel!.capture().observation!.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: { kind: "projectRemoval", projectId: uuid(1) }, targetRevision: "1" }),
        ]));
        expect(options.readyProjectIds).toEqual([]);
        controller.abort();
      }),
      stopProject: stopped,
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(stopped).toHaveBeenCalledWith(uuid(1), expect.any(AbortSignal));
    expect(f.store!.getProject({ projectId: uuid(1) })).not.toBeNull();
  });

});

it.skipIf(process.platform === "win32")("binds an explicit Agent CLI alias only in the worker's native environment", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  const target = path.join(f.homeDirectory, "development-cli");
  await writeFile(target, "#!/bin/sh\nprintf dev\n", { mode: 0o700 });
  await writeFile(f.paths.configFile, stringify({ ...f.document, agentCliAliases: { daynight: target } }));
  const originalPath = process.env.PATH;
  finishAtTick(cancellation, options => { void options.herdr.attachment; });
  await runWorker({ ...f, signal: cancellation.signal });
  const options = mocks.herdr.mock.calls[0]![0];
  expect(options.agentEnvironment.PATH).toContain(path.join(f.paths.stateDirectory, "agent-cli-aliases"));
  expect(options.agentEnvironment).toEqual({ PATH: options.agentEnvironment.PATH, DN_CONFIG_DIR: f.paths.stateDirectory });
  expect(process.env.PATH).toBe(originalPath); expect(options.environment).toBeUndefined();
});

it("retains committed Worker state while a Web state failure leaves the configuration channel available", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const invalid = new Database(webFile);
  invalid.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=4"); invalid.close();
  mocks.emit.mockImplementation((event: { error?: unknown }) => { if (event.error !== undefined) cancellation.abort(); });
  await runWorker({ ...f, signal: cancellation.signal });
  expect(mocks.reporter).toHaveBeenCalledOnce(); expect(mocks.coordinator).not.toHaveBeenCalled();
  expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "reconciliation-error", error: expect.objectContaining({ message: expect.stringContaining("unsupported-version") }) }));
  expect(mocks.reporter.mock.results[0]!.value.stop).toHaveBeenCalledOnce();
  const worker = new Database(f.paths.databaseFile); expect(worker.pragma("user_version", { simple: true })).toBe(11);
  expect(worker.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 }); worker.close();
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(4);
  expect(web.prepare("SELECT value FROM retained").get()).toEqual({ value: "original" });
  web.exec("DROP TABLE retained; CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT; PRAGMA user_version=1"); web.close();
  mocks.emit.mockImplementation(() => {});
  const repaired = new AbortController(); cancellations.add(repaired); finishAtTick(repaired);
  await runWorker({ ...f, signal: repaired.signal });
  expect(mocks.coordinator).toHaveBeenCalledOnce();
  const upgradedWeb = new Database(webFile);
  expect(upgradedWeb.pragma("user_version", { simple: true })).toBe(3);
  upgradedWeb.close();
  const unchangedWorker = new Database(f.paths.databaseFile);
  expect(unchangedWorker.pragma("user_version", { simple: true })).toBe(11);
  unchangedWorker.close();
});

it("rebuilds unknown zero-version Web state before starting its coordinator", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const original = new Database(webFile); original.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('discarded')"); original.close();
  finishAtTick(cancellation);
  await runWorker({ ...f, signal: cancellation.signal });
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(3);
  expect(web.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: "executions" }, { name: "orchestration_blockers" }]);
  expect(web.prepare("SELECT * FROM executions").all()).toEqual([]); web.close();
});

it("starts Bot management with no projects and preserves the Worker lock through Bot shutdown", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { run: vi.fn(async (signal: AbortSignal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }), shutdown: vi.fn(async () => {
      expect(await readFile(f.paths.lockFile, "utf8")).toContain(String(process.pid));
      expect(options.store.list(options.owner)).toEqual([]);
    }) };
  });
  mocks.coordinator.mockImplementation(() => coordinator(async () => cancellation.abort()));
  await runWorker({ ...f, signal: cancellation.signal });
  expect(mocks.bots).toHaveBeenCalledOnce();
  expect(botOptions.owner).toEqual({ serverOrigin: origin, ownerUserId: uuid(6), workerId });
  expect(mocks.bots.mock.results[0]!.value.run).toHaveBeenCalledOnce();
  expect(mocks.bots.mock.results[0]!.value.shutdown).toHaveBeenCalledOnce();
  expect(() => botOptions.store.list(botOptions.owner)).toThrow();
  expect((await readdir(f.paths.workerDirectory))).not.toContain("instance.lock");
});

it("attempts Task shutdown and releases stores and the lock when Bot shutdown fails", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  const failure = new Error("Bot writer stop remains unconfirmed");
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { run: async () => {}, shutdown: async () => { throw failure; } };
  });
  const tasks = coordinator(async () => cancellation.abort()); mocks.coordinator.mockReturnValue(tasks);
  await expect(runWorker({ ...f, signal: cancellation.signal })).rejects.toBe(failure);
  expect(tasks.shutdown).toHaveBeenCalledOnce();
  expect(() => botOptions.store.list(botOptions.owner)).toThrow();
  expect((await readdir(f.paths.workerDirectory))).not.toContain("instance.lock");
});
