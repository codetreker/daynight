import type { ClaimIdentity } from "../types.js";
import type { FailureWorktree } from "./types.js";
import { encodeWorktree } from "./worktree.js";

type SelectedOwner = ClaimIdentity & { worktreeId: string };
const key = (identity: ClaimIdentity): string => `${identity.projectId}/${identity.taskId}/${identity.claimId}`;
const owned = (identity: ClaimIdentity): identity is SelectedOwner => "worktreeId" in identity && typeof identity.worktreeId === "string";

/** Retain a selected target until its original cleanup responsibility ends. */
export const createSelectedWorktrees = () => {
  const values = new Map<string, { worktreeId: string; worktree: FailureWorktree }>();
  return {
    select(identity: ClaimIdentity, root: string, target: string): void {
      if (!owned(identity)) return;
      const existing = values.get(key(identity));
      if (existing !== undefined && existing.worktreeId !== identity.worktreeId) return;
      values.set(key(identity), { worktreeId: identity.worktreeId, worktree: encodeWorktree(root, target) });
    },
    get(identity: ClaimIdentity): FailureWorktree | undefined {
      const entry = values.get(key(identity));
      return owned(identity) && entry?.worktreeId === identity.worktreeId ? entry.worktree : undefined;
    },
    release(identity: ClaimIdentity): void {
      const entry = values.get(key(identity));
      if (owned(identity) && entry?.worktreeId === identity.worktreeId) values.delete(key(identity));
    },
  };
};
