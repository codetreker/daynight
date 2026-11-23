import type { TaskStatus } from "../../api/types";

export const ALL_TASK_STATUSES: readonly TaskStatus[] = ["proposed", "todo", "in_progress", "done", "cancelled"];

export const normalizeTaskStatuses = (statuses: readonly TaskStatus[]): readonly TaskStatus[] =>
  ALL_TASK_STATUSES.filter((status) => statuses.includes(status));

export const equalTaskStatuses = (left: readonly TaskStatus[], right: readonly TaskStatus[]): boolean =>
  left.length === right.length && left.every((status) => right.includes(status));

export const matchesTaskStatus = (statuses: readonly TaskStatus[], status: TaskStatus): boolean => statuses.includes(status);

export const decodeTaskStatuses = (value: unknown): readonly TaskStatus[] => {
  if (!Array.isArray(value) || value.some((status) => !ALL_TASK_STATUSES.includes(status)) || new Set(value).size !== value.length) {
    throw new Error("Invalid task status filter preference.");
  }
  return normalizeTaskStatuses(value);
};
