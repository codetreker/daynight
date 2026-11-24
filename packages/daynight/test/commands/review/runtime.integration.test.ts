import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfiguration } from "../../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { createCopilotRunner } from "../../../src/commands/review/adapters/copilot.js";
import { createGitManager, gitCommandCleanupState } from "../../../src/commands/review/adapters/worktrees.js";
import { createGitHubClient, executeCommand } from "../../../src/commands/review/adapters/github.js";
import { runCoordinator } from "../../../src/commands/review/coordinator.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import { acquireInstanceLock, hasRetainedWorkerReviewFailure, isConfirmedWorkerReviewFailure, reconcileWorkerReviewFailure, runForegroundReview } from "../../../src/commands/review/runtime.js";
import { openStore } from "../../../src/commands/review/store.js";
import { prepareReviewSkill } from "../../../src/commands/review/skill.js";
import type { RuntimeDependencies } from "../../../src/commands/review/runtime.js";
import { createOperation } from "../../../src/api/operation.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { runLifecycleOwnedCommand, withOwnedCommandLifecycle } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { hasUnconfirmedOwnedCommandCleanup } from "../../../src/commands/worker/owned-command.js";
import * as files from "../../../src/platform/files.js";
import type { AssignmentSource } from "../../../src/commands/review/assignment.js";

const packageDirectory = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;
beforeAll(async () => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true }); directory = await mkdtemp(path.join(temporary, "runtime-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const dependencies = (coordinate: RuntimeDependencies["coordinate"]): RuntimeDependencies => ({
  prepareSkill: prepareReviewSkill, openStore, createClient: createGitHubClient, createGit: createGitManager, createRunner: createCopilotRunner, createProcesses: createProcessSupervisor, coordinate,
});
const input = (name: string) => {
  const paths = resolveReviewPaths(path.join(directory, name));
  return { paths, configuration: parseConfiguration("review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]", paths) };
};
const source: AssignmentSource = { snapshot: () => ({ kind: "disabled" }), subscribe: () => () => {}, capturePrompt: async () => { throw new Error("No review is assigned."); } };

describe("foreground runtime ownership", () => {
  it("logs only failed SQLite migration diagnostics", async () => {
    const { configuration, paths } = input("migration-logging");
    const log = vi.fn();
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    await runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, log });
    expect(log.mock.calls.map(([event]) => event.phase)).not.toContain("sqlite-migration-started");
    expect(log.mock.calls.map(([event]) => event.phase)).not.toContain("sqlite-migration-completed");

    const failure = new Error("Migration failed.");
    const migration = { migrationId: "test-migration", database: "review", file: paths.databaseFile, kind: "failed", phase: "migrate", fromVersion: 1, toVersion: 2, durationMs: 1, outcome: "rolled-back" } as const;
    deps.openStore = (_file, options) => { options?.onMigration?.(migration); throw failure; };
    await expect(runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, log })).rejects.toMatchObject({ cause: failure });
    expect(log).toHaveBeenCalledWith({ level: "error", phase: "sqlite-migration-failed", message: JSON.stringify(migration) });
  });

  it("releases the original Reviewer after its initial read-only Git reservation reconciles through the real coordinator", async () => {
    const { configuration, paths } = input("worker-readonly-git"), controller = new AbortController();
    const repository = { host: "github.com", githubId: "42", owner: "o", name: "r" };
    const root = path.join(paths.stateDirectory, "repositories", repository.githubId);
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, timeout: 10_000, stdio: "ignore" });
    const journalDirectory = path.join(paths.stateDirectory, "journal");
    const journal = await openExecutionResourceJournal({ directory: journalDirectory, identity: {
      serverOrigin: "https://daynight.example", userId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002",
    } });
    const replace = files.replaceFileAtomically;
    let rejectSave = true, wrapped: unknown, coordination: Awaited<ReturnType<typeof runCoordinator>> | undefined;
    const replacement = vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (rejectSave && path.dirname(file) === journalDirectory) throw new Error("initial prepared save failed");
      return replace(file, text, ...rest);
    });
    const execute = vi.fn(executeCommand), deps = dependencies(async options => { coordination = await runCoordinator(options); return coordination; });
    deps.createClient = () => ({ ...createGitHubClient({ execute: async () => { throw new Error("Unexpected GitHub request."); } }), resolveRepository: async () => repository });
    deps.createGit = options => createGitManager({ ...options, execute });
    const assignment: AssignmentSource = { ...source, snapshot: () => ({ kind: "enabled", pullRequests: [{ projectId: "project", repositoryId: repository.githubId, repositoryUrl: "https://github.com/o/r", number: 1 }] }) };
    let failure: unknown, testFailure: unknown;
    try {
      failure = await withOwnedCommandLifecycle(journal.sink("1"), () => runForegroundReview({ ...configuration, repositories: [] }, paths, {
        packageDirectory, dependencies: deps, source: assignment, signal: controller.signal,
        log: event => { if (event.phase === "poll" && event.error !== undefined) { wrapped = event.error; controller.abort(); } },
      })).catch(error => error);
      expect(wrapped).toMatchObject({ name: "GitCommandError", completed: false, cause: { name: "OwnedCommandCleanupError" } });
      expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]![1]).toContain("rev-parse");
      expect(gitCommandCleanupState(wrapped)).toBe("unconfirmed");
      expect(coordination?.safeToReleaseLock).toBe(false);
      expect(hasRetainedWorkerReviewFailure(failure)).toBe(true);
      await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
      await expect(reconcileWorkerReviewFailure(failure)).rejects.toThrow("processes remain unconfirmed");
      rejectSave = false;
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 1000 });
      expect(gitCommandCleanupState(wrapped)).toBe("confirmed");
      expect(coordination?.safeToReleaseLock).toBe(true);
      await reconcileWorkerReviewFailure(failure);
      expect(hasRetainedWorkerReviewFailure(failure)).toBe(false);
      await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(execute).toHaveBeenCalledOnce();
      expect((await journal.read())[0]!.event).toMatchObject({ stage: "stopped", proof: null });
    } catch (error) { testFailure = error; throw error; }
    finally {
      rejectSave = false; controller.abort(); replacement.mockRestore();
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 1000 });
      if (hasRetainedWorkerReviewFailure(failure)) {
        try { await reconcileWorkerReviewFailure(failure); }
        catch (error) { throw new AggregateError([...(testFailure === undefined ? [] : [testFailure]), error], "Reviewer test and original cleanup failed."); }
      }
    }
  }, 20_000);

  it("releases the original Worker Reviewer lock only after its command output and stop save reconcile", async () => {
    const { configuration, paths } = input("worker-native-reconcile");
    const journal = await openExecutionResourceJournal({ directory: path.join(paths.stateDirectory, "journal"), identity: {
      serverOrigin: "https://daynight.example", userId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002",
    } });
    const originalReplace = files.replaceFileAtomically;
    let rejectStop = true, commandFailure: unknown;
    const replace = vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (path.dirname(file) === path.join(paths.stateDirectory, "journal") && JSON.parse(String(text)).event.stage === "stopped" && rejectStop) throw new Error("original stop save unavailable");
      return originalReplace(file, text, ...rest);
    });
    const marker = path.join(paths.stateDirectory, "command-count");
    const deps = dependencies(async () => {
      const operation = createOperation({ limits: { totalMs: 20_000, requestMs: 20_000 } });
      try {
        commandFailure = await runLifecycleOwnedCommand({ file: process.execPath,
          args: ["--input-type=module", "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'once\\n');process.stdout.write('closed output');`], environment: process.env }, operation, journal.sink("1")).catch(error => error);
      } finally { operation.dispose(); }
      // The production coordinator exposes the same live original receipt after
      // its interrupted attempt and all writers have joined.
      return { get safeToReleaseLock() { return !hasUnconfirmedOwnedCommandCleanup(commandFailure); } };
    });
    let failure: unknown;
    try {
      failure = await runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, log: () => {} }).catch(error => error);
      expect(commandFailure).toMatchObject({ name: "OwnedCommandCleanupError" });
      expect(hasRetainedWorkerReviewFailure(failure)).toBe(true);
      await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
      await expect(reconcileWorkerReviewFailure(failure)).rejects.toThrow("processes remain unconfirmed");
      rejectStop = false;
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 10_000 });
      await Promise.all([reconcileWorkerReviewFailure(failure), reconcileWorkerReviewFailure(failure)]);
      expect(hasRetainedWorkerReviewFailure(failure)).toBe(false);
      await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(marker, "utf8")).toBe("once\n");
      await reconcileWorkerReviewFailure(failure);
    } finally {
      rejectStop = false; replace.mockRestore();
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 10_000 });
      if (hasRetainedWorkerReviewFailure(failure)) await reconcileWorkerReviewFailure(failure);
    }
  }, 30_000);

  it("confirms a joined Worker startup failure without hiding the original error", async () => {
    const { configuration, paths } = input("worker-startup-failure");
    const failure = new Error("Worker Reviewer skill unavailable");
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    deps.prepareSkill = async () => { throw failure; };
    const result = await runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, log: () => {} }).catch(error => error);
    expect(result).toMatchObject({ cause: failure });
    await reconcileWorkerReviewFailure(result);
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("confirms the original startup cancellation only after releasing its acquired lock", async () => {
    const { configuration, paths } = input("worker-cancelled-startup"), controller = new AbortController();
    const reason = new Error("original scope stopped");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    deps.prepareSkill = async (...args) => {
      const skill = await prepareReviewSkill(...args);
      entered.resolve(); await release.promise; return skill;
    };
    const running = runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, signal: controller.signal, log: () => {} }).catch(error => error);
    try {
      await entered.promise;
      await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
      controller.abort(reason); release.resolve();
      const receipt = await running;
      expect(receipt).toMatchObject({ cause: reason });
      expect(isConfirmedWorkerReviewFailure(receipt)).toBe(true);
      expect(isConfirmedWorkerReviewFailure(reason)).toBe(false);
      await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { controller.abort(reason); release.resolve(); await running; }
  });

  it("retains the original store and lock until a failed close actually succeeds", async () => {
    const { configuration, paths } = input("worker-close-retry");
    const failure = new Error("SQLite close failed"), deps = dependencies(async () => ({ safeToReleaseLock: true }));
    const earlier = input("worker-shared-cause"), startup = dependencies(async () => ({ safeToReleaseLock: true }));
    startup.prepareSkill = async () => { throw failure; };
    const earlierFailure = await runForegroundReview(earlier.configuration, earlier.paths, { packageDirectory, dependencies: startup, source, log: () => {} }).catch(error => error);
    await reconcileWorkerReviewFailure(earlierFailure);
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let result: unknown;
    deps.openStore = (...args) => {
      const store = openStore(...args), original = store.close;
      close = vi.spyOn(store, "close").mockImplementationOnce(() => { throw failure; }).mockImplementation(original);
      return store;
    };
    try {
      result = await runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, source, log: () => {} }).catch(error => error);
      expect(result).toMatchObject({ cause: failure });
      expect(result).not.toBe(earlierFailure);
      expect(hasRetainedWorkerReviewFailure(result)).toBe(true);
      await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
      await reconcileWorkerReviewFailure(result);
      expect(close).toHaveBeenCalledTimes(2);
      await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (hasRetainedWorkerReviewFailure(result)) await reconcileWorkerReviewFailure(result); close?.mockRestore(); }
  });

  it("stays running until its signal stops admission and releases only its own lock after coordinator shutdown", async () => {
    const { configuration, paths } = input("normal");
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const events: string[] = [];
    const coordinate: RuntimeDependencies["coordinate"] = async ({ signal, store, processes }) => {
      expect(store.listActiveReviews()).toEqual([]);
      entered();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { events.push("stopped"); resolve(); }, { once: true }); });
      return { safeToReleaseLock: true };
    };
    const deps = dependencies(coordinate);
    deps.prepareSkill = vi.fn(prepareReviewSkill);
    deps.createRunner = vi.fn(createCopilotRunner);
    const running = runForegroundReview(configuration, paths, { packageDirectory, signal: controller.signal, dependencies: deps, log: () => {} });
    await ready;
    expect(deps.prepareSkill).toHaveBeenCalledExactlyOnceWith(packageDirectory, paths.cacheDirectory);
    const skill = await vi.mocked(deps.prepareSkill).mock.results[0]!.value;
    expect(deps.createRunner).toHaveBeenCalledExactlyOnceWith({
      paths, skill, processOwner: expect.any(String), timeoutMs: configuration.agentTimeoutMs,
    });
    expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
    controller.abort();
    await running;
    expect(events).toEqual(["stopped"]);
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = openStore(paths.databaseFile); reopened.close();
  });

  it.each([
    { name: "model", settings: { copilotModel: "future-provider/model-v9" }, runnerOptions: { model: "future-provider/model-v9" } },
    { name: "effort", settings: { copilotReasoningEffort: "high" }, runnerOptions: { reasoningEffort: "high" } },
    { name: "both", settings: { copilotModel: "auto", copilotReasoningEffort: "future-effort" }, runnerOptions: { model: "auto", reasoningEffort: "future-effort" } },
  ])("forwards independent Copilot settings when constructing the startup runner: $name", async ({ name, settings, runnerOptions }) => {
    const { configuration, paths } = input(`copilot-${name}`);
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    deps.createRunner = vi.fn(createCopilotRunner);
    await runForegroundReview({ ...configuration, ...settings }, paths, { packageDirectory, dependencies: deps, log: () => {} });
    expect(deps.createRunner).toHaveBeenCalledExactlyOnceWith({
      paths, skill: expect.objectContaining({ name: "daynight-review" }), processOwner: expect.any(String), timeoutMs: configuration.agentTimeoutMs, ...runnerOptions,
    });
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the lock after uncertainty until an operator excludes the previous processes and removes it", async () => {
    const { configuration, paths } = input("uncertain");
    await expect(runForegroundReview(configuration, paths, { packageDirectory, dependencies: dependencies(async () => ({ safeToReleaseLock: false })), log: () => {} })).rejects.toThrow("Instance lock");
    await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("Cannot acquire instance lock");
    await rm(paths.lockFile);
    const coordinate = vi.fn<RuntimeDependencies["coordinate"]>(async ({ processes }) => {
      const proof = await processes.recover({} as Parameters<typeof processes.recover>[0]);
      expect(proof).toEqual({ processesExcluded: true, operationsStopped: true });
      return { safeToReleaseLock: true };
    });
    await runForegroundReview(configuration, paths, { packageDirectory, dependencies: dependencies(coordinate), log: () => {} });
    expect(coordinate).toHaveBeenCalledOnce();
  });

  it("releases a newly acquired lock if database startup fails before review operations", async () => {
    const { configuration, paths } = input("database-failure");
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    deps.openStore = () => { throw new Error("broken SQLite"); };
    await expect(runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, log: () => {} })).rejects.toThrow("broken SQLite");
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid bundled skill resources before opening state and releases its new lock", async () => {
    const { configuration, paths } = input("skill-failure");
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    const failure = new Error("The installed skill is missing.");
    deps.prepareSkill = vi.fn(async () => { throw failure; });
    deps.openStore = vi.fn(openStore);
    deps.createRunner = vi.fn(createCopilotRunner);
    await expect(runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, log: () => {} })).rejects.toBe(failure);
    expect(deps.openStore).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
    await expect(readFile(paths.databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["database", "skill", "aborted-signal"])("retains a recovered predecessor's uncertainty when startup fails at %s", async (failure) => {
    const { configuration, paths } = input(`recovered-startup-${failure}`);
    await mkdir(paths.stateDirectory, { recursive: true });
    await writeFile(paths.lockFile, JSON.stringify({ owner: "dead", pid: 2_147_483_647, startedAt: "2000-01-01T00:00:00.000Z" }));
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); });
    const deps = dependencies(async () => ({ safeToReleaseLock: true }));
    deps.openStore = vi.fn(() => { throw new Error("broken SQLite"); });
    if (failure === "skill") deps.prepareSkill = vi.fn(async () => { throw new Error("broken skill"); });
    const controller = new AbortController();
    if (failure === "aborted-signal") controller.abort(new Error("Startup cancelled"));
    try {
      await expect(runForegroundReview(configuration, paths, { packageDirectory, signal: controller.signal, dependencies: deps, log: () => {} }))
        .rejects.toThrow(failure === "database" ? "broken SQLite" : failure === "skill" ? "broken skill" : "Startup cancelled");
      expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toMatchObject({ pid: process.pid });
      if (failure !== "database") expect(deps.openStore).not.toHaveBeenCalled();
    } finally { probe.mockRestore(); }
  });

  it("retains interrupted state after automatic lock recovery until the old agents are excluded", async () => {
    const { configuration, paths } = input("recovered-uncertain");
    await mkdir(paths.stateDirectory, { recursive: true });
    await writeFile(paths.lockFile, JSON.stringify({ owner: "dead", pid: 2_147_483_647, startedAt: "2000-01-01T00:00:00.000Z" }));
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); });
    const deps = dependencies(async ({ processes }) => {
      await expect(processes.recover()).rejects.toThrow("instance-lock owner's confirmation");
      return { safeToReleaseLock: true };
    });
    deps.createProcesses = vi.fn(createProcessSupervisor);
    try {
      await expect(runForegroundReview(configuration, paths, { packageDirectory, dependencies: deps, log: () => {} })).rejects.toThrow("Instance lock");
      expect(deps.createProcesses).toHaveBeenCalledWith({});
      expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    } finally { probe.mockRestore(); }
    await rm(paths.lockFile);
    const confirmed = dependencies(async ({ processes }) => {
      await expect(processes.recover()).resolves.toEqual({ processesExcluded: true, operationsStopped: true });
      return { safeToReleaseLock: true };
    });
    await runForegroundReview(configuration, paths, { packageDirectory, dependencies: confirmed, log: () => {} });
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts a real CLI after a forced crash and releases the recovered lock after shutdown", async () => {
    const home = path.join(directory, "crashed-cli");
    const state = path.join(home, ".daynight");
    const emptyPath = path.join(home, "empty-path");
    await mkdir(state, { recursive: true }); await mkdir(emptyPath);
    await writeFile(path.join(state, "config.yml"), "review:\n  pollIntervalMs: 50\n  repositories: [{remote: https://github.com/o/r, path: ../repository}]\n");
    const harness = path.join(home, "control.mjs");
    await writeFile(harness, "process.on('message', (message) => { if (message === 'shutdown') { process.emit('SIGINT'); process.disconnect(); } });\n");
    const executable = fileURLToPath(new URL("../../../dist/main.js", import.meta.url));
    const launch = (cwd = home) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(harness).href, executable, "review", "run"], {
        cwd, stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyPath, Path: emptyPath },
      });
      let errors = "";
      const lifetime = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => { clearTimeout(lifetime); resolve({ code, signal }); });
      });
      const started = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error(`CLI startup timed out: ${errors}`)); }, 10_000);
        child.stderr!.on("data", (data: Buffer) => {
          errors += data.toString();
          if (errors.includes("Foreground review started")) { clearTimeout(timeout); resolve(); }
        });
        void exited.then(() => { clearTimeout(timeout); reject(new Error(`CLI exited before startup: ${errors}`)); }, reject);
      });
      return { child, exited, started, errors: () => errors };
    };
    const first = launch();
    let second: ReturnType<typeof launch> | undefined;
    try {
      await first.started;
      const firstRecord = JSON.parse(await readFile(path.join(state, "instance.lock"), "utf8")) as { pid: number; owner: string };
      expect(firstRecord.pid).toBe(first.child.pid);
      first.child.kill("SIGKILL");
      await first.exited;
      expect(JSON.parse(await readFile(path.join(state, "instance.lock"), "utf8"))).toEqual(firstRecord);
      second = launch(emptyPath);
      await second.started;
      expect(JSON.parse(await readFile(path.join(state, "instance.lock"), "utf8"))).toMatchObject({ pid: second.child.pid });
      second.child.send("shutdown");
      expect((await second.exited).code, second.errors()).toBe(0);
      await expect(readFile(path.join(state, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const running of [first, second]) if (running !== undefined) {
        if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
        await running.exited;
      }
    }
  }, 30_000);

});
