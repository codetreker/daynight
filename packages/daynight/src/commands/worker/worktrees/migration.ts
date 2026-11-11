import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Operation } from "../../../api/operation.js";
import { ensureDurableDirectory, syncDurableDirectory } from "../../../platform/durable-directory.js";
import { writeDurableJson } from "../../../platform/durable-json.js";
import { runRepositoryGit } from "../../../repository/git.js";
import { startOwnedRepositoryGit } from "../../../repository/git-owned.js";
import { decodeStrictSessionJson } from "../../../session/v2/values.js";
import { sameResourceOwner } from "../resource-owner.js";
import { parseWebTaskV1 } from "../backends/web-record.js";
import type { LocalTask as WebTask } from "../backends/web-types.js";
import { isHerdrNeverStarted, parseHerdrLifecycleRecord } from "../herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord } from "../herdr/lifecycle-types.js";
import type { HerdrRetainedResource } from "../herdr/resource-types.js";
import { hasConfirmedHerdrResourceDeletion } from "../resource-disposal.js";
import { readRegistrationIndex } from "../worktree-scan.js";
import { ambiguousMissingGitTargets, resolveGitDirectory, resolveGitFile } from "../worktree-paths.js";
import type { ResourceOwner } from "../types.js";
import { createWorktreeManifestStore, type WorktreeManifest } from "./manifest.js";
import { canonicalWorktreeId, managedNamespace } from "./paths.js";

export type MigrationSources = {
  /** Complete schedules belonging to this repository, including retained claims. */
  listSchedules(): Promise<readonly ResourceOwner[]> | readonly ResourceOwner[];
  /** Complete validated Web records from both unfinished and completed store listings. */
  listWebTasks(): Promise<readonly WebTask[]> | readonly WebTask[];
  /** Complete original Herdr lifecycles from the lifecycle store. */
  listHerdrLifecycles(): Promise<readonly HerdrLifecycleRecord[]> | readonly HerdrLifecycleRecord[];
  /**
   * Bindings from every workspace pane in tasks.listResources(operation) and
   * every pendingStops().context.cwd. An unavailable or partial observation,
   * workspace without panes, missing cwd, or inconsistent cwd must throw. An
   * adapter's error fallback to an empty list is not a complete observation.
   */
  listHerdrBindings(): Promise<readonly { owner: ResourceOwner; cwd: string }[]> | readonly { owner: ResourceOwner; cwd: string }[];
  /** Verified never-started retirements from the same lifecycle store's listRetired(). */
  listHerdrRetired(): Promise<readonly HerdrLifecycleRecord[]> | readonly HerdrLifecycleRecord[];
  /** Complete retained-resource projections from the original Herdr archive. */
  listHerdrResources(): Promise<readonly HerdrRetainedResource[]> | readonly HerdrRetainedResource[];
};
export type MigrationCheckpoint = "manifest-published" | "unlocked" | "sidecar-removed" | "format-published";
export type MigrationOptions = {
  repositoryPath: string;
  commonDirectory: string;
  operation: Operation;
  sources: MigrationSources;
  startOwnedGit?: typeof startOwnedRepositoryGit;
  checkpoint?: (stage: MigrationCheckpoint, owner?: ResourceOwner) => void | Promise<void>;
};

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const fields = ["projectId", "taskId", "claimId", "worktreeId"] as const;
const prefix = "daynight-worker:";
const ownerOf = (value: ResourceOwner): ResourceOwner => {
  if (typeof value !== "object" || value === null) throw new Error("Missing worktree owner.");
  return Object.fromEntries(fields.map(field => [field, canonicalWorktreeId(value[field])])) as ResourceOwner;
};
const markerOwner = (marker: string): ResourceOwner => {
  if (!marker.startsWith(prefix)) throw new Error("Not a Worker ownership marker.");
  const value: unknown = decodeStrictSessionJson(Buffer.from(marker.slice(prefix.length)), 32768);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Worker ownership marker.");
  return ownerOf(value as ResourceOwner);
};
const directory = async (target: string): Promise<string | null> => {
  try {
    const entry = await lstat(target, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Not an ordinary directory: ${target}`);
    return `${entry.dev}:${entry.ino}`;
  } catch (error) { if (missing(error)) return null; throw error; }
};
const ordinaryFile = async (target: string): Promise<string | null> => {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Not an ordinary file: ${target}`);
    return (await readFile(target, "utf8")).replace(/\r?\n$/, "");
  } catch (error) { if (missing(error)) return null; throw error; }
};
const sameManifest = (a: WorktreeManifest, b: WorktreeManifest): boolean => sameResourceOwner(a, b) && a.directoryName === b.directoryName && a.schemaVersion === b.schemaVersion;
const claim = (owner: ResourceOwner): string => JSON.stringify([owner.projectId, owner.taskId, owner.claimId]);
const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const inspectSidecar = async (admin: string, owner: ResourceOwner, marker: string | null): Promise<string | null> => {
  const file = path.join(admin, "daynight-identity.json");
  let before;
  try { before = await lstat(file, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  const valid = (stat: typeof before): boolean => stat.isFile() && stat.nlink === 1n
    && (process.platform === "win32" || (typeof process.getuid === "function" && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === 0o600n));
  if (!valid(before) || before.size > 32768n) throw new Error("Worktree identity sidecar is not an owned private regular file.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let contents: string;
  try {
    const observed = await handle.stat({ bigint: true });
    if (!valid(observed) || observed.dev !== before.dev || observed.ino !== before.ino || observed.size !== before.size) throw new Error("Worktree identity sidecar changed while opening.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (bytes.length !== Number(before.size) || !valid(after) || !valid(current) || after.dev !== before.dev || after.ino !== before.ino
      || current.dev !== before.dev || current.ino !== before.ino || after.size !== before.size || current.size !== before.size
      || after.mtimeNs !== before.mtimeNs || current.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || current.ctimeNs !== before.ctimeNs) throw new Error("Worktree identity sidecar changed while reading.");
    contents = bytes.toString("utf8");
  } finally { await handle.close(); }
  const value: unknown = decodeStrictSessionJson(Buffer.from(contents), 32768);
  if (!exactObject(value, ["version", "owner", "markerSha256", "directories"]) || value.version !== 1
    || !exactObject(value.owner, fields) || !sameResourceOwner(ownerOf(value.owner as ResourceOwner), owner)
    || typeof value.markerSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.markerSha256)
    || !exactObject(value.directories, ["root", "common", "admin", "leaf"])) throw new Error("Unrecognized worktree identity sidecar.");
  for (const role of ["root", "common", "admin", "leaf"] as const) {
    const identity = value.directories[role];
    if (!exactObject(identity, ["kind", "volumeUuid", "fileId"]) || identity.kind !== "darwin-apfs-v1"
      || typeof identity.volumeUuid !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(identity.volumeUuid)
      || identity.volumeUuid === "00000000-0000-0000-0000-000000000000"
      || typeof identity.fileId !== "string" || !/^[1-9][0-9]{0,19}$/.test(identity.fileId) || BigInt(identity.fileId) > 0xffffffffffffffffn) throw new Error("Unrecognized worktree identity sidecar directory.");
  }
  if (marker !== null) {
    const bytes = await readFile(path.join(admin, "locked"));
    if (bytes.toString("utf8").replace(/\r?\n$/, "") !== marker || createHash("sha256").update(bytes).digest("hex") !== value.markerSha256) throw new Error("Worktree identity sidecar does not match the Worker lock.");
  }
  return contents;
};

/**
 * Run under the repository's existing exclusive Worker ownership and task gates,
 * with the previous Worker stopped. Source callbacks must enumerate every record
 * for this repository and propagate read failures; they are called again before
 * format publication. This does not move or remove checkout contents.
 */
export const migrateLegacyWorktrees = async (options: MigrationOptions): Promise<WorktreeManifest[]> => {
  const { operation, sources } = options;
  operation.check();
  if (!path.isAbsolute(options.repositoryPath) || !path.isAbsolute(options.commonDirectory)) throw new Error("Migration requires absolute repository and common-directory paths.");
  const root = await resolveGitDirectory(".", options.repositoryPath), common = await resolveGitDirectory(".", options.commonDirectory);
  const rootIdentity = await directory(root), commonIdentity = await directory(common);
  if (rootIdentity === null || commonIdentity === null) throw new Error("Migration repository or common directory is missing.");
  const canonicalRoot = await realpath(root), canonicalCommon = await realpath(common);
  const gitRead = async (args: readonly string[]): Promise<string> => (await runRepositoryGit(root, args, operation)).stdout.replace(/\r?\n$/, "");
  if (await gitRead(["rev-parse", "--is-bare-repository"]) !== "false"
    || await realpath(await gitRead(["rev-parse", "--show-toplevel"])) !== canonicalRoot
    || await realpath(await gitRead(["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== canonicalCommon) throw new Error("Migration repository root and Git common directory do not match.");
  const namespace = managedNamespace(root), parent = path.join(common, "daynight"), manifestDir = path.join(parent, "worktrees"), format = path.join(manifestDir, "format.json");
  const store = createWorktreeManifestStore(common);
  const namespaceExists = await directory(parent) !== null && await directory(manifestDir) !== null;
  const readFormat = (durable: boolean): boolean => {
    let before;
    try { before = lstatSync(format); } catch (error) { if (missing(error)) return false; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Worktree format is not an ordinary file.");
    const fd = openSync(format, (durable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Worktree format changed during read.");
      const value = decodeStrictSessionJson(readFileSync(fd), 16384);
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1 || (value as Record<string, unknown>).version !== 1) throw new Error("Unknown worktree format.");
      if (durable) fsyncSync(fd);
    } finally { closeSync(fd); }
    if (durable) syncDurableDirectory(manifestDir);
    return true;
  };
  const activeFormat = readFormat(false);
  if (namespaceExists) {
    // The durable writer may be interrupted before rename. Only its private,
    // single-link format temporaries can be retired; they are not owner evidence.
    const temporary = (await readdir(manifestDir)).filter(name => /^format\.json\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(name));
    for (const name of temporary) {
      const stat = await lstat(path.join(manifestDir, name), { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || (process.platform !== "win32" && (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o600n))) throw new Error("Worktree format temporary is not a private ordinary file.");
    }
    for (const name of temporary) await unlink(path.join(manifestDir, name));
    // Also retry the barrier when a prior unlink succeeded but its sync failed.
    syncDurableDirectory(manifestDir);
  }
  if (activeFormat) {
    ensureDurableDirectory(parent); ensureDurableDirectory(manifestDir);
    readFormat(true);
    return store.list();
  }
  const repo = { root, commonDirectory: common, rootIdentity, commonIdentity };
  const readers = { directory, ordinaryFile, markerOwner };
  const targetName = async (cwd: string): Promise<string> => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\r\n\0]/.test(cwd)) throw new Error("Invalid original worktree path.");
    const name = canonicalWorktreeId(path.basename(cwd));
    const original = await resolveGitFile(cwd, ".git"), expected = await resolveGitFile(path.join(namespace, name), ".git");
    if (original.path !== expected.path || ambiguousMissingGitTargets(original, expected)) throw new Error("Original worktree path is outside the managed namespace.");
    return name;
  };
  // A retired path may already belong to a successor. Validate its stored
  // location without opening or resolving the historical checkout.
  const sameDirectory = async (left: string, right: string): Promise<boolean> => {
    if (left === right) return true;
    await resolveGitDirectory(".", left); await resolveGitDirectory(".", right);
    const leftIdentity = await directory(left), rightIdentity = await directory(right);
    return leftIdentity !== null && leftIdentity === rightIdentity;
  };
  const historicalName = async (cwd: string, verifiedRoot?: string): Promise<string> => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\r\n\0]/.test(cwd) || cwd.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("Invalid retired worktree path.");
    const name = canonicalWorktreeId(path.basename(cwd));
    const knownRoots = [options.repositoryPath, ...(verifiedRoot === undefined ? [] : [verifiedRoot])].filter(candidate => !candidate.split(/[\\/]/).some(part => part === "." || part === ".."));
    if (path.dirname(cwd) !== namespace && !knownRoots.some(candidate => path.dirname(cwd) === managedNamespace(candidate))
      && !await sameDirectory(path.dirname(cwd), namespace)) throw new Error("Retired worktree path is outside the managed namespace.");
    return name;
  };
  const collect = async () => {
    operation.check();
    const [schedules, rawWeb, rawHerdr, legacyHerdr, rawRetired, resources] = await Promise.all([
      sources.listSchedules(), sources.listWebTasks(), sources.listHerdrLifecycles(), sources.listHerdrBindings(), sources.listHerdrRetired(), sources.listHerdrResources(),
    ]);
    const values: WorktreeManifest[] = [];
    const identities = new Map<string, ResourceOwner>(), worktreeIds = new Map<string, ResourceOwner>();
    const observe = (input: ResourceOwner): ResourceOwner => {
      const owner = ownerOf(input), priorClaim = identities.get(claim(owner)), priorId = worktreeIds.get(owner.worktreeId);
      if (priorClaim && !sameResourceOwner(priorClaim, owner) || priorId && !sameResourceOwner(priorId, owner)) throw new Error("Conflicting worktree owners.");
      identities.set(claim(owner), owner); worktreeIds.set(owner.worktreeId, owner);
      return owner;
    };
    const retiredOwners = new Map<string, { owner: ResourceOwner; directoryName: string | null }>();
    const backendClaims = new Set<string>();
    const recordBackend = (owner: ResourceOwner): void => {
      if (backendClaims.has(claim(owner))) throw new Error("Conflicting original execution sources.");
      backendClaims.add(claim(owner));
    };
    const retire = async (owner: ResourceOwner, cwd: string | null, verifiedRoot?: string): Promise<void> => {
      const directoryName = cwd === null ? null : await historicalName(cwd, verifiedRoot);
      retiredOwners.set(claim(owner), { owner, directoryName });
    };
    const add = (input: ResourceOwner, name: string | null): void => {
      const owner = observe(input);
      if (retiredOwners.has(claim(owner))) throw new Error("Retired execution still has a worktree ownership source.");
      const old = values.find(item => item.worktreeId === owner.worktreeId || claim(item) === claim(owner));
      if (old) {
        if (!sameResourceOwner(old, owner) || (name !== null && old.directoryName !== name)) throw new Error("Conflicting worktree owners or locations.");
        return;
      }
      if (name === null) throw new Error("Worktree owner has no location evidence.");
      const directoryName = name;
      if (values.some(item => item.directoryName === directoryName)) throw new Error("Conflicting worktree locations.");
      values.push({ schemaVersion: 1, ...owner, directoryName });
    };
    const web = rawWeb.map(task => parseWebTaskV1(structuredClone(task)));
    const herdr = rawHerdr.map(record => parseHerdrLifecycleRecord(structuredClone(record)));
    const retired = rawRetired.map(record => parseHerdrLifecycleRecord(structuredClone(record)));
    const lifecycleOwners = new Map<string, { owner: ResourceOwner; record: HerdrLifecycleRecord }>();
    for (const task of web) {
      const owner = observe(task); recordBackend(owner);
      const binding = task.resources.worktree;
      if (binding === null) {
        if (task.status === "done") {
          if (task.cleanup?.kind !== "terminal") throw new Error("Completed Web execution has no confirmed terminal cleanup.");
          if (!await sameDirectory(root, task.repositoryPath)) throw new Error("Retired Web execution belongs to another repository.");
          await retire(owner, null);
        }
        continue;
      }
      if (binding.branch !== `daynight/${owner.taskId}` || !path.isAbsolute(task.repositoryPath) || !path.isAbsolute(binding.repositoryPath) || !path.isAbsolute(binding.commonDirectory)) throw new Error("Web worktree binding conflicts with its repository or owner.");
      if (task.status === "done") {
        if (task.cleanup?.kind !== "terminal") throw new Error("Completed Web worktree has no confirmed terminal cleanup.");
        if (!await sameDirectory(task.repositoryPath, binding.repositoryPath)
          || !await sameDirectory(root, binding.repositoryPath)
          || !await sameDirectory(common, binding.commonDirectory)) throw new Error("Retired Web binding belongs to another repository.");
        await retire(owner, binding.worktreePath, binding.repositoryPath);
      } else {
        if (await resolveGitDirectory(root, task.repositoryPath) !== canonicalRoot || await resolveGitDirectory(root, binding.repositoryPath) !== canonicalRoot
          || await resolveGitDirectory(common, binding.commonDirectory) !== canonicalCommon) throw new Error("Web worktree binding conflicts with its repository or owner.");
        add(owner, await targetName(binding.worktreePath));
      }
    }
    for (const record of herdr) {
      const owner = observe({ ...record.owner, claimId: record.claimId });
      canonicalWorktreeId(record.sessionId); recordBackend(owner);
      lifecycleOwners.set(claim(owner), { owner, record });
    }
    const retiredKeys = new Set<string>();
    for (const evidence of retired) {
      const owner = observe({ ...evidence.owner, claimId: evidence.claimId }), original = lifecycleOwners.get(claim(owner));
      if (!original || !sameResourceOwner(original.owner, owner) || !isDeepStrictEqual(original.record, evidence) || !isHerdrNeverStarted(evidence) || retiredKeys.has(claim(owner))) throw new Error("Herdr retirement does not match the original lifecycle.");
      retiredKeys.add(claim(owner));
    }
    const resourceKeys = new Set<string>();
    for (const resource of resources) {
      const owner = observe(resource.owner), original = lifecycleOwners.get(claim(owner));
      canonicalWorktreeId(resource.sessionId);
      if (!original || !sameResourceOwner(original.owner, owner) || resource.sessionId !== original.record.sessionId || resource.worktreePath !== original.record.cwd || resourceKeys.has(claim(owner))) throw new Error("Herdr resource does not match its original lifecycle.");
      if (retiredKeys.has(claim(owner))) throw new Error("Never-started retirement conflicts with a retained Herdr resource.");
      resourceKeys.add(claim(owner));
      if (resource.worktreeDeleted) {
        if (!hasConfirmedHerdrResourceDeletion(resource)) throw new Error("Herdr resource deletion lacks confirmed original evidence.");
        retiredKeys.add(claim(owner));
      }
    }
    for (const { owner, record } of lifecycleOwners.values()) {
      if (retiredKeys.has(claim(owner))) await retire(owner, record.cwd);
      else add(owner, await targetName(record.cwd));
    }
    const legacy = new Map<string, { owner: ResourceOwner; cwd: string }>();
    for (const binding of legacyHerdr) {
      const owner = observe(binding.owner), original = lifecycleOwners.get(claim(owner)), prior = legacy.get(claim(owner));
      if (retiredOwners.has(claim(owner)) || backendClaims.has(claim(owner)) && !original
        || original && original.record.cwd !== binding.cwd || prior && (!sameResourceOwner(prior.owner, owner) || prior.cwd !== binding.cwd)) throw new Error("Legacy Herdr binding conflicts with original execution evidence.");
      legacy.set(claim(owner), { owner, cwd: binding.cwd });
      add(owner, await targetName(binding.cwd));
    }
    for (const value of store.list()) add(value, value.directoryName);
    const index = await readRegistrationIndex(repo, readers, operation);
    for (const entry of index.entries) {
      if (entry.errors.length) throw entry.errors[0];
      if (!entry.managed) continue;
      if (entry.owner === null || entry.physicalPointer === null || entry.common === null) throw new Error("Incomplete Worker Git registration.");
      const expected = await resolveGitFile(path.join(namespace, entry.owner.taskId), ".git");
      if (entry.physicalPointer.path !== expected.path || await realpath(entry.common) !== canonicalCommon) throw new Error("Worker registration points outside its original repository or task path.");
      add(entry.owner, entry.owner.taskId);
    }
    for (const input of schedules) {
      const owner = observe(input);
      if (retiredOwners.has(claim(owner))) continue;
      const found = values.find(value => value.worktreeId === owner.worktreeId || claim(value) === claim(owner));
      if (!found) throw new Error("Cleanup schedule has no worktree location evidence.");
      add(owner, null);
    }
    const checkParent = await directory(path.dirname(namespace));
    const checkNamespace = checkParent === null ? null : await directory(namespace);
    if (checkNamespace !== null) {
      for (const name of await readdir(namespace)) {
        const target = path.join(namespace, name);
        const info = await lstat(target);
        if (info.isDirectory() && !info.isSymbolicLink() && !values.some(value => value.directoryName === name) && (await readdir(target)).length) {
          const targetPointer = await resolveGitFile(target, ".git");
          const foreign = index.entries.filter(entry => entry.physicalPointer?.path === targetPointer.path);
          if (foreign.length !== 1 || foreign[0]!.managed) throw new Error(`Unassociated nonempty worktree directory: ${target}`);
          const entry = foreign[0]!;
          const reverse = await ordinaryFile(path.join(target, ".git"));
          const commonPointer = await ordinaryFile(path.join(entry.directory, "commondir"));
          if (targetPointer.missing || reverse === null || !reverse.startsWith("gitdir: ")
            || await resolveGitDirectory(target, reverse.slice(8)) !== await realpath(entry.directory)
            || commonPointer === null || await realpath(await resolveGitDirectory(entry.directory, commonPointer)) !== canonicalCommon) throw new Error(`Unassociated nonempty worktree directory: ${target}`);
        }
      }
    }
    const associated: { manifest: WorktreeManifest; entry: typeof index.entries[number] | null }[] = [];
    for (const manifest of values) {
      operation.check();
      const leaf = path.join(namespace, manifest.directoryName);
      const leafIdentity = checkNamespace === null ? null : await directory(leaf);
      const pointer = await resolveGitFile(leaf, ".git");
      if (index.entries.some(entry => entry.physicalPointer && ambiguousMissingGitTargets(pointer, entry.physicalPointer))) throw new Error("Ambiguous missing Git registration targets.");
      const matches = index.entries.filter(entry => entry.physicalPointer?.path === pointer.path);
      if (matches.length > 1) throw new Error("Ambiguous worktree registrations.");
      const entry = matches[0] ?? null;
      if (entry === null) {
        if (leafIdentity !== null && (await readdir(leaf)).length) throw new Error("Nonempty worktree has no associated Git registration.");
      } else {
        if (entry.marker !== null && (!entry.managed || entry.owner === null || !sameResourceOwner(entry.owner, manifest))) throw new Error("Worktree has a foreign Git lock.");
        const commonPointer = entry.common ?? await ordinaryFile(path.join(entry.directory, "commondir"));
        if (commonPointer === null) throw new Error("Git registration has no common directory.");
        const actualCommon = entry.common ?? await resolveGitDirectory(entry.directory, commonPointer);
        if (await realpath(actualCommon) !== canonicalCommon) throw new Error("Git registration belongs to another repository.");
        const head = await ordinaryFile(path.join(entry.directory, "HEAD"));
        if (head !== `ref: refs/heads/daynight/${manifest.taskId}`) throw new Error("Worktree registration has an unexpected branch.");
        if (leafIdentity !== null) {
          const reverse = await ordinaryFile(path.join(leaf, ".git"));
          if (reverse === null) {
            const published = store.read(manifest.worktreeId);
            const owned = entry.managed && entry.owner !== null && sameResourceOwner(entry.owner, manifest)
              || entry.marker === null && published !== null && sameManifest(published, manifest);
            if (!owned || (await readdir(leaf)).length !== 0) throw new Error("Worktree reverse Git pointer does not match its registration.");
          } else if (!reverse.startsWith("gitdir: ") || await resolveGitDirectory(leaf, reverse.slice(8)) !== await realpath(entry.directory)) throw new Error("Worktree reverse Git pointer does not match its registration.");
        }
        await inspectSidecar(entry.directory, manifest, entry.marker);
      }
      associated.push({ manifest, entry });
    }
    if (await realpath(root) !== canonicalRoot || await directory(root) !== rootIdentity || await realpath(common) !== canonicalCommon || await directory(common) !== commonIdentity) throw new Error("Repository changed during migration.");
    return associated;
  };
  const initial = await collect();
  ensureDurableDirectory(parent); ensureDurableDirectory(manifestDir);
  for (const { manifest } of initial) {
    operation.check(); store.publish(manifest); await options.checkpoint?.("manifest-published", manifest);
  }
  for (const { manifest } of initial) {
    const found = store.read(manifest.worktreeId);
    if (found === null || !sameManifest(found, manifest)) throw new Error("Published worktree manifest did not read back.");
  }
  const covered = (entries: Awaited<ReturnType<typeof collect>>): void => {
    for (const { manifest } of entries) {
      const observed = store.read(manifest.worktreeId);
      if (observed === null || !sameManifest(observed, manifest)) throw new Error("Worktree source is not covered by a published manifest.");
    }
  };
  for (const { manifest } of initial) {
    operation.check();
    const observed = await collect();
    covered(observed);
    const current = observed.find(item => sameManifest(item.manifest, manifest));
    if (!current) throw new Error("Worktree source changed during migration.");
    const entry = current.entry;
    if (entry === null) continue;
    if (entry.marker !== null) {
      if (!entry.managed || entry.owner === null || !sameResourceOwner(entry.owner, manifest)) throw new Error("Worktree lock changed during migration.");
      const checked = await ordinaryFile(path.join(entry.directory, "locked"));
      if (checked === null || !sameResourceOwner(markerOwner(checked), manifest)) throw new Error("Worktree lock owner changed during migration.");
      const process = (options.startOwnedGit ?? startOwnedRepositoryGit)(root, ["worktree", "unlock", path.join(namespace, manifest.directoryName)], operation);
      let outcome;
      try { outcome = await process.outcome; }
      catch (error) { try { await process.joined; } catch (cleanup) { throw new AggregateError([error, cleanup], "Git unlock and local cleanup failed.", { cause: error }); } throw error; }
      const settlement = await process.joined;
      if (settlement.cleanupErrors.length) throw new AggregateError(outcome.kind === "success" ? settlement.cleanupErrors : [outcome.error, ...settlement.cleanupErrors], "Git unlock local cleanup failed.");
      if (outcome.kind !== "success") throw outcome.error;
      await options.checkpoint?.("unlocked", manifest);
    }
    const after = (await collect()).find(item => sameManifest(item.manifest, manifest));
    if (!after || after.entry?.directory !== entry.directory || after.entry.marker !== null) throw new Error("Worktree registration changed before sidecar removal.");
    const sidecar = path.join(entry.directory, "daynight-identity.json");
    const data = await inspectSidecar(entry.directory, manifest, null);
    if (data !== null) {
      await unlink(sidecar);
    }
    // A previous unlink may have succeeded before its directory barrier failed.
    syncDurableDirectory(entry.directory);
    await options.checkpoint?.("sidecar-removed", manifest);
  }
  const final = await collect();
  covered(final);
  for (const { manifest, entry } of final) {
    const published = store.read(manifest.worktreeId);
    if (published === null || !sameManifest(published, manifest)) throw new Error("Worktree source is not covered by a published manifest.");
    if (entry?.managed) throw new Error("Worker Git lock remains after migration.");
    if (entry && await ordinaryFile(path.join(entry.directory, "daynight-identity.json")) !== null) throw new Error("Worktree identity sidecar remains after migration.");
  }
  operation.check();
  writeDurableJson(format, { version: 1 });
  await options.checkpoint?.("format-published");
  if (!readFormat(true)) throw new Error("Worktree format did not read back.");
  return store.list();
};
