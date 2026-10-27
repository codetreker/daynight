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
import type { CleanupState } from "../../../src/commands/worker/types.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockReturnValue({ tick: vi.fn(async () => {}), advanceCommittedCleanups: vi.fn(async () => {}), shutdown: vi.fn(async () => true) });
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
    expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(mocks.herdr).not.toHaveBeenCalled();
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
  });

  it("requires a repository after a successful cold guide without creating runtime state", async () => {
    const f = await fixture();
    const before = (await readdir(f.homeDirectory, { recursive: true })).sort();
    const prepareRepositories = vi.fn(async () => {});
    await expect(runWorker({ ...f, prepareRepositories })).rejects.toThrow("did not select any repositories");
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(before);
    expect(mocks.coordinator).not.toHaveBeenCalled();
  });

  it("bypasses repository selection when startup configuration is nonempty", async () => {
    const f = await fixture(false, true);
    const controller = new AbortController();
    const prepareRepositories = vi.fn(async () => { throw new Error("Configured startup must not prompt."); });
    mocks.coordinator.mockReturnValue({
      advanceCommittedCleanups: vi.fn(async () => {}), shutdown: vi.fn(async () => true),
      tick: vi.fn(async () => { controller.abort(new Error("Startup observed.")); }),
    });
    await runWorker({ ...f, signal: controller.signal, prepareRepositories });
    expect(prepareRepositories).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it.each(["task", "claimAttempt"] as const)("restarts a retained %s after Project association without replacing its SSH binding", async (retained) => {
    const f = await fixture(true, true);
    const remote = "git@git.example:team/repo.git";
    const { projectId: _projectId, ...withoutProjectId } = f.repository;
    const repository = retained === "claimAttempt" ? { ...withoutProjectId, remote } : { ...f.repository, remote };
    const source = stringify({ ...f.document, worker: { repositories: [repository], maxConcurrent: 1, agent: "codex", model: "original-model" } });
    await writeFile(f.paths.configFile, source);
    const binding = { serverOrigin: origin, projectId: uuid(1), repoUrl: remote, localPath: f.repository.path };
    const claim = { serverOrigin: origin, projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), workerId, worktreeId: uuid(5) };
    const configuration = { agent: "codex" as const, model: "original-model", args: [], recoveryLimit: 3 };
    const attempt = { taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId, workerId, userId: uuid(6), expectedVersion: "1", configuration };
    f.store!.registerProject(binding);
    if (retained === "task") f.store!.registerPending(claim, { kind: "new", configuration }, 10, uuid(6));
    else f.store!.beginClaimAttempt(binding, attempt);
    const originalTask = f.store!.getTask(claim);
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    await changeWorkerRepositories({ paths: f.paths, homeDirectory: f.homeDirectory, snapshot,
      projects: [{ id: uuid(1), name: "Existing Project", repoUrl: f.repository.remote,
        settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" }],
      addProjectIds: [uuid(1)],
    });
    const controller = new AbortController();
    const tick = vi.fn(async () => { controller.abort(new Error("Original binding restarted.")); });
    mocks.coordinator.mockReturnValue({ tick, advanceCommittedCleanups: vi.fn(async () => {}), shutdown: vi.fn(async () => true) });
    await runWorker({ ...f, signal: controller.signal });
    expect(tick).toHaveBeenCalledOnce();
    expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual(binding);
    expect(f.store!.getProject(binding)).toEqual({ ...binding, claimAttempt: retained === "claimAttempt" ? attempt : null });
    expect(f.store!.getTask(claim)).toEqual(originalTask);
    expect(f.store!.getClaimAttempt(binding)).toEqual(retained === "claimAttempt" ? attempt : null);
  });

  it("reloads selected startup settings once without hot reload or replacing the coordinator", async () => {
    const f = await fixture(true);
    const controller = new AbortController();
    let coordinatorOptions: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      coordinatorOptions = options;
      expect(options.maxConcurrent).toBe(1);
      return {
        advanceCommittedCleanups: vi.fn(async () => {}), shutdown: vi.fn(async () => true),
        tick: vi.fn(async () => {
          expect(options.maxConcurrent).toBe(5);
          await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository], maxConcurrent: 7 } }));
          expect(options.maxConcurrent).toBe(5);
          controller.abort(new Error("Startup settings observed."));
        }),
      };
    });
    const prepareRepositories = vi.fn(async () => {
      expect(mocks.coordinator).toHaveBeenCalledOnce();
      await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository], maxConcurrent: 5 } }));
    });
    await runWorker({ ...f, signal: controller.signal, prepareRepositories });
    expect(prepareRepositories).toHaveBeenCalledOnce();
    expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(coordinatorOptions!.maxConcurrent).toBe(5);
  });

  it("keeps prepared service and acquisition settings from one captured configuration source", async () => {
    const f = await fixture(true);
    const controller = new AbortController();
    const prepared = { ...f.document, worker: { repositories: [f.repository], maxConcurrent: 1, agent: "codex", model: "origin-a-model" } };
    const nextSource = stringify({ ...prepared,
      serverUrl: "https://origin-b.example", serverToken: "dn_pat_Zbcdefghijklmnopqrstuvwxyz1234567890",
      worker: { ...prepared.worker, repositories: [{ ...f.repository, path: path.join(f.homeDirectory, "origin-b-repository") }], model: "origin-b-model" },
    });
    const originalRead = configurationFiles.readConfigurationSource;
    let preparedSaved = false;
    let replacedAfterCapture = false;
    const read = vi.spyOn(configurationFiles, "readConfigurationSource").mockImplementation(async (...args) => {
      const source = await originalRead(...args);
      if (preparedSaved && !replacedAfterCapture) {
        await writeFile(`${f.paths.configFile}.next`, nextSource);
        await rename(`${f.paths.configFile}.next`, f.paths.configFile);
        replacedAfterCapture = true;
      }
      return source;
    });
    let coordinatorOptions: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      coordinatorOptions = options;
      return {
        advanceCommittedCleanups: vi.fn(async () => {}), shutdown: vi.fn(async () => true),
        tick: vi.fn(async () => { controller.abort(new Error("Prepared snapshot observed.")); }),
      };
    });
    try {
      await runWorker({ ...f, signal: controller.signal, prepareRepositories: async () => {
        await writeFile(f.paths.configFile, stringify(prepared));
        preparedSaved = true;
      } });
      expect(replacedAfterCapture).toBe(true);
      expect(await readFile(f.paths.configFile, "utf8")).toBe(nextSource);
      expect(mocks.remote.mock.calls[0]![0]).toEqual({ serverUrl: origin, serverToken: token });
      expect(coordinatorOptions!.serverOrigin).toBe(origin);
      expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toMatchObject({ serverOrigin: origin, localPath: f.repository.path });
      expect(coordinatorOptions!.repositories[0]!.configuration.model).toBe("origin-a-model");
    } finally { read.mockRestore(); }
  });

  it.each(["serverUrl", "serverToken"] as const)("refuses a changed %s after warm configuration instead of rebinding resources", async (field) => {
    const f = await fixture(true);
    const prepareRepositories = vi.fn(async () => {
      await writeFile(f.paths.configFile, stringify({ ...f.document,
        [field]: field === "serverUrl" ? "https://changed.example" : "dn_pat_Zbcdefghijklmnopqrstuvwxyz1234567890",
        worker: { repositories: [f.repository], maxConcurrent: 1 },
      }));
    });
    await expect(runWorker({ ...f, prepareRepositories })).rejects.toThrow("service or authentication changed");
    expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(mocks.coordinator.mock.calls[0]![0].serverOrigin).toBe(origin);
    expect(mocks.remote.mock.results[0]!.value.currentUserId).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).not.toHaveBeenCalled();
  });

  it.each(["terminal", "shutdown"] as const)("advances persisted %s cleanup while repository discovery remains held", async (kind: CleanupState["kind"]) => {
    const f = await fixture(true);
    const project = { serverOrigin: "https://previous-origin.example", projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path };
    f.store!.registerProject(project);
    const task = f.store!.registerPending({ ...project, taskId: uuid(2), claimId: uuid(3), workerId, worktreeId: uuid(5) },
      { kind: "new", configuration: { agent: "codex", model: "original-model", args: [], recoveryLimit: 2 } }, 1, uuid(6));
    f.store!.activateTask(task, 2);
    const startedAt = Date.now();
    const deadline = startedAt + 50;
    f.store!.beginCleanup(task, { kind, deadline, ...(kind === "terminal" ? { claimEnded: true as const } : {}) }, startedAt);
    let reportSelecting!: () => void;
    const selecting = new Promise<void>((resolve) => { reportSelecting = resolve; });
    let reportCleaned!: () => void;
    let failCleanup!: (error: Error) => void;
    const cleaned = new Promise<void>((resolve, reject) => {
      reportCleaned = resolve;
      failCleanup = reject;
    });
    const failure = new Error("The new service Project request failed after cleanup.");
    const advance = vi.fn(async (identity: Parameters<WorkerStore["getTask"]>[0]) => {
      await selecting;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>((resolve) => { setTimeout(resolve, remaining); });
      expect(f.store!.getTask(identity)!.cleanup!.deadline).toBe(deadline);
      const current = mocks.coordinator.mock.calls[0]![0].store as WorkerStore;
      const now = Date.now();
      current.recordCleanupInputOutcome(identity, "unavailable", now);
      current.recordCleanupResult(identity, "timed-out", null, now);
      current.confirmAgentStopped(identity, { agentStopped: true }, now);
      current.confirmWorkspaceClosed(identity, { workspaceClosed: true }, now);
      if (kind === "terminal") { current.confirmWorktreeDeleted(identity, { worktreeDeleted: true }, now); current.completeTask(identity, now); }
      reportCleaned();
    });
    mocks.coordinator.mockReturnValue({ advanceCommittedCleanups: advance, shutdown: vi.fn(async () => true), tick: vi.fn(async () => {}) });
    const prepareRepositories = vi.fn(async () => {
      const cleanupTimer = setTimeout(() => failCleanup(new Error("Committed cleanup did not advance while repository selection waited.")), 2_000);
      reportSelecting();
      try {
        await cleaned;
        expect(f.store!.getTask(task)!.cleanup).toMatchObject({ deadline, result: "timed-out", agentStopped: true, workspaceClosed: true });
        expect(mocks.remote.mock.results[0]!.value.currentUserId).not.toHaveBeenCalled();
        throw failure;
      } finally { clearTimeout(cleanupTimer); }
    });
    await expect(runWorker({ ...f, prepareRepositories })).rejects.toBe(failure);
    expect(f.store!.getTask(task)!.configuration!.model).toBe("original-model");
    expect(f.store!.getTask(task)!.cleanup!.deadline).toBe(deadline);
    expect(mocks.coordinator.mock.results[0]!.value.tick).not.toHaveBeenCalled();
  });
});
