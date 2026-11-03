import type { GraphTask, TaskGraph, TaskStatus } from "../src/api/types";

const id = (letter: string): string => `00000000-0000-0000-0000-${letter.charCodeAt(0).toString(16).padStart(12, "0")}`;
const time = "2026-10-20T00:00:00.123456Z";
type Seed = { readonly id: string; readonly status?: TaskStatus; readonly dependsOn?: readonly string[]; readonly externalDependsOn?: readonly string[] };
export const graph = (seeds: readonly Seed[]): TaskGraph => {
  const tasks: GraphTask[] = seeds.map((seed) => {
    const dependsOn = seed.dependsOn ?? [];
    const status = seed.status ?? "todo";
    const blockedBy = dependsOn.filter((predecessor) => seeds.find((item) => item.id === predecessor)?.status !== "done");
    return { requiredPlatform: null, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null,
      id: seed.id, status, dependsOn, blockedBy, ready: status === "todo" && blockedBy.length === 0,
      titlePreview: "Private task text", titleTruncated: false, createdAt: time, updatedAt: time,
    };
  });
  const todo = tasks.filter((task) => task.status === "todo");
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: id("P"), name: "Private project", repoUrl: "git@github.com:owner/repo.git", createdAt: time, updatedAt: time },
    tasks,
    summary: {
      total: tasks.length, todo: todo.length, inProgress: tasks.filter((task) => task.status === "in_progress").length,
      done: tasks.filter((task) => task.status === "done").length,
      ready: todo.filter((task) => task.ready).length, blocked: todo.filter((task) => !task.ready).length,
    },
  };
};

