import { ApiError } from "../../api/client";
import { stringifyApiJson } from "../../api/json";
import { parseTaskDetail } from "../../api/parse";
import type { GraphTask, TaskDetail, TaskSummary } from "../../api/types";
import { TaskCacheError, type DetailRecord, type ProjectRecord, type TaskIntrinsicDetail } from "../task-cache/database";
import type { SyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { sameSummary } from "../task-cache/projection";

export const DETAIL_CACHE_LIMITS = { records: 32, totalBytes: 8 * 1024 * 1024, recordBytes: 2 * 1024 * 1024 } as const;
const intrinsic = ({ ready: _ready, blockedBy: _blockedBy, ...detail }: TaskDetail): TaskIntrinsicDetail => detail;
export const detailByteSize = (detail: TaskIntrinsicDetail): number => new TextEncoder().encode(stringifyApiJson(detail)).byteLength;
export const materializeDetail = (detail: TaskIntrinsicDetail, node: GraphTask): TaskDetail => ({ ...detail, ready: node.ready, blockedBy: node.blockedBy });
const summaryOf = (detail: TaskIntrinsicDetail): TaskSummary => {
  const { projectId: _projectId, title, description: _description, properties: _properties, ...summary } = detail;
  const characters = Array.from(title);
  return { ...summary, titlePreview: characters.slice(0, 160).join(""), titleTruncated: characters.length > 160 };
};
const sameIntrinsicDetail = (left: TaskIntrinsicDetail, right: TaskIntrinsicDetail): boolean =>
  left.projectId === right.projectId && left.title === right.title && left.description === right.description &&
  JSON.stringify(left.properties) === JSON.stringify(right.properties) && sameSummary(summaryOf(left), summaryOf(right));

const validateRecord = (value: DetailRecord, ticket: SyncTicket, manifest: ProjectRecord, summaries: ReadonlyMap<string, TaskSummary>): DetailRecord => {
  try {
    if (value.userId !== ticket.userId || value.projectId !== ticket.projectId || value.taskId !== value.detail.id ||
      value.userFence !== manifest.userFence || value.cacheGeneration !== manifest.cacheGeneration ||
      !Number.isSafeInteger(value.lastUsedAt) || value.lastUsedAt < 0 || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 ||
      Object.hasOwn(value.detail, "ready") || Object.hasOwn(value.detail, "blockedBy")) throw new Error("Invalid detail cache record.");
    const detail = intrinsic(parseTaskDetail({ ...value.detail, ready: false, blockedBy: [] }, ticket.projectId, value.taskId));
    const summary = summaries.get(value.taskId);
    if (summary === undefined || !sameSummary(summary, summaryOf(detail)) || value.byteSize !== detailByteSize(detail) || value.byteSize > DETAIL_CACHE_LIMITS.recordBytes) throw new Error("Invalid detail cache content.");
    return { ...value, detail };
  } catch (error) { throw new TaskCacheError("corrupt", error); }
};
export const validateDetailSummary = (detail: TaskIntrinsicDetail, summary: TaskSummary): void => {
  if (!sameSummary(summary, summaryOf(detail))) throw new ApiError("protocol");
};

export type DetailAdmission = { readonly kind: "matching"; readonly detail: TaskIntrinsicDetail } | { readonly kind: "older" } | { readonly kind: "newer" };

const withDetailRecovery = async <T,>(scope: TaskCacheScope, ticket: SyncTicket, signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof TaskCacheError) || error.category !== "corrupt") throw error;
    await scope.detailTransaction(ticket, signal, async (store) => {
      for await (const cursor of store.index("by-project").iterate([scope.userId, ticket.projectId])) await cursor.delete();
    });
    throw error;
  }
};

export const readCachedDetail = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<TaskIntrinsicDetail | null> =>
  withDetailRecovery(scope, ticket, signal, () => scope.detailTransaction(ticket, signal, async (store, manifest, summaries) => {
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return null;
    const record = validateRecord(row, ticket, manifest, summaries);
    await store.put({ ...record, lastUsedAt: Date.now() });
    return record.detail;
  }));

export const saveDetail = async (scope: TaskCacheScope, ticket: SyncTicket, detail: TaskDetail, signal: AbortSignal): Promise<DetailAdmission> => {
  const body = intrinsic(parseTaskDetail(detail, ticket.projectId, detail.id));
  const byteSize = detailByteSize(body);
  return withDetailRecovery(scope, ticket, signal, () => scope.detailTransaction(ticket, signal, async (store, manifest, summaries) => {
    const summary = summaries.get(detail.id);
    if (summary === undefined) return { kind: "newer" };
    if (detail.version < summary.version) return { kind: "older" };
    if (detail.version > summary.version) return { kind: "newer" };
    validateDetailSummary(body, summary);
    const rows = (await store.index("by-project").getAll([scope.userId, ticket.projectId]))
      .map((row) => validateRecord(row, ticket, manifest, summaries));
    if (rows.length > DETAIL_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > DETAIL_CACHE_LIMITS.totalBytes) throw new TaskCacheError("corrupt");
    const previous = rows.find((row) => row.taskId === detail.id);
    if (previous !== undefined && !sameIntrinsicDetail(previous.detail, body)) throw new ApiError("protocol");
    if (byteSize > DETAIL_CACHE_LIMITS.recordBytes) {
      if (previous !== undefined) await store.delete([scope.userId, ticket.projectId, detail.id]);
      return { kind: "matching", detail: body };
    }
    if (previous !== undefined) return { kind: "matching", detail: previous.detail };
    const others = rows.filter((row) => row.taskId !== detail.id).sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.taskId.localeCompare(right.taskId));
    let count = others.length + 1;
    let bytes = others.reduce((sum, row) => sum + row.byteSize, byteSize);
    for (const row of others) {
      if (count <= DETAIL_CACHE_LIMITS.records && bytes <= DETAIL_CACHE_LIMITS.totalBytes) break;
      await store.delete([scope.userId, ticket.projectId, row.taskId]); count--; bytes -= row.byteSize;
    }
    await store.put({ userId: scope.userId, projectId: ticket.projectId, taskId: detail.id,
      userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, detail: body, byteSize, lastUsedAt: Date.now() });
    return { kind: "matching", detail: body };
  }));
};
