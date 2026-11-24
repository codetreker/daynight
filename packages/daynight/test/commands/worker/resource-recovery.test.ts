import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recoverCompletedWebResource } from "../../../src/commands/worker/resource-recovery.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import type { Task } from "../../../src/api/types.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixture = () => {
  const owner = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const root = path.resolve(".tmp/resource-recovery"), binding = { repositoryPath: root, commonDirectory: path.join(root, ".git"), worktreePath: path.join(root, ".worktrees/daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  const record = { ...owner, workerId: uuid(5), userId: uuid(6), serverOrigin: "https://example.test", status: "done", repositoryPath: root, repoUrl: "https://example.test/repo.git", configuration: { agent: "codex", agentControlMode: "web" }, resources: { worktree: binding }, cleanup: { kind: "terminal" }, webExecution: { executionId: uuid(7), sessionId: uuid(8) } } as LocalTask;
  const task = { id: owner.taskId, projectId: owner.projectId, status: "done", properties: { worker: { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId: record.workerId, userId: record.userId, state: "completed", agent: "codex", agentControlMode: "web", machine: { id: uuid(9), name: "fixture" }, platform: "macos", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-16T00:00:00Z" } } } as unknown as Task;
  const dependencies = {
    serverOrigin: record.serverOrigin, workerId: record.workerId, currentUserId: vi.fn(async () => record.userId!),
    getRecord: vi.fn(() => record as LocalTask | null), readTask: vi.fn(async () => task),
    readProject: vi.fn(async () => ({ id: owner.projectId, repoUrl: record.repoUrl })),
    project: { projectId: owner.projectId, localPath: root, repoUrl: record.repoUrl },
    inspectWorktree: vi.fn(async () => binding), verifyStoppedArchive: vi.fn(async () => {}),
    verifyPreserved: vi.fn(async () => {}), removeSafely: vi.fn(async () => {}),
  };
  return { owner, record, task, dependencies, signal: new AbortController().signal };
};

describe("completed Web resource recovery", () => {
  it("previews a completed original owner without deleting anything", async () => {
    const f = fixture();
    const result = await recoverCompletedWebResource({ ...f, request: { ...f.owner, confirmed: false } });
    expect(result).toMatchObject({ outcome: "verified", owner: f.owner });
    expect(f.dependencies.verifyStoppedArchive).toHaveBeenCalled();
    expect(f.dependencies.removeSafely).not.toHaveBeenCalled();
  });
  it("rechecks evidence and safely removes only the original completed worktree", async () => {
    const f = fixture();
    const result = await recoverCompletedWebResource({ ...f, request: { projectId: f.owner.projectId, taskId: f.owner.taskId, claimId: f.owner.claimId, confirmed: true } });
    expect(result.outcome).toBe("recovered");
    expect(f.dependencies.readTask).toHaveBeenCalledTimes(2);
    expect(f.dependencies.removeSafely).toHaveBeenCalledExactlyOnceWith(f.owner, f.record.resources.worktree, f.signal);
  });
  it.each(["missing", "active", "worker", "user", "claim", "worktree", "repository", "shutdown", "successor"])("refuses insufficient or foreign evidence: %s", async kind => {
    const f = fixture();
    if (kind === "missing") f.dependencies.getRecord.mockReturnValue(null);
    if (kind === "active") f.record.status = "active";
    if (kind === "worker") f.record.workerId = uuid(30);
    if (kind === "user") f.dependencies.currentUserId.mockResolvedValue(uuid(30));
    if (kind === "claim") f.record.claimId = uuid(30);
    if (kind === "worktree") f.record.worktreeId = uuid(30);
    if (kind === "repository") f.record.repositoryPath = path.resolve(".tmp/other");
    if (kind === "shutdown") f.record.cleanup!.kind = "shutdown";
    if (kind === "successor") (f.task.properties.worker as Record<string, unknown>).claimId = uuid(30);
    await expect(recoverCompletedWebResource({ ...f, request: { ...f.owner, confirmed: true } })).rejects.toThrow();
    expect(f.dependencies.removeSafely).not.toHaveBeenCalled();
  });
  it.each(["stop/archive", "files", "task changed", "delete failed"])("retains resources when %s cannot be confirmed", async kind => {
    const f = fixture();
    if (kind === "stop/archive") f.dependencies.verifyStoppedArchive.mockRejectedValue(new Error("unknown stop or archive"));
    if (kind === "files") f.dependencies.verifyPreserved.mockRejectedValue(new Error("dirty files"));
    if (kind === "task changed") f.dependencies.readTask.mockResolvedValueOnce(f.task).mockResolvedValue({ ...f.task, status: "in_progress" });
    if (kind === "delete failed") f.dependencies.removeSafely.mockRejectedValue(new Error("unconfirmed removal"));
    await expect(recoverCompletedWebResource({ ...f, request: { ...f.owner, confirmed: true } })).rejects.toThrow();
  });
});
