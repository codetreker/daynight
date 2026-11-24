import { expect, it } from "vitest";
import { validateProjectManifest, validateUserScope } from "../src/features/task-cache/lifecycle";

const userId = "10000000-0000-0000-0000-000000000001";
const projectId = "20000000-0000-0000-0000-000000000001";
const userFence = "30000000-0000-0000-0000-000000000001";
const cacheGeneration = "40000000-0000-0000-0000-000000000001";
const time = "2026-10-20T12:00:00.123456789Z";
const project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: "Project", repoUrl: "https://example.test/repo", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const invalidated = { userId, projectId, userFence, cacheGeneration, syncRevision: cacheGeneration, state: "invalidated", invalidatedBy: "corrupt", epoch: null, project: null, coverageUpdatedAt: null, taskCount: 0, edgeCount: 0 };
const active = { ...invalidated, state: "active", invalidatedBy: null, epoch: cacheGeneration, project, coverageUpdatedAt: time, taskCount: 1 };

it.each([undefined, null, "bad", { userId, userFence: null }, { userId, userFence: "" }, { userId: projectId, userFence }, { userId, userFence: "ABCDEF00-0000-0000-0000-000000000001" }])("rejects malformed user lifecycle values %#", (value) => {
  expect(() => validateUserScope(value, userId)).toThrow(expect.objectContaining({ category: "corrupt" }));
});
it("accepts canonical persisted user identities", () => expect(validateUserScope({ userId, userFence }, userId)).toEqual({ userId, userFence }));
it.each([
  { userId: projectId }, { projectId: userId }, { userFence: cacheGeneration }, { cacheGeneration: "" }, { cacheGeneration: null }, { syncRevision: undefined }, { syncRevision: null }, { syncRevision: "bad" },
  { invalidatedBy: null }, { invalidatedBy: "unknown" }, { epoch: cacheGeneration }, { epoch: undefined }, { project }, { coverageUpdatedAt: time },
  { rebuildRevision: cacheGeneration },
  { taskCount: 1 }, { edgeCount: 1 }, { taskCount: "0" }, { taskCount: 0.1 }, { edgeCount: -1 }, { state: "unknown" },
])("rejects incomplete or contradictory invalidated baselines %#", (change) => {
  expect(() => validateProjectManifest({ ...invalidated, ...change }, userId, projectId, userFence)).toThrow(expect.objectContaining({ category: "corrupt" }));
});
it.each([
  { invalidatedBy: "corrupt" }, { epoch: null }, { project: null }, { project: { ...project, id: userId } },
  { taskCount: Number.MAX_SAFE_INTEGER + 1 }, { edgeCount: 0.1 }, { coverageUpdatedAt: null }, { coverageUpdatedAt: "bad" }, { coverageUpdatedAt: "0000-01-01T00:00:00Z" },
  { rebuildRevision: null }, { rebuildRevision: "bad" },
])("rejects malformed active lifecycle metadata %#", (change) => {
  expect(() => validateProjectManifest({ ...active, ...change }, userId, projectId, userFence)).toThrow(expect.objectContaining({ category: "corrupt" }));
});
it("preserves complete active and invalidated manifest contracts", () => {
  expect(validateProjectManifest(invalidated, userId, projectId, userFence)).toEqual(invalidated);
  const complete = { ...active, taskCount: 1001, edgeCount: 5001 };
  expect(validateProjectManifest(complete, userId, projectId, userFence)).toEqual(complete);
  expect(validateProjectManifest({ ...active, taskCount: 0, coverageUpdatedAt: null }, userId, projectId, userFence).coverageUpdatedAt).toBeNull();
  expect(validateProjectManifest({ ...active, taskCount: 0 }, userId, projectId, userFence).coverageUpdatedAt).toBe(time);
  expect(validateProjectManifest({ ...active, rebuildRevision: cacheGeneration }, userId, projectId, userFence).rebuildRevision).toBe(cacheGeneration);
});
