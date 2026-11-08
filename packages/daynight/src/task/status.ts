export const taskStatuses = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const isTaskStatus = (value: unknown): value is TaskStatus => taskStatuses.some((status) => status === value);
export const isTerminalTaskStatus = (status: TaskStatus): boolean => status === "done" || status === "cancelled";
export const requiresSatisfiedPrerequisites = (status: TaskStatus): boolean => status === "in_progress" || status === "done";
