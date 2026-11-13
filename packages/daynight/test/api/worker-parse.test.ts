import { readWorkerClaim } from "../../src/api/task-properties.js";
import { describe, expect, it } from "vitest";
import { parseTask } from "../../src/api/parse.js";
import type { Task, WorkerClaim } from "../../src/api/types.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const claimId = "33333333-3333-3333-3333-333333333333";
const time = "2026-10-24T12:34:56.123456789Z";
const worker: WorkerClaim = {
  claimId, state: "active", userId: projectId, workerId: taskId, machine: { id: claimId, name: "Machine" },
  platform: "linux", agent: "codex", agentControlMode: "herdr", worktreeId: projectId, phase: "executing", herdr: { session: "w", workspaceId: "ws", paneId: "p" }, nativeSessionId: "native", claimedAt: time,
};
const task: Task = {
  id: taskId, type: "task", parentId: null, projectId, title: "Task", description: "", tags: [], status: "in_progress", allowAgents: true, requiredPlatform: null, assignedTo: null,
  version: 9_223_372_036_854_775_807n, properties: { pullRequests: [{ url: "\0", title: "\ud800" }], worker },
  startedAt: time, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
};
const malformedWorkers: unknown[] = [
  undefined, null, {}, [], false, { ...worker, state: "released" }, { ...worker, state: "expired" }, { ...worker, claimId: "not-id" }, { ...worker, userId: "not-id" },
  { ...worker, workerId: "not-id" }, { ...worker, worktreeId: "not-id" }, { ...worker, machine: { id: claimId, name: "" } },
  { ...worker, machine: { id: "bad", name: "Machine" } }, { ...worker, machine: { ...worker.machine, unexpected: true } },
  { ...worker, platform: null }, { ...worker, platform: "win32" }, { ...worker, agent: "other" }, { ...worker, phase: "done" },
  { ...worker, herdr: {} }, { ...worker, herdr: { session: "w", workspaceId: "ws", paneId: "" } },
  { ...worker, nativeSessionId: "" }, { ...worker, claimedAt: "2026-02-30T00:00:00Z" }, { ...worker, unexpected: true },
  ...Object.keys(worker).map((key) => Object.fromEntries(Object.entries(worker).filter(([field]) => field !== key))),
];

describe("worker ownership read DTO", () => {
  it("accepts the additional ordinary resource type and parent fields", () => {
    expect(parseTask({ ...task, type: "task", parentId: null }, projectId, taskId)).toEqual(task);
  });
  it.each([undefined, "", "invalid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", true, 1, {}, []].map((assignedTo) => ({ assignedTo })))("requires the native nullable assignment on worker task resources %#", ({ assignedTo }) => {
    expect(() => parseTask({ ...task, assignedTo }, projectId, taskId)).toThrow("invalid response");
  });
  it("retains responsibility independently from execution ownership", () => {
    const assignedTo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(parseTask({ ...task, assignedTo }, projectId, taskId)).toMatchObject({ assignedTo, properties: { worker: { userId: projectId } } });
  });
  it("retains protected execution metadata and opaque PR strings", () => {
    expect(parseTask(task, projectId, taskId)).toEqual(task);
    const preparing = { ...task, properties: { ...task.properties, worker: { ...worker, herdr: null, nativeSessionId: null } } };
    expect(parseTask(preparing, projectId, taskId)).toEqual(preparing);
  });
  it("preserves Go-valid non-whitespace FEFF in worker resource names", () => {
    const taskWithNames = { ...task, properties: { ...task.properties, worker: { ...worker, machine: { ...worker.machine, name: "\uFEFF" }, nativeSessionId: "\uFEFF", herdr: { session: "\uFEFF", workspaceId: "\uFEFF", paneId: "\uFEFF" } } } };
    expect(parseTask(taskWithNames, projectId, taskId)).toEqual(taskWithNames);
  });
  it("retains absent ownership and inactive history without creating defaults", () => {
    const neverClaimed = { ...task, properties: { pullRequests: task.properties.pullRequests! } };
    expect(parseTask(neverClaimed, projectId, taskId)).toEqual(neverClaimed);
    for (const status of ["todo", "in_progress", "done", "cancelled"] as const) {
      const historical = { ...task, status, cancelledAt: status === "cancelled" ? time : null, ready: status === "todo", properties: { ...task.properties, worker: { ...worker, state: "completed" } } };
      expect(parseTask(historical, projectId, taskId)).toEqual(historical);
    }
  });
  it.each(malformedWorkers)("rejects missing or malformed protected execution metadata %#", (value) => {
    expect(() => parseTask({ ...task, properties: { ...task.properties, worker: value } }, projectId, taskId)).toThrow("invalid response");
  });
  it("accepts a cancelled task without ownership and rejects an active claim on it", () => {
    const cancelled = { ...task, status: "cancelled", ready: false, cancelledAt: time };
    const unowned = { ...cancelled, properties: { pullRequests: task.properties.pullRequests! } };
    expect(parseTask(unowned, projectId, taskId)).toEqual(unowned);
    expect(() => parseTask(cancelled, projectId, taskId)).toThrow("invalid response");
  });
  it("rejects active ownership outside in_progress", () => {
    expect(() => parseTask({ ...task, status: "done" }, projectId, taskId)).toThrow("invalid response");
  });
  it.each(["todo", "cancelled"] as const)("rejects the retired released state on %s", (status) => {
    expect(() => parseTask({ ...task, status, cancelledAt: status === "cancelled" ? time : null, properties: { ...task.properties, worker: { ...worker, state: "released" } } }, projectId, taskId)).toThrow("invalid response");
  });
});


describe("worker execution mode read contract", () => {
  const read = (value: unknown) => readWorkerClaim(parseTask({ ...task, properties: { ...task.properties, worker: value } }, projectId, taskId).properties);
  it("rejects a claim without an explicit execution mode", () => {
    const { agentControlMode: _mode, ...legacy } = worker as WorkerClaim & { agentControlMode?: string };
    expect(() => read(legacy)).toThrow("invalid response");
  });
  it.each(["codex", "claude", "copilot"])("reads %s web claims with no Herdr binding", (agent) => {
    expect(read({ ...worker, agentControlMode: "web", agent, herdr: null })).toMatchObject({ agentControlMode: "web", agent, herdr: null });
  });
  it.each([null, "", "other", undefined])("rejects explicit invalid mode %j", (agentControlMode) => {
    expect(() => read({ ...worker, agentControlMode })).toThrow("invalid response");
  });
  it("rejects a web claim with an unsupported agent or Herdr resource", () => {
    expect(() => read({ ...worker, agentControlMode: "web", agent: "unsupported", herdr: null })).toThrow();
    expect(() => read({ ...worker, agentControlMode: "web" })).toThrow();
  });
});
