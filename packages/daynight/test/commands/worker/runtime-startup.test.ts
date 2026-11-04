import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import * as configurationFiles from "../../../src/config/files.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { changeWorkerRepositories, readWorkerRepositorySnapshot } from "../../../src/commands/worker/repositories.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), reporter: vi.fn() }));
vi.mock("../../../src/commands/worker/reporter.js", () => ({ createWorkerReporter: mocks.reporter }));
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
  return { homeDirectory, version: "0.26.1", workingDirectory: homeDirectory, packageDirectory: path.resolve("package"), paths, source, document, repository, store };
};
const coordinator = (tick: () => Promise<void>) => ({ tick: vi.fn(tick), shutdown: vi.fn(async () => true) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reporter.mockReturnValue({ publishInventory: vi.fn(), recordClaim: vi.fn(), stop: vi.fn(async () => {}) });
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), resolveProject: vi.fn(async () => ({ id: uuid(1) })) });
  mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockReturnValue(coordinator(async () => {}));
});
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worker repository preparation lifecycle", () => {
  it.each([false, true])("starts without repositories or interactive preparation (warm: %s)", async (warm) => {
    const f = await fixture(warm); const controller = new AbortController();
    const prepareRepositories = vi.fn(async () => { throw new Error("Startup must not prompt."); });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.repositories).toEqual([]);
      expect(options.store.listProjects()).toEqual([]);
      expect(options.store.listTasks()).toEqual([]);
      expect(options.store.listCleanupSchedules()).toEqual([]);
      controller.abort(new Error("Startup observed."));
    }));
    await runWorker({ ...f, signal: controller.signal, ...{ prepareRepositories } });
    expect(prepareRepositories).not.toHaveBeenCalled();
    expect(mocks.remote.mock.results[0]!.value.resolveProject).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).not.toHaveBeenCalled();
    expect(mocks.herdr).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("persists configured project mappings before its first reconciliation", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.store.listProjects()).toEqual([{ projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path }]);
      expect(options.repositories).toHaveLength(1);
      controller.abort(new Error("Startup observed."));
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(
      { projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path }, expect.anything(),
    );
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
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
        settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" }], addProjectIds: [uuid(1)],
    });
    const controller = new AbortController();
    mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Original binding restarted.")); }));
    await runWorker({ ...f, signal: controller.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual(binding);
    expect(f.store!.getProject(binding)).toEqual(binding);
    expect(f.store!.getTask(claim)).toEqual(original);
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
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.serverOrigin).toBe(origin);
      expect(options.maxConcurrent).toBe(1);
      expect(options.repositories).toHaveLength(1);
      controller.abort();
    }));
    try {
      await runWorker({ ...f, signal: controller.signal });
      expect(mocks.remote.mock.calls[0]![0]).toEqual({ serverUrl: origin, serverToken: token });
    } finally { read.mockRestore(); }
  });

  it("rejects a second zero-repository runner under the same worker lock", async () => {
    const f = await fixture(); const controller = new AbortController();
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
    const f = await fixture(true); const controller = new AbortController();
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

});


it.skipIf(process.platform === "win32")("binds an explicit Agent CLI alias only in the worker's native environment", async () => {
  const f = await fixture(false, true); const controller = new AbortController();
  const target = path.join(f.homeDirectory, "development-cli");
  await writeFile(target, "#!/bin/sh\nprintf dev\n", { mode: 0o700 });
  await writeFile(f.paths.configFile, stringify({ ...f.document, agentCliAliases: { daynight: target } }));
  const originalPath = process.env.PATH;
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
    void options.herdr.attachment;
    controller.abort(new Error("Startup observed."));
  }));
  await runWorker({ ...f, signal: controller.signal });
  const options = mocks.herdr.mock.calls[0]![0];
  expect(options.agentEnvironment.PATH).toContain(path.join(f.paths.stateDirectory, "agent-cli-aliases"));
  expect(options.agentEnvironment).toEqual({ PATH: options.agentEnvironment.PATH, DN_CONFIG_DIR: f.paths.stateDirectory });
  expect(process.env.PATH).toBe(originalPath);
  expect(options.environment).toBeUndefined();
});

it.runIf(process.platform === "win32")("rejects explicit Agent CLI aliases on Windows before launching native agents", async () => {
  const f = await fixture(false, true);
  await writeFile(f.paths.configFile, stringify({ ...f.document, agentCliAliases: { daynight: "daynight-dev" } }));
  const originalPath = process.env.PATH;
  await expect(runWorker(f)).rejects.toThrow("agentCliAliases is supported only on macOS and Linux");
  expect(mocks.herdr).not.toHaveBeenCalled();
  expect(mocks.coordinator).not.toHaveBeenCalled();
  expect(process.env.PATH).toBe(originalPath);
});

it("retains a committed Worker upgrade when Web state fails and resumes after its cause is corrected", async () => {
  const f = await fixture(false, true);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const invalid = new Database(webFile);
  invalid.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=3");
  invalid.close();
  await expect(runWorker(f)).rejects.toThrow("unsupported-version");
  expect(mocks.coordinator).not.toHaveBeenCalled();
  const worker = new Database(f.paths.databaseFile);
  expect(worker.pragma("user_version", { simple: true })).toBe(8);
  expect(worker.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
  worker.close();
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(3);
  expect(web.prepare("SELECT value FROM retained").get()).toEqual({ value: "original" });
  web.exec("DROP TABLE retained; CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT; PRAGMA user_version=1");
  web.close();
  const controller = new AbortController();
  mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Repaired state observed.")); }));
  await runWorker({ ...f, signal: controller.signal });
  expect(mocks.coordinator).toHaveBeenCalledOnce();
  const upgradedWeb = new Database(webFile);
  expect(upgradedWeb.pragma("user_version", { simple: true })).toBe(2);
  upgradedWeb.close();
  const unchangedWorker = new Database(f.paths.databaseFile);
  expect(unchangedWorker.pragma("user_version", { simple: true })).toBe(8);
  unchangedWorker.close();
});

it("rebuilds unknown zero-version Web state before starting its coordinator", async () => {
  const f = await fixture(false, true);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const original = new Database(webFile);
  original.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('discarded')");
  original.close();
  const controller = new AbortController();
  mocks.coordinator.mockReturnValue(coordinator(async () => { controller.abort(new Error("Rebuilt state observed.")); }));
  await runWorker({ ...f, signal: controller.signal });
  expect(mocks.coordinator).toHaveBeenCalledOnce();
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(2);
  expect(web.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: "executions" }]);
  expect(web.prepare("SELECT * FROM executions").all()).toEqual([]);
  web.close();
});
