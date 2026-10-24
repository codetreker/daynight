import { describe, expect, it } from "vitest";
import { parseTaskDetail } from "../src/api/parse";
import type { TaskDetail, WorkerClaim } from "../src/api/types";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const claimId = "33333333-3333-3333-3333-333333333333";
const time = "2026-10-24T12:34:56.123456789Z";
const worker: WorkerClaim = {
  claimId, state: "active", userId: projectId, workerId: taskId, machine: { id: claimId, name: "Machine" },
  platform: "linux", agent: "codex", worktreeId: projectId, phase: "executing", herdr: { session: "w", workspaceId: "ws", paneId: "p" }, nativeSessionId: "native", claimedAt: time,
};
const task: TaskDetail = {
  id: taskId, projectId, title: "Task", description: "", status: "in_progress", allowAgents: true, requiredPlatform: null,
  version: 9_223_372_036_854_775_807n, properties: { pullRequests: [{ url: "\0", title: "\ud800" }], worker },
  startedAt: time, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
};
const invalidWorkers: unknown[] = [
  undefined, {}, [], false, { ...worker, state: "expired" }, { ...worker, claimId: "bad" }, { ...worker, userId: "bad" },
  { ...worker, workerId: "bad" }, { ...worker, worktreeId: "bad" }, { ...worker, machine: { id: claimId, name: "" } },
  { ...worker, machine: { id: "bad", name: "Machine" } }, { ...worker, machine: { ...worker.machine, unexpected: true } },
  { ...worker, platform: null }, { ...worker, platform: "win32" }, { ...worker, agent: "other" }, { ...worker, phase: "done" },
  { ...worker, herdr: {} }, { ...worker, herdr: { session: "w", workspaceId: "ws", paneId: "" } },
  { ...worker, nativeSessionId: "" }, { ...worker, claimedAt: "2026-02-30T00:00:00Z" }, { ...worker, unexpected: true },
  ...Object.keys(worker).map((key) => Object.fromEntries(Object.entries(worker).filter(([field]) => field !== key))),
];

describe("worker ownership detail reads", () => {
  it("preserves every protected execution field alongside opaque PR values", () => {
    expect(parseTaskDetail(task, projectId, taskId)).toEqual(task);
    const preparing = { ...task, properties: { ...task.properties, worker: { ...worker, herdr: null, nativeSessionId: null } } };
    expect(parseTaskDetail(preparing, projectId, taskId)).toEqual(preparing);
  });
  it("preserves Go-valid non-whitespace FEFF in worker resource names", () => {
    const taskWithNames = { ...task, properties: { ...task.properties, worker: { ...worker, machine: { ...worker.machine, name: "\uFEFF" }, nativeSessionId: "\uFEFF", herdr: { session: "\uFEFF", workspaceId: "\uFEFF", paneId: "\uFEFF" } } } };
    expect(parseTaskDetail(taskWithNames, projectId, taskId)).toEqual(taskWithNames);
  });
  it("accepts explicit unclaimed null and retains inactive completed history after reopening", () => {
    const neverClaimed = { ...task, properties: { ...task.properties, worker: null } };
    expect(parseTaskDetail(neverClaimed, projectId, taskId)).toEqual(neverClaimed);
    const reopened = { ...task, status: "todo", ready: true, properties: { ...task.properties, worker: { ...worker, state: "completed" } } };
    expect(parseTaskDetail(reopened, projectId, taskId)).toEqual(reopened);
  });
  it.each(invalidWorkers)("rejects missing or malformed worker data %#", (value) => {
    expect(() => parseTaskDetail({ ...task, properties: { ...task.properties, worker: value } }, projectId, taskId)).toThrow("invalid response");
  });
  it("rejects ownership inconsistent with the task status", () => {
    expect(() => parseTaskDetail({ ...task, status: "done" }, projectId, taskId)).toThrow("invalid response");
    expect(() => parseTaskDetail({ ...task, properties: { ...task.properties, worker: { ...worker, state: "released" } } }, projectId, taskId)).toThrow("invalid response");
  });
});
