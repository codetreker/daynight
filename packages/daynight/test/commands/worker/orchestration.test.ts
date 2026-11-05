import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LEGACY_BRANCH_ERROR, verifyLegacyBranchProvenance } from "../../../src/commands/worker/backends/orchestration.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";

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
