import { describe, expect, it } from "vitest";
import type { Project, TaskSummary } from "../src/api/types";
import { compareTimestamps, maxUpdatedAt, projectSummaries, sameProject, sameSummary } from "../src/features/task-cache/projection";
import { GraphDataError, projectChain } from "../src/features/task-graph/model";

const id = (value: number) => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
const time = "2026-10-20T12:00:00Z";
const project: Project = { id: id(100), name: "Project", repoUrl: "git@example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ id: id(n), version: 1n, titlePreview: `Task ${n}`, titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, ...changes });

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
  const projection = projectSummaries(project, tasks, time);
  expect(projection.graph.tasks.map((row) => row.id)).toEqual([id(3), id(4), id(1), id(2)]);
  expect(projection.graph.tasks.find((row) => row.id === id(3))).toMatchObject({ blockedBy: [id(2)], ready: false });
  expect(projection.graph.summary).toEqual({ total: 4, todo: 3, inProgress: 0, done: 1, ready: 2, blocked: 1 });
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
    [task(1), task(1)], [task(1, { dependsOn: [id(2)] })],
    [task(1, { dependsOn: [id(1)] })], [task(1, { dependsOn: [id(2)] }), task(2, { dependsOn: [id(1)] })],
    [task(1), task(2, { status: "in_progress", dependsOn: [id(1)] })],
    [task(1, { dependsOn: [id(2)], externalDependsOn: [id(3)] }), task(2)],
  ])("rejects incomplete or inconsistent full facts %#", (...tasks) => expect(() => projectSummaries(project, tasks, time)).toThrow(GraphDataError));
  it("enforces the full node capacity and supports empty projects", () => {
    expect(() => projectSummaries(project, Array.from({ length: 1001 }, (_, n) => task(n + 1)), time)).toThrow(GraphDataError);
    expect(projectSummaries(project, [], time).graph.summary.total).toBe(0);
  });
});

it("compares intrinsic facts including versions and preserves semantically equal time formats", () => {
  const original = task(1);
  expect(sameSummary(original, { ...original, createdAt: `${time.slice(0, -1)}.000Z` })).toBe(true);
  expect(sameSummary(original, task(1, { version: 2n }))).toBe(false);
  expect(sameSummary(original, task(1, { allowAgents: false }))).toBe(false);
  expect(sameSummary(original, task(1, { dependsOn: [id(2)] }))).toBe(false);
  expect(sameSummary(original, task(1, { startedAt: time }))).toBe(false);
  expect(sameProject(project, { ...project })).toBe(true);
  expect(sameProject(project, { ...project, settings: { ...project.settings, version: 2n } })).toBe(false);
});
