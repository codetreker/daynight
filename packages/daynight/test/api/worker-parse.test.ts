import { describe, expect, it } from "vitest";
import { parseTask } from "../../src/api/parse.js";
import type { Task, WorkerClaim } from "../../src/api/types.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const claimId = "33333333-3333-3333-3333-333333333333";
const time = "2026-10-24T12:34:56.123456789Z";
const worker: WorkerClaim = {
  claimId, state: "active", userId: projectId, workerId: taskId, machine: { id: claimId, name: "Machine" },
  platform: "linux", agent: "codex", worktreeId: projectId, phase: "executing", herdr: { session: "w", workspaceId: "ws", paneId: "p" }, nativeSessionId: "native", claimedAt: time,
};
const task: Task = {
  id: taskId, projectId, title: "Task", description: "", status: "in_progress", allowAgents: true, requiredPlatform: null,
  version: 9_223_372_036_854_775_807n, properties: { pullRequests: [{ url: "\0", title: "\ud800" }], worker },
  startedAt: time, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
};
const malformedWorkers: unknown[] = [
  undefined, {}, [], false, { ...worker, state: "expired" }, { ...worker, claimId: "not-id" }, { ...worker, userId: "not-id" },
  { ...worker, workerId: "not-id" }, { ...worker, worktreeId: "not-id" }, { ...worker, machine: { id: claimId, name: "" } },
  { ...worker, machine: { id: "bad", name: "Machine" } }, { ...worker, machine: { ...worker.machine, unexpected: true } },
  { ...worker, platform: null }, { ...worker, platform: "win32" }, { ...worker, agent: "other" }, { ...worker, phase: "done" },
  { ...worker, herdr: {} }, { ...worker, herdr: { session: "w", workspaceId: "ws", paneId: "" } },
  { ...worker, nativeSessionId: "" }, { ...worker, claimedAt: "2026-02-30T00:00:00Z" }, { ...worker, unexpected: true },
  ...Object.keys(worker).map((key) => Object.fromEntries(Object.entries(worker).filter(([field]) => field !== key))),
];

describe("worker ownership read DTO", () => {
  it("retains protected execution metadata and opaque PR strings", () => {
    expect(parseTask(task, projectId, taskId)).toEqual(task);
    const preparing = { ...task, properties: { ...task.properties, worker: { ...worker, herdr: null, nativeSessionId: null } } };
    expect(parseTask(preparing, projectId, taskId)).toEqual(preparing);
  });
  it("preserves Go-valid non-whitespace FEFF in worker resource names", () => {
    const taskWithNames = { ...task, properties: { ...task.properties, worker: { ...worker, machine: { ...worker.machine, name: "\uFEFF" }, nativeSessionId: "\uFEFF", herdr: { session: "\uFEFF", workspaceId: "\uFEFF", paneId: "\uFEFF" } } } };
    expect(parseTask(taskWithNames, projectId, taskId)).toEqual(taskWithNames);
  });
  it("requires explicit worker null for never-claimed tasks and retains inactive history", () => {
    const neverClaimed = { ...task, properties: { ...task.properties, worker: null } };
    expect(parseTask(neverClaimed, projectId, taskId)).toEqual(neverClaimed);
    for (const status of ["todo", "in_progress", "done"] as const) {
      const historical = { ...task, status, ready: status === "todo", properties: { ...task.properties, worker: { ...worker, state: "completed" } } };
      expect(parseTask(historical, projectId, taskId)).toEqual(historical);
    }
  });
  it.each(malformedWorkers)("rejects missing or malformed protected execution metadata %#", (value) => {
    expect(() => parseTask({ ...task, properties: { ...task.properties, worker: value } }, projectId, taskId)).toThrow("invalid response");
  });
  it("rejects active ownership outside in_progress and released ownership outside todo", () => {
    expect(() => parseTask({ ...task, status: "done" }, projectId, taskId)).toThrow("invalid response");
    expect(() => parseTask({ ...task, properties: { ...task.properties, worker: { ...worker, state: "released" } } }, projectId, taskId)).toThrow("invalid response");
  });
});
