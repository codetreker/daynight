export const taskStatuses = ["proposed", "todo", "in_progress", "done", "cancelled"] as const;
export const taskCreationStatuses = ["proposed", "todo"] as const;
export type TaskCreationStatus = (typeof taskCreationStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];

export const isTaskStatus = (value: unknown): value is TaskStatus => taskStatuses.some((status) => status === value);
export const isTaskCreationStatus = (value: unknown): value is TaskCreationStatus => taskCreationStatuses.some((status) => status === value);
export const isTerminalTaskStatus = (status: TaskStatus): boolean => status === "done" || status === "cancelled";
export const requiresSatisfiedPrerequisites = (status: TaskStatus): boolean => status === "in_progress" || status === "done";
