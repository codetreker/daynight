import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfiguration } from "../../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { createCopilotRunner } from "../../../src/commands/review/adapters/copilot.js";
import { createGitManager } from "../../../src/commands/review/adapters/worktrees.js";
import { createGitHubClient } from "../../../src/commands/review/adapters/github.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import { acquireInstanceLock, formatCoordinatorEvent, runForegroundReview } from "../../../src/commands/review/runtime.js";
import { openStore } from "../../../src/commands/review/store.js";
import { prepareReviewSkill } from "../../../src/commands/review/skill.js";
import type { RuntimeDependencies } from "../../../src/commands/review/runtime.js";

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

describe("foreground runtime ownership", () => {
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
    const launch = () => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(harness).href, executable, "review", "run"], {
        cwd: home, stdio: ["ignore", "ignore", "pipe", "ipc"],
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
      second = launch();
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

  it("formats durable execution context and retry time", () => {
    expect(formatCoordinatorEvent({ level: "error", phase: "retry", message: "missing marker", repository: "o/r", number: 4,
      reviewId: "uuid", revision: 2, attempt: 1, retryAt: 1_000 })).toBe("o/r PR 4 review=uuid revision=2 attempt=1 retry: missing marker retryAt=1970-01-01T00:00:01.000Z");
  });

  it("reports the affected repository and the complete original error chain", () => {
    expect(formatCoordinatorEvent({ level: "error", phase: "poll", repository: "o/r", message: "Polling failed.",
      error: new Error("Cannot read PRs", { cause: new AggregateError([new Error("HTTP 403"), new Error("Rate limited")], "API rejected") }) }))
      .toBe("o/r poll: Polling failed.\nCannot read PRs\nCaused by: API rejected\nHTTP 403\nRate limited");
  });
});
