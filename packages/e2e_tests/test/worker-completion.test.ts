import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandFailure } from "../src/command.ts";
import { completeFixtureTask, type WorkerCompletionTask } from "../src/worker-completion.ts";

const projectId = "project", taskId = "task", userId = "user";
const original = { claimId: "claim", workerId: "worker", worktreeId: "worktree", nativeSessionId: "session", state: "active", platform: "linux", agent: "codex", agentControlMode: "web" };
const task = (version: number): WorkerCompletionTask => ({ id: taskId, projectId, version, status: "in_progress", assignedTo: userId, allowAgents: true,
  properties: { worker: { ...original, userId } } });
const conflict = () => new CommandFailure("daynight", { exitCode: 1, stdout: "", stderr: `worker.complete project=${projectId} task=${taskId} [response]: version_conflict: Task version does not match.\n` });

test("a confirmed version conflict reads the original assignment again before a bounded completion", async () => {
  const reads: number[] = [], writes: number[] = [];
  await completeFixtureTask({ projectId, taskId, userId, original,
    read: async () => { const version = reads.length + 1; reads.push(version); return task(version); },
    complete: async version => { writes.push(version); if (version === 1) throw conflict(); } });
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(writes, [1, 2]);
});

test("a changed claim, assignment, permission, pause or task identity forbids a second completion", async () => {
  const changes: ((value: WorkerCompletionTask) => void)[] = [
    value => { value.properties.worker!.claimId = "other"; },
    value => { value.properties.worker!.workerId = "other"; },
    value => { value.properties.worker!.worktreeId = "other"; },
    value => { value.properties.worker!.nativeSessionId = "other"; },
    value => { value.properties.worker!.userId = "other"; },
    value => { value.properties.worker!.state = "completed"; },
    value => { value.properties.worker!.platform = "other"; },
    value => { value.properties.worker!.agent = "other"; },
    value => { value.properties.worker!.agentControlMode = "other"; },
    value => { value.assignedTo = "other"; },
    value => { value.allowAgents = false; },
    value => { value.properties.paused = true; },
    value => { value.status = "done"; },
    value => { value.id = "other"; },
    value => { value.projectId = "other"; },
  ];
  for (const change of changes) {
    let reads = 0, writes = 0;
    await assert.rejects(completeFixtureTask({ projectId, taskId, userId, original,
      read: async () => { const value = task(++reads); if (reads === 2) change(value); return value; },
      complete: async () => { writes++; throw conflict(); } }), /original active Worker assignment/);
    assert.equal(writes, 1);
  }
});

test("unknown failures and conflicts for another request are not retried", async () => {
  const errors = [new Error("connection lost"), new CommandFailure("daynight", { exitCode: 1, stdout: "", stderr: "worker.complete project=other task=task [response]: version_conflict: conflict" })];
  for (const error of errors) {
    let reads = 0, writes = 0;
    await assert.rejects(completeFixtureTask({ projectId, taskId, userId, original, read: async () => task(++reads), complete: async () => { writes++; throw error; } }), actual => actual === error);
    assert.equal(reads, 1); assert.equal(writes, 1);
  }
});

test("repeated explicit conflicts stop after three attempts", async () => {
  let reads = 0, writes = 0;
  await assert.rejects(completeFixtureTask({ projectId, taskId, userId, original, read: async () => task(++reads), complete: async () => { writes++; throw conflict(); } }), CommandFailure);
  assert.equal(reads, 3); assert.equal(writes, 3);
});
