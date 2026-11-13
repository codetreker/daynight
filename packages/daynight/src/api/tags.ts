import { array, count, fields, id, malformed, resourceVersion, text, timestamp } from "./validation.js";

export type Tag = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly usage: { readonly tasks: number; readonly goals: number };
};
export type TagListQuery = { readonly query?: string; readonly limit?: number; readonly cursor?: string };
export type TagPage = { readonly items: readonly Tag[]; readonly catalogEpoch: string; readonly nextCursor: string | null };
export type TagDeletionReceipt = { readonly projectId: string; readonly tagId: string; readonly deleted: true };

// The service trims Unicode White_Space and preserves all other presentation spelling.
export const normalizedTagName = (name: string): string => name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");

export const parseTagName = (value: unknown): string => {
  const name = text(value, true);
  if (name !== normalizedTagName(name) || Array.from(name).length > 64 || /[\p{Cc}\u2028\u2029]/u.test(name)) return malformed();
  return name;
};

export const parseTag = (value: unknown, projectId: string, tagId?: string): Tag => {
  const data = fields(value, ["id", "projectId", "name", "version", "createdAt", "updatedAt", "usage"]);
  const usage = fields(data.usage, ["tasks", "goals"]);
  const result = {
    id: id(data.id), projectId: id(data.projectId), name: parseTagName(data.name), version: resourceVersion(data.version),
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), usage: { tasks: count(usage.tasks), goals: count(usage.goals) },
  };
  if (result.projectId !== projectId || tagId !== undefined && result.id !== tagId) return malformed();
  return result;
};

export const parseTagPage = (value: unknown, projectId: string, limit: number): TagPage => {
  const data = fields(value, ["items", "catalogEpoch", "nextCursor"]);
  const items = array(data.items, (item) => parseTag(item, projectId));
  const nextCursor = data.nextCursor === null ? null : text(data.nextCursor, true);
  if (items.length > limit || new Set(items.map(item => item.id)).size !== items.length || nextCursor !== null && items.length === 0) return malformed();
  return { items, catalogEpoch: id(data.catalogEpoch), nextCursor };
};

export const parseTagDeletionReceipt = (value: unknown, projectId: string, tagId: string): TagDeletionReceipt => {
  const data = fields(value, ["projectId", "tagId", "deleted"]);
  if (id(data.projectId) !== projectId || id(data.tagId) !== tagId || data.deleted !== true) return malformed();
  return { projectId, tagId, deleted: true };
};
