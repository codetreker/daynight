import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { healthyOriginalGeneration, LEGACY_BRANCH_ERROR, preservesControllerEvidence, preservesControllerProcessProof, stoppedOriginalGeneration, verifyLegacyBranchProvenance } from "../../../src/commands/worker/backends/orchestration.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async (delay: number) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/orchestration-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-"));
  roots.push(home);
  const store = openWebExecutionStore(path.join(home, "worker.sqlite"));
  try {
    const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };
    const identity = { ...project, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID() };
    store.register({ ...identity, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, userId: randomUUID() }, 1);
    let task = store.initializeWebExecution(store.getTask(identity)!, 2);
    task = store.updateWebExecution(task, { sessionId: randomUUID(), launchSubmission: "acknowledged" }, 3);
    task = store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 4);
    const reportTime = 1_000_000;
    store.pauseRecovery(task, LEGACY_BRANCH_ERROR, reportTime, "recovery_limit");
    store.observeStartup(task, { state: "ready", reasonCode: "ready" }, reportTime);
    task = store.getTask(task)!;
    const entries = [reportTime - 15_000, reportTime - 10_000, reportTime - 5_000, reportTime + delay].map(timestamp => ({
      timestamp: new Date(timestamp).toISOString(), workerId: task.workerId, projectId: task.projectId,
      taskId: task.taskId, claimId: task.claimId, sessionId: task.resources.nativeSession!.sessionId,
      kind: "execution-error", error: { name: "Error", message: LEGACY_BRANCH_ERROR },
    }));
    const directory = path.join(home, ".daynight", "worker", "logs");
    await mkdir(directory, { recursive: true });
    const save = () => writeFile(path.join(directory, "worker-1970-01-01.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    return { home, task, entries, save, reportTime };
  } finally { store.close(); }
};

it.each([6_000, 40_000, 45_000])("accepts a legacy terminal diagnostic delayed by %s ms after the persisted report", async delay => {
  const f = await fixture(delay);
  await f.save();
  await expect(verifyLegacyBranchProvenance(f.home, f.task, new AbortController().signal)).resolves.toBeUndefined();
});

it.each(["late", "before-report", "old", "worker", "claim", "native", "reason", "duplicate", "short", "conflict"] as const)("retains the legacy latch for %s diagnostic evidence", async conflict => {
  const f = await fixture(40_000);
  const terminal = f.entries[3]!;
  if (conflict === "late") terminal.timestamp = new Date(f.reportTime + 45_001).toISOString();
  if (conflict === "before-report") terminal.timestamp = new Date(f.reportTime - 1).toISOString();
  if (conflict === "old") f.entries[0]!.timestamp = new Date(f.reportTime - 600_001).toISOString();
  if (conflict === "worker") terminal.workerId = randomUUID();
  if (conflict === "claim") terminal.claimId = randomUUID();
  if (conflict === "native") terminal.sessionId = randomUUID();
  if (conflict === "reason") terminal.error.message = "Original controller stopped.";
  if (conflict === "duplicate") f.entries[1]!.timestamp = f.entries[0]!.timestamp;
  if (conflict === "short") f.entries.shift();
  if (conflict === "conflict") f.entries.push({ ...terminal, timestamp: new Date(f.reportTime + 41_000).toISOString(), error: { name: "Error", message: "Original controller stopped." } });
  await f.save();
  await expect(verifyLegacyBranchProvenance(f.home, f.task, new AbortController().signal)).rejects.toThrow(/provenance is incomplete or conflicting/);
});

const windowsProofFixture = async () => {
  const f = await fixture(0), execution = f.task.webExecution!;
  const core = { pid: 123, parentPid: 1, processGroupId: null, startedAt: "2026-11-05T00:00:00.0000000Z", commandHash: "a".repeat(64) };
  const nativeProcesses = [{ ...core, pid: 124, parentPid: 123 }];
  const task: LocalTask = { ...f.task, webExecution: { ...execution, controllerProcess: core, nativeProcesses } };
  const observed: ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "working", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: task.resources.nativeSession!.sessionId, initialInputState: "confirmed", activity: "working", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: false }, controllerProcess: { ...core, jobObjectName: `Local\\Daynight-${execution.launchId}` }, nativeProcesses, nativeStopped: false, stoppedAt: null, error: null };
  return { task, observed, core, execution };
};

it("accepts original Windows Job capture after launcher process capture for live and stopped observations", async () => {
  const { task, observed, core, execution } = await windowsProofFixture();
  expect(healthyOriginalGeneration(task, observed)).toBe(true);
  expect(preservesControllerEvidence({ ...observed, controllerProcess: core }, observed, execution.launchId)).toBe(true);
  expect(stoppedOriginalGeneration(task, { ...observed, lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date(0).toISOString() })).toBe(true);
  expect(preservesControllerProcessProof(core, core, execution.launchId)).toBe(true);
  expect(preservesControllerProcessProof(observed.controllerProcess!, observed.controllerProcess, execution.launchId)).toBe(true);
  expect(preservesControllerProcessProof(core, null, execution.launchId)).toBe(false);
  expect(preservesControllerProcessProof({ ...core, processGroupId: core.pid }, { ...observed.controllerProcess!, processGroupId: core.pid }, execution.launchId)).toBe(false);
});

it.each(["pid", "parent", "group", "birth", "command", "other-launch", "known-job", "lost-job"] as const)("rejects %s changes when comparing Windows controller proofs", async conflict => {
  const f = await windowsProofFixture();
  if (conflict === "pid") f.observed.controllerProcess = { ...f.observed.controllerProcess!, pid: 999 };
  if (conflict === "parent") f.observed.controllerProcess = { ...f.observed.controllerProcess!, parentPid: 999 };
  if (conflict === "group") f.observed.controllerProcess = { ...f.observed.controllerProcess!, processGroupId: 999 };
  if (conflict === "birth") f.observed.controllerProcess = { ...f.observed.controllerProcess!, startedAt: "different" };
  if (conflict === "command") f.observed.controllerProcess = { ...f.observed.controllerProcess!, commandHash: "b".repeat(64) };
  if (conflict === "other-launch") f.observed.controllerProcess = { ...f.observed.controllerProcess!, jobObjectName: `Local\\Daynight-${randomUUID()}` };
  if (conflict === "known-job" || conflict === "lost-job") {
    f.task.webExecution!.controllerProcess = { ...f.core, jobObjectName: `Local\\Daynight-${randomUUID()}` };
    if (conflict === "lost-job") f.observed.controllerProcess = f.core;
  }
  expect(healthyOriginalGeneration(f.task, f.observed)).toBe(false);
  expect(preservesControllerEvidence({ ...f.observed, controllerProcess: f.task.webExecution!.controllerProcess }, f.observed, f.execution.launchId)).toBe(false);
  expect(stoppedOriginalGeneration(f.task, { ...f.observed, lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date(0).toISOString() })).toBe(false);
});
