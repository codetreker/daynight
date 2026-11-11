import path from "node:path";
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
