import { createHash } from "node:crypto";
import { normalizeTaskTagIds } from "./task-tags.js";
import { normalizedTagName, parseTagName } from "./tags.js";
import { array, fields, malformed } from "./validation.js";

export type WorkerTaskTagFilter = { readonly names: readonly string[]; readonly match: "any" | "all" };

const nameKey = (name: string): string => name.replace(/[A-Z]/g, character => character.toLowerCase());
const sortedNames = (names: readonly string[]): readonly [string, string][] => {
  const distinct = new Map<string, string>();
  for (const value of names) {
    const name = parseTagName(normalizedTagName(value)), key = nameKey(name);
    if (!distinct.has(key)) distinct.set(key, name);
  }
  // UTF-8 byte order agrees with Unicode scalar order, including supplementary characters.
  return [...distinct].map(([key, name]) => ({ key, name, bytes: Buffer.from(key, "utf8") }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
    .map(({ key, name }): [string, string] => [key, name]);
};

export const parseTaskTagFilter = (value: unknown): WorkerTaskTagFilter => {
  const data = fields(value, ["names", "match"]);
  if (data.match !== "any" && data.match !== "all") return malformed();
  const names = array(data.names, name => typeof name === "string" ? name : malformed());
  const normalized = sortedNames(names).map(([, name]) => name);
  return { names: normalized, match: normalized.length === 0 ? "any" : data.match };
};

export const taskTagFilterKey = (filter: WorkerTaskTagFilter): string => {
  const normalized = parseTaskTagFilter(filter);
  const keys = normalized.names.map(nameKey);
  return createHash("sha256").update(JSON.stringify([normalized.match, keys]), "utf8").digest("hex");
};

export const parseTaskTagFilterKey = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : malformed();

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
