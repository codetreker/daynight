export const sceneIds = ["context", "dependencies", "evidence"] as const;
export const taskIds = ["requirements", "design", "api", "ui", "email", "verification"] as const;
export const documentIds = ["brief", "design", "acceptance"] as const;
export const receiptIds = ["acceptance", "changes", "handoff"] as const;

export type DemoSceneId = typeof sceneIds[number];
export type DemoTaskId = typeof taskIds[number];
export type DemoDocumentId = typeof documentIds[number];
export type DemoReceiptId = typeof receiptIds[number];
export type DemoTaskState = "done" | "running" | "ready" | "blocked";
type DemoTask = {
  readonly status: "todo" | "in_progress" | "done";
  readonly dependsOn: readonly DemoTaskId[];
};

export const demoTasks: Readonly<Record<DemoTaskId, DemoTask>> = {
  requirements: { status: "done", dependsOn: [] },
  design: { status: "done", dependsOn: ["requirements"] },
  api: { status: "in_progress", dependsOn: ["design"] },
  ui: { status: "todo", dependsOn: ["design"] },
  email: { status: "todo", dependsOn: ["api"] },
  verification: { status: "todo", dependsOn: ["api", "ui", "email"] },
};

export const blockedBy = (id: DemoTaskId): readonly DemoTaskId[] =>
  demoTasks[id].dependsOn.filter((prerequisite) => demoTasks[prerequisite].status !== "done");

export const taskState = (id: DemoTaskId): DemoTaskState => {
  const task = demoTasks[id];
  if (task.status === "done") return "done";
  if (task.status === "in_progress") return "running";
  return blockedBy(id).length === 0 ? "ready" : "blocked";
};
