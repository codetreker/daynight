import path from "node:path";
import { realpathSync } from "node:fs";
import { resolvePhysicalDirectory } from "../../../platform/filesystem.js";

export const managedNamespace = (repositoryPath: string): string => path.join(repositoryPath, ".worktrees", "daynight");
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
