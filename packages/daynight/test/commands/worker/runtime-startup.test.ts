import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import * as configurationFiles from "../../../src/config/files.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { changeWorkerRepositories, readWorkerRepositorySnapshot } from "../../../src/commands/worker/repositories.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn() }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", () => ({ createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const workerId = uuid(4);
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const fixture = async (warm = false, configured = false) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-startup-tests");
  await mkdir(parent, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(parent, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(warm ? paths.workerDirectory : paths.stateDirectory, { recursive: true });
  const repository = { remote: "https://git.example/team/repo.git", path: path.join(homeDirectory, "repo"), projectId: uuid(1) };
  const document = { serverUrl: origin, serverToken: token, workerId, worker: { repositories: configured ? [repository] : [], maxConcurrent: 1 } };
  const source = stringify(document);
  await writeFile(paths.configFile, source);
  let store: WorkerStore | undefined;
  if (warm) { store = openWorkerStore(paths.databaseFile); stores.add(store); }
  return { homeDirectory, packageDirectory: path.resolve("package"), paths, source, document, repository, store };
};
const coordinator = (tick: () => Promise<void>) => ({ tick: vi.fn(tick), shutdown: vi.fn(async () => true) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), tasks: { hasUnmanagedWorkspaces: vi.fn(async () => false) }, attachment: {} });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockReturnValue(coordinator(async () => {}));
});
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worker repository preparation lifecycle", () => {
  it("keeps cold cancellation before identity, locks, databases and native controllers", async () => {
    const f = await fixture();
    const before = (await readdir(f.homeDirectory, { recursive: true })).sort();
    const failure = new Error("Project selection cancelled.");
    const prepareRepositories = vi.fn(async () => { throw failure; });
    await expect(runWorker({ ...f, prepareRepositories })).rejects.toBe(failure);
    expect(prepareRepositories).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    for (const factory of [mocks.coordinator, mocks.herdr, mocks.git, mocks.remote]) expect(factory).not.toHaveBeenCalled();
  });

  it("requires a repository after a successful cold guide without creating runtime state", async () => {
    const f = await fixture();
    const before = (await readdir(f.homeDirectory, { recursive: true })).sort();
    const prepareRepositories = vi.fn(async () => {});
    await expect(runWorker({ ...f, prepareRepositories })).rejects.toThrow("did not select any repositories");
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(before);
    expect(mocks.coordinator).not.toHaveBeenCalled();
  });

  it("bypasses the guide and persists configured project mappings before its first reconciliation", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    const prepareRepositories = vi.fn(async () => { throw new Error("Configured startup must not prompt."); });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.store.listProjects()).toEqual([{ projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path }]);
      expect(options.repositories).toHaveLength(1);
      const acceptsOwner = mocks.herdr.mock.calls[0]![0].acceptsOwner;
      expect(acceptsOwner({ projectId: uuid(1) })).toBe(true);
      expect(acceptsOwner({ projectId: uuid(100) })).toBe(false);
      options.store.registerProject({ projectId: uuid(100), repoUrl: "https://git.example/another.git", localPath: path.join(f.homeDirectory, "another") });
      expect(acceptsOwner({ projectId: uuid(100) })).toBe(true);
      controller.abort(new Error("Startup observed."));
    }));
    await runWorker({ ...f, signal: controller.signal, prepareRepositories });
    expect(prepareRepositories).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(
      { projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path }, expect.anything(),
    );
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it.each([false, true])("considers only locally proven Git worktrees before changing a project binding: %s", async (owned) => {
    const f = await fixture(true, true); const controller = new AbortController();
    const previous = { projectId: f.repository.projectId, repoUrl: f.repository.remote, localPath: path.join(f.homeDirectory, "previous-repo") };
    f.store!.registerProject(previous);
    const owner = { projectId: previous.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(5) };
    if (owned) f.store!.registerPending({ ...owner, agent: "codex" });
    const listWorktrees = vi.fn(async (_project: unknown, _operation: unknown, acceptsOwner: (value: typeof owner) => boolean) => {
      expect(acceptsOwner(owner)).toBe(owned);
      return acceptsOwner(owner) ? [{ owner }] : [];
    });
    mocks.git.mockReturnValue({ listWorktrees, prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });
    mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Startup observed.")); }));
    const running = runWorker({ ...f, signal: controller.signal });
    if (owned) {
      await expect(running).rejects.toThrow("Owned worktrees prevent changing");
      expect(f.store!.getProject(previous)).toEqual(previous); expect(mocks.coordinator).not.toHaveBeenCalled();
    } else {
      await running;
      expect(f.store!.getProject(previous)?.localPath).toBe(f.repository.path); expect(mocks.coordinator).toHaveBeenCalledOnce();
    }
    expect(listWorktrees).toHaveBeenCalledOnce();
  });

  it.each([true, false])("retains the daemon exactly when unmanaged workspaces remain after successful managed shutdown: %s", async (unmanaged) => {
    const f = await fixture(false, true); const controller = new AbortController(); const messages: string[] = [];
    const lifecycle = coordinator(async () => { controller.abort(new Error("Shutdown requested.")); });
    const hasUnmanagedWorkspaces = vi.fn(async () => { expect(lifecycle.shutdown).toHaveBeenCalledOnce(); return unmanaged; });
    const stopInstance = vi.fn(async () => {});
    mocks.herdr.mockReturnValue({ stopInstance, tasks: { hasUnmanagedWorkspaces } });
    mocks.coordinator.mockReturnValue(lifecycle);
    await runWorker({ ...f, signal: controller.signal, log: (message) => messages.push(message) });
    expect(hasUnmanagedWorkspaces).toHaveBeenCalledOnce();
    expect(stopInstance).toHaveBeenCalledTimes(unmanaged ? 0 : 1);
    expect(messages.some((message) => message.includes("shutdown-error"))).toBe(false);
  });

  it("retains the daemon and exposes failures to inspect remaining workspaces", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    const failure = new Error("Herdr snapshot could not be read.");
    const hasUnmanagedWorkspaces = vi.fn(async () => { throw failure; }); const stopInstance = vi.fn();
    mocks.herdr.mockReturnValue({ stopInstance, tasks: { hasUnmanagedWorkspaces } });
    mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Shutdown requested.")); }));
    await expect(runWorker({ ...f, signal: controller.signal })).rejects.toBe(failure);
    expect(stopInstance).not.toHaveBeenCalled();
  });

  it("keeps the daemon when a known managed agent cannot stop", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    const lifecycle = coordinator(async () => { controller.abort(new Error("Shutdown requested.")); }); lifecycle.shutdown.mockResolvedValue(false);
    const hasUnmanagedWorkspaces = vi.fn(); const stopInstance = vi.fn();
    mocks.herdr.mockReturnValue({ stopInstance, tasks: { hasUnmanagedWorkspaces } }); mocks.coordinator.mockReturnValue(lifecycle);
    await expect(runWorker({ ...f, signal: controller.signal })).rejects.toThrow("Some task agents could not stop");
    expect(hasUnmanagedWorkspaces).not.toHaveBeenCalled(); expect(stopInstance).not.toHaveBeenCalled();
  });

  it.each([true, false])("retains an SSH binding and its six-column task after Project association (explicit ID: %s)", async (explicit) => {
    const f = await fixture(true, true); const remote = "git@git.example:team/repo.git";
    const { projectId: _projectId, ...withoutProjectId } = f.repository;
    const repository = { ...(explicit ? f.repository : withoutProjectId), remote };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [repository], maxConcurrent: 1, agent: "codex", model: "current-model" } }));
    const binding = { projectId: uuid(1), repoUrl: remote, localPath: f.repository.path };
    const claim = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex" as const, sessionId: uuid(5) };
    f.store!.registerProject(binding); const original = f.store!.registerPending(claim);
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    await changeWorkerRepositories({ paths: f.paths, homeDirectory: f.homeDirectory, snapshot,
      projects: [{ id: uuid(1), name: "Existing Project", repoUrl: f.repository.remote,
        settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" }], addProjectIds: [uuid(1)],
    });
    const controller = new AbortController();
    mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Original binding restarted.")); }));
    await runWorker({ ...f, signal: controller.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual(binding);
    expect(f.store!.getProject(binding)).toEqual(binding);
    expect(f.store!.getTask(claim)).toEqual(original);
  });

  it("reloads guided startup settings once before constructing its coordinator", async () => {
    const f = await fixture(true); const controller = new AbortController();
    let coordinatorOptions: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      coordinatorOptions = options;
      expect(options.maxConcurrent).toBe(5);
      return coordinator(async () => {
        await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository], maxConcurrent: 7 } }));
        expect(options.maxConcurrent).toBe(5);
        controller.abort(new Error("Startup settings observed."));
      });
    });
    const prepareRepositories = vi.fn(async () => {
      expect(mocks.coordinator).not.toHaveBeenCalled();
      expect(mocks.herdr).not.toHaveBeenCalled();
      await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository], maxConcurrent: 5 } }));
    });
    await runWorker({ ...f, signal: controller.signal, prepareRepositories });
    expect(prepareRepositories).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(coordinatorOptions!.maxConcurrent).toBe(5);
  });

  it("keeps prepared service and acquisition settings from one captured configuration source", async () => {
    const f = await fixture(true); const controller = new AbortController();
    const prepared = { ...f.document, worker: { repositories: [f.repository], maxConcurrent: 1, agent: "codex", model: "origin-a-model" } };
    const nextSource = stringify({ ...prepared,
      serverUrl: "https://origin-b.example", serverToken: "dn_pat_Zbcdefghijklmnopqrstuvwxyz1234567890",
      worker: { ...prepared.worker, repositories: [{ ...f.repository, path: path.join(f.homeDirectory, "origin-b-repository") }], model: "origin-b-model" },
    });
    const originalRead = configurationFiles.readConfigurationSource;
    let preparedSaved = false; let replacedAfterCapture = false;
    const read = vi.spyOn(configurationFiles, "readConfigurationSource").mockImplementation(async (...args) => {
      const source = await originalRead(...args);
      if (preparedSaved && !replacedAfterCapture) {
        await writeFile(`${f.paths.configFile}.next`, nextSource); await rename(`${f.paths.configFile}.next`, f.paths.configFile); replacedAfterCapture = true;
      }
      return source;
    });
    let coordinatorOptions: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      coordinatorOptions = options; return coordinator(async () => { controller.abort(new Error("Prepared snapshot observed.")); });
    });
    try {
      await runWorker({ ...f, signal: controller.signal, prepareRepositories: async () => {
        await writeFile(f.paths.configFile, stringify(prepared)); preparedSaved = true;
      } });
      expect(replacedAfterCapture).toBe(true); expect(await readFile(f.paths.configFile, "utf8")).toBe(nextSource);
      expect(mocks.remote.mock.calls[0]![0]).toEqual({ serverUrl: origin, serverToken: token });
      expect(coordinatorOptions!.serverOrigin).toBe(origin);
      expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual({ projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path });
      expect(coordinatorOptions!.repositories[0]!.configuration.model).toBe("origin-a-model");
    } finally { read.mockRestore(); }
  });

  it.each(["serverUrl", "serverToken"] as const)("refuses a changed %s after the warm guide before constructing resource controllers", async (field) => {
    const f = await fixture(true);
    await expect(runWorker({ ...f, prepareRepositories: async () => {
      await writeFile(f.paths.configFile, stringify({ ...f.document,
        [field]: field === "serverUrl" ? "https://changed.example" : "dn_pat_Zbcdefghijklmnopqrstuvwxyz1234567890",
        worker: { repositories: [f.repository], maxConcurrent: 1 },
      }));
    } })).rejects.toThrow("service or authentication changed");
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled();
  });

  it("does not run native work while warm repository discovery is pending", async () => {
    const f = await fixture(true); const failure = new Error("Project discovery failed.");
    const binding = { projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path };
    f.store!.registerProject(binding);
    const pending = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex" });
    f.store!.activateTask(pending);
    await expect(runWorker({ ...f, prepareRepositories: async () => {
      expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled();
      expect(f.store!.getTask(pending)?.status).toBe("active");
      throw failure;
    } })).rejects.toBe(failure);
    expect(f.store!.getTask(pending)?.status).toBe("active");
    expect(f.store!.getProject(binding)).toEqual(binding);
  });
});
