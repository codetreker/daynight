import path from "node:path";
import { realpathSync } from "node:fs";
import { resolvePhysicalDirectory } from "../../../platform/filesystem.js";
import { canonicalId } from "../../../api/validation.js";
import type { WorktreeBinding } from "../types.js";
import type { WorktreeManifest } from "./manifest.js";

export const canonicalWorktreeId = (value: string): string => {
  if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("Worktree identifiers must be canonical UUIDs.");
  return value;
};

export const managedNamespace = (repositoryPath: string): string => path.join(repositoryPath, ".worktrees", "daynight");
export const manifestPath = (commonDirectory: string, worktreeId: string): string => path.join(commonDirectory, "daynight", "worktrees", `${canonicalWorktreeId(worktreeId)}.json`);
export const bindingForManifest = (repositoryPath: string, commonDirectory: string, manifest: WorktreeManifest): WorktreeBinding => ({
  repositoryPath,
  commonDirectory,
  worktreePath: path.join(managedNamespace(repositoryPath), canonicalWorktreeId(manifest.directoryName)),
  branch: `daynight/${canonicalWorktreeId(manifest.taskId)}`,
});

/** Compare observed locations while preserving the original cwd bytes for its backend. */
export const sameWorktreeLocation = async (left: string, right: string): Promise<boolean> => {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const [a, b] = await Promise.all([resolvePhysicalDirectory(left), resolvePhysicalDirectory(right)]);
  return path.join(a.ancestorPath, ...a.missingComponents) === path.join(b.ancestorPath, ...b.missingComponents);
};

/** A previously settled backend binding is only checked for its original scope. */
export const retainedWorktreePathInScope = (repository: string, owner: { taskId: string; worktreeId: string }, cwd: string): boolean => {
  if (!path.isAbsolute(repository) || !path.isAbsolute(cwd)) return false;
  const namespace = path.dirname(cwd);
  if (path.basename(namespace) !== "daynight" || path.basename(path.dirname(namespace)) !== ".worktrees" || ![owner.taskId, owner.worktreeId].includes(path.basename(cwd))) return false;
  const root = path.dirname(path.dirname(namespace));
  if (root === repository) return true;
  try { return realpathSync(root) === realpathSync(repository); } catch { return false; }
};
