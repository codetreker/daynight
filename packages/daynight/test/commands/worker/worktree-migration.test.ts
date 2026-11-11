import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { ResourceOwner, WorktreeBinding } from "../../../src/commands/worker/types.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { migrateLegacyWorktrees, type MigrationSources } from "../../../src/commands/worker/worktrees/migration.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { createHerdrRecordingResources } from "../../../src/commands/worker/herdr/recording-resources.js";
import type { HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { SessionV2Archive } from "../../../src/session/v2/types.js";
import type { Task } from "../../../src/api/types.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import Database from "better-sqlite3";

const fault = vi.hoisted(() => ({ syncDirectory: "", afterRemoval: "", afterPresent: "", temporaryPrefix: "", unlink: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => {
    if (fault.temporaryPrefix) {
      const parent = path.dirname(fault.temporaryPrefix), prefix = path.basename(fault.temporaryPrefix), actual = fs.fstatSync(fd);
      if (fs.existsSync(parent) && fs.readdirSync(parent).some(name => {
        if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
        const target = fs.statSync(path.join(parent, name)); return actual.dev === target.dev && actual.ino === target.ino;
      })) throw new Error("controlled file flush failure");
    }
    if (fault.syncDirectory && (!fault.afterRemoval || !fs.existsSync(fault.afterRemoval)) && (!fault.afterPresent || fs.existsSync(fault.afterPresent))) {
      const actual = fs.fstatSync(fd), target = fs.statSync(fault.syncDirectory);
      if (actual.dev === target.dev && actual.ino === target.ino) throw new Error("controlled directory barrier failure");
    }
    fs.fsyncSync(fd);
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, unlink: async (target: Parameters<typeof fs.unlink>[0]) => {
    if (String(target) === fault.unlink) throw new Error("controlled sidecar unlink failure");
    return fs.unlink(target);
  } };
});

const roots: string[] = [];
afterEach(() => { fault.syncDirectory = ""; fault.afterRemoval = ""; fault.afterPresent = ""; fault.temporaryPrefix = ""; fault.unlink = ""; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: env(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
const owner = (): ResourceOwner => ({ projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() });
const webTask = (value: ResourceOwner, binding: WorktreeBinding): WebTask => ({
  ...value, serverOrigin: "https://daynight.example", workerId: value.projectId, userId: value.claimId, status: "active",
  repoUrl: "https://example.test/repo.git", repositoryPath: binding.repositoryPath,
  configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
  resources: { mode: "web", worktree: binding, herdr: null, nativeSession: null },
  recovery: { count: 0, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null,
  webExecution: null, nativeExecution: null, createdAt: 1, updatedAt: 1,
});
const herdrRecord = (value: ResourceOwner, cwd: string): HerdrLifecycleRecord => ({
  owner: { projectId: value.projectId, taskId: value.taskId, worktreeId: value.worktreeId, workerId: value.projectId,
    ownerUserId: value.claimId, serverOrigin: "https://daynight.example", provider: "codex" },
  claimId: value.claimId, cwd, sessionId: value.claimId, registrationId: value.worktreeId, connectionEpoch: null,
  registrationRequest: null, ledgerRequest: null, publishedLedgerHash: null, controlEpoch: "0", initialAssignment: "pending",
  initialPrompt: null, automationBlocked: false, preparation: null, runs: [], segments: [], version: 1,
});
const fixture = () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-migration");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "case-")); roots.push(root);
  const repositoryPath = path.join(root, "repo"); mkdirSync(repositoryPath);
  git(repositoryPath, ["init", "--initial-branch=main"]);
  git(repositoryPath, ["config", "user.name", "Fixture"]); git(repositoryPath, ["config", "user.email", "fixture@example.com"]);
  writeFileSync(path.join(repositoryPath, "tracked.txt"), "original\n");
  git(repositoryPath, ["add", "tracked.txt"]); git(repositoryPath, ["commit", "-m", "fixture"]);
  const commonDirectory = git(repositoryPath, ["rev-parse", "--absolute-git-dir"]);
  const namespace = path.join(repositoryPath, ".worktrees", "daynight"); mkdirSync(namespace, { recursive: true });
  const directory = path.join(commonDirectory, "daynight", "worktrees");
  const schedule: ResourceOwner[] = [], web: { owner: ResourceOwner; binding: WorktreeBinding }[] = [], herdr: { owner: ResourceOwner; cwd: string }[] = [];
  const sources: MigrationSources = { listSchedules: () => schedule, listWebTasks: () => web.map(({ owner, binding }) => webTask(owner, binding)),
    listHerdrLifecycles: () => herdr.map(({ owner, cwd }) => herdrRecord(owner, cwd)), listHerdrRetired: () => [], listHerdrResources: () => [], listHerdrBindings: () => [] };
  const binding = (value: ResourceOwner): WorktreeBinding => ({ repositoryPath, commonDirectory, worktreePath: path.join(namespace, value.taskId), branch: `daynight/${value.taskId}` });
  const add = (value: ResourceOwner, locked = true) => {
    const cwd = binding(value).worktreePath;
    const marker = `daynight-worker:${JSON.stringify({ ...value, leaf: "1:1", root: "2:2", common: "3:3" })}`;
    git(repositoryPath, ["worktree", "add", ...(locked ? ["--lock", "--reason", marker] : []), "-b", `daynight/${value.taskId}`, "--", cwd]);
    const admin = git(cwd, ["rev-parse", "--absolute-git-dir"]);
    return { cwd, admin, marker };
  };
  const migrate = async (checkpoint?: Parameters<typeof migrateLegacyWorktrees>[0]["checkpoint"]) => {
    const operation = createOperation();
    try { return await migrateLegacyWorktrees({ repositoryPath, commonDirectory, operation, sources, ...(checkpoint === undefined ? {} : { checkpoint }) }); }
    finally { operation.dispose(); }
  };
  return { root, repositoryPath, commonDirectory, namespace, directory, schedule, web, herdr, sources, binding, add, migrate, store: createWorktreeManifestStore(commonDirectory) };
};
const expected = (value: ResourceOwner) => ({ schemaVersion: 1 as const, ...value, directoryName: value.taskId });
const sidecar = (admin: string, value: ResourceOwner): string => {
  const marker = readFileSync(path.join(admin, "locked"));
  const identity = { kind: "darwin-apfs-v1", volumeUuid: randomUUID(), fileId: "1" };
  const file = path.join(admin, "daynight-identity.json");
  writeFileSync(file, JSON.stringify({ version: 1, owner: value, markerSha256: createHash("sha256").update(marker).digest("hex"), directories: { root: identity, common: identity, admin: identity, leaf: identity } }), { mode: 0o600 });
  return file;
};
const snapshotRows = (file: string, table: string): unknown[] => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); } finally { db.close(); }
};
const historicalFixture = () => {
  const f = fixture(), old = owner(), next = { ...old, claimId: randomUUID(), worktreeId: randomUUID() }, original = f.add(old);
  const workerFile = path.join(f.root, "worker.sqlite"), webFile = path.join(f.root, "web.sqlite"), herdrFile = path.join(f.root, "herdr.sqlite");
  const worker = openWorkerStore(workerFile, { onMigration: () => {} });
  const web = openWebExecutionStore(webFile, { onMigration: () => {} });
  const herdr = openHerdrLifecycleStore(herdrFile, { onMigration: () => {} });
  worker.registerProject({ projectId: old.projectId, repoUrl: "https://example.test/repo.git", localPath: f.repositoryPath });
  const registerWeb = (value: ResourceOwner, bind = true) => {
    const project = { projectId: value.projectId, repoUrl: "https://example.test/repo.git", localPath: f.repositoryPath };
    const task = web.register({ ...value, project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    return bind ? web.bindWorktree(task, f.binding(value), 2) : task;
  };
  const registerHerdr = (value: ResourceOwner) => herdr.create({
    owner: { projectId: value.projectId, taskId: value.taskId, worktreeId: value.worktreeId, workerId: randomUUID(),
      ownerUserId: randomUUID(), serverOrigin: "https://daynight.example", provider: "codex" },
    claimId: value.claimId, cwd: f.binding(value).worktreePath,
  });
  const sources: MigrationSources = { listSchedules: () => worker.listCleanupSchedules(), listWebTasks: () => [...web.listCompletedTasks(), ...web.listUnfinishedTasks()],
    listHerdrLifecycles: () => herdr.list(), listHerdrRetired: () => herdr.listRetired(), listHerdrResources: () => [], listHerdrBindings: () => [] };
  const release = () => { git(f.repositoryPath, ["worktree", "unlock", "--", original.cwd]); git(f.repositoryPath, ["worktree", "remove", "--force", "--", original.cwd]); };
  const reuse = () => {
    const marker = `daynight-worker:${JSON.stringify({ ...next, leaf: "1:1", root: "2:2", common: "3:3" })}`;
    git(f.repositoryPath, ["worktree", "add", "--lock", "--reason", marker, "--", original.cwd, `daynight/${next.taskId}`]);
    return { cwd: original.cwd, admin: git(original.cwd, ["rev-parse", "--absolute-git-dir"]), marker };
  };
  const run = async (input: MigrationSources = sources) => {
    const operation = createOperation();
    try { return await migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation, sources: input }); }
    finally { operation.dispose(); }
  };
  return { ...f, old, next, original, workerFile, webFile, herdrFile, worker, web, herdr, sources, registerWeb, registerHerdr, release, reuse, run,
    close: () => { herdr.close(); web.close(); worker.close(); } };
};

describe("legacy worktree migration", { timeout: 30_000 }, () => {
  it("recovers a real process interruption before format rename", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    const moduleRoot = path.resolve(import.meta.dirname, "../../../dist");
    const source = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const config = JSON.parse(process.argv[1]);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { if (String(to) === config.format) process.exit(79); return rename(from, to); };
      syncBuiltinESMExports();
      const { migrateLegacyWorktrees } = await import(config.migration);
      const { createOperation } = await import(config.operation);
      const operation = createOperation();
      await migrateLegacyWorktrees({ repositoryPath: config.root, commonDirectory: config.common, operation,
        sources: { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrRetired: () => [], listHerdrResources: () => [], listHerdrBindings: () => [] } });
      operation.dispose();
    `;
    const config = { root: f.repositoryPath, common: f.commonDirectory, format: path.join(f.directory, "format.json"),
      migration: pathToFileURL(path.join(moduleRoot, "commands/worker/worktrees/migration.js")).href,
      operation: pathToFileURL(path.join(moduleRoot, "api/operation.js")).href };
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify(config)], { encoding: "utf8", env: env(), timeout: 20_000 });
    expect({ status: child.status, error: child.error, stderr: child.stderr }).toEqual({ status: 79, error: undefined, stderr: "" });
    const temps = readdirSync(f.directory).filter(name => /^format\.json\..*\.tmp$/.test(name));
    expect(temps).toHaveLength(1);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
    await f.migrate();
    expect(existsSync(path.join(f.directory, temps[0]!))).toBe(false);
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
  });

  it("retains an unsafe format temporary and refuses activation", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    mkdirSync(f.directory, { recursive: true });
    const outside = path.join(f.root, "foreign"), temporary = path.join(f.directory, `format.json.${randomUUID()}.tmp`);
    writeFileSync(outside, "keep", { mode: 0o600 }); linkSync(outside, temporary);
    await expect(f.migrate()).rejects.toThrow("format temporary");
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(readFileSync(temporary, "utf8")).toBe("keep");
    expect(existsSync(path.join(original.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("retries the directory barrier after removing a format temporary", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    mkdirSync(f.directory, { recursive: true });
    const temporary = path.join(f.directory, `format.json.${randomUUID()}.tmp`);
    writeFileSync(temporary, "partial", { mode: 0o600 });
    fault.syncDirectory = f.directory; fault.afterRemoval = temporary;
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(path.join(original.admin, "locked"))).toBe(true);
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    fault.syncDirectory = "";
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
  });

  it("converts an empty checkout after its Git pointer was removed", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    unlinkSync(path.join(original.cwd, ".git")); unlinkSync(path.join(original.cwd, "tracked.txt"));
    await expect(f.migrate(stage => { if (stage === "unlocked") throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    expect(readdirSync(original.cwd)).toEqual([]);
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(readdirSync(original.cwd)).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
  });

  it("retains a nonempty checkout whose Git pointer is missing", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    const tracked = readFileSync(path.join(original.cwd, "tracked.txt"));
    unlinkSync(path.join(original.cwd, ".git"));
    await expect(f.migrate()).rejects.toThrow("reverse Git pointer");
    expect(readFileSync(path.join(original.cwd, "tracked.txt"))).toEqual(tracked);
    expect(existsSync(path.join(original.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("retains a foreign lock on an empty checkout without a Git pointer", async () => {
    const f = fixture(), value = owner(), original = f.add(value, false);
    git(f.repositoryPath, ["worktree", "lock", "--reason", "manual", original.cwd]);
    f.web.push({ owner: value, binding: f.binding(value) });
    unlinkSync(path.join(original.cwd, ".git")); unlinkSync(path.join(original.cwd, "tracked.txt"));
    await expect(f.migrate()).rejects.toThrow("foreign Git lock");
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe("manual");
    expect(readdirSync(original.cwd)).toEqual([]);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("converts every source, preserving worktree and frozen execution bytes", async () => {
    const f = fixture(), marked = owner(), scheduled = owner(), completedWeb = owner(), activeWeb = owner(), herdrOwner = owner();
    const original = f.add(marked), identityFile = sidecar(original.admin, marked); f.add(scheduled);
    f.schedule.push(scheduled); f.web.push({ owner: completedWeb, binding: f.binding(completedWeb) }, { owner: activeWeb, binding: f.binding(activeWeb) });
    f.herdr.push({ owner: herdrOwner, cwd: f.binding(herdrOwner).worktreePath });
    const frozen = path.join(f.root, "frozen.json");
    writeFileSync(frozen, JSON.stringify({ ticket: f.web, lifecycle: f.herdr }));
    const originalFrozen = readFileSync(frozen), pointer = readFileSync(path.join(original.cwd, ".git"));
    writeFileSync(path.join(original.cwd, "tracked.txt"), "dirty work\n");
    await f.migrate();
    expect(f.store.list()).toEqual(expect.arrayContaining([marked, scheduled, completedWeb, activeWeb, herdrOwner].map(expected)));
    expect(f.store.list()).toHaveLength(5);
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
    expect(existsSync(identityFile)).toBe(false);
    expect(readFileSync(path.join(original.cwd, ".git"))).toEqual(pointer);
    expect(readFileSync(path.join(original.cwd, "tracked.txt"), "utf8")).toBe("dirty work\n");
    expect(readFileSync(frozen)).toEqual(originalFrozen);
    expect(git(original.cwd, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/daynight/${marked.taskId}`);
    await f.migrate();
    expect(f.store.list()).toHaveLength(5);
  });

  it("reads actual persisted schedule, completed Web and Herdr sources without changing their records or ticket", async () => {
    const f = fixture(), scheduled = owner(), completed = owner(), active = owner(), herdrOwner = owner();
    f.add(scheduled);
    const worker = openWorkerStore(path.join(f.root, "worker.sqlite"), { onMigration: () => {} });
    const web = openWebExecutionStore(path.join(f.root, "web.sqlite"), { onMigration: () => {} });
    const herdr = openHerdrLifecycleStore(path.join(f.root, "herdr.sqlite"), { onMigration: () => {} });
    try {
      worker.registerProject({ projectId: scheduled.projectId, repoUrl: "https://example.test/repo.git", localPath: f.repositoryPath });
      worker.saveCleanupSchedule(scheduled, { deadline: 100, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
      const config = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
      const register = (value: ResourceOwner) => {
        const project = { projectId: value.projectId, repoUrl: "https://example.test/repo.git", localPath: f.repositoryPath };
        const task = web.register({ ...value, project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(), configuration: config }, 1);
        return web.bindWorktree(task, f.binding(value), 2);
      };
      let done = register(completed); register(active);
      done = web.initializeWebExecution(done, 3);
      const execution = done.webExecution!;
      const ticket: ControllerLaunchTicket = {
        schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId,
        controllerInstanceId: execution.controllerInstanceId, sessionId: randomUUID(), executionGeneration: execution.executionGeneration,
        serverOrigin: done.serverOrigin, projectId: done.projectId, taskId: done.taskId, claimId: done.claimId, workerId: done.workerId,
        worktreeId: done.worktreeId, userId: done.userId!, provider: "codex", cwd: done.resources.worktree!.worktreePath,
        nativeHome: path.join(f.root, "native"), configuration: config, initialOperationId: execution.initialOperationId,
        initialPrompt: "fixture", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"),
        ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString(),
      };
      const ticketPath = await writeLaunchTicket(f.root, ticket), ticketBytes = readFileSync(ticketPath);
      web.beginCleanup(done, { kind: "terminal", deadline: 100 }, 4); web.completeTask(done, 5);
      herdr.create({ owner: { projectId: herdrOwner.projectId, taskId: herdrOwner.taskId, worktreeId: herdrOwner.worktreeId,
        workerId: randomUUID(), ownerUserId: randomUUID(), serverOrigin: "https://daynight.example", provider: "codex" },
      claimId: herdrOwner.claimId, cwd: f.binding(herdrOwner).worktreePath });
      const rawRows = (file: string, table: string) => {
        const db = new Database(file, { readonly: true });
        try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); }
      };
      const webRows = rawRows(path.join(f.root, "web.sqlite"), "executions"), herdrRows = rawRows(path.join(f.root, "herdr.sqlite"), "executions");
      const operation = createOperation();
      try {
        await migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation, sources: {
          listSchedules: () => worker.listCleanupSchedules(),
          listWebTasks: () => [...web.listCompletedTasks(), ...web.listUnfinishedTasks()],
          listHerdrLifecycles: () => herdr.list(), listHerdrRetired: () => herdr.listRetired(), listHerdrResources: () => [], listHerdrBindings: () => [],
        } });
      } finally { operation.dispose(); }
      expect(f.store.list()).toEqual(expect.arrayContaining([scheduled, active, herdrOwner].map(expected)));
      expect(f.store.read(completed.worktreeId)).toBeNull();
      expect(web.listCompletedTasks()).toHaveLength(1);
      expect(rawRows(path.join(f.root, "web.sqlite"), "executions")).toEqual(webRows);
      expect(rawRows(path.join(f.root, "herdr.sqlite"), "executions")).toEqual(herdrRows);
      expect(readFileSync(ticketPath)).toEqual(ticketBytes);
    } finally { herdr.close(); web.close(); worker.close(); }
  });

  it("keeps completed Web history and a stale schedule while a new owner reuses the real checkout", async () => {
    const f = historicalFixture();
    try {
      f.registerWeb(f.old); f.release();
      f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      f.worker.saveCleanupSchedule(f.old, { deadline: 100, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
      const current = f.reuse(); f.registerWeb(f.next);
      writeFileSync(path.join(current.cwd, "tracked.txt"), "current owner\n");
      const pointer = readFileSync(path.join(current.cwd, ".git")), oldBinding = f.web.getTask(f.old)!.resources.worktree;
      const webRows = snapshotRows(f.webFile, "executions"), schedules = snapshotRows(f.workerFile, "cleanup_schedules");
      await f.run();
      expect(f.store.list()).toEqual([expected(f.next)]);
      expect(f.web.getTask(f.old)!.resources.worktree).toEqual(oldBinding);
      expect(snapshotRows(f.webFile, "executions")).toEqual(webRows);
      expect(snapshotRows(f.workerFile, "cleanup_schedules")).toEqual(schedules);
      expect(readFileSync(path.join(current.cwd, ".git"))).toEqual(pointer);
      expect(readFileSync(path.join(current.cwd, "tracked.txt"), "utf8")).toBe("current owner\n");
    } finally { f.close(); }
  });

  it("ignores a stale schedule for completed Web execution without a frozen worktree binding", async () => {
    const f = historicalFixture();
    try {
      f.registerWeb(f.old, false); f.release();
      f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      f.worker.saveCleanupSchedule(f.old, { deadline: 100, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
      const schedules = snapshotRows(f.workerFile, "cleanup_schedules");
      await f.run();
      expect(f.store.list()).toEqual([]);
      expect(f.web.getTask(f.old)!.resources.worktree).toBeNull();
      expect(snapshotRows(f.workerFile, "cleanup_schedules")).toEqual(schedules);
      expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
    } finally { f.close(); }
  });

  it("rejects a Web done record lacking terminal cleanup evidence even without a binding", async () => {
    const f = historicalFixture();
    try {
      const task = f.registerWeb(f.old, false);
      await expect(f.run({ ...f.sources, listWebTasks: () => [{ ...task, status: "done", cleanup: null }] })).rejects.toThrow();
      expect(readFileSync(path.join(f.original.admin, "locked"), "utf8").trim()).toBe(f.original.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("accepts a retired Web cwd with native case aliases when the filesystem supports them", async context => {
    const f = historicalFixture();
    try {
      const alias = path.join(f.root, "REPO");
      if (!existsSync(alias) || realpathSync(alias) !== realpathSync(f.repositoryPath)) context.skip();
      const project = { projectId: f.old.projectId, repoUrl: "https://example.test/repo.git", localPath: alias };
      f.web.register({ ...f.old, project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
        configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
      const frozen = { ...f.binding(f.old), repositoryPath: alias, commonDirectory: path.join(alias, ".git"), worktreePath: path.join(alias, ".worktrees", "daynight", f.old.taskId) };
      f.web.bindWorktree(f.old, frozen, 2); f.release();
      f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      f.reuse(); f.registerWeb(f.next);
      await f.run();
      expect(f.store.list()).toEqual([expected(f.next)]);
      expect(f.web.getTask(f.old)!.resources.worktree).toEqual(frozen);
    } finally { f.close(); }
  });

  it.skipIf(process.platform === "win32")("rejects a retired Web repository path with deceptive symlink traversal", async () => {
    const f = historicalFixture();
    try {
      const other = path.join(f.root, "other"), child = path.join(other, "child"), foreign = path.join(other, "repo");
      mkdirSync(child, { recursive: true }); mkdirSync(path.join(foreign, ".git"), { recursive: true });
      const alias = path.join(f.root, "redirect"); symlinkSync(child, alias, "dir");
      const deceptive = `${alias}/../repo`, common = `${deceptive}/.git`;
      expect(path.normalize(deceptive)).toBe(f.repositoryPath);
      expect(realpathSync.native(deceptive)).toBe(foreign);
      const project = { projectId: f.old.projectId, repoUrl: "https://example.test/repo.git", localPath: deceptive };
      f.web.register({ ...f.old, project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
        configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
      f.web.bindWorktree(f.old, { ...f.binding(f.old), repositoryPath: deceptive, commonDirectory: common }, 2);
      f.release(); f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      const current = f.reuse();
      await expect(f.run()).rejects.toThrow("Retired Web binding belongs to another repository.");
      expect(readFileSync(path.join(current.admin, "locked"), "utf8").trim()).toBe(current.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it.skipIf(process.platform === "win32")("accepts a verified parent alias after the retired namespace disappears", async () => {
    const f = historicalFixture();
    try {
      const link = path.join(f.root, "alias"); symlinkSync(f.root, link, "dir");
      const alias = path.join(link, "repo"), project = { projectId: f.old.projectId, repoUrl: "https://example.test/repo.git", localPath: alias };
      f.web.register({ ...f.old, project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
        configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
      const binding = { ...f.binding(f.old), repositoryPath: alias, commonDirectory: path.join(alias, ".git"), worktreePath: path.join(alias, ".worktrees", "daynight", f.old.taskId) };
      f.web.bindWorktree(f.old, binding, 2); f.release();
      f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      rmdirSync(f.namespace); rmdirSync(path.dirname(f.namespace));
      const rows = snapshotRows(f.webFile, "executions");
      await f.run();
      expect(f.store.list()).toEqual([]);
      expect(snapshotRows(f.webFile, "executions")).toEqual(rows);
      expect(f.web.getTask(f.old)!.resources.worktree).toEqual(binding);
      expect(existsSync(f.namespace)).toBe(false);
    } finally { f.close(); }
  });

  it("rejects an unfinished Web owner when another claim uses its cwd", async () => {
    const f = historicalFixture();
    try {
      f.registerWeb(f.old); f.release(); const current = f.reuse(); f.registerWeb(f.next);
      const rows = snapshotRows(f.webFile, "executions");
      await expect(f.run()).rejects.toThrow();
      expect(readFileSync(path.join(current.admin, "locked"), "utf8").trim()).toBe(current.marker);
      expect(snapshotRows(f.webFile, "executions")).toEqual(rows);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("rejects completed Web history contradicted by its own remaining marker", async () => {
    const f = historicalFixture();
    try {
      f.registerWeb(f.old); f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      const marker = readFileSync(path.join(f.original.admin, "locked"));
      await expect(f.run()).rejects.toThrow();
      expect(readFileSync(path.join(f.original.admin, "locked"))).toEqual(marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("does not discard a published manifest that contradicts completed Web history", async () => {
    const f = historicalFixture();
    try {
      f.registerWeb(f.old); f.release();
      f.web.beginCleanup(f.old, { kind: "terminal", deadline: 100 }, 4); f.web.completeTask(f.old, 5);
      f.store.publish(expected(f.old)); const current = f.reuse(); f.registerWeb(f.next);
      await expect(f.run()).rejects.toThrow();
      expect(f.store.read(f.old.worktreeId)).toEqual(expected(f.old));
      expect(readFileSync(path.join(current.admin, "locked"), "utf8").trim()).toBe(current.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("keeps retired Herdr lifecycle bytes when a later claim reuses its cwd", async () => {
    const f = historicalFixture();
    try {
      const record = f.registerHerdr(f.old); f.release(); f.herdr.retireNeverStarted(record);
      const current = f.reuse(); f.registerHerdr(f.next);
      const executions = snapshotRows(f.herdrFile, "executions"), retired = snapshotRows(f.herdrFile, "never_started_retirements");
      const cwd = f.herdr.get(f.old)!.cwd, pointer = readFileSync(path.join(current.cwd, ".git"));
      await f.run();
      expect(f.store.list()).toEqual([expected(f.next)]);
      expect(f.herdr.get(f.old)!.cwd).toBe(cwd);
      expect(snapshotRows(f.herdrFile, "executions")).toEqual(executions);
      expect(snapshotRows(f.herdrFile, "never_started_retirements")).toEqual(retired);
      expect(readFileSync(path.join(current.cwd, ".git"))).toEqual(pointer);
    } finally { f.close(); }
  });

  it("refuses unregistered foreign contents at a retired Herdr cwd", async () => {
    const f = historicalFixture();
    try {
      const record = f.registerHerdr(f.old); f.release(); f.herdr.retireNeverStarted(record);
      mkdirSync(f.original.cwd); const foreign = path.join(f.original.cwd, "foreign.txt"); writeFileSync(foreign, "keep\n");
      await expect(f.run()).rejects.toThrow();
      expect(readFileSync(foreign, "utf8")).toBe("keep\n");
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("uses a real Herdr archive deletion projection to distinguish a reused cwd", async () => {
    const f = fixture();
    const doc = JSON.parse(readFileSync(new URL("../../session/fixtures/v2/valid-archive.json", import.meta.url), "utf8")) as SessionV2Archive;
    const old: ResourceOwner = { projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId };
    const next = { ...old, claimId: randomUUID(), worktreeId: randomUUID() }, original = f.add(old);
    const file = path.join(f.root, "herdr.sqlite"), herdr = openHerdrLifecycleStore(file, { onMigration: () => {} });
    const recordingDirectory = path.join(f.root, "recordings"), source = path.join(recordingDirectory, doc.sessionId);
    const archiveDirectory = path.join(f.root, "archives");
    try {
      herdr.create({ owner: doc.owner, claimId: doc.claimId, cwd: original.cwd });
      const record: HerdrLifecycleRecord = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd: original.cwd,
        registrationId: doc.finalizationId, connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: "a".repeat(64),
        controlEpoch: "1", initialAssignment: "transport_completed", initialPrompt: null, automationBlocked: true, preparation: null,
        runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", nativeLaunch: "observed", instanceDirectory: f.root,
          daemon: { role: "daemon", pid: 99, birthToken: "start:daemon", bootId: run.stopProof!.bootId, auditToken: [501, 501, 20, 501, 20, 99, 100000, 99], ppid: 1, pgid: 99, sid: 99 },
          processes: run.stopProof!.processes.map(process => ({ ...process, auditToken: [501, 501, 20, 501, 20, process.pid, 100000, process.pid], ppid: 1, pgid: process.pid, sid: process.pid })),
          stopOperationId: run.stopProof!.recordId, stopReason: "terminal", error: null, admission: null })),
        segments: doc.segments.map(segment => ({ ...segment, gap: null })), version: 1 };
      const db = new Database(file);
      try { db.prepare("UPDATE executions SET version = ?, data = ?").run(record.version, JSON.stringify(record)); } finally { db.close(); }
      expect(herdr.get(old)).toEqual(record);
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId }));
      const archive = createHerdrRecordingArchive({ directory: archiveDirectory, api: { state: async () => { throw new Error("offline"); } } as unknown as HerdrArchiveApi });
      const resources = createHerdrRecordingResources({ directory: recordingDirectory, archive, list: () => herdr.list(), get: value => herdr.get(value),
        source: () => { throw new Error("unused"); }, publishStopped: async () => {}, currentUserId: async () => doc.owner.ownerUserId,
        readTask: async () => ({ id: old.taskId, projectId: old.projectId, status: "done", properties: {} } as Task) });
      const operation = createOperation();
      try {
        await resources.dispose({ ...old, sessionId: doc.sessionId, operationId: randomUUID(), action: "delete", confirmed: true }, operation, async () => {
          git(f.repositoryPath, ["worktree", "unlock", "--", original.cwd]);
          git(f.repositoryPath, ["worktree", "remove", "--force", "--", original.cwd]);
        });
      } finally { operation.dispose(); }
      const marker = `daynight-worker:${JSON.stringify({ ...next, leaf: "1:1", root: "2:2", common: "3:3" })}`;
      git(f.repositoryPath, ["worktree", "add", "--lock", "--reason", marker, "--", original.cwd, `daynight/${next.taskId}`]);
      const rows = snapshotRows(file, "executions"), journal = path.join(archiveDirectory, `${doc.sessionId}.archive-state.json`), journalBytes = readFileSync(journal);
      const pointer = readFileSync(path.join(original.cwd, ".git")), migration = createOperation();
      try {
        await migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation: migration,
          sources: { ...f.sources, listHerdrLifecycles: () => herdr.list(), listHerdrRetired: () => herdr.listRetired(), listHerdrResources: () => resources.resources() } });
      } finally { migration.dispose(); }
      expect(f.store.list()).toEqual([expected(next)]);
      expect(snapshotRows(file, "executions")).toEqual(rows);
      expect(readFileSync(journal)).toEqual(journalBytes);
      expect(readFileSync(path.join(original.cwd, ".git"))).toEqual(pointer);
    } finally { herdr.close(); }
  });

  it("does not treat an unretired Herdr lifecycle as released when its cwd is reused", async () => {
    const f = historicalFixture();
    try {
      f.registerHerdr(f.old); f.release(); const current = f.reuse(); f.registerHerdr(f.next);
      const records = snapshotRows(f.herdrFile, "executions");
      await expect(f.run()).rejects.toThrow();
      expect(readFileSync(path.join(current.admin, "locked"), "utf8").trim()).toBe(current.marker);
      expect(snapshotRows(f.herdrFile, "executions")).toEqual(records);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("rejects archive resources contradicting a never-started retirement", async () => {
    const f = historicalFixture();
    try {
      const record = f.registerHerdr(f.old); f.release(); f.herdr.retireNeverStarted(record);
      const resource = { owner: f.old, sessionId: record.sessionId, stopped: false, stopEvidence: [], terminal: false,
        worktreePath: record.cwd, sourcePath: path.join(f.root, "recordings", record.sessionId), sourceBytes: "0",
        state: "pending" as const, error: null, nextAttemptAt: null, worktreeDeleted: false, disposition: null };
      await expect(f.run({ ...f.sources, listHerdrResources: () => [resource] })).rejects.toThrow();
      expect(f.herdr.retired(f.old)).toEqual(record);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("retains both owners when a retirement inventory cannot be read", async () => {
    const f = historicalFixture();
    try {
      const record = f.registerHerdr(f.old); f.release(); f.herdr.retireNeverStarted(record); const current = f.reuse();
      await expect(f.run({ ...f.sources, listHerdrRetired: () => { throw new Error("retirement unavailable"); } })).rejects.toThrow("retirement unavailable");
      expect(readFileSync(path.join(current.admin, "locked"), "utf8").trim()).toBe(current.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("retains a Git marker when a legacy Herdr binding identifies a different claim at its cwd", async () => {
    const f = historicalFixture();
    try {
      await expect(f.run({ ...f.sources, listHerdrBindings: () => [{ owner: f.next, cwd: f.original.cwd }] })).rejects.toThrow();
      expect(readFileSync(path.join(f.original.admin, "locked"), "utf8").trim()).toBe(f.original.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it("correlates a complete legacy Herdr binding to its matching real Git marker", async () => {
    const f = historicalFixture();
    try {
      await f.run({ ...f.sources, listHerdrBindings: () => [{ owner: f.old, cwd: f.original.cwd }] });
      expect(f.store.list()).toEqual([expected(f.old)]);
      expect(existsSync(path.join(f.original.admin, "locked"))).toBe(false);
    } finally { f.close(); }
  });

  it("does not consume any legacy lock when Herdr binding enumeration fails", async () => {
    const f = historicalFixture();
    try {
      await expect(f.run({ ...f.sources, listHerdrBindings: () => { throw new Error("Herdr inventory unavailable"); } })).rejects.toThrow("Herdr inventory unavailable");
      expect(readFileSync(path.join(f.original.admin, "locked"), "utf8").trim()).toBe(f.original.marker);
      expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    } finally { f.close(); }
  });

  it.each(["manifest-published", "unlocked", "sidecar-removed", "format-published"] as const)("recovers after interruption at %s", async stage => {
    const f = fixture(), value = owner(), original = f.add(value), identityFile = sidecar(original.admin, value);
    const pointer = readFileSync(path.join(original.cwd, ".git")); let interrupted = false;
    await expect(f.migrate(current => { if (!interrupted && current === stage) { interrupted = true; throw new Error("controlled interruption"); } })).rejects.toThrow("controlled interruption");
    expect(interrupted).toBe(true);
    if (stage === "manifest-published") {
      expect(existsSync(path.join(original.admin, "locked"))).toBe(true);
      expect(existsSync(identityFile)).toBe(true);
    }
    if (stage !== "format-published") expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
    expect(existsSync(identityFile)).toBe(false);
    expect(readFileSync(path.join(original.cwd, ".git"))).toEqual(pointer);
  });

  it("rejects an unknown format without changing the existing registration", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    mkdirSync(f.directory, { recursive: true }); writeFileSync(path.join(f.directory, "format.json"), '{"version":2}');
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(f.store.list()).toEqual([]);
  });

  it("rejects the common directory of another real repository", async () => {
    const first = fixture(), second = fixture(), operation = createOperation();
    try {
      await expect(migrateLegacyWorktrees({ repositoryPath: first.repositoryPath, commonDirectory: second.commonDirectory, operation, sources: first.sources })).rejects.toThrow();
    } finally { operation.dispose(); }
    expect(existsSync(path.join(second.directory, "format.json"))).toBe(false);
  });

  it("preserves conflicting owners and does not publish format or unlock", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    f.schedule.push({ ...value, worktreeId: randomUUID() });
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("rejects a marker with a duplicate owner field and keeps its bytes", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    const markerFile = path.join(original.admin, "locked");
    const bytes = `daynight-worker:{"projectId":"${value.projectId}","projectId":"${randomUUID()}","taskId":"${value.taskId}","claimId":"${value.claimId}","worktreeId":"${value.worktreeId}"}\n`;
    writeFileSync(markerFile, bytes);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(markerFile, "utf8")).toBe(bytes);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("accepts physically equivalent cwd paths without rewriting frozen bindings", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    const cwd = `${original.cwd}${path.sep}..${path.sep}${value.taskId}`;
    const repositoryPath = `${f.repositoryPath}${path.sep}..${path.sep}repo`;
    const commonDirectory = `${f.commonDirectory}${path.sep}..${path.sep}.git`;
    f.web.push({ owner: value, binding: { ...f.binding(value), repositoryPath, commonDirectory, worktreePath: cwd } });
    const before = JSON.stringify({ web: f.web, herdr: f.herdr });
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.stringify({ web: f.web, herdr: f.herdr })).toBe(before);
  });

  it("accepts native case aliases when the filesystem resolves them to the same paths", async context => {
    const f = fixture(), value = owner(), original = f.add(value), alias = path.join(f.root, "REPO");
    if (!existsSync(alias) || realpathSync(alias) !== realpathSync(f.repositoryPath)) context.skip();
    const cwd = path.join(alias, ".worktrees", "daynight", value.taskId);
    f.web.push({ owner: value, binding: { ...f.binding(value), repositoryPath: alias, commonDirectory: path.join(alias, ".git"), worktreePath: cwd } });
    const before = JSON.stringify({ web: f.web, herdr: f.herdr });
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.stringify({ web: f.web, herdr: f.herdr })).toBe(before);
    expect(existsSync(path.join(original.cwd, ".git"))).toBe(true);
  });

  it("publishes every owner before unlocking any old source", async () => {
    const f = fixture(), first = owner(), second = owner(), a = f.add(first), b = f.add(second);
    let seen = false;
    await expect(f.migrate(stage => {
      if (stage === "unlocked") {
        seen = true;
        expect(f.store.list()).toEqual(expect.arrayContaining([expected(first), expected(second)]));
        expect(f.store.list()).toHaveLength(2);
        throw new Error("stop after first unlock");
      }
    })).rejects.toThrow("stop after first unlock");
    expect(seen).toBe(true);
    expect([a, b].filter(entry => existsSync(path.join(entry.admin, "locked")))).toHaveLength(1);
    await f.migrate();
    expect(existsSync(path.join(a.admin, "locked"))).toBe(false);
    expect(existsSync(path.join(b.admin, "locked"))).toBe(false);
  });

  it("retains the manifest when an unlocked registration is pruned before retry", async () => {
    const f = fixture(), value = owner(), original = f.add(value);
    await expect(f.migrate(stage => { if (stage === "unlocked") throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    rmSync(original.cwd, { recursive: true }); git(f.repositoryPath, ["worktree", "prune"]);
    expect(existsSync(original.admin)).toBe(false);
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
  });

  it("propagates a failed source enumeration before changing legacy ownership", async () => {
    const f = fixture(), value = owner(), original = f.add(value), operation = createOperation();
    try {
      await expect(migrateLegacyWorktrees({
        repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation,
        sources: { ...f.sources, listWebTasks: () => { throw new Error("source unavailable"); } },
      })).rejects.toThrow("source unavailable");
    } finally { operation.dispose(); }
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("retains a nonempty directory with no Git registration", async () => {
    const f = fixture(), value = owner(), cwd = f.binding(value).worktreePath;
    mkdirSync(cwd); writeFileSync(path.join(cwd, "foreign.txt"), "keep\n"); f.schedule.push(value);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(path.join(cwd, "foreign.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("retains a manually registered nonempty worktree after its reverse Git pointer disappears", async () => {
    const f = fixture(), value = owner(), original = f.add(value, false);
    rmSync(path.join(original.cwd, ".git"));
    writeFileSync(path.join(original.cwd, "foreign.txt"), "keep\n");
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(path.join(original.cwd, "foreign.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(original.admin)).toBe(true);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("refuses an unlocatable schedule without assuming its historical path", async () => {
    const f = fixture(), value = owner(); f.schedule.push(value);
    await expect(f.migrate()).rejects.toThrow();
    expect(f.store.list()).toEqual([]);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("preserves a manual lock and unrelated worktree metadata", async () => {
    const f = fixture(), value = owner(), original = f.add(value), cwd = path.join(f.root, "manual");
    git(f.repositoryPath, ["worktree", "add", "--lock", "--reason", "manual lock", "-b", "manual", "--", cwd]);
    const admin = git(cwd, ["rev-parse", "--absolute-git-dir"]);
    const file = path.join(admin, "manual-note"); writeFileSync(file, "untouched\n");
    await f.migrate();
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
    expect(readFileSync(path.join(admin, "locked"), "utf8").trim()).toBe("manual lock");
    expect(readFileSync(file, "utf8")).toBe("untouched\n");
    expect(f.store.list()).toEqual([expected(value)]);
  });

  it.skipIf(process.platform === "win32")("retries the admin directory barrier after sidecar removal", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = sidecar(original.admin, value);
    fault.syncDirectory = original.admin; fault.afterRemoval = file;
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    fault.syncDirectory = "";
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
  });

  it.each(["manifest", "format"] as const)("recovers from a real %s file flush failure", async target => {
    const f = fixture(), value = owner(), original = f.add(value);
    fault.temporaryPrefix = path.join(f.directory, target === "manifest" ? `${value.worktreeId}.json.` : "format.json.");
    await expect(f.migrate()).rejects.toThrow("controlled file flush failure");
    if (target === "manifest") expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    fault.temporaryPrefix = "";
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(JSON.parse(readFileSync(path.join(f.directory, "format.json"), "utf8"))).toEqual({ version: 1 });
  });

  it("retains every old lock if the second of multiple manifest publications fails", async () => {
    const f = fixture(), first = owner(), second = owner(), a = f.add(first), b = f.add(second);
    await expect(f.migrate((stage, published) => {
      if (stage === "manifest-published") {
        const remaining = published!.worktreeId === first.worktreeId ? second : first;
        fault.temporaryPrefix = path.join(f.directory, `${remaining.worktreeId}.json.`);
      }
    })).rejects.toThrow("controlled file flush failure");
    expect(f.store.list()).toHaveLength(1);
    expect(existsSync(path.join(a.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(b.admin, "locked"))).toBe(true);
    fault.temporaryPrefix = "";
    await f.migrate();
    expect(f.store.list()).toEqual(expect.arrayContaining([expected(first), expected(second)]));
  });

  it.skipIf(process.platform === "win32")("repairs a visible format file after its directory barrier fails", async () => {
    const f = fixture(), value = owner(); f.add(value);
    const file = path.join(f.directory, "format.json");
    fault.syncDirectory = f.directory; fault.afterPresent = file;
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1 });
    await expect(f.migrate()).rejects.toThrow("controlled directory barrier failure");
    fault.syncDirectory = "";
    await f.migrate();
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
  });

  it("retains the manifest and lock after a real failed Git unlock and retries", async () => {
    const f = fixture(), value = owner(), original = f.add(value), operation = createOperation();
    try {
      await expect(migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation, sources: f.sources,
        startOwnedGit: (cwd, _args, op, options) => startOwnedRepositoryGit(cwd, ["worktree", "unlock", path.join(f.root, "missing-worktree")], op, options),
      })).rejects.toThrow();
    } finally { operation.dispose(); }
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    await f.migrate();
    expect(existsSync(path.join(original.admin, "locked"))).toBe(false);
  });

  it("recovers when the second real Git unlock fails after the first succeeds", async () => {
    const f = fixture(), first = owner(), second = owner(), a = f.add(first), b = f.add(second), operation = createOperation();
    let attempts = 0;
    try {
      await expect(migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation, sources: f.sources,
        startOwnedGit: (cwd, args, op, options) => startOwnedRepositoryGit(cwd, ++attempts === 2 ? ["worktree", "unlock", path.join(f.root, "missing-worktree")] : args, op, options),
      })).rejects.toThrow();
    } finally { operation.dispose(); }
    expect(attempts).toBe(2);
    expect(f.store.list()).toHaveLength(2);
    expect([a, b].filter(entry => existsSync(path.join(entry.admin, "locked")))).toHaveLength(1);
    await f.migrate();
    expect([a, b].every(entry => !existsSync(path.join(entry.admin, "locked")))).toBe(true);
  });

  it("recovers after the actual sidecar unlink fails", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = sidecar(original.admin, value);
    fault.unlink = file;
    await expect(f.migrate()).rejects.toThrow("controlled sidecar unlink failure");
    expect(existsSync(file)).toBe(true);
    expect(f.store.read(value.worktreeId)).toEqual(expected(value));
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
    fault.unlink = "";
    await f.migrate();
    expect(existsSync(file)).toBe(false);
  });

  it("recovers when a later sidecar unlink fails after the first is removed", async () => {
    const f = fixture(), first = owner(), second = owner(), a = f.add(first), b = f.add(second);
    const files = [sidecar(a.admin, first), sidecar(b.admin, second)];
    await expect(f.migrate((stage, done) => {
      if (stage === "sidecar-removed") fault.unlink = files[done!.worktreeId === first.worktreeId ? 1 : 0]!;
    })).rejects.toThrow("controlled sidecar unlink failure");
    expect(files.filter(existsSync)).toHaveLength(1);
    expect(f.store.list()).toHaveLength(2);
    fault.unlink = "";
    await f.migrate();
    expect(files.some(existsSync)).toBe(false);
  });

  it("retains a malformed sidecar even if it mentions the same owner", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = path.join(original.admin, "daynight-identity.json");
    const bytes = JSON.stringify({ version: 1, owner: value, foreign: "keep" });
    writeFileSync(file, bytes);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("retains a sidecar whose marker digest no longer matches", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = sidecar(original.admin, value);
    const metadata = JSON.parse(readFileSync(file, "utf8")); metadata.markerSha256 = "f".repeat(64);
    const bytes = JSON.stringify(metadata); writeFileSync(file, bytes);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
  });

  it.skipIf(process.platform === "win32")("retains a nonprivate sidecar", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = sidecar(original.admin, value);
    chmodSync(file, 0o644); const bytes = readFileSync(file);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });

  it("retains a sidecar with multiple hard links", async () => {
    const f = fixture(), value = owner(), original = f.add(value), file = sidecar(original.admin, value), other = path.join(f.root, "sidecar-link");
    linkSync(file, other); const bytes = readFileSync(file);
    await expect(f.migrate()).rejects.toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(readFileSync(other)).toEqual(bytes);
    expect(readFileSync(path.join(original.admin, "locked"), "utf8").trim()).toBe(original.marker);
    expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  });
});
