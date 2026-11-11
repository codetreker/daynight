import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { ResourceOwner, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
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
  const sources = { listSchedules: () => schedule, listWebBindings: () => web, listHerdrBindings: () => herdr };
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
const expected = (value: ResourceOwner) => ({ schemaVersion: 1, ...value, directoryName: value.taskId });
const sidecar = (admin: string, value: ResourceOwner): string => {
  const marker = readFileSync(path.join(admin, "locked"));
  const identity = { kind: "darwin-apfs-v1", volumeUuid: randomUUID(), fileId: "1" };
  const file = path.join(admin, "daynight-identity.json");
  writeFileSync(file, JSON.stringify({ version: 1, owner: value, markerSha256: createHash("sha256").update(marker).digest("hex"), directories: { root: identity, common: identity, admin: identity, leaf: identity } }), { mode: 0o600 });
  return file;
};

describe("legacy worktree migration", { timeout: 30_000 }, () => {
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
      const ownerFrom = (value: ResourceOwner): ResourceOwner => ({ projectId: value.projectId, taskId: value.taskId, claimId: value.claimId, worktreeId: value.worktreeId });
      const operation = createOperation();
      try {
        await migrateLegacyWorktrees({ repositoryPath: f.repositoryPath, commonDirectory: f.commonDirectory, operation, sources: {
          listSchedules: () => worker.listCleanupSchedules(),
          listWebBindings: () => [...web.listCompletedTasks(), ...web.listUnfinishedTasks()].map(task => ({ owner: ownerFrom(task), binding: task.resources.worktree! })),
          listHerdrBindings: () => [...herdr.list(), ...herdr.listRetired()].map(record => ({ owner: ownerFrom({ ...record.owner, claimId: record.claimId }), cwd: record.cwd })),
        } });
      } finally { operation.dispose(); }
      expect(f.store.list()).toEqual(expect.arrayContaining([scheduled, completed, active, herdrOwner].map(expected)));
      expect(web.listCompletedTasks()).toHaveLength(1);
      expect(rawRows(path.join(f.root, "web.sqlite"), "executions")).toEqual(webRows);
      expect(rawRows(path.join(f.root, "herdr.sqlite"), "executions")).toEqual(herdrRows);
      expect(readFileSync(ticketPath)).toEqual(ticketBytes);
    } finally { herdr.close(); web.close(); worker.close(); }
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
    f.herdr.push({ owner: value, cwd });
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
    f.herdr.push({ owner: value, cwd });
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
        sources: { ...f.sources, listWebBindings: () => { throw new Error("source unavailable"); } },
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
