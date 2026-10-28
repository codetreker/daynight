import Database from "better-sqlite3";
import { lstat, readdir, realpath, rename } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { loadServerConfiguration, normalizeServerUrl } from "../../config/server.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import { runRepositoryGit } from "../../repository/git.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { createHerdrInstance, resolveHerdrInstancePaths } from "./herdr/instance.js";
import { herdrIpcAddress } from "./herdr/rpc.js";
import { acquireWorkerInstanceLock } from "./instance-lock.js";
import {
  assertWorkerWorkspaceMigrationReady, completeWorkspaceMigration, createWorkspaceMigrationBackup,
  migrationDirectoryIdentity, migrationExists, migrationHash, persistWorkspaceMigrationPhase,
  readMigrationFile, readWorkspaceMigrationManifest, rollbackWorkspaceMigration, syncMigrationDirectory,
  workspaceMigrationFile, writeMigrationFile,
} from "./migration-state.js";
import type { WorkspaceMigrationManifest } from "./migration-state.js";
import { resolveWorkerPaths } from "./paths.js";
import type { WorkerPaths } from "./paths.js";
import { parseResourceOwner, resourceOwnerKey, sameResourceOwner } from "./resource-owner.js";
import type { LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export { assertWorkerWorkspaceMigrationReady } from "./migration-state.js";
export type WorkspaceMigrationPhase = "backed-up" | "workspaces-closed" | "herdr-persisted" | "markers-written" | "recovery-archived";
export type WorkspaceMigrationHerdr = {
  assertStopped(operation: Operation): Promise<void>;
  start(operation: Operation): Promise<void>;
  snapshot(operation: Operation): Promise<Record<string, unknown>>;
  close(workspaceId: string, operation: Operation): Promise<void>;
  stop(operation: Operation): Promise<void>;
};
export type WorkspaceMigrationDependencies = {
  createHerdr?: (paths: WorkerPaths) => WorkspaceMigrationHerdr;
  afterPhase?: (phase: WorkspaceMigrationPhase) => Promise<void>;
};

type LegacyOwner = ResourceOwner & { serverOrigin: string };
type LegacyMarker = LegacyOwner & { leaf: string; root: string; common: string };
type MarkerPlan = { file: string; before: string; after: string; owner: ResourceOwner };
type Inventory = { projects: WorkerProject[]; tasks: LocalTask[] };
type WorkspacePlan = { label: string; owner: ResourceOwner; cwd: string };
const markerPrefix = "daynight-worker:";
const ownerFields = ["projectId", "taskId", "claimId", "worktreeId"] as const;
const ownerKey = (owner: Pick<ResourceOwner, "projectId" | "taskId" | "claimId">): string => `${owner.projectId}/${owner.taskId}/${owner.claimId}`;
const object = (value: unknown, subject: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${subject} must be an object.`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, subject: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array.`);
  return value;
};
const string = (value: unknown, subject: string): string => {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) throw new Error(`${subject} must be nonempty text without line breaks or NUL.`);
  return value;
};
const id = (value: unknown, subject: string): string => {
  const text = string(value, subject);
  if (canonicalId(text) !== text) throw new Error(`${subject} must be a canonical UUID.`);
  return text;
};
const plainOwner = (value: Record<string, unknown>): ResourceOwner => ({ projectId: id(value.projectId, "Project ID"), taskId: id(value.taskId, "Task ID"), claimId: id(value.claimId, "Claim ID"), worktreeId: id(value.worktreeId, "Worktree ID") });
const legacyOwner = (value: Record<string, unknown>, serverOrigin: string): LegacyOwner => {
  const actual = string(value.serverOrigin, "Legacy server origin");
  if (normalizeServerUrl(actual) !== actual || actual !== serverOrigin) throw new Error("A legacy resource belongs to another service. Restore its original configuration before migrating.");
  return { serverOrigin: actual, ...plainOwner(value) };
};
const parseLegacyLabel = (label: unknown, serverOrigin: string): LegacyOwner | null => {
  if (typeof label !== "string") return null;
  const currentSuffix = label.lastIndexOf(" | daynight:");
  if (currentSuffix > 0) {
    parseResourceOwner(label.slice(currentSuffix + " | daynight:".length));
    return null;
  }
  if (!label.startsWith("daynight:")) return null;
  const raw = label.slice("daynight:".length);
  const data = object(JSON.parse(raw) as unknown, "Legacy Herdr label");
  const fields = ["serverOrigin", ...ownerFields];
  if (Object.keys(data).length !== fields.length || fields.some((field) => !Object.hasOwn(data, field))) throw new Error("The legacy Herdr label has an unsupported field set.");
  const owner = legacyOwner(data, serverOrigin);
  if (JSON.stringify(owner) !== raw) throw new Error("The legacy Herdr label does not use canonical identity encoding.");
  return owner;
};
const parseMarker = (raw: string, serverOrigin: string): LegacyMarker | null => {
  if (!raw.startsWith(markerPrefix)) return null;
  const value = object(JSON.parse(raw.slice(markerPrefix.length).trimEnd()) as unknown, "Legacy Git marker");
  const fields = [...ownerFields, "leaf", "root", "common"];
  if (!Object.hasOwn(value, "serverOrigin")) {
    if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new Error("The Git marker has an unsupported field set.");
    plainOwner(value);
    return null;
  }
  if (Object.keys(value).length !== fields.length + 1 || fields.some((field) => !Object.hasOwn(value, field))) throw new Error("The legacy Git marker has an unsupported field set.");
  const owner = legacyOwner(value, serverOrigin);
  const fingerprints = Object.fromEntries(["leaf", "root", "common"].map((field) => {
    const fingerprint = string(value[field], `Legacy ${field} fingerprint`);
    if (!/^\d+:\d+$/.test(fingerprint)) throw new Error("The legacy Git marker has an invalid directory fingerprint.");
    return [field, fingerprint];
  })) as Pick<LegacyMarker, "leaf" | "root" | "common">;
  return { ...owner, ...fingerprints };
};
const readInventory = async (paths: WorkerPaths): Promise<Inventory> => {
  if (!await migrationExists(paths.databaseFile)) return { projects: [], tasks: [] };
  await readMigrationFile(paths.databaseFile);
  const database = new Database(paths.databaseFile, { readonly: true, fileMustExist: true });
  try {
    const projects = (database.prepare("SELECT project_id AS projectId, repo_url AS repoUrl, local_path AS localPath FROM projects ORDER BY project_id").all() as Record<string, unknown>[]).map((row): WorkerProject => {
      const localPath = string(row.localPath, "Project repository path");
      if (!path.isAbsolute(localPath)) throw new Error("The original project repository path is not absolute.");
      return { projectId: id(row.projectId, "Project ID"), repoUrl: string(row.repoUrl, "Project repository URL"), localPath };
    });
    const tasks = (database.prepare("SELECT project_id AS projectId, task_id AS taskId, claim_id AS claimId, status, agent, session_id AS sessionId FROM tasks ORDER BY project_id, task_id, claim_id").all() as Record<string, unknown>[]).map((row): LocalTask => {
      if (row.status !== "pending" && row.status !== "active" && row.status !== "done") throw new Error("The persisted task has an unsupported status.");
      if (row.agent !== "codex" && row.agent !== "copilot") throw new Error("The persisted task has an unsupported native agent.");
      return { projectId: id(row.projectId, "Project ID"), taskId: id(row.taskId, "Task ID"), claimId: id(row.claimId, "Claim ID"), status: row.status, agent: row.agent, sessionId: row.sessionId === null ? null : id(row.sessionId, "Native session ID") };
    });
    return { projects, tasks };
  } finally { database.close(); }
};
const needTask = (owner: ResourceOwner, inventory: Inventory): LocalTask => {
  const task = inventory.tasks.find((candidate) => ownerKey(candidate) === ownerKey(owner));
  if (task === undefined) throw new Error(`The legacy resource has no original SQLite claim: ${ownerKey(owner)}.`);
  if (task.status !== "done" && task.sessionId === null) throw new Error(`The legacy execution ${ownerKey(owner)} has no recorded native session ID. Inspect it before migrating.`);
  return task;
};
const git = async (cwd: string, arguments_: readonly string[], operation: Operation): Promise<string> => {
  const result = await runRepositoryGit(cwd, ["-c", "core.hooksPath=", ...arguments_], operation);
  return result.stdout.replace(/\r?\n$/, "");
};
const markerPlans = async (inventory: Inventory, serverOrigin: string, operation: Operation): Promise<MarkerPlan[]> => {
  const plans: MarkerPlan[] = [];
  const owners = new Map<string, ResourceOwner>();
  for (const project of inventory.projects) {
    operation.check();
    const rootIdentity = await migrationDirectoryIdentity(project.localPath);
    if (path.normalize(await realpath(await git(project.localPath, ["rev-parse", "--show-toplevel"], operation))) !== path.normalize(await realpath(project.localPath))) throw new Error("The project path no longer identifies its original primary worktree.");
    if (repositoryIdentity(await git(project.localPath, ["config", "--get", "remote.origin.url"], operation)) !== repositoryIdentity(project.repoUrl)) throw new Error("The original repository remote does not match the stored project mapping.");
    const common = await realpath(await git(project.localPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation));
    const commonIdentity = await migrationDirectoryIdentity(common);
    const family = path.join(common, "worktrees");
    if (!await migrationExists(family)) continue;
    await migrationDirectoryIdentity(family);
    for (const name of (await readdir(family)).sort()) {
      const admin = path.join(family, name);
      await migrationDirectoryIdentity(admin);
      const file = path.join(admin, "locked");
      if (!await migrationExists(file)) continue;
      const before = (await readMigrationFile(file)).toString("utf8");
      const marker = parseMarker(before, serverOrigin);
      if (marker === null || marker.projectId !== project.projectId) continue;
      const owner = plainOwner(marker as unknown as Record<string, unknown>);
      needTask(owner, inventory);
      const old = owners.get(ownerKey(owner));
      if (old !== undefined) throw new Error("Legacy resources have duplicate or conflicting four-field identities.");
      owners.set(ownerKey(owner), owner);
      const leaf = path.join(project.localPath, ".worktrees", "daynight", owner.taskId);
      if (marker.root !== rootIdentity || marker.common !== commonIdentity || marker.leaf !== await migrationDirectoryIdentity(leaf)) throw new Error("The legacy Git marker directory fingerprints do not match the original worktree.");
      const pointer = (await readMigrationFile(path.join(leaf, ".git"))).toString("utf8").trimEnd();
      const registered = (await readMigrationFile(path.join(admin, "gitdir"))).toString("utf8").trimEnd();
      const parent = (await readMigrationFile(path.join(admin, "commondir"))).toString("utf8").trimEnd();
      const physicalParent = await resolvePhysicalDirectory(path.dirname(leaf));
      const expectedPointer = path.join(physicalParent.ancestorPath, ...physicalParent.missingComponents, path.basename(leaf), ".git");
      if (!pointer.startsWith("gitdir: ") || await realpath(path.resolve(leaf, pointer.slice(8))) !== admin
        || await realpath(path.resolve(admin, registered)) !== expectedPointer
        || await realpath(path.resolve(admin, parent)) !== common) throw new Error("The legacy worktree Git registration does not point to the original task path.");
      if (await git(leaf, ["symbolic-ref", "HEAD"], operation) !== `refs/heads/daynight/${owner.taskId}`) throw new Error("The legacy worktree no longer uses its original task branch.");
      plans.push({ file, before, owner, after: `${markerPrefix}${JSON.stringify({ ...owner, leaf: marker.leaf, root: marker.root, common: marker.common })}\n` });
    }
  }
  return plans;
};
const readPersistedWorkspaces = async (sessionFile: string): Promise<Record<string, unknown>[]> => {
  if (!await migrationExists(sessionFile)) return [];
  const snapshot = object(JSON.parse((await readMigrationFile(sessionFile)).toString("utf8")) as unknown, "Herdr session snapshot");
  if (snapshot.version !== 3) throw new Error("Workspace migration requires a supported Herdr session snapshot version 3.");
  return array(snapshot.workspaces, "Saved Herdr workspaces").map((workspace) => object(workspace, "Saved Herdr workspace"));
};
const workspacePlans = async (sessionFile: string, inventory: Inventory, markers: readonly MarkerPlan[], serverOrigin: string): Promise<WorkspacePlan[]> => {
  const plans: WorkspacePlan[] = [];
  const identities = new Set<string>();
  for (const workspace of await readPersistedWorkspaces(sessionFile)) {
    const owner = parseLegacyLabel(workspace.custom_name, serverOrigin);
    if (owner === null) continue;
    const task = needTask(owner, inventory);
    const marker = markers.find((candidate) => sameResourceOwner(candidate.owner, owner));
    if (marker === undefined) throw new Error("A legacy Herdr workspace has no matching verified Git ownership marker.");
    const key = ownerKey(owner);
    if (identities.has(key)) throw new Error("Legacy Herdr workspaces have duplicate or conflicting execution identities.");
    identities.add(key);
    const project = inventory.projects.find((candidate) => candidate.projectId === owner.projectId)!;
    const cwd = path.join(project.localPath, ".worktrees", "daynight", owner.taskId);
    const tabs = array(workspace.tabs, "Legacy workspace tabs");
    if (tabs.length !== 1) throw new Error("A legacy workspace has ambiguous tabs; retain it for inspection.");
    const panes = Object.values(object(object(tabs[0], "Legacy tab").panes, "Legacy saved panes"));
    if (panes.length !== 1) throw new Error("A legacy workspace has ambiguous panes; retain it for inspection.");
    const pane = object(panes[0], "Legacy pane");
    const savedCwd = string(pane.cwd, "Legacy pane cwd");
    if (!path.isAbsolute(savedCwd) || await realpath(savedCwd) !== await realpath(cwd)) throw new Error("A legacy Herdr pane no longer points at its original worktree.");
    if (pane.agent_session !== undefined && pane.agent_session !== null) {
      const native = object(pane.agent_session, "Legacy native session");
      if (native.kind !== "id" || native.agent !== task.agent || native.source !== `herdr:${task.agent}` || native.value !== task.sessionId) throw new Error("The saved Herdr native reference differs from the original SQLite session.");
    }
    plans.push({ label: string(workspace.custom_name, "Legacy label"), owner, cwd });
  }
  return plans;
};

const endpointStopped = (endpoint: string, operation: Operation): Promise<void> => new Promise((resolve, reject) => {
  operation.check();
  const socket = new Socket();
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("Cannot establish whether the private Herdr endpoint is stopped.")); }, Math.min(1_000, operation.remainingMs()));
  const finish = (error?: unknown): void => { clearTimeout(timer); operation.signal.removeEventListener("abort", cancel); socket.destroy(); if (error === undefined) resolve(); else reject(error); };
  const cancel = (): void => finish(operation.signal.reason);
  socket.once("connect", () => finish(new Error("The private Herdr daemon is still running. Stop the worker and its private daemon before migrating workspaces.")));
  socket.once("error", (error) => { if ("code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) finish(); else finish(error); });
  operation.signal.addEventListener("abort", cancel, { once: true });
  socket.connect(herdrIpcAddress(endpoint));
});
const defaultHerdr = (paths: WorkerPaths): WorkspaceMigrationHerdr => {
  const instance = createHerdrInstance({ paths });
  let startedHere = false;
  return {
    assertStopped: async (operation) => { await endpointStopped(instance.paths.apiEndpoint, operation); await endpointStopped(instance.paths.clientEndpoint, operation); },
    start: async (operation) => {
      if ((await instance.ensure(operation)).reconnected) throw new Error("Migration requires its own newly started maintenance Herdr daemon.");
      startedHere = true;
    },
    snapshot: async (operation) => {
      const result = await instance.rpc.request("session.snapshot", {}, operation);
      if (result.type !== "session_snapshot") throw new Error("The maintenance daemon returned an invalid session snapshot.");
      return object(result.snapshot, "Maintenance snapshot");
    },
    close: async (workspaceId, operation) => { if ((await instance.rpc.request("workspace.close", { workspace_id: workspaceId, close_group: false }, operation)).type !== "ok") throw new Error("The maintenance daemon did not acknowledge workspace closure."); },
    stop: async (operation) => { if (startedHere) { await instance.stop(operation); startedHere = false; } },
  };
};

const closeLegacyWorkspaces = async (herdr: WorkspaceMigrationHerdr, plans: readonly WorkspacePlan[], serverOrigin: string, operation: Operation): Promise<void> => {
  const snapshot = await herdr.snapshot(operation);
  const actual = array(snapshot.workspaces, "Maintenance workspaces").map((value) => object(value, "Maintenance workspace"));
  const panes = array(snapshot.panes, "Maintenance panes").map((value) => object(value, "Maintenance pane"));
  const matches: { id: string; plan: WorkspacePlan }[] = [];
  for (const workspace of actual) {
    const owner = parseLegacyLabel(workspace.label, serverOrigin);
    if (owner === null) continue;
    const plan = plans.find((candidate) => sameResourceOwner(candidate.owner, owner));
    if (plan === undefined || plan.label !== workspace.label) throw new Error("The restored legacy workspace differs from the complete migration inventory.");
    const workspaceId = string(workspace.workspace_id, "Maintenance workspace ID");
    const bound = panes.filter((pane) => pane.workspace_id === workspaceId);
    if (bound.length !== 1) throw new Error("The restored legacy workspace has ambiguous panes or a different cwd.");
    const restoredCwd = string(bound[0]!.cwd, "Maintenance cwd");
    if (!path.isAbsolute(restoredCwd) || await realpath(restoredCwd) !== await realpath(plan.cwd)) throw new Error("The restored legacy workspace has ambiguous panes or a different cwd.");
    matches.push({ id: workspaceId, plan });
  }
  if (matches.length !== plans.length || new Set(matches.map((match) => resourceOwnerKey(match.plan.owner))).size !== plans.length) throw new Error("The maintenance daemon did not restore every original legacy workspace.");
  for (const match of matches) { operation.check(); await herdr.close(match.id, operation); }
  const after = await herdr.snapshot(operation);
  if (array(after.workspaces, "Maintenance workspaces").some((value) => parseLegacyLabel(object(value, "Maintenance workspace").label, serverOrigin) !== null)) throw new Error("A legacy workspace remains after maintenance closure.");
};

export const migrateWorkerWorkspaces = async (
  options: { homeDirectory: string; rollback?: boolean; signal?: AbortSignal; log?: (message: string) => void },
  dependencies: WorkspaceMigrationDependencies = {},
): Promise<void> => {
  const paths = resolveWorkerPaths(options.homeDirectory);
  const lock = await acquireWorkerInstanceLock(paths);
  const operation = createOperation({ ...(options.signal === undefined ? {} : { signal: options.signal }), limits: { totalMs: 300_000 } });
  let herdr: WorkspaceMigrationHerdr | undefined;
  let started = false;
  let failure: unknown;
  try {
    operation.check();
    herdr = dependencies.createHerdr === undefined ? defaultHerdr(paths) : dependencies.createHerdr(paths);
    await herdr.assertStopped(operation);
    if (options.rollback === true) {
      if (!await migrationExists(workspaceMigrationFile(paths))) throw new Error("There is no incomplete workspace migration to roll back.");
      const manifest = await readWorkspaceMigrationManifest(paths);
      await rollbackWorkspaceMigration(paths, manifest);
      options.log?.("Restored and verified the original worker workspace state. Retry daynight worker migrate-workspaces to migrate it.\n");
      return;
    }
    await assertWorkerWorkspaceMigrationReady(paths);
    const { serverUrl } = await loadServerConfiguration(paths, operation.signal);
    const inventory = await readInventory(paths);
    const markers = await markerPlans(inventory, serverUrl, operation);
    const instancePaths = resolveHerdrInstancePaths(paths);
    const sessionFile = path.join(instancePaths.sessionDirectory, "session.json");
    const workspaces = await workspacePlans(sessionFile, inventory, markers, serverUrl);
    if (markers.length === 0 && workspaces.length === 0) { options.log?.("No legacy worker workspace identities require migration.\n"); return; }
    const targets = markers.map((marker) => marker.file);
    for (const file of [paths.databaseFile, `${paths.databaseFile}-wal`, `${paths.databaseFile}-shm`]) if (await migrationExists(file)) targets.push(file);
    const manifest = await createWorkspaceMigrationBackup(paths, targets, new Set([instancePaths.apiEndpoint, instancePaths.clientEndpoint]));
    const phase = async (value: WorkspaceMigrationPhase): Promise<void> => {
      await persistWorkspaceMigrationPhase(paths, manifest, value);
      options.log?.(`Worker workspace migration: ${value}.\n`);
      await dependencies.afterPhase?.(value);
      operation.check();
    };
    await phase("backed-up");
    if (workspaces.length !== 0) {
      started = true;
      await herdr.start(operation);
      await closeLegacyWorkspaces(herdr, workspaces, serverUrl, operation);
      await phase("workspaces-closed");
      await herdr.stop(operation);
      started = false;
      if ((await readPersistedWorkspaces(sessionFile)).some((workspace) => parseLegacyLabel(workspace.custom_name, serverUrl) !== null)) throw new Error("Herdr did not durably remove the legacy workspaces; keep the worker stopped and roll back.");
    }
    await phase("herdr-persisted");
    for (const marker of markers) {
      operation.check();
      if ((await readMigrationFile(marker.file)).toString("utf8") !== marker.before) throw new Error("A legacy Git marker changed after migration preflight; keep the worker stopped and roll back.");
      await writeMigrationFile(marker.file, marker.after, (await lstat(marker.file)).mode);
      if ((await readMigrationFile(marker.file)).toString("utf8") !== marker.after) throw new Error("A migrated Git marker failed readback verification.");
    }
    await phase("markers-written");
    for (const name of ["session-backups", "session-snapshots"]) {
      const directory = path.join(instancePaths.sessionDirectory, name);
      if (!await migrationExists(directory)) continue;
      await migrationDirectoryIdentity(directory);
      await rename(directory, path.join(manifest.backupDirectory, name));
      await syncMigrationDirectory(instancePaths.sessionDirectory);
      await syncMigrationDirectory(manifest.backupDirectory);
    }
    await phase("recovery-archived");
    await verifyUnchangedSQLite(paths, manifest);
    await completeWorkspaceMigration(paths, manifest, "completed");
    options.log?.(`Migrated ${markers.length} Git workspace identities and ${workspaces.length} Herdr workspaces; claims, worktrees and native session IDs were retained. Backup: ${manifest.backupDirectory}.\n`);
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanup: unknown[] = [];
    if (started && herdr !== undefined) {
      const stop = createOperation({ limits: { totalMs: 30_000 } });
      try { await herdr.stop(stop); } catch (error) { cleanup.push(error); } finally { stop.dispose(); }
    }
    operation.dispose();
    try { await lock.release(); } catch (error) { cleanup.push(error); }
    if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Workspace migration and resource cleanup did not both complete.");
  }
};

const verifyUnchangedSQLite = async (paths: WorkerPaths, manifest: WorkspaceMigrationManifest): Promise<void> => {
  for (const file of manifest.files.filter((file) => file.target === paths.databaseFile || file.target === `${paths.databaseFile}-wal` || file.target === `${paths.databaseFile}-shm`)) {
    if (migrationHash(await readMigrationFile(file.target)) !== file.hash) throw new Error("The original SQLite claim/session bytes changed during workspace migration.");
  }
};
