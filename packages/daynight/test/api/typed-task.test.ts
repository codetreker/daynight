import { describe, expect, it } from "vitest";
import { parseTask, parseTaskGraph, parseTaskSearchPage } from "../../src/api/parse.js";
import { parseObservedTask, taskObservationPartial } from "../../src/api/task-observation.js";
import { renderTaskGraphDependencies } from "../../src/commands/task/rendering.js";
import { observation, projectId, task, taskId, time } from "../fixtures/task-observation.js";

const otherId = "99999999-9999-4999-8999-999999999999";
const goal = { ...task, type: "goal", parentId: null, status: "todo", ready: false, allowAgents: false, requiredPlatform: null, properties: {}, startedAt: null, progress: { total: 3, done: 1, cancelled: 1, unfinished: 1 } };
const ordinary = { ...task, type: "task", parentId: otherId };

describe("typed Task reads", () => {
  it("retains Goal progress and a not-applicable observation without a partial failure", () => {
    const session = { ...observation, observation: "observed", registration: "not_applicable", error: null };
    const parsed = parseObservedTask({ ...goal, session }, projectId, taskId);
    expect(parsed).toMatchObject({ type: "goal", parentId: null, ready: false, progress: goal.progress });
    expect(taskObservationPartial(parsed.session)).toBe(false);
    expect(parseTask(ordinary, projectId).parentId).toBe(otherId);
  });

  it.each([
    { type: undefined }, { type: "other" }, { parentId: undefined }, { parentId: "bad" },
    { type: "goal", parentId: otherId }, { status: "proposed" }, { ready: true },
    { allowAgents: true }, { requiredPlatform: "linux" }, { dependsOn: [otherId] },
    { progress: undefined }, { progress: { total: 3, done: 2, cancelled: 1, unfinished: 1 } },
  ])("rejects malformed Goal resources %#", changes => {
    expect(() => parseTask({ ...goal, ...changes }, projectId)).toThrow("invalid response");
  });

  it("keeps ordinary readiness rules and refuses ordinary progress", () => {
    expect(() => parseTask({ ...ordinary, status: "todo", ready: false }, projectId)).toThrow("invalid response");
    expect(() => parseTask({ ...ordinary, progress: goal.progress }, projectId)).toThrow("invalid response");
    expect(parseTask({ ...ordinary, status: "proposed", ready: false }, projectId).status).toBe("proposed");
  });

  it("validates typed search items without expanding their projection", () => {
    const item = { id: taskId, type: "task", parentId: otherId, projectId, title: "Task", status: "todo", cancelledAt: null, tags: [], assignedTo: null, updatedAt: time, context: null, match: { fields: ["title"], descriptionSnippet: null } };
    const page = { projectId, total: 1, items: [item], nextCursor: null };
    expect(parseTaskSearchPage(page, projectId).items[0]).toMatchObject({ type: "task", parentId: otherId });
    expect(() => parseTaskSearchPage({ ...page, items: [{ ...item, type: undefined }] }, projectId)).toThrow("invalid response");
  });
});

describe("typed Task graph", () => {
  const project = { id: projectId, name: "Project", repoUrl: "https://example.test/repo", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: otherId, version: 1n }, createdAt: time, updatedAt: time };
  const node = { id: taskId, type: "task", parentId: null, titlePreview: "Task", titleTruncated: false, status: "todo", allowAgents: false, requiredPlatform: null, assignedTo: null, startedAt: null, completedAt: null, cancelledAt: null, dependsOn: [otherId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false, createdAt: time, updatedAt: time };
  const graph = { project, observedAt: time, tasks: [node], summary: { total: 1, proposed: 0, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 1 } };
  it("retains a hidden prerequisite ID without inventing a graph node", () => {
    const parsed = parseTaskGraph(graph, projectId, taskId);
    expect(parsed.tasks).toEqual([node]);
    expect(JSON.parse(renderTaskGraphDependencies(parsed, true))).toEqual([{ id: taskId, dependsOn: [otherId], externalDependsOn: [otherId] }]);
    expect(parseTaskGraph({ ...graph, tasks: [{ ...node, externalDependsOn: [] }] }, projectId, taskId).tasks[0]?.dependsOn).toEqual([otherId]);
  });
  it("rejects Goal graph nodes", () => {
    expect(() => parseTaskGraph({ ...graph, tasks: [{ ...node, type: "goal", dependsOn: [], externalDependsOn: [], blockedBy: [] }] }, projectId, taskId)).toThrow("invalid response");
  });
});
