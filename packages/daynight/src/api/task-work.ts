import type { SessionAggregation, SessionIndicator, TaskSessionSend } from "./task-observation.js";
import { choice, nullable, parseSessionAggregation, parseTaskSessionSend, sessionIndicator } from "./task-observation.js";
import { array, bool, count, fields, id, malformed, text, timestamp } from "./validation.js";

export type TaskWorkQuery = { readonly assignedTo?: string; readonly limit?: number; readonly cursor?: string; readonly groupId?: string; readonly targetsCursor?: string };
export type TaskWorkRoot = { readonly taskId: string; readonly titlePreview: string; readonly titleTruncated: boolean };
export type TaskWorkTarget = { readonly taskId: string; readonly assignedTo: string | null; readonly matchesAssignee: boolean; readonly sessionId: string | null; readonly indicator: SessionIndicator; readonly reason: string; readonly send: TaskSessionSend };
export type TaskWorkGroup = {
  readonly groupId: string;
  readonly kind: "chain" | "task";
  readonly displayTaskId: string;
  readonly titlePreview: string;
  readonly titleTruncated: boolean;
  readonly assignedTo: string;
  readonly aggregationScope: "accessible_in_progress_members";
  readonly memberCount: number;
  readonly matchedCount: number;
  readonly inProgressCount: number;
  readonly rootCount: number;
  readonly roots: readonly TaskWorkRoot[];
  readonly rootsTruncated: boolean;
  readonly summary: SessionAggregation;
  readonly targets: readonly TaskWorkTarget[];
  readonly contributorCursor: string | null;
  readonly observedAt: string;
};
export type TaskWorkPage = { readonly groups: readonly TaskWorkGroup[]; readonly nextCursor: string | null; readonly observedAt: string; readonly partial: boolean };

const cursor = (value: unknown): string | null => nullable(value, item => text(item, true));
const title = (data: Record<string, unknown>): Pick<TaskWorkRoot, "titlePreview" | "titleTruncated"> => {
  const titlePreview = text(data.titlePreview, true), titleTruncated = bool(data.titleTruncated);
  if (Array.from(titlePreview).length > 160) return malformed();
  return { titlePreview, titleTruncated };
};
const parseGroup = (value: unknown, assignedTo: string): TaskWorkGroup => {
  const data = fields(value, ["groupId", "kind", "displayTaskId", "titlePreview", "titleTruncated", "assignedTo", "aggregationScope", "memberCount", "matchedCount", "inProgressCount", "rootCount", "roots", "rootsTruncated", "summary", "targets", "contributorCursor", "observedAt"]);
  const roots = array(data.roots, value => { const root = fields(value, ["taskId", "titlePreview", "titleTruncated"]); return { taskId: id(root.taskId), ...title(root) }; });
  const targets = array(data.targets, value => {
    const target = fields(value, ["taskId", "assignedTo", "matchesAssignee", "sessionId", "indicator", "reason", "send"]);
    const result = { taskId: id(target.taskId), assignedTo: nullable(target.assignedTo, id), matchesAssignee: bool(target.matchesAssignee), sessionId: nullable(target.sessionId, id), indicator: sessionIndicator(target.indicator), reason: text(target.reason, true), send: parseTaskSessionSend(target.send) };
    if (result.matchesAssignee !== (result.assignedTo === assignedTo)) return malformed();
    return result;
  });
  const result: TaskWorkGroup = {
    groupId: id(data.groupId), kind: choice(data.kind, ["chain", "task"]), displayTaskId: id(data.displayTaskId), ...title(data), assignedTo: id(data.assignedTo),
    aggregationScope: choice(data.aggregationScope, ["accessible_in_progress_members"]), memberCount: count(data.memberCount), matchedCount: count(data.matchedCount),
    inProgressCount: count(data.inProgressCount), rootCount: count(data.rootCount), roots, rootsTruncated: bool(data.rootsTruncated), summary: parseSessionAggregation(data.summary),
    targets, contributorCursor: cursor(data.contributorCursor), observedAt: timestamp(data.observedAt),
  };
  if (result.assignedTo !== assignedTo || result.matchedCount === 0 || result.matchedCount > result.inProgressCount || result.inProgressCount > result.memberCount
    || result.rootCount > result.memberCount || roots.length > 5 || roots.length > result.rootCount || new Set(roots.map(root => root.taskId)).size !== roots.length
    || targets.length > 20 || targets.length > result.inProgressCount || targets.some((target, index) => index > 0 && targets[index - 1]!.taskId >= target.taskId)) return malformed();
  return result;
};
export const parseTaskWorkPage = (value: unknown, assignedTo: string, limit: number, groupId?: string): TaskWorkPage => {
  const data = fields(value, ["groups", "nextCursor", "observedAt", "partial"]);
  const groups = array(data.groups, group => parseGroup(group, assignedTo));
  const nextCursor = cursor(data.nextCursor);
  if (groups.length > limit || new Set(groups.map(group => group.groupId)).size !== groups.length || nextCursor !== null && groups.length === 0
    || groupId !== undefined && (groups.length !== 1 || groups[0]!.groupId !== groupId || nextCursor !== null)) return malformed();
  return { groups, nextCursor, observedAt: timestamp(data.observedAt), partial: bool(data.partial) };
};
