import path from "node:path";
import { readRegistrationIndex, registrationsFor, scanRepositoryWorktrees, type RegistrationIndex, type WorktreeScan } from "./worktree-scan.js";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { runRepositoryGit } from "../../repository/git.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";
import { canonicalResourceOwner } from "./resource-owner.js";
import { removeWorktreeContents } from "./remove-worktree-contents.js";

type GitRunner = typeof runRepositoryGit;
export class WorktreePreconditionError extends Error {
  constructor(readonly code: "branch_mismatch" | "validation_failed", message: string, options?: ErrorOptions) { super(message, options); this.name = "WorktreePreconditionError"; }
}
type Owner = ResourceOwner & { leaf: string; root: string; common: string };
type Registration = { directory: string; marker: string | null; pointer: string; common: string };
export type WorkerRepository = { root: string; commonDirectory: string; rootIdentity: string; commonIdentity: string };
export type OwnedWorktree = { owner: ResourceOwner; binding: WorktreeBinding };
const prefix = "daynight-worker:";
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
const markerOwner = (marker: string): Owner => {
  if (!marker.startsWith(prefix)) throw new Error("The task worktree has a different ownership marker.");
  const value: unknown = JSON.parse(marker.slice(prefix.length));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The task worktree ownership marker is invalid.");
  const fields = ["projectId", "taskId", "claimId", "worktreeId", "leaf", "root", "common"];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field) || typeof (value as Record<string, unknown>)[field] !== "string")) throw new Error("The task worktree ownership marker is invalid.");
  const owner = value as Owner;
  for (const field of ["leaf", "root", "common"] as const) if (!/^\d+:\d+$/.test(owner[field])) throw new Error("The task worktree ownership fingerprint is invalid.");
  if (Object.entries(coordinates(owner)).some(([key, value]) => owner[key as keyof Owner] !== value)) throw new Error("The task worktree ownership coordinates are not canonical.");
  return owner;
};
const sameCoordinates = (owner: Owner, identity: ResourceOwner): boolean => Object.entries(coordinates(identity)).every(([key, value]) => owner[key as keyof Owner] === value);

export const createWorkerGitManager = (options: { temporaryDirectory: string; runGit?: GitRunner; removeDirectory?: typeof rm }) => {
  const temporaryDirectory = absolute(options.temporaryDirectory, "Git temporary directory");
  const runGit = options.runGit === undefined ? runRepositoryGit : options.runGit;
  const removeDirectory: typeof rm = options.removeDirectory ?? (target => unlink(target));
  let hooks: Promise<string> | null = null;
  const hookDirectory = async (): Promise<string> => {
    if (hooks === null) hooks = (async () => {
      await mkdir(temporaryDirectory, { recursive: true });
      if (await directory(temporaryDirectory) === null) throw new Error("The Git temporary directory is missing.");
      return mkdtemp(path.join(temporaryDirectory, "git-hooks-"));
    })();
    return hooks;
  };
  const git = async (cwd: string, args: readonly string[], operation: Operation, timeoutMs?: number): Promise<string> => {
    operation.check();
    const environment: Record<string, undefined> = {};
    for (const name of Object.keys(process.env)) {
      const key = name.toUpperCase();
      if (["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CURL_VERBOSE"].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) || key.startsWith("GIT_TRACE")) environment[name] = undefined;
    }
    const result = await runGit(cwd, ["-c", `core.hooksPath=${await hookDirectory()}`, "-c", "submodule.recurse=false", ...args], operation, { environment, timeoutMs: timeoutMs === undefined ? operation.limits.requestMs : timeoutMs });
    return line(result.stdout);
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
  const bindingFor = (project: WorkerProject, owner: ResourceOwner, repository: WorkerRepository): WorktreeBinding => {
    const identity = coordinates(owner);
    if (identity.projectId !== uuid(project.projectId, "Project ID")) throw new Error("The resource owner does not belong to this project.");
    return { repositoryPath: project.localPath, commonDirectory: repository.commonDirectory, worktreePath: path.join(repository.root, ".worktrees", "daynight", identity.taskId), branch: `daynight/${identity.taskId}` };
  };
  const readers = { directory, ordinaryFile, markerOwner: (marker: string) => coordinates(markerOwner(marker)) };
  const registrations = async (repository: WorkerRepository, target: string, operation: Operation, index?: RegistrationIndex): Promise<Registration[]> =>
    registrationsFor(index ?? await readRegistrationIndex(repository, readers, operation), target, readers);
  const inspectWorktree = async (project: WorkerProject, identity: ResourceOwner, repository: WorkerRepository, operation: Operation, terminal: boolean, index?: RegistrationIndex) => {
    const binding = bindingFor(project, identity, repository);
    for (const parent of [path.join(repository.root, ".worktrees"), path.join(repository.root, ".worktrees", "daynight")]) {
      await directory(parent);
    }
    const leaf = await directory(binding.worktreePath);
    const matches = await registrations(repository, binding.worktreePath, operation, index);
    if (matches.length > 1) throw new Error("The task worktree registration is ambiguous.");
    const registration = matches[0] ?? null;
    if (registration === null) {
      if (leaf !== null && (!terminal || (await readdir(binding.worktreePath)).length > 0)) throw new Error("An existing task worktree path has no matching ownership registration; it was retained.");
      return { binding, leaf, registration };
    }
    if (registration.marker === null) throw new Error("The task worktree has no ownership marker; it was retained.");
    const owner = markerOwner(registration.marker);
    if (!sameCoordinates(owner, identity) || owner.root !== repository.rootIdentity || owner.common !== repository.commonIdentity || await directory(registration.common) !== repository.commonIdentity) throw new Error("The task worktree ownership marker or repository identity does not match this claim.");
    if (leaf !== null) {
      const pointer = await ordinaryFile(path.join(binding.worktreePath, ".git"));
      if (pointer === null) {
        if (!terminal || (await readdir(binding.worktreePath)).length > 0) throw new Error("The original worktree Git pointer is missing; the present directory cannot be attributed safely and was retained.");
      } else {
        if (owner.leaf !== leaf) throw new Error("The original task worktree directory was replaced; it was retained.");
        if (!pointer.startsWith("gitdir: ") || path.resolve(binding.worktreePath, pointer.slice(8)) !== registration.directory) throw new Error("The original worktree Git pointer has changed.");
        const common = await git(binding.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation);
        if (await directory(common) !== repository.commonIdentity) throw new Error("The task worktree belongs to another Git repository.");
        if (!terminal) await validateOrigin(binding.worktreePath, project.repoUrl, operation);
      }
    }
    const branch = await git(repository.root, [`--git-dir=${registration.directory}`, "symbolic-ref", "--quiet", "HEAD"], operation);
    if (branch !== `refs/heads/${binding.branch}`) throw new WorktreePreconditionError("branch_mismatch", "The task worktree no longer uses its original task branch.");
    return { binding, leaf, registration };
  };
  const removeEmptyDirectory = async (target: string, operation: Operation): Promise<void> => {
    operation.check();
    try { await rmdir(target); }
    catch (error) { if (!missing(error) || await directory(target) !== null) throw error; }
    operation.check();
  };
  const removeEmptyReservation = async (repository: WorkerRepository, taskId: string, operation: Operation): Promise<void> => {
    const parents = [path.join(repository.root, ".worktrees"), path.join(repository.root, ".worktrees", "daynight")];
    const target = path.join(parents[1]!, uuid(taskId, "Task ID"));
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
  const scanWorktrees = async (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false): Promise<WorktreeScan> => {
    operation.check();
    try {
      if (allowMissingRepository) {
        const physical = await resolvePhysicalDirectory(absolute(project.localPath, "Repository path"));
        operation.check();
        if (physical.missingComponents.length > 0) return { enumerationComplete: true, validated: [], quarantined: [], unknown: [] };
      }
      const repository = await inspectRepository(project, operation);
      const index = await readRegistrationIndex(repository, readers, operation);
      return await scanRepositoryWorktrees(project, repository, index, operation, readers, async owner => {
        const observed = await inspectWorktree({ ...project, projectId: owner.projectId }, owner, repository, operation, true, index);
        if (observed.registration === null) throw new Error("The owned task worktree registration disappeared.");
        return { owner, binding: observed.binding };
      }, includeOtherProjects);
    } catch (error) {
      operation.check();
      return { enumerationComplete: false, validated: [], quarantined: [], unknown: [{ error }] };
    }
  };
  return {
    prepareRepository: async (project: WorkerProject, operation: Operation): Promise<WorkerRepository> => {
      operation.check();
      repositoryIdentity(project.repoUrl);
      const root = absolute(project.localPath, "Repository path");
      if (await directory(root) === null) {
        await mkdir(path.dirname(root), { recursive: true });
        await mkdir(root);
        const reserved = await directory(root);
        try {
          await git(path.dirname(root), ["clone", "--origin=origin", `--template=${await hookDirectory()}`, "--", project.repoUrl, root], operation, 120_000);
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
      return inspectRepository(project, operation);
    },
    prepareWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding> => {
      const repository = await inspectRepository(project, operation);
      const parent = path.join(repository.root, ".worktrees");
      await ensureDirectory(parent);
      await ensureDirectory(path.join(parent, "daynight"));
      const reservation = await inspectWorktree(project, owner, repository, operation, true);
      if (reservation.registration === null && reservation.leaf !== null) await removeEmptyReservation(repository, owner.taskId, operation);
      const before = await inspectWorktree(project, owner, repository, operation, false);
      if (before.registration !== null) {
        if (before.leaf === null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
        return before.binding;
      }
      const names = (await git(repository.root, ["for-each-ref", "--format=%(refname)", `refs/heads/${before.binding.branch}`], operation)).split("\n");
      const reference = `refs/heads/${before.binding.branch}`;
      if (names.some((name) => name.startsWith(`${reference}/`))) throw new Error("An existing branch namespace conflicts with the task branch.");
      const existing = names.includes(reference);
      if (existing && await git(repository.root, ["for-each-ref", "--format=%(worktreepath)", reference], operation) !== "") throw new Error("The retained task branch is already checked out in another worktree.");
      const baseRef = `refs/daynight/worker-bases/${coordinates(owner).worktreeId}`;
      let fetchedRef: string | undefined;
      let baseCommit: string | undefined;
      if (!existing) {
        await git(repository.root, ["fetch", "--no-recurse-submodules", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--refmap=", "--", "origin", `+HEAD:${baseRef}`], operation, 120_000);
      }
      let binding: WorktreeBinding;
      try {
        if (!existing) {
          const observedRef = await git(repository.root, ["rev-parse", "--verify", baseRef], operation);
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(observedRef)) throw new Error("Git returned an invalid remote HEAD object ID.");
          fetchedRef = observedRef;
          baseCommit = await git(repository.root, ["rev-parse", "--verify", `${baseRef}^{commit}`], operation);
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) throw new Error("Git returned an invalid remote HEAD commit ID.");
        }
        await mkdir(before.binding.worktreePath);
        const leaf = await directory(before.binding.worktreePath);
        if (leaf === null) throw new Error("The reserved task worktree directory disappeared.");
        const marker = `${prefix}${JSON.stringify({ ...coordinates(owner), leaf, root: repository.rootIdentity, common: repository.commonIdentity } satisfies Owner)}`;
        const branchArgs = !existing ? ["-b", before.binding.branch, "--", before.binding.worktreePath, baseCommit!] : ["--", before.binding.worktreePath, before.binding.branch];
        await git(repository.root, ["worktree", "add", "--lock", "--reason", marker, ...branchArgs], operation);
        const after = await inspectWorktree(project, owner, repository, operation, false);
        if (after.leaf === null || after.registration === null) throw new Error("Git did not create the expected owned task worktree.");
        binding = after.binding;
      } catch (error) {
        if (fetchedRef !== undefined) {
          try { await git(repository.root, ["update-ref", "-d", baseRef, fetchedRef], operation); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Task worktree creation and base reference cleanup failed.", { cause: error }); }
        }
        throw error;
      }
      if (fetchedRef !== undefined) await git(repository.root, ["update-ref", "-d", baseRef, fetchedRef], operation);
      return binding;
    },
    removeEmptyReservation: async (project: WorkerProject, taskId: string, operation: Operation): Promise<void> => {
      await removeEmptyReservation(await inspectRepository(project, operation), taskId, operation);
    },
    verifyWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding> => {
      const repository = await inspectRepository(project, operation);
      const result = await inspectWorktree(project, owner, repository, operation, false);
      if (result.leaf === null || result.registration === null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
      return result.binding;
    },
    findWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<WorktreeBinding | null> => {
      const repository = await inspectRepository(project, operation);
      const result = await inspectWorktree(project, owner, repository, operation, true);
      if (result.registration === null) return null;
      return result.binding;
    },
    scanWorktrees,
    listWorktrees: async (project: WorkerProject, operation: Operation, allowMissingRepository = false, includeOtherProjects = false): Promise<OwnedWorktree[]> => {
      const scan = await scanWorktrees(project, operation, allowMissingRepository, includeOtherProjects);
      if (scan.unknown.length > 0) throw scan.unknown[0]!.error;
      if (scan.quarantined.length > 0) throw scan.quarantined[0]!.error;
      return scan.validated;
    },
    removeWorktree: async (project: WorkerProject, owner: ResourceOwner, operation: Operation): Promise<void> => {
      const repository = await inspectRepository(project, operation);
      const key = `${repository.rootIdentity}/${repository.commonIdentity}/${uuid(owner.taskId, "Task ID")}`;
      if (removing.has(key)) throw new Error("Task worktree cleanup is already in progress.");
      removing.add(key);
      try {
        let result = await inspectWorktree(project, owner, repository, operation, true);
        if (result.registration === null) {
          await removeEmptyReservation(repository, owner.taskId, operation);
          return;
        }
        if (result.leaf !== null && await ordinaryFile(path.join(result.binding.worktreePath, ".git")) === null) {
          // Nonrecursive removal also settles an interrupted final unlink or an
          // empty reservation without authorizing deletion of unattributed bytes.
          operation.check();
          await removeEmptyDirectory(result.binding.worktreePath, operation);
          result = await inspectWorktree(project, owner, repository, operation, true);
        }
        if (result.registration === null) return;
        if (result.leaf !== null) {
          const { registration, binding, leaf } = result;
          const directories = new Map<string, string>([[repository.root, repository.rootIdentity], [repository.commonDirectory, repository.commonIdentity]]);
          for (const target of [path.join(repository.root, ".worktrees"), path.dirname(binding.worktreePath), path.dirname(registration.directory), registration.directory]) {
            const identity = await directory(target);
            if (identity === null) throw new Error(`Worktree ownership directory ${target} disappeared.`);
            directories.set(target, identity);
          }
          directories.set(binding.worktreePath, leaf);
          const metadata = new Map<string, string>();
          for (const target of [path.join(binding.worktreePath, ".git"), ...["locked", "gitdir", "commondir"].map(name => path.join(registration.directory, name))]) {
            const contents = await ordinaryFile(target);
            if (contents === null) throw new Error(`Worktree ownership metadata ${target} disappeared.`);
            metadata.set(target, contents);
          }
          const verifyOwnership = async (): Promise<void> => {
            operation.check();
            for (const [target, identity] of directories) {
              if (await directory(target) !== identity) throw new Error(`Worktree ownership directory ${target} changed during cleanup.`);
            }
            for (const [target, contents] of metadata) {
              if (await ordinaryFile(target) !== contents) throw new Error(`Worktree ownership metadata ${target} changed during cleanup.`);
            }
            operation.check();
          };
          // Bind the lightweight mutation guards to a second complete ownership inspection.
          const confirmed = await inspectWorktree(project, owner, repository, operation, true);
          if (confirmed.leaf !== leaf || confirmed.registration?.directory !== registration.directory || confirmed.registration.marker !== registration.marker) throw new Error("The task worktree ownership changed before cleanup.");
          await verifyOwnership();
          await removeWorktreeContents(binding.worktreePath, leaf, operation, verifyOwnership, removeDirectory);
          await inspectWorktree(project, owner, repository, operation, true);
          await verifyOwnership();
          await unlink(path.join(binding.worktreePath, ".git"));
          operation.check();
          for (const [target, identity] of directories) {
            if (await directory(target) !== identity) throw new Error(`Worktree ownership directory ${target} changed during cleanup.`);
          }
          operation.check();
          await removeEmptyDirectory(binding.worktreePath, operation);
        }
        operation.check();
        result = await inspectWorktree(project, owner, repository, operation, true);
        if (result.leaf !== null) throw new Error("The original task worktree directory still exists after removal.");
        if (result.registration !== null) {
          try { await git(repository.root, ["worktree", "remove", "--force", "--force", "--", result.binding.worktreePath], operation); }
          catch (error) {
            operation.check();
            const observed = await inspectWorktree(project, owner, repository, operation, true);
            if (observed.leaf !== null || observed.registration !== null) throw error;
          }
        }
        result = await inspectWorktree(project, owner, repository, operation, true);
        if (result.leaf !== null || result.registration !== null) throw new Error("The original task worktree removal is incomplete.");
      } finally {
        removing.delete(key);
      }
    },
    dispose: async (): Promise<void> => { if (hooks !== null) { await rm(await hooks, { recursive: true }); hooks = null; } },
  };
};
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
