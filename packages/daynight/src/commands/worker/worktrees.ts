import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { normalizeServerUrl } from "../../config/server.js";
import { runRepositoryGit } from "../../repository/git.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { LocalTask, WorkerProject, WorktreeBinding } from "./types.js";

type GitRunner = typeof runRepositoryGit;
type Owner = { serverOrigin: string; projectId: string; taskId: string; claimId: string; worktreeId: string; leaf: string; root: string; common: string };
type Registration = { directory: string; marker: string | null; pointer: string; common: string };
export type WorkerRepository = { root: string; commonDirectory: string; rootIdentity: string; commonIdentity: string };
export type WorktreeRemovalProof = { terminal: true; agentStopped: true } & ({ workspaceClosed: true } | { backendResourcesClosed: true });
const prefix = "daynight-worker:";
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
const coordinates = (task: LocalTask) => ({ serverOrigin: normalizeServerUrl(task.serverOrigin), projectId: uuid(task.projectId, "Project ID"), taskId: uuid(task.taskId, "Task ID"), claimId: uuid(task.claimId, "Claim ID"), worktreeId: uuid(task.worktreeId, "Worktree ID") });
const markerOwner = (marker: string): Owner => {
  if (!marker.startsWith(prefix)) throw new Error("The task worktree has a different ownership marker.");
  const value: unknown = JSON.parse(marker.slice(prefix.length));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The task worktree ownership marker is invalid.");
  const fields = ["serverOrigin", "projectId", "taskId", "claimId", "worktreeId", "leaf", "root", "common"];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field) || typeof (value as Record<string, unknown>)[field] !== "string")) throw new Error("The task worktree ownership marker is invalid.");
  const owner = value as Owner;
  for (const field of ["leaf", "root", "common"] as const) if (!/^\d+:\d+$/.test(owner[field])) throw new Error("The task worktree ownership fingerprint is invalid.");
  return owner;
};
const sameCoordinates = (owner: Owner, task: LocalTask): boolean => Object.entries(coordinates(task)).every(([key, value]) => owner[key as keyof Owner] === value);

export const createWorkerGitManager = (options: { temporaryDirectory: string; runGit?: GitRunner; removeDirectory?: typeof rm }) => {
  const temporaryDirectory = absolute(options.temporaryDirectory, "Git temporary directory");
  const runGit = options.runGit === undefined ? runRepositoryGit : options.runGit;
  const removeDirectory = options.removeDirectory === undefined ? rm : options.removeDirectory;
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
    const result = await runGit(cwd, ["-c", `core.hooksPath=${await hookDirectory()}`, "-c", "submodule.recurse=false", ...args], operation, { environment, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
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
  const projectFor = (task: LocalTask): WorkerProject => ({ serverOrigin: task.serverOrigin, projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath });
  const bindingFor = (task: LocalTask, repository: WorkerRepository): WorktreeBinding => ({ repositoryPath: task.repositoryPath, commonDirectory: repository.commonDirectory, worktreePath: path.join(repository.root, ".worktrees", "daynight", coordinates(task).taskId), branch: `daynight/${coordinates(task).taskId}` });
  const validateBinding = (task: LocalTask, expected: WorktreeBinding): void => {
    const original = task.resources.worktree;
    if (original !== null && Object.entries(expected).some(([key, value]) => original[key as keyof WorktreeBinding] !== value)) throw new Error("The task's original worktree binding differs from its actual repository or fixed path.");
  };
  const registrations = async (repository: WorkerRepository, target: string): Promise<Registration[]> => {
    const family = path.join(repository.commonDirectory, "worktrees");
    if (await directory(family) === null) return [];
    const parent = await resolvePhysicalDirectory(path.dirname(target));
    const expectedPointer = path.join(parent.ancestorPath, ...parent.missingComponents, path.basename(target), ".git");
    const result: Registration[] = [];
    for (const entry of await readdir(family, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const admin = path.join(family, entry.name);
      const pointer = await ordinaryFile(path.join(admin, "gitdir"));
      if (pointer === null || path.resolve(admin, pointer) !== expectedPointer) continue;
      const common = await ordinaryFile(path.join(admin, "commondir"));
      if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
      result.push({ directory: admin, marker: await ordinaryFile(path.join(admin, "locked")), pointer: expectedPointer, common: path.resolve(admin, common) });
    }
    return result;
  };
  const inspectWorktree = async (task: LocalTask, repository: WorkerRepository, operation: Operation, terminal: boolean) => {
    const binding = bindingFor(task, repository);
    validateBinding(task, binding);
    for (const parent of [path.join(repository.root, ".worktrees"), path.join(repository.root, ".worktrees", "daynight")]) {
      await directory(parent);
    }
    const leaf = await directory(binding.worktreePath);
    const matches = await registrations(repository, binding.worktreePath);
    if (matches.length > 1) throw new Error("The task worktree registration is ambiguous.");
    const registration = matches[0] ?? null;
    if (registration === null) {
      if (leaf !== null) throw new Error("An existing task worktree path has no matching ownership registration; it was retained.");
      return { binding, leaf, registration };
    }
    if (registration.marker === null) throw new Error("The task worktree has no ownership marker; it was retained.");
    const owner = markerOwner(registration.marker);
    if (!sameCoordinates(owner, task) || owner.root !== repository.rootIdentity || owner.common !== repository.commonIdentity || await directory(registration.common) !== repository.commonIdentity) throw new Error("The task worktree ownership marker or repository identity does not match this claim.");
    if (leaf !== null) {
      const pointer = await ordinaryFile(path.join(binding.worktreePath, ".git"));
      if (pointer === null) throw new Error("The original worktree Git pointer is missing; the present directory cannot be attributed safely and was retained.");
      if (owner.leaf !== leaf) throw new Error("The original task worktree directory was replaced; it was retained.");
      if (!pointer.startsWith("gitdir: ") || path.resolve(binding.worktreePath, pointer.slice(8)) !== registration.directory) throw new Error("The original worktree Git pointer has changed.");
      const common = await git(binding.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation);
      if (await directory(common) !== repository.commonIdentity) throw new Error("The task worktree belongs to another Git repository.");
      if (!terminal) await validateOrigin(binding.worktreePath, task.repoUrl, operation);
    }
    const branch = await git(repository.root, [`--git-dir=${registration.directory}`, "symbolic-ref", "--quiet", "HEAD"], operation);
    if (branch !== `refs/heads/${binding.branch}`) throw new Error("The task worktree no longer uses its original task branch.");
    return { binding, leaf, registration };
  };
  return {
    prepareRepository: async (project: WorkerProject, operation: Operation): Promise<WorkerRepository> => {
      operation.check();
      repositoryIdentity(project.repoUrl);
      const root = absolute(project.localPath, "Repository path");
      if (await directory(root) === null) {
        await mkdir(path.dirname(root), { recursive: true });
        await mkdir(root);
        await git(path.dirname(root), ["clone", "--origin=origin", `--template=${await hookDirectory()}`, "--", project.repoUrl, root], operation, 120_000);
      }
      return inspectRepository(project, operation);
    },
    prepareWorktree: async (task: LocalTask, operation: Operation): Promise<WorktreeBinding> => {
      if (task.status !== "active" || task.cleanup !== null || task.control !== null) throw new Error("Worktree preparation requires an active execution without cleanup or control intent.");
      const repository = await inspectRepository(projectFor(task), operation);
      const parent = path.join(repository.root, ".worktrees");
      await ensureDirectory(parent);
      await ensureDirectory(path.join(parent, "daynight"));
      const before = await inspectWorktree(task, repository, operation, false);
      if (before.registration !== null) {
        if (before.leaf === null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
        return before.binding;
      }
      if (task.resources.worktree !== null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
      const names = (await git(repository.root, ["for-each-ref", "--format=%(refname)", `refs/heads/${before.binding.branch}`], operation)).split("\n");
      const reference = `refs/heads/${before.binding.branch}`;
      if (names.some((name) => name.startsWith(`${reference}/`))) throw new Error("An existing branch namespace conflicts with the task branch.");
      const existing = names.includes(reference);
      if (existing && await git(repository.root, ["for-each-ref", "--format=%(worktreepath)", reference], operation) !== "") throw new Error("The retained task branch is already checked out in another worktree.");
      await mkdir(before.binding.worktreePath);
      const leaf = await directory(before.binding.worktreePath);
      if (leaf === null) throw new Error("The reserved task worktree directory disappeared.");
      const marker = `${prefix}${JSON.stringify({ ...coordinates(task), leaf, root: repository.rootIdentity, common: repository.commonIdentity } satisfies Owner)}`;
      const branchArgs = !existing ? ["-b", before.binding.branch, "--", before.binding.worktreePath, "HEAD"] : ["--", before.binding.worktreePath, before.binding.branch];
      await git(repository.root, ["worktree", "add", "--lock", "--reason", marker, ...branchArgs], operation);
      const after = await inspectWorktree(task, repository, operation, false);
      if (after.leaf === null || after.registration === null) throw new Error("Git did not create the expected owned task worktree.");
      return after.binding;
    },
    verifyWorktree: async (task: LocalTask, operation: Operation): Promise<WorktreeBinding> => {
      if (task.resources.worktree === null) throw new Error("Recovery requires the original persisted worktree binding.");
      const repository = await inspectRepository(projectFor(task), operation);
      const result = await inspectWorktree(task, repository, operation, false);
      if (result.leaf === null || result.registration === null) throw new Error("The original task worktree is missing; it cannot be recreated as recovery.");
      return result.binding;
    },
    findWorktree: async (task: LocalTask, operation: Operation): Promise<WorktreeBinding | null> => {
      const repository = await inspectRepository(projectFor(task), operation);
      const result = await inspectWorktree(task, repository, operation, task.cleanup !== null || task.control !== null);
      if (result.registration === null) return null;
      if (result.leaf === null) throw new Error("The original task worktree is missing; its ownership registration was retained.");
      return result.binding;
    },
    removeWorktree: async (task: LocalTask, proof: WorktreeRemovalProof, operation: Operation): Promise<void> => {
      if (proof.terminal !== true || proof.agentStopped !== true || !(task.configuration?.agentControlMode === "web" ? "backendResourcesClosed" in proof && proof.backendResourcesClosed : "workspaceClosed" in proof && proof.workspaceClosed)) throw new Error("Worktree removal requires terminal cleanup, confirmed agent stop and workspace closure.");
      const repository = await inspectRepository(projectFor(task), operation);
      let result = await inspectWorktree(task, repository, operation, true);
      if (result.registration === null) return;
      // Device/inode values can be reused after deletion, so the Git pointer must survive recursive cleanup.
      // Its final unlink and nonrecursive rmdir may leave an ambiguous empty leaf, which is retained on retry.
      if (result.leaf !== null) {
        for (const name of await readdir(result.binding.worktreePath)) {
          if (name === ".git") continue;
          operation.check();
          await removeDirectory(path.join(result.binding.worktreePath, name), { recursive: true });
        }
        operation.check();
        await rm(path.join(result.binding.worktreePath, ".git"));
        await rmdir(result.binding.worktreePath);
      }
      operation.check();
      result = await inspectWorktree(task, repository, operation, true);
      if (result.leaf !== null) throw new Error("The original task worktree directory still exists after removal.");
      if (result.registration !== null) await git(repository.root, ["worktree", "remove", "--force", "--force", "--", result.binding.worktreePath], operation);
      result = await inspectWorktree(task, repository, operation, true);
      if (result.leaf !== null || result.registration !== null) throw new Error("The original task worktree removal is incomplete.");
    },
    dispose: async (): Promise<void> => { if (hooks !== null) { await rm(await hooks, { recursive: true }); hooks = null; } },
  };
};
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
