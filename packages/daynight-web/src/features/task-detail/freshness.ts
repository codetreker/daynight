import type { GraphTask, TaskDetail } from "../../api/types";
import { compareTimestamps } from "../task-cache/projection";

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

const sameTime = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : compareTimestamps(left, right) === 0;

export const isTaskStale = (snapshotNode: GraphTask | undefined, detail: TaskDetail): boolean => {
  if (snapshotNode === undefined) return true;
  const title = Array.from(detail.title);
  return snapshotNode.id !== detail.id || !sameTime(snapshotNode.updatedAt, detail.updatedAt) || !sameTime(snapshotNode.createdAt, detail.createdAt) ||
    !sameTime(snapshotNode.startedAt, detail.startedAt) || !sameTime(snapshotNode.completedAt, detail.completedAt) || snapshotNode.status !== detail.status ||
    snapshotNode.allowAgents !== detail.allowAgents || snapshotNode.requiredPlatform !== detail.requiredPlatform || snapshotNode.ready !== detail.ready || !sameIds(snapshotNode.dependsOn, detail.dependsOn) ||
    snapshotNode.workerNeedsAttention !== (detail.properties.worker !== null && detail.properties.worker.signaling !== "") ||
    !sameIds(snapshotNode.externalDependsOn, detail.externalDependsOn) ||
    !sameIds(snapshotNode.blockedBy, detail.blockedBy) || snapshotNode.titlePreview !== title.slice(0, 160).join("") ||
    snapshotNode.titleTruncated !== (title.length > 160);
};

export const taskDescriptor = (task: GraphTask | undefined): string => task === undefined ? "" : JSON.stringify([
  task.id, task.updatedAt, task.status, task.ready, task.allowAgents, task.requiredPlatform, task.workerNeedsAttention, [...task.dependsOn].sort(), [...task.externalDependsOn].sort(), [...task.blockedBy].sort(), task.titlePreview, task.titleTruncated,
]);

export const taskReviewKey = (detail: TaskDetail): string => JSON.stringify([
  detail.projectId, detail.id, detail.version.toString(), detail.status, detail.title, detail.updatedAt,
  detail.ready, detail.allowAgents, detail.requiredPlatform, [...detail.dependsOn].sort(), [...detail.externalDependsOn].sort(), [...detail.blockedBy].sort(),
]);
