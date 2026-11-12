import path from "node:path";
import { readdir } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";
import { WorktreeValidationError } from "./worktree-errors.js";
import { createWorktreeManifestStore } from "./worktrees/manifest.js";
import { ambiguousMissingGitTargets, resolveGitDirectory, resolveGitFile, type GitFileTarget } from "./worktree-paths.js";
import type { ResourceOwner, WorkerProject } from "./types.js";
import type { OwnedWorktree, WorkerRepository } from "./worktrees.js";

export type Registration = { directory: string; marker: string | null; pointer: string; common: string };
type Entry = { directory: string; marker: string | null; pointer: string | null; physicalPointer: GitFileTarget | null; common: string | null; owner: ResourceOwner | null; managed: boolean; errors: unknown[] };
export type RegistrationIndex = { entries: Entry[] };
export type WorktreeScan = {
  enumerationComplete: boolean;
  validated: OwnedWorktree[];
  quarantined: { owner: ResourceOwner; error: unknown }[];
  unknown: { error: unknown }[];
};
type Readers = {
  directory(target: string): Promise<string | null>;
  ordinaryFile(target: string): Promise<string | null>;
  markerOwner(marker: string): ResourceOwner;
};
const prefix = "daynight-worker:";

// Keep entry failures until their target is known; unrelated target validation
// must not consume another registration's metadata failure.
export const readRegistrationIndex = async (repository: WorkerRepository, readers: Readers, operation: Operation): Promise<RegistrationIndex> => {
  operation.check();
  const family = path.join(repository.commonDirectory, "worktrees");
  if (await readers.directory(family) === null) return { entries: [] };
  const entries: Entry[] = [];
  for (const dirent of await readdir(family, { withFileTypes: true })) {
    operation.check();
    const entry: Entry = { directory: path.join(family, dirent.name), marker: null, pointer: null, physicalPointer: null, common: null, owner: null, managed: false, errors: [] };
    try {
      // An unreadable admin entry cannot prove that it is merely a manual
      // worktree. Never follow a redirected directory to obtain that proof.
      if (!dirent.isDirectory() || dirent.isSymbolicLink() || await readers.directory(entry.directory) === null) {
        throw new Error("A Git worktree administrative entry is not an ordinary directory.");
      }
    } catch (error) {
      operation.check(); entry.managed = true; entry.errors.push(error); entries.push(entry); continue;
    }
    try {
      entry.marker = await readers.ordinaryFile(path.join(entry.directory, "locked"));
      entry.managed = entry.marker?.startsWith(prefix) === true;
    } catch (error) { operation.check(); entry.managed = true; entry.errors.push(error); }
    try {
      const pointer = await readers.ordinaryFile(path.join(entry.directory, "gitdir"));
      entry.pointer = pointer;
      if (entry.pointer === null && entry.managed) throw new Error("The owned task worktree registration has no Git pointer.");
      // Manual registrations can alias a managed target too. Resolve every
      // pointer once, retaining missing descendants without following .git.
      if (entry.pointer !== null) entry.physicalPointer = await resolveGitFile(entry.directory, entry.pointer);
    } catch (error) { operation.check(); entry.errors.push(error); }
    if (entry.managed) {
      if (entry.marker !== null) try { entry.owner = readers.markerOwner(entry.marker); } catch (error) { entry.errors.push(error); }
      try {
        const common = await readers.ordinaryFile(path.join(entry.directory, "commondir"));
        if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
        entry.common = await resolveGitDirectory(entry.directory, common);
      } catch (error) { operation.check(); entry.errors.push(error); }
    }
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
    const common = entry.common ?? await readers.ordinaryFile(path.join(entry.directory, "commondir"));
    if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
    result.push({ directory: entry.directory, marker: entry.marker, pointer: pointer.path, common: entry.common ?? await resolveGitDirectory(entry.directory, common) });
  }
  return result;
};

export const scanRepositoryWorktrees = async (
  project: WorkerProject, repository: WorkerRepository, index: RegistrationIndex, operation: Operation, readers: Readers,
  inspect: (owner: ResourceOwner, observedPointer: string | null | undefined) => Promise<OwnedWorktree>, includeOtherProjects: boolean, settled: readonly OwnedWorktree[] = [],
): Promise<WorktreeScan> => {
  const result: WorktreeScan = { enumerationComplete: true, validated: [], quarantined: [], unknown: [] };
  const manifests = createWorktreeManifestStore(repository.commonDirectory).list();
  // An unreadable Git entry cannot be proved unrelated even when no manifest
  // currently names it. Preserve the incomplete observation as unknown.
  for (const entry of index.entries) {
    if (entry.physicalPointer === null && entry.errors.length > 0) result.unknown.push(...entry.errors.map(error => ({ error })));
  }
  for (const manifest of manifests) {
    operation.check();
    const owner: ResourceOwner = { projectId: manifest.projectId, taskId: manifest.taskId, claimId: manifest.claimId, worktreeId: manifest.worktreeId };
    if (!includeOtherProjects && owner.projectId !== project.projectId) continue;
    if (settled.some(item => item.owner.projectId === owner.projectId && item.owner.taskId === owner.taskId && item.owner.claimId === owner.claimId && item.owner.worktreeId === owner.worktreeId && path.basename(item.binding.worktreePath) === manifest.directoryName)) continue;
    try {
      const found = await inspect(owner, undefined);
      const leaf = await readers.directory(found.binding.worktreePath);
      const matches = await registrationsFor(index, found.binding.worktreePath, readers);
      if (leaf !== null || matches.length > 0) result.validated.push(found);
    } catch (error) {
      operation.check();
      if (error instanceof WorktreeValidationError) result.quarantined.push({ owner, error });
      else result.unknown.push({ error });
    }
  }
  operation.check();
  result.validated.sort((a, b) => a.owner.taskId.localeCompare(b.owner.taskId) || a.owner.claimId.localeCompare(b.owner.claimId));
  return result;
};
