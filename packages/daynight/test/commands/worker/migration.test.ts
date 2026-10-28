import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateWorkerWorkspaces, assertWorkerWorkspaceMigrationReady } from "../../../src/commands/worker/migration.js";
import type { WorkspaceMigrationDependencies, WorkspaceMigrationHerdr, WorkspaceMigrationPhase } from "../../../src/commands/worker/migration.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";

const root = path.resolve(import.meta.dirname, "../../../../../.tmp/m");
const home = root;
const owner = { projectId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", claimId: "33333333-3333-4333-8333-333333333333", worktreeId: "44444444-4444-4444-8444-444444444444" };
const sessionId = "55555555-5555-4555-8555-555555555555";
const origin = "https://daynight.example";
const legacy = { serverOrigin: origin, ...owner };
const label = `daynight:${JSON.stringify(legacy)}`;
const env = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: env(), timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const fingerprint = async (target: string): Promise<string> => { const stats = await lstat(target, { bigint: true }); return `${stats.dev}:${stats.ino}`; };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixture = async (ancestorAlias = false) => {
  await mkdir(root, { recursive: true });
  const paths = resolveWorkerPaths(home);
  await mkdir(paths.workerDirectory, { recursive: true });
  await writeFile(paths.configFile, `serverUrl: ${origin}\n`);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Fixture"]); git(repo, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  git(repo, ["add", "tracked.txt"]); git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["remote", "add", "origin", "https://example.com/repository.git"]);
  const worktree = path.join(repo, ".worktrees", "daynight", owner.taskId);
  git(repo, ["worktree", "add", "-b", `daynight/${owner.taskId}`, worktree, "HEAD"]);
  await writeFile(path.join(worktree, "tracked.txt"), "unfinished work\n");
  const admin = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const marker = path.join(admin, "locked");
  const fingerprints = { leaf: await fingerprint(worktree), root: await fingerprint(repo), common: await fingerprint(common) };
  const originalMarker = `daynight-worker:${JSON.stringify({ ...legacy, ...fingerprints })}\n`;
  await writeFile(marker, originalMarker);
  let configuredRepo = repo;
  if (ancestorAlias) {
    const alias = path.join(root, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    configuredRepo = path.join(alias, "repo");
  }
  const store = openWorkerStore(paths.databaseFile);
  store.registerProject({ projectId: owner.projectId, repoUrl: "https://example.com/repository.git", localPath: configuredRepo });
  store.registerPending({ ...owner, agent: "codex", sessionId });
  store.activateTask(owner); store.close();
  const sessionDirectory = path.join(paths.herdrDirectory, "c", "herdr", "sessions", "w");
  await mkdir(sessionDirectory, { recursive: true });
  const sessionFile = path.join(sessionDirectory, "session.json");
  const snapshot = { version: 3, workspaces: [{ id: "w1", custom_name: label, tabs: [{ panes: { "0": { cwd: worktree, agent_name: "old-agent", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: sessionId } } } }] }] };
  const sessionBytes = `${JSON.stringify(snapshot)}\n`;
  await writeFile(sessionFile, sessionBytes);
  await writeFile(path.join(sessionDirectory, "session-history.json"), "original terminal history");
  for (const name of ["session-backups", "session-snapshots"]) { await mkdir(path.join(sessionDirectory, name)); await writeFile(path.join(sessionDirectory, name, "session-old.json"), sessionBytes); }
  const events: string[] = [];
  let workspaces = [{ workspace_id: "w1", label }];
  let failStop = false;
  let loseSave = false;
  const adapter: WorkspaceMigrationHerdr = {
    assertStopped: async () => { events.push("assert-stopped"); },
    start: async () => {
      events.push("start");
      const restored = JSON.parse(await readFile(sessionFile, "utf8")) as { workspaces: { custom_name: string }[] };
      workspaces = restored.workspaces.map((workspace, index) => ({ workspace_id: `w${index + 1}`, label: workspace.custom_name }));
    },
    snapshot: async () => ({ workspaces: [...workspaces], panes: workspaces.map((workspace) => ({ workspace_id: workspace.workspace_id, cwd: worktree })) }),
    close: async (id) => { events.push(`close:${id}`); workspaces = workspaces.filter((workspace) => workspace.workspace_id !== id); },
    stop: async () => {
      events.push("stop");
      if (failStop) throw new Error("stop failed");
      if (!loseSave) await writeFile(sessionFile, `${JSON.stringify({ version: 3, workspaces: [] })}\n`);
    },
  };
  const dependencies: WorkspaceMigrationDependencies = { createHerdr: () => adapter };
  return { paths, repo, configuredRepo, worktree, marker, originalMarker, fingerprints, sessionDirectory, sessionFile, sessionBytes, events, adapter, dependencies, setFailStop: (value: boolean) => { failStop = value; }, setLoseSave: () => { loseSave = true; } };
};
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("one-time worker workspace migration", () => {
  it("retains SQLite native session and dirty Git work while closing and durably removing old Herdr identities", async () => {
    const f = await fixture();
    const database = hash(await readFile(f.paths.databaseFile));
    const phases: string[] = [];
    await migrateWorkerWorkspaces({ homeDirectory: home }, { ...f.dependencies, afterPhase: async (phase) => {
      phases.push(phase);
      await expect(assertWorkerWorkspaceMigrationReady(f.paths)).rejects.toThrow("incomplete");
      if (phase === "herdr-persisted") expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    } });
    expect(f.events).toEqual(["assert-stopped", "start", "close:w1", "stop"]);
    expect(phases).toEqual(["backed-up", "workspaces-closed", "herdr-persisted", "markers-written", "recovery-archived"]);
    expect(await readFile(f.marker, "utf8")).toBe(`daynight-worker:${JSON.stringify({ ...owner, ...f.fingerprints })}\n`);
    expect(hash(await readFile(f.paths.databaseFile))).toBe(database);
    expect(await readFile(path.join(f.worktree, "tracked.txt"), "utf8")).toBe("unfinished work\n");
    expect(git(f.worktree, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/daynight/${owner.taskId}`);
    const store = openWorkerStore(f.paths.databaseFile);
    expect(store.getTask(owner)?.sessionId).toBe(sessionId); store.close();
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
    await expect(lstat(path.join(f.sessionDirectory, "session-backups"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(f.sessionDirectory, "session-snapshots"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates and rolls back an ancestor directory alias while preserving the original configured path and execution", async () => {
    const f = await fixture(true);
    expect(f.configuredRepo).not.toBe(f.repo);
    expect(await realpath(f.configuredRepo)).toBe(await realpath(f.repo));
    const database = await readFile(f.paths.databaseFile);
    const config = await readFile(f.paths.configFile);
    const originalLeaf = await fingerprint(f.worktree);
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, { ...f.dependencies, afterPhase: async (phase) => {
      if (phase === "markers-written") throw new Error("interrupted aliased migration");
    } })).rejects.toThrow("interrupted aliased migration");
    expect(f.events).toContain("close:w1");
    expect(await readFile(f.marker, "utf8")).toBe(`daynight-worker:${JSON.stringify({ ...owner, ...f.fingerprints })}\n`);
    await migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies);
    expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    expect(await readFile(f.sessionFile, "utf8")).toBe(f.sessionBytes);
    expect(await readFile(f.paths.databaseFile)).toEqual(database);
    await migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies);
    expect(await readFile(f.paths.databaseFile)).toEqual(database);
    expect(await readFile(f.paths.configFile)).toEqual(config);
    expect(await fingerprint(f.worktree)).toBe(originalLeaf);
    expect(await readFile(path.join(f.worktree, "tracked.txt"), "utf8")).toBe("unfinished work\n");
    expect(git(f.worktree, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/daynight/${owner.taskId}`);
    const store = openWorkerStore(f.paths.databaseFile);
    const project = store.getProject(owner)!;
    const task = store.getTask(owner)!;
    store.close();
    expect(project.localPath).toBe(f.configuredRepo);
    expect(task).toMatchObject({ projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, sessionId, status: "active", agent: "codex" });
    const manager = createWorkerGitManager({ temporaryDirectory: path.join(root, "temporary") });
    const operation = createOperation();
    try {
      const binding = await manager.verifyWorktree(project, owner, operation);
      expect(binding.repositoryPath).toBe(f.configuredRepo);
      expect(await realpath(binding.worktreePath)).toBe(await realpath(f.worktree));
    } finally { operation.dispose(); await manager.dispose(); }
  });

  it.each<WorkspaceMigrationPhase>(["backed-up", "workspaces-closed", "herdr-persisted", "markers-written", "recovery-archived"])("keeps startup blocked after interruption at %s and restores the verified complete old set", async (interrupted) => {
    const f = await fixture();
    const database = hash(await readFile(f.paths.databaseFile));
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, { ...f.dependencies, afterPhase: async (phase) => { if (phase === interrupted) throw new Error(`interrupted:${phase}`); } })).rejects.toThrow(`interrupted:${interrupted}`);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).rejects.toThrow("incomplete");
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("--rollback");
    await migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies);
    expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    expect(await readFile(f.sessionFile, "utf8")).toBe(f.sessionBytes);
    expect(await readFile(path.join(f.sessionDirectory, "session-history.json"), "utf8")).toBe("original terminal history");
    expect(hash(await readFile(f.paths.databaseFile))).toBe(database);
    expect(await readFile(path.join(f.worktree, "tracked.txt"), "utf8")).toBe("unfinished work\n");
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
    await migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies);
    expect(await readFile(f.marker, "utf8")).not.toContain("serverOrigin");
  });

  it("does not migrate Git markers when a successful daemon stop did not persist workspace closure", async () => {
    const f = await fixture(); f.setLoseSave();
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("durably remove");
    expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).rejects.toThrow("incomplete");
  });

  it("preserves and reports a different service before creating the durable migration marker", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, "serverUrl: https://other.example\n");
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("another service");
    expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    expect(f.events).toEqual(["assert-stopped"]);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
  });

  it("blocks an unfinished legacy resource with unknown native session without pretending continuity", async () => {
    const f = await fixture();
    const database = new (await import("better-sqlite3")).default(f.paths.databaseFile);
    database.prepare("UPDATE tasks SET session_id = NULL").run(); database.close();
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("no recorded native session ID");
    expect(f.events).toEqual(["assert-stopped"]);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
  });

  it("detects replaced worktree directories before backing up or closing Herdr", async () => {
    const f = await fixture();
    await rename(f.worktree, `${f.worktree}-retained`); await mkdir(f.worktree);
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("fingerprints");
    expect(f.events).toEqual(["assert-stopped"]);
  });

  it("does not clear the blocking manifest when backup integrity prevents rollback", async () => {
    const f = await fixture();
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, { ...f.dependencies, afterPhase: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    const manifest = JSON.parse(await readFile(path.join(f.paths.workerDirectory, "workspace-migration.json"), "utf8")) as { backupDirectory: string; files: { backup: string }[] };
    await writeFile(path.join(manifest.backupDirectory, manifest.files[0]!.backup), "corrupt backup");
    await expect(migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies)).rejects.toThrow("cannot verify");
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).rejects.toThrow("incomplete");
  });

  it("releases the worker lock if creating the maintenance adapter throws", async () => {
    const f = await fixture();
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, { createHerdr: () => { throw new Error("constructor failed"); } })).rejects.toThrow("constructor failed");
    await migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
  });

  it("does not start a daemon or rewrite current resources when no legacy identities remain", async () => {
    const f = await fixture();
    await migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies);
    const marker = await readFile(f.marker);
    await writeFile(f.sessionFile, JSON.stringify({ version: 3, workspaces: [{ custom_name: `daynight: example | daynight:${JSON.stringify(owner)}` }] }));
    const count = f.events.length;
    await migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies);
    expect(f.events.slice(count)).toEqual(["assert-stopped"]);
    expect(await readFile(f.marker)).toEqual(marker);
    await expect(migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies)).rejects.toThrow("no incomplete");
  });

  it.skipIf(process.platform === "win32")("preserves recorded directory modes and verifies rollback under a restrictive umask", async () => {
    const f = await fixture();
    const directory = path.join(f.paths.herdrDirectory, "c");
    await chmod(directory, 0o755);
    const before = (await lstat(directory)).mode & 0o777;
    const originalMask = process.umask(0o077);
    try {
      await expect(migrateWorkerWorkspaces({ homeDirectory: home }, { ...f.dependencies, afterPhase: async (phase) => { if (phase === "markers-written") throw new Error("interrupted restrictive migration"); } })).rejects.toThrow("interrupted restrictive migration");
      await migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies);
      expect((await lstat(directory)).mode & 0o777).toBe(before);
      expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
      expect(await readFile(f.sessionFile, "utf8")).toBe(f.sessionBytes);
      await expect(assertWorkerWorkspaceMigrationReady(f.paths)).resolves.toBeUndefined();
    } finally { process.umask(originalMask); }
  });

  it("keeps migration blocked when private daemon termination is unconfirmed", async () => {
    const f = await fixture(); f.setFailStop(true);
    await expect(migrateWorkerWorkspaces({ homeDirectory: home }, f.dependencies)).rejects.toThrow("resource cleanup");
    expect(await readFile(f.marker, "utf8")).toBe(f.originalMarker);
    await expect(assertWorkerWorkspaceMigrationReady(f.paths)).rejects.toThrow("incomplete");
    f.setFailStop(false);
    await migrateWorkerWorkspaces({ homeDirectory: home, rollback: true }, f.dependencies);
  });
});
