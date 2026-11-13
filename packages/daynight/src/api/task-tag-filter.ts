import { normalizeTaskTagIds } from "./task-tags.js";

export type TaskTagFilter = {
  readonly tagIds?: readonly string[];
  readonly tagMatch?: "all" | "any";
  readonly untagged?: boolean;
};

// Snapshot the canonical set once so every page uses the same query identity.
export const normalizeTaskTagFilter = (filter: TaskTagFilter): TaskTagFilter => {
  if (filter.tagIds !== undefined && !Array.isArray(filter.tagIds)) throw new Error("Tag IDs must be an array of hyphenated UUIDs.");
  const tagIds = filter.tagIds === undefined ? undefined : normalizeTaskTagIds(filter.tagIds);
  if (filter.tagMatch !== undefined && filter.tagMatch !== "all" && filter.tagMatch !== "any") throw new Error("Tag match must be all or any.");
  if (filter.untagged !== undefined && typeof filter.untagged !== "boolean") throw new Error("Untagged filter must be boolean.");
  if (filter.untagged && tagIds !== undefined && tagIds.length > 0) throw new Error("Untagged conflicts with tag IDs.");
  return {
    ...(tagIds === undefined || tagIds.length === 0 ? {} : { tagIds }),
    ...(filter.tagMatch === undefined && (tagIds === undefined || tagIds.length === 0) ? {} : { tagMatch: filter.tagMatch ?? "all" }),
    ...(filter.untagged === undefined ? {} : { untagged: filter.untagged }),
  };
};
