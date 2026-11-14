import type { TaskTag } from "./types";
import { array, id, malformed, record, string } from "./validation";

export const parseTaskTags = (value: unknown): readonly TaskTag[] => {
  const tags = array(value, (item): TaskTag => {
    const data = record(item), name = string(data.name);
    if (!name.isWellFormed() || name !== name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "") ||
      name.length === 0 || Array.from(name).length > 64 || /[\p{Cc}\u2028\u2029]/u.test(name)) return malformed();
    return { id: id(data.id), name };
  });
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) return malformed();
  return tags;
};

export const sameTaskTags = (left: readonly TaskTag[], right: readonly TaskTag[]): boolean => {
  if (left.length !== right.length) return false;
  const names = new Map(left.map((tag) => [tag.id, tag.name]));
  return right.every((tag) => names.get(tag.id) === tag.name);
};

import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { isTaskVersion, parseApiJson, stringifyApiJson } from "./json";
import { jsonContainerSources, jsonObjectSources } from "./json-source";
import { count, nonemptyString, timestamp } from "./validation";

export type ProjectTag = TaskTag & {
  readonly projectId: string;
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly usage: { readonly tasks: number; readonly goals: number };
};
export type ProjectTagPage = { readonly items: readonly ProjectTag[]; readonly catalogEpoch: string; readonly nextCursor: string | null };
export type ProjectTagQuery = { readonly query: string; readonly limit: number; readonly cursor: string | null };

export const normalizeTagName = (value: string): string | null => {
  if (!value.isWellFormed()) return null;
  const name = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  return name.length === 0 || Array.from(name).length > 64 || /[\p{Cc}\u2028\u2029]/u.test(name) ? null : name;
};
export const tagNameKey = (name: string): string => name.replace(/[A-Z]/g, character => character.toLowerCase());

const parseProjectTag = (value: unknown, project: string, expectedId?: string): ProjectTag => {
  const data = record(value), tag = parseTaskTags([{ id: data.id, name: data.name }])[0]!, usage = record(data.usage);
  if (id(data.projectId) !== project || expectedId !== undefined && tag.id !== expectedId || !isTaskVersion(data.version)) return malformed();
  return { ...tag, projectId: project, version: data.version, createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), usage: { tasks: count(usage.tasks), goals: count(usage.goals) } };
};
const decodePage = async (response: Response): Promise<unknown> => {
  const source = await response.text(), data = record(JSON.parse(source));
  if (!response.ok) return data;
  const itemsSource = jsonObjectSources(source).get("items");
  if (itemsSource === undefined || !Array.isArray(data.items)) return malformed();
  const items = jsonContainerSources(itemsSource).map(parseApiJson);
  if (items.length !== data.items.length) return malformed();
  return { ...data, items };
};
const parsePage = (value: unknown, project: string, limit: number): ProjectTagPage => {
  const data = record(value), items = array(data.items, item => parseProjectTag(item, project));
  if (items.length > limit || new Set(items.map(item => item.id)).size !== items.length) return malformed();
  const nextCursor = data.nextCursor === null ? null : nonemptyString(data.nextCursor);
  if (nextCursor !== null && items.length === 0) return malformed();
  return { items, catalogEpoch: id(data.catalogEpoch), nextCursor };
};
const headers = { Accept: "application/json", "Content-Type": "application/json" };
const base = (project: string) => `/api/v1/projects/${project}/tags`;

export const listProjectTags = async (projectId: string, query: ProjectTagQuery, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectTagPage> => {
  const project = requestId(projectId);
  if (!query.query.isWellFormed() || query.query.includes("\0") || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || query.cursor !== null && (!query.cursor.isWellFormed() || query.cursor.trim() === "" || query.cursor.includes("\0"))) throw new ApiError("protocol");
  const parameters = new URLSearchParams();
  if (query.query !== "") parameters.set("query", query.query);
  parameters.set("limit", String(query.limit));
  if (query.cursor !== null) parameters.set("cursor", query.cursor);
  const response = await request(`${base(project)}?${parameters}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) return malformed(); return parsePage(value, project, query.limit); }, decodePage);
};
export const getProjectTag = async (projectId: string, tagId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectTag> => {
  const project = requestId(projectId), tag = requestId(tagId);
  const response = await request(`${base(project)}/${tag}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) return malformed(); return parseProjectTag(value, project, tag); });
};
const writeTag = async (project: string, tag: string | null, method: "POST" | "PATCH" | "DELETE", body: object, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectTag | { readonly projectId: string; readonly tagId: string; readonly deleted: true }> => {
  const response = await request(`${base(project)}${tag === null ? "" : `/${tag}`}`, signal, { method, headers, body: stringifyApiJson(body) }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  const success = method === "POST" ? 201 : 200;
  if (response.status === success) admission.onWriteConfirmed?.();
  return json(response, signal, value => {
    if (response.status !== success) return malformed();
    if (method === "DELETE") {
      const data = record(value);
      if (id(data.projectId) !== project || id(data.tagId) !== tag || data.deleted !== true) return malformed();
      return { projectId: project, tagId: tag!, deleted: true };
    }
    const result = parseProjectTag(value, project, tag ?? undefined);
    const input = body as { readonly name: string; readonly version?: bigint };
    if (result.name !== input.name || input.version !== undefined && result.version !== input.version && result.version !== input.version + 1n) return malformed();
    return result;
  }, undefined, false, admission.onWriteRejected);
};
export const createProjectTag = (projectId: string, name: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectTag> => {
  const project = requestId(projectId), normalized = normalizeTagName(name);
  if (normalized === null) throw new ApiError("protocol");
  return writeTag(project, null, "POST", { name: normalized }, signal, admission) as Promise<ProjectTag>;
};
export const renameProjectTag = (projectId: string, tagId: string, name: string, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectTag> => {
  const project = requestId(projectId), tag = requestId(tagId), normalized = normalizeTagName(name);
  if (normalized === null || !isTaskVersion(version)) throw new ApiError("protocol");
  return writeTag(project, tag, "PATCH", { version, name: normalized }, signal, admission) as Promise<ProjectTag>;
};
export const deleteProjectTag = (projectId: string, tagId: string, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission): Promise<{ readonly projectId: string; readonly tagId: string; readonly deleted: true }> => {
  const project = requestId(projectId), tag = requestId(tagId);
  if (!isTaskVersion(version)) throw new ApiError("protocol");
  return writeTag(project, tag, "DELETE", { version, confirm: true }, signal, admission) as Promise<{ readonly projectId: string; readonly tagId: string; readonly deleted: true }>;
};
export const resolveProjectTags = async (projectId: string, tagIds: readonly string[], signal: AbortSignal, admission: TaskResponseAdmission): Promise<readonly TaskTag[]> => {
  const project = requestId(projectId), ids = tagIds.map(requestId);
  if (new Set(ids).size !== ids.length) throw new ApiError("protocol");
  const response = await request(`${base(project)}/resolve`, signal, { method: "POST", headers, body: JSON.stringify({ tagIds: ids }) });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    const items = parseTaskTags(record(value).items);
    if (items.length !== ids.length || items.some(item => !ids.includes(item.id))) return malformed();
    return items;
  });
};
