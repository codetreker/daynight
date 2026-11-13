import { describe, expect, it } from "vitest";
import type { Project, TaskDependencyState, TaskSummary } from "../src/api/types";
import { compareTimestamps, maxUpdatedAt, projectSummaries, sameProject, sameSummary } from "../src/features/task-cache/projection";
import { GraphDataError, projectChain } from "../src/features/task-graph/model";

const id = (value: number) => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
const time = "2026-10-20T12:00:00Z";
const project: Project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: id(100), name: "Project", repoUrl: "git@example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ type: "task", parentId: null, assignedTo: null, id: id(n), version: 1n, properties: {}, tags: [], titlePreview: `Task ${n}`, titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes });
const projectTasks = (owner: Project, tasks: readonly TaskSummary[], observedAt: string) => {
  const states = new Map<string, TaskDependencyState>();
  for (const task of tasks) {
    if (task.type !== "task") continue;
    const blockedBy = task.dependsOn.filter((dependency) => !["done", "cancelled"].includes(tasks.find((item) => item.id === dependency)?.status ?? ""));
    states.set(task.id, { taskVersion: task.version, blockedBy, ready: task.status === "todo" && blockedBy.length === 0 });
  }
  return projectSummaries(owner, tasks, states, observedAt);
};

it("orders UTC seconds and padded nanoseconds without rounding or lexical fraction errors", () => {
  expect(compareTimestamps(`${time.slice(0, -1)}.1Z`, `${time.slice(0, -1)}.100000000Z`)).toBe(0);
  expect(compareTimestamps(time, `${time.slice(0, -1)}.000000001Z`)).toBeLessThan(0);
  expect(compareTimestamps(`${time.slice(0, -1)}.123456788Z`, `${time.slice(0, -1)}.123456789Z`)).toBeLessThan(0);
  expect(compareTimestamps("2026-10-20T12:00:01Z", `${time.slice(0, -1)}.999999999Z`)).toBeGreaterThan(0);
  expect(maxUpdatedAt([])).toBeNull();
  const precise = `${time.slice(0, -1)}.123456789Z`;
  expect(maxUpdatedAt([task(1), task(2, { updatedAt: precise }), task(3)])).toBe(precise);
});

it("derives complete dependency blocking, ordinary chains, all counts and precise stable ordering", () => {
  const tasks = [task(3, { dependsOn: [id(1), id(2)], externalDependsOn: [id(2)] }),
    task(2, { createdAt: `${time.slice(0, -1)}.000000002Z`, requiredPlatform: "linux" }),
    task(1, { createdAt: `${time.slice(0, -1)}.000000001Z`, status: "done", completedAt: time }), task(4)];
  const projection = projectTasks(project, tasks, time);
  expect(projection.graph.tasks.map((row) => row.id)).toEqual([id(3), id(4), id(1), id(2)]);
  expect(projection.graph.tasks.find((row) => row.id === id(3))).toMatchObject({ blockedBy: [id(2)], ready: false });
  expect(projection.graph.summary).toEqual({ proposed: 0, total: 4, todo: 3, inProgress: 0, done: 1, cancelled: 0, ready: 2, blocked: 1 });
  expect(projection.versions.get(id(1))).toBe(1n);
  expect(projection.graph.tasks[0]).not.toHaveProperty("version");
  expect(projection.index.componentByTask.get(id(3))).toBe(id(1));
  expect(projection.index.componentByTask.get(id(2))).toBe(id(2));
  const chain = projectChain(projection.index, id(1));
  expect(chain.externalIds).toEqual(new Set([id(2)]));
  expect(chain.edges.find((edge) => edge.source === id(2))?.external).toBe(true);
});

describe("graph validation", () => {
  it.each([
    [task(1), task(1)],
    [task(1, { dependsOn: [id(1)] })],
    [task(1), task(2, { status: "in_progress", dependsOn: [id(1)] })],
    [task(1, { dependsOn: [id(2)], externalDependsOn: [id(3)] }), task(2)],
  ])("rejects inconsistent full facts %#", (...tasks) => expect(() => projectTasks(project, tasks, time)).toThrow(GraphDataError));
  it("projects complete task collections and supports empty projects", () => {
    expect(projectTasks(project, Array.from({ length: 1001 }, (_, n) => task(n + 1)), time).graph.summary.total).toBe(1001);
    expect(projectTasks(project, [], time).graph.summary.total).toBe(0);
  });
});

it("compares intrinsic facts including versions and preserves semantically equal time formats", () => {
  const original = task(1);
  expect(sameSummary(original, { ...original, createdAt: `${time.slice(0, -1)}.000Z` })).toBe(true);
  expect(sameSummary(original, task(1, { version: 2n }))).toBe(false);
  expect(sameSummary(original, task(1, { allowAgents: false }))).toBe(false);
  expect(sameSummary(original, task(1, { dependsOn: [id(2)] }))).toBe(false);
  expect(sameSummary(original, task(1, { parentId: id(2) }))).toBe(false);
  expect(sameSummary(original, task(1, { type: "goal" }))).toBe(false);
  expect(sameSummary(original, task(1, { startedAt: time }))).toBe(false);
  expect(sameProject(project, { ...project })).toBe(true);
  expect(sameProject(project, { ...project, settings: { ...project.settings, version: 2n } })).toBe(false);
});

it("uses authoritative dependency states for hidden prerequisites and excludes Goals from the graph", () => {
  const goal = task(1, { type: "goal", allowAgents: false });
  const satisfied = task(2, { parentId: goal.id, dependsOn: [id(20)] });
  const blocked = task(3, { dependsOn: [id(21)], externalDependsOn: [id(21)] });
  const states = new Map<string, TaskDependencyState>([
    [satisfied.id, { taskVersion: 1n, blockedBy: [], ready: true }],
    [blocked.id, { taskVersion: 1n, blockedBy: [id(21)], ready: false }],
  ]);
  const result = projectSummaries(project, [goal, satisfied, blocked], states, time);
  expect(result.graph.summary).toMatchObject({ total: 2, ready: 1, blocked: 1 });
  expect(result.index.nodes.has(goal.id)).toBe(false);
  expect(result.index.nodes.get(satisfied.id)).toMatchObject({ parentId: goal.id, ready: true, blockedBy: [] });
  expect(result.index.nodes.get(blocked.id)).toMatchObject({ ready: false, blockedBy: [id(21)] });
  expect(result.versions.get(goal.id)).toBe(1n);
  expect(projectChain(result.index, blocked.id).edges).toEqual([]);
  expect(() => projectSummaries(project, [satisfied], new Map(), time)).toThrow(GraphDataError);
  expect(() => projectSummaries(project, [satisfied], new Map([[satisfied.id, { taskVersion: 2n, blockedBy: [], ready: true }]]), time)).toThrow(GraphDataError);
});

it("compares complete property values while keeping properties out of graph nodes", () => {
  const left = task(1, { properties: { future: { version: 42, first: 1, second: ["a", "b"] }, pullRequests: [] } });
  const reordered = task(1, { properties: { pullRequests: [], future: { second: ["a", "b"], first: 1, version: 42 } } });
  expect(sameSummary(left, reordered)).toBe(true);
  expect(sameSummary(task(1), task(1, { properties: { pullRequests: [] } }))).toBe(false);
  expect(sameSummary(task(1), task(1, { properties: { future: null } }))).toBe(false);
  expect(sameSummary(left, task(1, { properties: { ...left.properties, future: { version: 42, first: 1, second: ["b", "a"] } } }))).toBe(false);
  const projection = projectTasks(project, [left], time);
  expect(projection.graph.tasks[0]).not.toHaveProperty("properties");
  expect(projection.index.nodes.get(left.id)).not.toHaveProperty("properties");
  expect(left.properties).toHaveProperty("future", { version: 42, first: 1, second: ["a", "b"] });
});

it("compares tag identities and names without adding them to graph nodes", () => {
  const first = { id: id(10), name: "One" }, second = { id: id(11), name: "Two" };
  const original = task(1, { tags: [first, second] });
  expect(sameSummary(original, task(1, { tags: [second, first] }))).toBe(true);
  expect(sameSummary(original, task(1, { tags: [{ ...first, name: "Renamed" }, second] }))).toBe(false);
  expect(sameSummary(original, task(1, { tags: [first] }))).toBe(false);
  const projection = projectTasks(project, [original], time);
  expect(projection.graph.tasks[0]).not.toHaveProperty("tags");
  expect(projection.index.nodes.get(original.id)).not.toHaveProperty("tags");
});

it("satisfies both edge kinds from cancelled predecessors without requiring the cancelled task's own inputs", () => {
  const cancelled = task(2, { status: "cancelled", cancelledAt: time, dependsOn: [id(1)] });
  const projection = projectTasks(project, [task(1), cancelled, task(3, { dependsOn: [id(2)] }), task(4, { dependsOn: [id(2)], externalDependsOn: [id(2)] })], time);
  expect(projection.graph.tasks.find((row) => row.id === id(2))).toMatchObject({ blockedBy: [id(1)], ready: false });
  for (const n of [3, 4]) expect(projection.graph.tasks.find((row) => row.id === id(n))).toMatchObject({ blockedBy: [], ready: true });
  expect(projection.graph.summary).toEqual({ proposed: 0, total: 4, todo: 3, inProgress: 0, done: 0, cancelled: 1, ready: 3, blocked: 0 });
  expect(projection.index.components.get(id(1))!.progress).toEqual({ total: 3, done: 0, cancelled: 1, ended: 1, status: "in_progress" });
  expect(projection.index.components.get(id(4))!.progress.total).toBe(1);
  expect(sameSummary(cancelled, { ...cancelled, cancelledAt: "2026-10-20T12:00:00.000000001Z" })).toBe(false);
});


it("counts proposed separately and keeps both dependency kinds blocked until confirmation and completion", () => {
  const projection = projectTasks(project, [task(1, { status: "proposed" }), task(2, { status: "proposed", dependsOn: [id(1)] }),
    task(3, { dependsOn: [id(1)] }), task(4, { dependsOn: [id(1)], externalDependsOn: [id(1)] })], time);
  expect(projection.graph.summary).toEqual({ total: 4, proposed: 2, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 2 });
  expect(projection.graph.tasks[0]).toMatchObject({ status: "proposed", ready: false, blockedBy: [] });
  expect(projection.graph.tasks[1]).toMatchObject({ status: "proposed", ready: false, blockedBy: [id(1)] });
  for (const n of [3, 4]) expect(projection.graph.tasks.find((row) => row.id === id(n))).toMatchObject({ ready: false, blockedBy: [id(1)] });
  expect(projection.index.components.get(id(1))!.progress).toMatchObject({ total: 3, done: 0, ended: 0, status: "todo" });
});
