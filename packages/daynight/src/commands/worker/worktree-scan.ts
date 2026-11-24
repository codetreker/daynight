import path from "node:path";
import { readdir } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";
import { WorktreeValidationError } from "./worktree-errors.js";
import { canonicalId } from "../../api/parse.js";
import { managedNamespace } from "./worktrees/paths.js";
import { ambiguousMissingGitTargets, resolveGitDirectory, resolveGitFile, type GitFileTarget } from "./worktree-paths.js";
import type { RegisteredWorktree, WorkerRepository } from "./worktrees.js";

export type Registration = { directory: string; marker: string | null; pointer: string; common: string };
type Entry = { directory: string; marker: string | null; physicalPointer: GitFileTarget | null; errors: unknown[] };
export type RegistrationIndex = { entries: Entry[] };
export type WorktreeScan = {
  enumerationComplete: boolean;
  validated: RegisteredWorktree[];
  quarantined: (RegisteredWorktree & { error: unknown })[];
  unknown: { error: unknown }[];
};
type Readers = {
  directory(target: string): Promise<string | null>;
  ordinaryFile(target: string): Promise<string | null>;
};

// Keep entry failures until their target is known; unrelated target validation
// must not consume another registration's metadata failure.
export const readRegistrationIndex = async (repository: WorkerRepository, readers: Readers, operation: Operation): Promise<RegistrationIndex> => {
  operation.check();
  const family = path.join(repository.commonDirectory, "worktrees");
  if (await readers.directory(family) === null) return { entries: [] };
  const entries: Entry[] = [];
  for (const dirent of await readdir(family, { withFileTypes: true })) {
    operation.check();
    const entry: Entry = { directory: path.join(family, dirent.name), marker: null, physicalPointer: null, errors: [] };
    try {
      // An unreadable admin entry cannot prove that it is merely a manual
      // worktree. Never follow a redirected directory to obtain that proof.
      if (!dirent.isDirectory() || dirent.isSymbolicLink() || await readers.directory(entry.directory) === null) {
        throw new Error("A Git worktree administrative entry is not an ordinary directory.");
      }
    } catch (error) {
      operation.check(); entry.errors.push(error); entries.push(entry); continue;
    }
    try {
      entry.marker = await readers.ordinaryFile(path.join(entry.directory, "locked"));
    } catch (error) { operation.check(); entry.errors.push(error); }
    try {
      const pointer = await readers.ordinaryFile(path.join(entry.directory, "gitdir"));
      if (pointer === null) throw new Error("A Git worktree registration has no Git pointer.");
      // Manual registrations can alias a managed target too. Resolve every
      // pointer once, retaining missing descendants without following .git.
      entry.physicalPointer = await resolveGitFile(entry.directory, pointer);
    } catch (error) { operation.check(); entry.errors.push(error); }
    entries.push(entry);
  }
  operation.check();
  return { entries };
};

export const registrationsFor = async (index: RegistrationIndex, target: string, readers: Readers): Promise<Registration[]> => {
  const pointer = await resolveGitFile(target, ".git");
  const result: Registration[] = [];
  for (const entry of index.entries) {
    if (entry.physicalPointer === null && entry.errors.length > 0) throw entry.errors[0];
    if (entry.physicalPointer !== null && ambiguousMissingGitTargets(entry.physicalPointer, pointer)) throw new Error("Missing Git registration targets have ambiguous case spellings.");
    if (entry.physicalPointer?.path !== pointer.path) continue;
    if (entry.errors.length > 0) throw entry.errors[0];
    const common = await readers.ordinaryFile(path.join(entry.directory, "commondir"));
    if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
    result.push({ directory: entry.directory, marker: entry.marker, pointer: pointer.path, common: await resolveGitDirectory(entry.directory, common) });
  }
  return result;
};

export type BranchRegistration = { worktreePath: string; branch: string };

export const parseWorktreeBranches = (stdout: string): BranchRegistration[] => stdout.split("\0\0").flatMap(value => {
  const fields = value.split("\0");
  const worktree = fields.find(field => field.startsWith("worktree "));
  const branch = fields.find(field => field.startsWith("branch "));
  return worktree === undefined || branch === undefined ? [] : [{ worktreePath: worktree.slice("worktree ".length), branch: branch.slice("branch ".length) }];
});

export const scanRepositoryWorktrees = async (
  repository: WorkerRepository, repositoryPath: string, index: RegistrationIndex, operation: Operation, readers: Readers,
  readBranch: (gitDirectory: string) => Promise<string | null>, inspect: (worktree: RegisteredWorktree) => Promise<void>,
): Promise<WorktreeScan> => {
  const result: WorktreeScan = { enumerationComplete: true, validated: [], quarantined: [], unknown: [] };
  const namespace = managedNamespace(repository.root);
  await readers.directory(path.dirname(namespace));
  await readers.directory(namespace);
  const namespaceTarget = await resolveGitFile(namespace, ".git");
  const physicalNamespace = path.dirname(namespaceTarget.path);
  for (const entry of index.entries) {
    operation.check();
    if (entry.physicalPointer === null) {
      result.unknown.push(...entry.errors.map(error => ({ error })));
      continue;
    }
    const target = entry.physicalPointer.path;
    const physicalWorktree = path.dirname(target);
    if (path.basename(target) !== ".git" || path.dirname(physicalWorktree) !== physicalNamespace) continue;
    let worktree: RegisteredWorktree | undefined;
    try {
      if (entry.errors.length > 0) throw entry.errors[0];
      const branch = await readBranch(entry.directory);
      const prefix = "refs/heads/daynight/";
      if (branch === null || !branch.startsWith(prefix)) continue;
      const taskId = branch.slice(prefix.length);
      if (canonicalId(taskId) !== taskId) continue;
      worktree = { taskId, binding: {
        repositoryPath,
        commonDirectory: repository.commonDirectory,
        worktreePath: path.join(namespace, path.basename(physicalWorktree)),
        branch: `daynight/${taskId}`,
      } };
      await inspect(worktree);
      result.validated.push(worktree);
    } catch (error) {
      operation.check();
      if (worktree !== undefined && error instanceof WorktreeValidationError) result.quarantined.push({ ...worktree, error });
      else result.unknown.push({ error });
    }
  }
  operation.check();
  result.validated.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.binding.worktreePath.localeCompare(b.binding.worktreePath));
  return result;
};
