import type { GraphTask, TaskGraph, TaskStatus } from "../src/api/types";

const id = (letter: string): string => `00000000-0000-0000-0000-${letter.charCodeAt(0).toString(16).padStart(12, "0")}`;
const time = "2026-10-20T00:00:00.123456Z";
type Seed = { readonly id: string; readonly status?: TaskStatus; readonly dependsOn?: readonly string[]; readonly externalDependsOn?: readonly string[] };
export const graph = (seeds: readonly Seed[]): TaskGraph => {
  const tasks: GraphTask[] = seeds.map((seed) => {
    const dependsOn = seed.dependsOn ?? [];
    const status = seed.status ?? "todo";
    const blockedBy = dependsOn.filter((predecessor) => seeds.find((item) => item.id === predecessor)?.status !== "done" && seeds.find((item) => item.id === predecessor)?.status !== "cancelled");
    return { assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null, cancelledAt: status === "cancelled" ? time : null,
      id: seed.id, type: "task", parentId: null, status, dependsOn, blockedBy, ready: status === "todo" && blockedBy.length === 0,
      titlePreview: "Private task text", titleTruncated: false, createdAt: time, updatedAt: time,
    };
  });
  const todo = tasks.filter((task) => task.status === "todo");
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: id("P"), name: "Private project", repoUrl: "git@github.com:owner/repo.git", createdAt: time, updatedAt: time },
    tasks,
    summary: { proposed: tasks.filter((task) => task.status === "proposed").length,
      total: tasks.length, todo: todo.length, inProgress: tasks.filter((task) => task.status === "in_progress").length,
      done: tasks.filter((task) => task.status === "done").length, cancelled: tasks.filter((task) => task.status === "cancelled").length,
      ready: todo.filter((task) => task.ready).length, blocked: todo.filter((task) => !task.ready).length,
    },
  };
};
