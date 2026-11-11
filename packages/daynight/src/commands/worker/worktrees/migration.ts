import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import { ensureDurableDirectory, syncDurableDirectory } from "../../../platform/durable-directory.js";
import { writeDurableJson } from "../../../platform/durable-json.js";
import { runRepositoryGit } from "../../../repository/git.js";
import { startOwnedRepositoryGit } from "../../../repository/git-owned.js";
import { decodeStrictSessionJson } from "../../../session/v2/values.js";
import { sameResourceOwner } from "../resource-owner.js";
import { readRegistrationIndex } from "../worktree-scan.js";
import { ambiguousMissingGitTargets, resolveGitDirectory, resolveGitFile } from "../worktree-paths.js";
import type { ResourceOwner, WorktreeBinding } from "../types.js";
import { createWorktreeManifestStore, type WorktreeManifest } from "./manifest.js";
import { canonicalWorktreeId, managedNamespace } from "./paths.js";

export type MigrationSources = {
  /** Complete schedules belonging to this repository, including retained claims. */
  listSchedules(): Promise<readonly ResourceOwner[]> | readonly ResourceOwner[];
  /** Complete Web worktree bindings, including completed executions, for this repository. */
  listWebBindings(): Promise<readonly { owner: ResourceOwner; binding: WorktreeBinding }[]> | readonly { owner: ResourceOwner; binding: WorktreeBinding }[];
  /** Complete original Herdr lifecycle bindings for this repository. */
  listHerdrBindings(): Promise<readonly { owner: ResourceOwner; cwd: string }[]> | readonly { owner: ResourceOwner; cwd: string }[];
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
  if (await directory(parent) !== null) await directory(manifestDir);
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
  if (readFormat(false)) {
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
  const collect = async () => {
    operation.check();
    const [schedules, web, herdr] = await Promise.all([sources.listSchedules(), sources.listWebBindings(), sources.listHerdrBindings()]);
    const values: WorktreeManifest[] = [];
    const add = (input: ResourceOwner, name: string | null): void => {
      const owner = ownerOf(input);
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
    for (const value of store.list()) add(value, value.directoryName);
    for (const { owner: input, binding } of web) {
      const owner = ownerOf(input);
      if (!path.isAbsolute(binding.repositoryPath) || !path.isAbsolute(binding.commonDirectory)
        || await resolveGitDirectory(root, binding.repositoryPath) !== canonicalRoot
        || await resolveGitDirectory(common, binding.commonDirectory) !== canonicalCommon
        || binding.branch !== `daynight/${owner.taskId}`) throw new Error("Web worktree binding conflicts with its repository or owner.");
      add(owner, await targetName(binding.worktreePath));
    }
    for (const { owner, cwd } of herdr) add(owner, await targetName(cwd));
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
      const owner = ownerOf(input);
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
          if (reverse === null || !reverse.startsWith("gitdir: ") || await resolveGitDirectory(leaf, reverse.slice(8)) !== await realpath(entry.directory)) throw new Error("Worktree reverse Git pointer does not match its registration.");
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
