import path from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import { WorktreeValidationError } from "./worktree-errors.js";
import type { ResourceOwner, WorkerProject } from "./types.js";
import type { OwnedWorktree, WorkerRepository } from "./worktrees.js";

export type Registration = { directory: string; marker: string | null; pointer: string; common: string };
type Entry = { directory: string; marker: string | null; pointer: string | null; physicalPointer: string | null; common: string | null; owner: ResourceOwner | null; managed: boolean; errors: unknown[] };
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
const physicalPointer = async (target: string): Promise<string> => {
  const parent = await resolvePhysicalDirectory(path.dirname(target));
  const resolved = path.join(parent.ancestorPath, ...parent.missingComponents, path.basename(target));
  let entry;
  try {
    entry = await lstat(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("A Git registration target must be an ordinary file with one link.");
  // Existing targets can have case aliases even when their parent is canonical.
  // Multiple hard links cannot establish a unique target by path spelling.
  return realpath(resolved);
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
      entry.pointer = pointer === null ? null : path.resolve(entry.directory, pointer);
      if (entry.pointer === null && entry.managed) throw new Error("The owned task worktree registration has no Git pointer.");
      // Manual registrations can alias a managed target too. Resolve every
      // pointer once, retaining missing descendants without following .git.
      if (entry.pointer !== null) entry.physicalPointer = await physicalPointer(entry.pointer);
    } catch (error) { operation.check(); entry.errors.push(error); }
    if (entry.managed) {
      if (entry.marker !== null) try { entry.owner = readers.markerOwner(entry.marker); } catch (error) { entry.errors.push(error); }
      try {
        const common = await readers.ordinaryFile(path.join(entry.directory, "commondir"));
        if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
        entry.common = path.resolve(entry.directory, common);
      } catch (error) { operation.check(); entry.errors.push(error); }
    }
    entries.push(entry);
  }
  operation.check();
  return { entries };
};

export const registrationsFor = async (index: RegistrationIndex, target: string, readers: Readers): Promise<Registration[]> => {
  const pointer = await physicalPointer(path.join(target, ".git"));
  const result: Registration[] = [];
  for (const entry of index.entries) {
    if (entry.physicalPointer === null && entry.errors.length > 0) throw entry.errors[0];
    if (entry.physicalPointer !== pointer) continue;
    if (entry.errors.length > 0) throw entry.errors[0];
    const common = entry.common ?? await readers.ordinaryFile(path.join(entry.directory, "commondir"));
    if (common === null) throw new Error("The task worktree registration is missing its common-directory pointer.");
    result.push({ directory: entry.directory, marker: entry.marker, pointer, common: path.resolve(entry.directory, common) });
  }
  return result;
};

export const scanRepositoryWorktrees = async (
  project: WorkerProject, repository: WorkerRepository, index: RegistrationIndex, operation: Operation, readers: Readers,
  inspect: (owner: ResourceOwner) => Promise<OwnedWorktree>, includeOtherProjects: boolean,
): Promise<WorktreeScan> => {
  const result: WorktreeScan = { enumerationComplete: true, validated: [], quarantined: [], unknown: [] };
  const namespace = path.join(repository.root, ".worktrees", "daynight");
  await readers.directory(path.dirname(namespace));
  await readers.directory(namespace);
  const physical = await resolvePhysicalDirectory(namespace);
  const physicalNamespace = path.join(physical.ancestorPath, ...physical.missingComponents);
  for (const entry of index.entries) {
    operation.check();
    if (entry.errors.length > 0) { result.unknown.push(...entry.errors.map(error => ({ error }))); continue; }
    if (!entry.managed) continue;
    const owner = entry.owner;
    if (owner === null) { result.unknown.push({ error: new Error("The owned registration has no recognized owner.") }); continue; }
    try {
      if (index.entries.some(other => other.physicalPointer === null && other.errors.length > 0)) throw new Error("An unreadable registration prevents proving unique worktree ownership.");
      if (entry.pointer !== path.join(physicalNamespace, owner.taskId, ".git")) throw new Error("The owned task worktree registration does not point to its fixed task path.");
      if (index.entries.filter(other => other.physicalPointer === entry.physicalPointer).length !== 1
        || index.entries.some(other => other !== entry && other.owner?.projectId === owner.projectId && other.owner.taskId === owner.taskId && other.owner.claimId === owner.claimId)) throw new Error("The owned task worktree registration is ambiguous.");
      if (entry.common === null || await readers.directory(entry.common) !== repository.commonIdentity) throw new Error("The task worktree registration points to another Git repository.");
      const leaf = path.join(namespace, owner.taskId);
      // A foreign reverse pointer is not a local identity-validation failure.
      if (await readers.directory(leaf) !== null) {
        const reverse = await readers.ordinaryFile(path.join(leaf, ".git"));
        if (reverse !== null && (!reverse.startsWith("gitdir: ") || path.resolve(leaf, reverse.slice(8)) !== entry.directory)) throw new Error("The original worktree Git pointer has changed.");
      }
    } catch (error) { operation.check(); result.unknown.push({ error }); continue; }
    try {
      const found = await inspect(owner);
      if (includeOtherProjects || owner.projectId === project.projectId) result.validated.push(found);
    } catch (error) {
      operation.check();
      // Unknown errors, including native failures without a code or wrapped
      // filesystem errors, cannot establish bounded resource failure.
      if (error instanceof WorktreeValidationError) result.quarantined.push({ owner, error });
      else result.unknown.push({ error });
    }
  }
  operation.check();
  result.validated.sort((a, b) => a.owner.taskId.localeCompare(b.owner.taskId) || a.owner.claimId.localeCompare(b.owner.claimId));
  return result;
};
