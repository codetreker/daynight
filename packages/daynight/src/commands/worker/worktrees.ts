import path from "node:path";
import { randomUUID } from "node:crypto";
import { readRegistrationIndex, registrationsFor, scanRepositoryWorktrees, type RegistrationIndex, type WorktreeScan } from "./worktree-scan.js";
import { resolveGitDirectory } from "./worktree-paths.js";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { OperationError, type Operation } from "../../api/operation.js";
import { cleanupOperation } from "../cleanup-operation.js";
import { canonicalId } from "../../api/parse.js";
import { runRepositoryGit } from "../../repository/git.js";
import { startOwnedRepositoryGit, RepositoryGitCleanupPendingError, type GitSettlement, type OwnedRepositoryGit } from "../../repository/git-owned.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";
import { canonicalResourceOwner } from "./resource-owner.js";
import { removeWorktreeContents } from "./remove-worktree-contents.js";
import { createWorktreeManifestStore, type WorktreeManifest } from "./worktrees/manifest.js";
import { bindingForManifest, managedNamespace, sameWorktreeLocation } from "./worktrees/paths.js";
import { sameResourceOwner } from "./resource-owner.js";

import { WorktreeValidationError } from "./worktree-errors.js";

type GitRunner = typeof runRepositoryGit;
export class WorktreePreconditionError extends WorktreeValidationError {
  constructor(readonly code: "branch_mismatch" | "validation_failed", message: string, options?: ErrorOptions) { super(message, options); this.name = "WorktreePreconditionError"; }
}
export class WorktreeRestoreRequiredError extends Error {
  constructor() { super("The original execution may still be running; its worktree cannot be restored."); this.name = "WorktreeRestoreRequiredError"; }
}
type Registration = { directory: string; marker: string | null; pointer: string; common: string };
export type WorkerRepository = { root: string; commonDirectory: string; rootIdentity: string; commonIdentity: string };
export type OwnedWorktree = { owner: ResourceOwner; binding: WorktreeBinding };
export type WorktreeCleanupOutcome = { kind: "absent"; effectErrors: readonly unknown[] };
export type WorktreeCleanupOptions = { signal?: AbortSignal };

/** The Git manager and execution backends share the selected task target. */
export const selectedWorktreePath = (repositoryRoot: string, worktreeId: string): string => path.join(managedNamespace(repositoryRoot), uuid(worktreeId, "Worktree ID"));
const removing = new Set<string>();
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const line = (value: string): string => value.replace(/\r?\n$/, "");
const uuid = (value: string, name: string): string => {
  const normalized = canonicalId(value);
  if (normalized === null) throw new Error(`${name} must be a UUID.`);
  return normalized;
};
const absolute = (value: string, name: string): string => {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${name} must be an absolute path without line breaks or NUL.`);
  return path.normalize(value);
};
const directory = async (target: string): Promise<string | null> => {
  try {
    const entry = await lstat(target, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Managed path ${target} must be an ordinary directory.`);
    return `${entry.dev}:${entry.ino}`;
  } catch (error) { if (missing(error)) return null; throw error; }
};
const ordinaryFile = async (target: string): Promise<string | null> => {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Git metadata ${target} must be an ordinary file.`);
    return line(await readFile(target, "utf8"));
  } catch (error) { if (missing(error)) return null; throw error; }
};
const ensureDirectory = async (target: string): Promise<void> => {
  if (await directory(target) !== null) return;
  try { await mkdir(target); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  if (await directory(target) === null) throw new Error(`Managed directory ${target} disappeared.`);
};
const coordinates = canonicalResourceOwner;
export type WorkerGitPending = { error: RepositoryGitCleanupPendingError; attemptId: string; projectId: string; owner?: ResourceOwner; command: "clone" | "fetch" | "worktree-add" | "update-ref" | "worktree-remove" };
class WorkerGitCleanupError extends AggregateError {}
class WorktreeCleanupInProgressError extends Error {
  constructor() { super("Task worktree cleanup is already in progress."); }
}

export const createWorkerGitManager = (options: { temporaryDirectory: string; runGit?: GitRunner; startOwnedGit?: typeof startOwnedRepositoryGit; reportPending?: (pending: WorkerGitPending) => void; reportSettled?: (pending: WorkerGitPending, settlement: GitSettlement) => void; removeDirectory?: typeof rm; prepareFormat?: (project: WorkerProject, repository: WorkerRepository, operation: Operation) => Promise<void> }) => {
  const temporaryDirectory = absolute(options.temporaryDirectory, "Git temporary directory");
  const runGit = options.runGit === undefined ? runRepositoryGit : options.runGit;
  const startOwnedGit = options.startOwnedGit ?? startOwnedRepositoryGit;
  const removeDirectory: typeof rm = options.removeDirectory ?? (target => unlink(target));
  const closing = new AbortController();
  const preparations = new Set<Promise<unknown>>();
  const handles = new Set<OwnedRepositoryGit>();
  let disposed: Promise<void> | undefined;
  const prepared = new Set<string>();
  const preparationByPath = new Map<string, Promise<WorkerRepository>>();
  const migrationByCommon = new Map<string, Promise<void>>();
  const preparedByPath = new Map<string, { repository: string; projectId: string; remote: string }>();
  const repositoryKey = (repository: WorkerRepository): string => JSON.stringify([repository.root, repository.commonDirectory, repository.rootIdentity, repository.commonIdentity]);
  const tracked = <T>(operation: Operation, action: (operation: Operation) => Promise<T>): Promise<T> => {
    if (closing.signal.aborted) return Promise.reject(closing.signal.reason);
    const signal = AbortSignal.any([operation.signal, closing.signal]);
    const check = (): void => { operation.check(); signal.throwIfAborted(); };
    const scoped: Operation = {
      signal, limits: operation.limits, check,
      remainingMs: () => { check(); return operation.remainingMs(); },
      remainingBytes: () => { check(); return operation.remainingBytes(); },
      consume: bytes => { check(); operation.consume(bytes); },
      dispose: () => {},
    };
    const promise = Promise.resolve().then(() => { check(); return action(scoped); });
    preparations.add(promise);
    void promise.then(() => preparations.delete(promise), () => preparations.delete(promise));
    return promise;
  };
  let hooks: Promise<string> | null = null;
  const hookDirectory = async (): Promise<string> => {
    if (hooks === null) hooks = (async () => {
      await mkdir(temporaryDirectory, { recursive: true });
      if (await directory(temporaryDirectory) === null) throw new Error("The Git temporary directory is missing.");
      return mkdtemp(path.join(temporaryDirectory, "git-hooks-"));
    })();
    return hooks;
  };
  const git = async (cwd: string, args: readonly string[], operation: Operation, timeoutMs?: number, mutation?: Omit<WorkerGitPending, "error" | "attemptId">): Promise<string> => {
    operation.check();
    const environment: Record<string, undefined> = {};
    for (const name of Object.keys(process.env)) {
      const key = name.toUpperCase();
      if (["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CURL_VERBOSE"].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) || key.startsWith("GIT_TRACE")) environment[name] = undefined;
    }
    const commandArgs = ["-c", `core.hooksPath=${await hookDirectory()}`, "-c", "submodule.recurse=false", ...args];
    operation.check();
    const commandOptions = { environment, timeoutMs: timeoutMs === undefined ? operation.limits.requestMs : timeoutMs };
    if (mutation === undefined) return line((await runGit(cwd, commandArgs, operation, commandOptions)).stdout);
    const attemptId = randomUUID();
    const command = startOwnedGit(cwd, commandArgs, operation, commandOptions);
    handles.add(command);
    try {
      const outcome = await command.outcome;
      const reportingErrors: unknown[] = [];
      if (outcome.kind === "cleanup-pending") {
        try { options.reportPending?.({ ...mutation, attemptId, error: outcome.error }); }
        catch (error) { reportingErrors.push(error); }
      }
      const settlement = await command.joined;
      if (outcome.kind === "cleanup-pending") {
        try { options.reportSettled?.({ ...mutation, attemptId, error: outcome.error }, settlement); }
        catch (error) { reportingErrors.push(error); }
      }
      const error = outcome.kind === "success" ? undefined : outcome.error;
      const errors = [...settlement.cleanupErrors, ...reportingErrors];
      if (errors.length > 0) throw new WorkerGitCleanupError(error === undefined ? errors : [error, ...errors], "Repository Git local cleanup or reporting failed.", error === undefined ? undefined : { cause: error });
      if (error !== undefined) throw error;
      if (outcome.kind !== "success") throw new Error("Repository Git returned an invalid outcome.");
      return line(outcome.result.stdout);
    } finally {
      try { await command.joined; } finally { handles.delete(command); }
    }
  };
  const validateOrigin = async (root: string, repoUrl: string, operation: Operation): Promise<void> => {
    const remote = await git(root, ["config", "--get-all", "remote.origin.url"], operation);
    if (remote.includes("\n") || repositoryIdentity(remote) !== repositoryIdentity(repoUrl)) throw new Error("The repository origin does not match its configured address.");
  };
  const inspectRepository = async (project: WorkerProject, operation: Operation): Promise<WorkerRepository> => {
    const root = absolute(project.localPath, "Repository path");
    const rootIdentity = await directory(root);
    if (rootIdentity === null) throw new Error(`The original repository ${root} is missing.`);
    if (await git(root, ["rev-parse", "--is-bare-repository"], operation) !== "false") throw new Error("The worker repository must have a primary worktree.");
    const top = absolute(await git(root, ["rev-parse", "--show-toplevel"], operation), "Git root");
    if (await directory(top) !== rootIdentity) throw new Error("The configured repository path must identify its worktree root.");
    await validateOrigin(root, project.repoUrl, operation);
    const commonDirectory = await realpath(absolute(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation), "Git common directory"));
    const commonIdentity = await directory(commonDirectory);
    if (commonIdentity === null) throw new Error("The Git common directory is missing.");
    return { root, commonDirectory, rootIdentity, commonIdentity };
  };
  const requirePrepared = async (project: WorkerProject, operation: Operation): Promise<WorkerRepository> => {
    const repository = await inspectRepository(project, operation);
    const binding = preparedByPath.get(absolute(project.localPath, "Repository path"));
    if (binding === undefined || binding.projectId !== uuid(project.projectId, "Project ID") || binding.remote !== repositoryIdentity(project.repoUrl)
      || binding.repository !== repositoryKey(repository) || !prepared.has(binding.repository)) throw new Error("The repository worktree format has not been prepared.");
    return repository;
  };
  const manifestFor = (project: WorkerProject, owner: ResourceOwner, repository: WorkerRepository): WorktreeManifest | null => {
    const identity = coordinates(owner);
    if (identity.projectId !== uuid(project.projectId, "Project ID")) throw new Error("The resource owner does not belong to this project.");
    const store = createWorktreeManifestStore(repository.commonDirectory);
    const manifest = store.read(identity.worktreeId);
    const claim = store.findClaim(identity);
    if (manifest !== null && !sameResourceOwner(manifest, identity) || claim !== null && !sameResourceOwner(claim, identity)) throw new WorktreeValidationError("The worktree manifest belongs to another original resource.");
    return manifest;
  };
  // Old Worker lock parsing is confined to the one-time migration.
  const readers = { directory, ordinaryFile, markerOwner: (_marker: string): ResourceOwner => { throw new Error("Legacy Worker lock remains in the current worktree format."); } };
  const registrations = async (repository: WorkerRepository, target: string, operation: Operation, index?: RegistrationIndex): Promise<Registration[]> =>
    registrationsFor(index ?? await readRegistrationIndex(repository, readers, operation), target, readers);
  const inspectWorktree = async (project: WorkerProject, identity: ResourceOwner, repository: WorkerRepository, operation: Operation, terminal: boolean, index?: RegistrationIndex, observedPointer?: string | null, original?: WorktreeManifest) => {
    const manifest = original ?? manifestFor(project, identity, repository);
    if (manifest === null) return null;
    const binding = bindingForManifest(project.localPath, repository.commonDirectory, manifest);
    for (const parent of [path.join(repository.root, ".worktrees"), managedNamespace(repository.root)]) await directory(parent);
    const leaf = await directory(binding.worktreePath);
    if (leaf === null && observedPointer !== undefined && observedPointer !== null) throw new Error("The worktree Git pointer disappeared during inspection.");
    const matches = await registrations(repository, binding.worktreePath, operation, index);
    if (matches.length > 1) throw new Error("The task worktree registration is ambiguous.");
    const registration = matches[0] ?? null;
    if (registration === null) {
      if (leaf !== null && (await readdir(binding.worktreePath)).length > 0) throw new Error("An existing task worktree path has no matching Git registration; it was retained.");
      return { manifest, binding, leaf, registration };
    }
    if (registration.marker !== null) throw new WorktreeValidationError("The task worktree has an external Git lock; it was retained.");
    if (await directory(registration.common) !== repository.commonIdentity) throw new Error("The task worktree belongs to another Git repository.");
    if (leaf !== null) {
      const pointer = await ordinaryFile(path.join(binding.worktreePath, ".git"));
      if (observedPointer !== undefined && pointer !== observedPointer) throw new Error("The worktree Git pointer changed during inspection.");
      if (pointer === null) {
        if (!terminal || (await readdir(binding.worktreePath)).length > 0) throw new WorktreeValidationError("The original worktree Git pointer is missing; the present directory cannot be attributed safely and was retained.");
      } else {
        if (!pointer.startsWith("gitdir: ") || await resolveGitDirectory(binding.worktreePath, pointer.slice(8)) !== await resolveGitDirectory(registration.directory, ".")) throw new Error("The original worktree Git pointer has changed.");
        const common = await git(binding.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation);
        if (await directory(common) !== repository.commonIdentity) throw new Error("The task worktree belongs to another Git repository.");
        if (!terminal) await validateOrigin(binding.worktreePath, project.repoUrl, operation);
      }
    }
    if (!terminal) {
      const branch = await git(repository.root, [`--git-dir=${registration.directory}`, "symbolic-ref", "--quiet", "HEAD"], operation);
      if (branch !== `refs/heads/${binding.branch}`) throw new WorktreePreconditionError("branch_mismatch", "The task worktree no longer uses its original task branch.");
    }
    return { manifest, binding, leaf, registration };
  };
  const removeEmptyDirectory = async (target: string, operation: Operation): Promise<void> => {
    operation.check();
    try { await rmdir(target); }
    catch (error) { if (!missing(error) || await directory(target) !== null) throw error; }
    operation.check();
  };
  const removeEmptyReservation = async (repository: WorkerRepository, directoryName: string, operation: Operation): Promise<void> => {
    const parents = [path.join(repository.root, ".worktrees"), path.join(repository.root, ".worktrees", "daynight")];
    const target = path.join(parents[1]!, uuid(directoryName, "Worktree directory"));
    const directories = new Map<string, string>([[repository.root, repository.rootIdentity], [repository.commonDirectory, repository.commonIdentity]]);
    for (const parent of parents) {
      const observed = await directory(parent);
      if (observed !== null) directories.set(parent, observed);
    }
    const leaf = await directory(target);
    if ((await registrations(repository, target, operation)).length > 0) throw new Error("The task path still has a Git worktree registration; its owner must be observed before cleanup.");
    operation.check();
    if (leaf === null) return;
    if ((await readdir(target)).length > 0) throw new Error("The unregistered task directory is not empty; it was retained.");
    directories.set(target, leaf);
    for (const [entry, expected] of directories) if (await directory(entry) !== expected) throw new Error(`Worktree reservation directory ${entry} changed before cleanup.`);
    if ((await registrations(repository, target, operation)).length > 0) throw new Error("A Git worktree registration appeared before reservation cleanup.");
    for (const [entry, expected] of directories) if (await directory(entry) !== expected) throw new Error(`Worktree reservation directory ${entry} changed before cleanup.`);
    await removeEmptyDirectory(target, operation);
    if (await directory(target) !== null || (await registrations(repository, target, operation)).length > 0) throw new Error("The unregistered task reservation removal is incomplete.");
  };
  const scanWorktrees = async (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false, settled: readonly OwnedWorktree[] = []): Promise<WorktreeScan> => {
    operation.check();
    try {
      if (allowMissingRepository) {
        const physical = await resolvePhysicalDirectory(absolute(project.localPath, "Repository path"));
        operation.check();
        if (physical.missingComponents.length > 0) return { enumerationComplete: true, validated: [], quarantined: [], unknown: [] };
      }
      const repository = await requirePrepared(project, operation);
      const index = await readRegistrationIndex(repository, readers, operation);
      return await scanRepositoryWorktrees(project, repository, index, operation, readers, async (owner, observedPointer) => {
        const observed = await inspectWorktree({ ...project, projectId: owner.projectId }, owner, repository, operation, false, index, observedPointer);
        if (observed === null) throw new Error("The worktree manifest disappeared.");
        return { owner, binding: observed.binding };
      }, includeOtherProjects, settled);
    } catch (error) {
      operation.check();
      return { enumerationComplete: false, validated: [], quarantined: [], unknown: [{ error }] };
    }
  };
  const manager = {
    prepareRepository: async (project: WorkerProject, operation: Operation): Promise<WorkerRepository> => {
      operation.check();
      repositoryIdentity(project.repoUrl);
      const root = absolute(project.localPath, "Repository path");
      if (await directory(root) === null) {
        await mkdir(path.dirname(root), { recursive: true });
        await mkdir(root);
        const reserved = await directory(root);
        try {
          await git(path.dirname(root), ["clone", "--origin=origin", `--template=${await hookDirectory()}`, "--", project.repoUrl, root], operation, 120_000, { projectId: project.projectId, command: "clone" });
        } catch (error) {
          // Remove only our unchanged, empty reservation; partial clones and replacements remain for inspection.
          try {
            if (reserved !== null && await directory(root) === reserved) await rmdir(root);
          } catch (cleanupError) {
            if (!(cleanupError instanceof Error && "code" in cleanupError && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(cleanupError.code)))) throw new AggregateError([error, cleanupError], "Repository clone and reservation cleanup failed.");
          }
          throw error;
        }
      }
      const repository = await inspectRepository(project, operation);
      if (!options.prepareFormat) throw new Error("The repository worktree format preparation is unavailable.");
      for (const key of prepared) if ((JSON.parse(key) as string[])[1] === repository.commonDirectory) prepared.delete(key);
      let migration = migrationByCommon.get(repository.commonDirectory);
      if (migration === undefined) {
        migration = options.prepareFormat(project, repository, operation);
        migrationByCommon.set(repository.commonDirectory, migration);
        void migration.then(() => { if (migrationByCommon.get(repository.commonDirectory) === migration) migrationByCommon.delete(repository.commonDirectory); }, () => { if (migrationByCommon.get(repository.commonDirectory) === migration) migrationByCommon.delete(repository.commonDirectory); });
      }
      await migration;
      operation.check();
      prepared.add(repositoryKey(repository));
      return repository;
    },
    prepareWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation, originalCwd?: string, requireExistingBranch = false, originalBinding?: WorktreeBinding, allowRestore = true): Promise<WorktreeBinding> => {
      const repository = await requirePrepared(project, operation), identity = coordinates(owner);
      if (originalBinding !== undefined && (!await sameWorktreeLocation(originalBinding.repositoryPath, repository.root) || !await sameWorktreeLocation(originalBinding.commonDirectory, repository.commonDirectory) || originalBinding.branch !== `daynight/${identity.taskId}` || originalCwd === undefined || !await sameWorktreeLocation(originalBinding.worktreePath, originalCwd))) throw new Error("The original worktree binding differs from its repository.");
      const store = createWorktreeManifestStore(repository.commonDirectory);
      const existing = manifestFor(project, identity, repository);
      let directoryName = identity.worktreeId;
      if (originalCwd !== undefined) {
        const name = path.basename(originalCwd);
        if (![identity.taskId, identity.worktreeId].includes(name) || !await sameWorktreeLocation(originalCwd, path.join(managedNamespace(project.localPath), name))) throw new Error("The original execution has no matching worktree path.");
        directoryName = name;
      }
      const manifest: WorktreeManifest = existing ?? { schemaVersion: 1, ...identity, directoryName };
      const binding = bindingForManifest(project.localPath, repository.commonDirectory, manifest);
      if (originalCwd !== undefined && !await sameWorktreeLocation(originalCwd, binding.worktreePath)) throw new Error("The original execution path differs from its manifest.");
      const before = await inspectWorktree(project, identity, repository, operation, false, undefined, undefined, manifest);
      if (!allowRestore && (before?.leaf == null || before.registration === null)) throw new WorktreeRestoreRequiredError();
      await ensureDirectory(path.join(repository.root, ".worktrees"));
      await ensureDirectory(managedNamespace(repository.root));
      const names = (await git(repository.root, ["for-each-ref", "--format=%(refname)", `refs/heads/${binding.branch}`], operation)).split("\n");
      const reference = `refs/heads/${binding.branch}`;
      if (names.some(name => name.startsWith(`${reference}/`))) throw new Error("An existing branch namespace conflicts with the task branch.");
      const hasBranch = names.includes(reference);
      if (!hasBranch && (requireExistingBranch || before?.registration != null)) throw new Error("The original task branch is missing; the worktree cannot be restored.");
      if (before?.registration !== null && before?.registration !== undefined) {
        if (existing === null && originalCwd === undefined && before.leaf !== null) throw new Error("The existing worktree registration has no original binding.");
        operation.check();
        store.publish(manifest);
        if (before.leaf !== null) return before.binding;
        // The exact original registration points to an absent checkout. Remove
        // only that registration before restoring the retained branch.
        await git(repository.root, ["worktree", "remove", "--force", "--force", "--", binding.worktreePath], operation, undefined, { projectId: project.projectId, owner, command: "worktree-remove" });
        const after = await inspectWorktree(project, identity, repository, operation, false);
        if (after === null || after.leaf !== null || after.registration !== null) throw new Error("The original stale registration remains after removal.");
      }
      if (hasBranch && await git(repository.root, ["for-each-ref", "--format=%(worktreepath)", reference], operation) !== "") throw new Error("The retained task branch is already checked out in another worktree.");
      if (await directory(binding.worktreePath) === null) await mkdir(binding.worktreePath);
      const reserved = await directory(binding.worktreePath);
      if (reserved === null || (await readdir(binding.worktreePath)).length > 0) throw new Error("The unregistered worktree reservation is not empty.");
      operation.check();
      store.publish(manifest);
      operation.check();
      const baseRef = `refs/daynight/worker-bases/${identity.worktreeId}`;
      let fetchedRef: string | undefined;
      try {
        let baseCommit: string | undefined;
        if (!hasBranch) {
          await git(repository.root, ["fetch", "--no-recurse-submodules", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--refmap=", "--", "origin", `+HEAD:${baseRef}`], operation, 120_000, { projectId: project.projectId, owner, command: "fetch" });
          fetchedRef = await git(repository.root, ["rev-parse", "--verify", baseRef], operation);
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fetchedRef)) throw new Error("Git returned an invalid remote HEAD object ID.");
          baseCommit = await git(repository.root, ["rev-parse", "--verify", `${baseRef}^{commit}`], operation);
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) throw new Error("Git returned an invalid remote HEAD commit ID.");
        }
        if (await directory(binding.worktreePath) !== reserved || (await readdir(binding.worktreePath)).length > 0 || (await registrations(repository, binding.worktreePath, operation)).length > 0) throw new Error("The worktree reservation changed before Git add.");
        const branchArgs = !hasBranch ? ["-b", binding.branch, "--", binding.worktreePath, baseCommit!] : ["--", binding.worktreePath, binding.branch];
        await git(repository.root, ["worktree", "add", ...branchArgs], operation, undefined, { projectId: project.projectId, owner, command: "worktree-add" });
        const after = await inspectWorktree(project, owner, repository, operation, false);
        if (after?.leaf == null || after.registration === null) throw new Error("Git did not create the expected task worktree.");
      } catch (error) {
        if (fetchedRef !== undefined) {
          try { await git(repository.root, ["update-ref", "-d", baseRef, fetchedRef], operation, undefined, { projectId: project.projectId, owner, command: "update-ref" }); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Task worktree creation and base reference cleanup failed.", { cause: error }); }
        }
        throw error;
      }
      if (fetchedRef !== undefined) await git(repository.root, ["update-ref", "-d", baseRef, fetchedRef], operation, undefined, { projectId: project.projectId, owner, command: "update-ref" });
      return binding;
    },
    removeEmptyReservation: async (project: WorkerProject, _taskId: string, operation: Operation): Promise<void> => {
      // A claim identity alone cannot identify its directory after migration.
      await requirePrepared(project, operation);
      throw new Error("A task ID alone cannot locate the original worktree reservation.");
    },
    removeUnpublishedReservation: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<void> => {
      const repository = await requirePrepared(project, operation), identity = coordinates(owner);
      if (manifestFor(project, identity, repository) !== null) throw new Error("The original worktree has a published manifest; reservation cleanup is prohibited.");
      if (createWorktreeManifestStore(repository.commonDirectory).list().some(manifest => manifest.directoryName === identity.worktreeId)) throw new Error("The worktree reservation belongs to another published manifest.");
      await removeEmptyReservation(repository, identity.worktreeId, operation);
    },
    verifyWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding> => {
      const repository = await requirePrepared(project, operation);
      const result = await inspectWorktree(project, owner, repository, operation, false);
      if (result?.leaf == null || result.registration === null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
      return result.binding;
    },
    findWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding | null> => {
      const repository = await requirePrepared(project, operation);
      const result = await inspectWorktree(project, owner, repository, operation, true);
      if (result === null) throw new Error("The original worktree manifest is missing; resource absence cannot be inferred.");
      return result.leaf === null && result.registration === null ? null : result.binding;
    },
    resolveWorktreeBinding: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding | null> => {
      const repository = await requirePrepared(project, operation), manifest = manifestFor(project, owner, repository);
      return manifest === null ? null : bindingForManifest(project.localPath, repository.commonDirectory, manifest);
    },
    listWorktreeManifests: async (project: WorkerProject, operation: Operation, includeOtherProjects = false): Promise<OwnedWorktree[]> => {
      const repository = await requirePrepared(project, operation);
      return createWorktreeManifestStore(repository.commonDirectory).list().filter(manifest => includeOtherProjects || manifest.projectId === project.projectId).map(manifest => ({ owner: coordinates(manifest), binding: bindingForManifest(project.localPath, repository.commonDirectory, manifest) }));
    },
    retireWorktreeManifest: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<void> => {
      const repository = await requirePrepared(project, operation), manifest = manifestFor(project, owner, repository);
      if (manifest === null) return;
      operation.check();
      createWorktreeManifestStore(repository.commonDirectory).remove(manifest);
    },
    scanWorktrees,
    listWorktrees: async (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false): Promise<OwnedWorktree[]> => {
      const scan = await scanWorktrees(project, operation, allowMissingRepository, includeOtherProjects);
      if (scan.unknown.length > 0) throw scan.unknown[0]!.error;
      if (scan.quarantined.length > 0) throw scan.quarantined[0]!.error;
      return scan.validated;
    },
    removeWorktree: async (project: WorkerProject, owner: ResourceOwner, options: WorktreeCleanupOptions): Promise<WorktreeCleanupOutcome> => {
      let key: string | undefined;
      let effectError: unknown;
      let failed = false;
      try {
        try {
          await cleanupOperation(async operation => {
            const repository = await requirePrepared(project, operation);
            key = `${repository.rootIdentity}/${repository.commonIdentity}/${uuid(owner.taskId, "Task ID")}`;
            if (removing.has(key)) { key = undefined; throw new WorktreeCleanupInProgressError(); }
            removing.add(key);
            let result = await inspectWorktree(project, owner, repository, operation, true);
            if (result === null) throw new Error("The original worktree manifest is missing; resource removal cannot be authorized.");
            if (result.registration === null) {
              if (result.leaf !== null) await removeEmptyReservation(repository, result.manifest.directoryName, operation);
              return;
            }
            if (result.leaf !== null && await ordinaryFile(path.join(result.binding.worktreePath, ".git")) === null) {
              await removeEmptyDirectory(result.binding.worktreePath, operation);
              result = await inspectWorktree(project, owner, repository, operation, true);
            }
            if (result?.registration === null || result === null) return;
            if (result.leaf !== null) {
              const { registration, binding, leaf, manifest } = result;
              const directories = new Map<string, string>([[repository.root, repository.rootIdentity], [repository.commonDirectory, repository.commonIdentity]]);
              for (const target of [path.join(repository.root, ".worktrees"), path.dirname(binding.worktreePath), path.dirname(registration.directory), registration.directory]) {
                const identity = await directory(target);
                if (identity === null) throw new Error(`Worktree ownership directory ${target} disappeared.`);
                directories.set(target, identity);
              }
              directories.set(binding.worktreePath, leaf);
              const metadata = new Map<string, string>();
              for (const target of [path.join(binding.worktreePath, ".git"), ...["gitdir", "commondir"].map(name => path.join(registration.directory, name))]) {
                const contents = await ordinaryFile(target);
                if (contents === null) throw new Error(`Worktree metadata ${target} disappeared.`);
                metadata.set(target, contents);
              }
              const verifyOwnership = async (): Promise<void> => {
                operation.check();
                const current = manifestFor(project, owner, repository);
                if (current === null || current.directoryName !== manifest.directoryName) throw new Error("The worktree manifest changed during cleanup.");
                for (const [target, identity] of directories) if (await directory(target) !== identity) throw new Error(`Worktree ownership directory ${target} changed during cleanup.`);
                for (const [target, contents] of metadata) if (await ordinaryFile(target) !== contents) throw new Error(`Worktree metadata ${target} changed during cleanup.`);
                if (await ordinaryFile(path.join(registration.directory, "locked")) !== null) throw new Error("The worktree acquired a Git lock during cleanup.");
                operation.check();
              };
              const confirmed = await inspectWorktree(project, owner, repository, operation, true);
              if (confirmed?.leaf !== leaf || confirmed.registration?.directory !== registration.directory) throw new Error("The task worktree changed before cleanup.");
              await verifyOwnership();
              await removeWorktreeContents({ target: binding.worktreePath, expectedIdentity: leaf, operation }, removeDirectory);
              await verifyOwnership();
              await unlink(path.join(binding.worktreePath, ".git"));
              operation.check();
              for (const [target, identity] of directories) if (await directory(target) !== identity) throw new Error(`Worktree ownership directory ${target} changed during cleanup.`);
              await removeEmptyDirectory(binding.worktreePath, operation);
            }
            operation.check();
            result = await inspectWorktree(project, owner, repository, operation, true);
            if (result === null) throw new Error("The worktree manifest disappeared during cleanup.");
            if (result.leaf !== null) throw new Error("The original task worktree directory still exists after removal.");
            if (result.registration !== null) {
              await git(repository.root, ["worktree", "remove", "--force", "--force", "--", result.binding.worktreePath], operation, undefined, { projectId: project.projectId, owner, command: "worktree-remove" });
              operation.check();
            }
          }, options.signal);
        } catch (error) {
          if (error instanceof WorktreeCleanupInProgressError) throw error;
          failed = true;
          effectError = error;
        }
        const checkCancellation = (): void => {
          if (!options.signal?.aborted) return;
          const cancellation = new OperationError("cancelled", { cause: options.signal.reason });
          if (failed) throw new AggregateError([effectError, cancellation], "Worktree cleanup failed before cancellation.", { cause: effectError });
          throw cancellation;
        };
        checkCancellation();
        let absent: boolean;
        try {
          absent = await cleanupOperation(async operation => {
            const repository = await requirePrepared(project, operation);
            if (key === undefined) {
              key = `${repository.rootIdentity}/${repository.commonIdentity}/${uuid(owner.taskId, "Task ID")}`;
              if (removing.has(key)) { key = undefined; throw new WorktreeCleanupInProgressError(); }
              removing.add(key);
            }
            const result = await inspectWorktree(project, owner, repository, operation, true);
            if (result === null) throw new Error("The original worktree manifest is missing; resource absence cannot be inferred.");
            operation.check();
            return result.leaf === null && result.registration === null;
          }, options.signal);
        } catch (observationError) {
          if (failed) throw new AggregateError([effectError, observationError], "Worktree cleanup and its postcondition observation failed.", { cause: effectError });
          throw observationError;
        }
        checkCancellation();
        if (!absent) {
          if (failed) throw effectError;
          throw new Error("The original task worktree removal is incomplete.");
        }
        return { kind: "absent", effectErrors: failed ? [effectError] : [] };
      } finally { if (key !== undefined) removing.delete(key); }
    },
    dispose: (): Promise<void> => {
      if (disposed !== undefined) return disposed;
      closing.abort(new Error("Worker Git manager is closing."));
      for (const handle of handles) handle.requestStop();
      disposed = (async () => {
        await Promise.allSettled([...preparations]);
        await Promise.all([...handles].map(handle => handle.joined));
        if (hooks !== null) { await rm(await hooks, { recursive: true }); hooks = null; }
      })();
      return disposed;
    },
  };
  return {
    prepareRepository: (project: WorkerProject, operation: Operation) => tracked(operation, async scoped => {
      const key = absolute(project.localPath, "Repository path");
      const projectId = uuid(project.projectId, "Project ID"), remote = repositoryIdentity(project.repoUrl);
      while (true) {
        const prior = preparationByPath.get(key);
        if (prior !== undefined) { await prior; scoped.check(); continue; }
        const previous = preparedByPath.get(key);
        if (previous !== undefined && previous.projectId === projectId && previous.remote === remote) {
          const current = await inspectRepository(project, scoped);
          scoped.check();
          if (preparationByPath.has(key) || preparedByPath.get(key) !== previous) continue;
          if (repositoryKey(current) === previous.repository && prepared.has(previous.repository)) return current;
        }
        if (previous !== undefined && preparedByPath.get(key) === previous) { prepared.delete(previous.repository); preparedByPath.delete(key); }
        const pending = manager.prepareRepository(project, scoped);
        preparationByPath.set(key, pending);
        try {
          const result = await pending;
          preparedByPath.set(key, { repository: repositoryKey(result), projectId, remote });
          return result;
        } finally { if (preparationByPath.get(key) === pending) preparationByPath.delete(key); }
      }
    }),
    prepareWorktree: (project: WorkerProject, owner: ResourceOwner, operation: Operation, originalCwd?: string, requireExistingBranch = false, originalBinding?: WorktreeBinding, allowRestore = true) => tracked(operation, scoped => manager.prepareWorktree(project, owner, scoped, originalCwd, requireExistingBranch, originalBinding, allowRestore)),
    removeEmptyReservation: (project: WorkerProject, taskId: string, operation: Operation) => tracked(operation, scoped => manager.removeEmptyReservation(project, taskId, scoped)),
    removeUnpublishedReservation: (project: WorkerProject, owner: ResourceOwner, operation: Operation) => tracked(operation, scoped => manager.removeUnpublishedReservation(project, owner, scoped)),
    verifyWorktree: (project: WorkerProject, owner: ResourceOwner, operation: Operation) => tracked(operation, scoped => manager.verifyWorktree(project, owner, scoped)),
    findWorktree: (project: WorkerProject, owner: ResourceOwner, operation: Operation) => tracked(operation, scoped => manager.findWorktree(project, owner, scoped)),
    resolveWorktreeBinding: (project: WorkerProject, owner: ResourceOwner, operation: Operation) => tracked(operation, scoped => manager.resolveWorktreeBinding(project, owner, scoped)),
    listWorktreeManifests: (project: WorkerProject, operation: Operation, includeOtherProjects = false) => tracked(operation, scoped => manager.listWorktreeManifests(project, scoped, includeOtherProjects)),
    retireWorktreeManifest: (project: WorkerProject, owner: ResourceOwner, operation: Operation) => tracked(operation, scoped => manager.retireWorktreeManifest(project, owner, scoped)),
    scanWorktrees: (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false, settled: readonly OwnedWorktree[] = []) => tracked(operation, scoped => manager.scanWorktrees(project, scoped, allowMissingRepository, includeOtherProjects, settled)),
    listWorktrees: (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false) => tracked(operation, scoped => manager.listWorktrees(project, scoped, allowMissingRepository, includeOtherProjects)),
    removeWorktree: (project: WorkerProject, owner: ResourceOwner, options: WorktreeCleanupOptions) => {
      if (closing.signal.aborted) return Promise.reject(closing.signal.reason);
      const signal = options.signal === undefined ? closing.signal : AbortSignal.any([options.signal, closing.signal]);
      const promise = Promise.resolve().then(() => manager.removeWorktree(project, owner, { signal }));
      preparations.add(promise);
      void promise.then(() => preparations.delete(promise), () => preparations.delete(promise));
      return promise;
    },
    dispose: manager.dispose,
  };
};
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
