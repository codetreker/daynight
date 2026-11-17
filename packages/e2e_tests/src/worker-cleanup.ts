import { DatabaseSync } from "node:sqlite";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ManagedCommand } from "./command.ts";

export type FixtureProcessProof = { pid: number; parentPid: number; processGroupId: number | null; startedAt: string; commandHash: string };
type Execution = { projectId: string; taskId: string; claimId: string; workerId: string; worktreeId: string; userId: string; serverOrigin: string;
  resources: { worktree: { worktreePath: string; branch: string } | null; nativeSession: { sessionId: string } | null };
  webExecution: { executionId: string; launchId: string; sessionId: string; controllerId: string; controllerInstanceId: string; executionGeneration: string;
    initialOperationId: string; initialPrompt: string; ticketPath: string; launchSubmission: string;
    controllerProcess: FixtureProcessProof | null; nativeProcesses: FixtureProcessProof[] } | null };
type Ticket = { executionId: string; launchId: string; sessionId: string; controllerId: string; controllerInstanceId: string; executionGeneration: string;
  initialOperationId: string; initialPrompt: string; claimId: string; projectId: string; taskId: string; workerId: string; worktreeId: string; userId: string; serverOrigin: string; cwd: string };
type Snapshot = { controllerProcess: FixtureProcessProof | null; nativeProcesses: FixtureProcessProof[]; nativeSessionId: string | null };
export type FixtureStopProofs = {
  parseLaunchTicket: (input: unknown) => Ticket;
  readCurrentControllerSnapshot: (filename: string, ticket: Ticket, deadline: number) => Snapshot;
  preservesControllerProcessProof: (previous: FixtureProcessProof, observed: FixtureProcessProof | null, launchId: string) => boolean;
  preservesNativeProcessPrefix: (previous: readonly FixtureProcessProof[], observed: readonly FixtureProcessProof[]) => boolean;
  preservesControllerEvidence: (previous: Snapshot, observed: Snapshot, launchId: string) => boolean;
  stopControllerProcesses: (controller: FixtureProcessProof, native: readonly FixtureProcessProof[], deadline: number) => Promise<void>;
  confirmControllerProcessesStopped: (controller: FixtureProcessProof, native: readonly FixtureProcessProof[], deadline: number) => Promise<boolean>;
};

export const loadFixtureStopProofs = async (load: (name: string) => Promise<Record<string, unknown>>): Promise<FixtureStopProofs> => {
  const [processProof, ticket, journal, orchestration] = await Promise.all([
    load("commands/controller/process-proof.js"), load("commands/controller/launch-ticket.js"),
    load("commands/controller/lifecycle-store.js"), load("commands/worker/backends/orchestration.js"),
  ]);
  const functions = {
    stopControllerProcesses: processProof.stopControllerProcesses, confirmControllerProcessesStopped: processProof.confirmControllerProcessesStopped,
    parseLaunchTicket: ticket.parseLaunchTicket, readCurrentControllerSnapshot: journal.readCurrentControllerSnapshot,
    preservesControllerProcessProof: orchestration.preservesControllerProcessProof, preservesNativeProcessPrefix: orchestration.preservesNativeProcessPrefix,
    preservesControllerEvidence: orchestration.preservesControllerEvidence,
  };
  if (Object.values(functions).some(value => typeof value !== "function")) throw new Error("Fixture Controller proof implementation is unavailable.");
  return functions as FixtureStopProofs;
};

// A zero exit from worker run includes its normal shutdown proof; other outcomes do not.
export class FixtureWorkerStopError extends Error {
  readonly groupStopped: boolean;
  constructor(groupStopped: boolean) { super("Fixture Worker shutdown was not confirmed successful."); this.groupStopped = groupStopped; }
}
export const stopFixtureWorker = async (worker: ManagedCommand, exited: boolean): Promise<void> => {
  let exitCode: number | undefined;
  try {
    if (!exited) process.kill(worker.pid, "SIGINT");
    exitCode = (await worker.finished).exitCode;
  } catch { /* The process-group observation below decides whether fallback is safe. */ }
  let groupStopped = false;
  try { await worker.stopProcesses(); groupStopped = true; } catch { /* Retain the original evidence. */ }
  if (!groupStopped || exitCode !== 0) throw new FixtureWorkerStopError(groupStopped);
};

export type FixtureExecutionIdentity = { projectId: string; taskId: string; workerId: string; userId: string; serverOrigin: string; repository: string; claimId?: string };
const absent = async (filename: string): Promise<boolean> => {
  try { await stat(filename); return false; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error; }
};

// Ticket, journal and append-only process evidence fence the original launch.
export const stopRecordedFixtureExecutions = async (records: readonly Execution[], expected: FixtureExecutionIdentity, directory: string, proofs: FixtureStopProofs, deadline: number): Promise<void> => {
  if (records.length !== 1) throw new Error("Fixture Worker original execution record is missing or ambiguous.");
  const record = records[0]!;
  if (record.projectId !== expected.projectId || record.taskId !== expected.taskId || record.workerId !== expected.workerId
    || record.userId !== expected.userId || record.serverOrigin !== expected.serverOrigin || expected.claimId !== undefined && record.claimId !== expected.claimId
    || typeof record.worktreeId !== "string" || !/^[0-9a-f-]{36}$/.test(record.worktreeId)) throw new Error("Fixture Worker execution identity conflicts with the original task.");
  const execution = record.webExecution;
  if (execution === null) {
    if (record.resources.nativeSession !== null) throw new Error("Fixture native identity lacks original execution evidence.");
    return;
  }
  if (!Array.isArray(execution.nativeProcesses) || !/^[0-9a-f-]{36}$/.test(execution.executionId) || !/^[0-9a-f-]{36}$/.test(execution.launchId)) throw new Error("Fixture native process evidence is unavailable.");
  const journal = path.join(directory, "controller", "executions", execution.executionId, "journal.sqlite");
  if (execution.launchSubmission === "not-submitted" && execution.controllerProcess === null && execution.nativeProcesses.length === 0) {
    if (execution.executionGeneration !== "1" || record.resources.nativeSession !== null || !await absent(journal)) throw new Error("Fixture preceding generation requires original stop evidence.");
    return;
  }
  if (!["unknown", "acknowledged"].includes(execution.launchSubmission)) throw new Error("Fixture Controller launch submission evidence is invalid.");
  const worktree = path.join(expected.repository, ".worktrees", "daynight", record.worktreeId);
  const ticketPath = path.join(directory, "controller", "launches", `${execution.launchId}.json`);
  if (record.resources.worktree?.worktreePath !== worktree || record.resources.worktree.branch !== `daynight/${expected.taskId}`
    || execution.controllerProcess === null || execution.ticketPath !== ticketPath) throw new Error("Fixture Controller ownership or original process proof is unavailable.");
  const size = (await stat(ticketPath)).size;
  if (size > 6 * 1024 * 1024) throw new Error("Fixture Controller ticket is too large.");
  let ticket: Ticket;
  try { ticket = proofs.parseLaunchTicket(JSON.parse(await readFile(ticketPath, "utf8"))); }
  catch { throw new Error("Fixture Controller ticket is unavailable or invalid."); }
  if (ticket.executionId !== execution.executionId || ticket.launchId !== execution.launchId || ticket.controllerId !== execution.controllerId
    || ticket.sessionId !== execution.sessionId || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.executionGeneration !== execution.executionGeneration
    || ticket.initialOperationId !== execution.initialOperationId || ticket.initialPrompt !== execution.initialPrompt || ticket.claimId !== record.claimId
    || ticket.projectId !== record.projectId || ticket.taskId !== record.taskId || ticket.workerId !== record.workerId || ticket.worktreeId !== record.worktreeId
    || ticket.userId !== record.userId || ticket.serverOrigin !== record.serverOrigin || ticket.cwd !== worktree) throw new Error("Fixture Controller ticket conflicts with the original execution.");
  const observe = (): Snapshot => {
    const snapshot = proofs.readCurrentControllerSnapshot(journal, ticket, deadline);
    if (!proofs.preservesControllerProcessProof(execution.controllerProcess!, snapshot.controllerProcess, execution.launchId)
      || !proofs.preservesNativeProcessPrefix(execution.nativeProcesses, snapshot.nativeProcesses)
      || record.resources.nativeSession !== null && snapshot.nativeSessionId !== record.resources.nativeSession.sessionId) throw new Error("Fixture Controller journal conflicts with the original process evidence.");
    return snapshot;
  };
  const stop = async (snapshot: Snapshot): Promise<void> => {
    if (!await proofs.confirmControllerProcessesStopped(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline)) {
      await proofs.stopControllerProcesses(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline);
      if (!await proofs.confirmControllerProcessesStopped(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline)) throw new Error("Fixture Controller process stop remains unconfirmed.");
    }
  };
  const first = observe(); await stop(first);
  const latest = observe();
  if (!proofs.preservesControllerEvidence(first, latest, execution.launchId)) throw new Error("Fixture Controller journal changed incompatibly during stop.");
  await stop(latest);
  const final = observe();
  if (!proofs.preservesControllerEvidence(latest, final, execution.launchId) || JSON.stringify(latest.nativeProcesses) !== JSON.stringify(final.nativeProcesses)
    || !await proofs.confirmControllerProcessesStopped(final.controllerProcess!, final.nativeProcesses, deadline)) throw new Error("Fixture Controller final process evidence is not settled.");
};

export const readFixtureExecutions = async (workerConfigDirectory: string): Promise<Execution[]> => {
  const filename = path.join(workerConfigDirectory, "worker", "web-executions.sqlite");
  if (!(await stat(filename)).isFile()) throw new Error("Fixture execution store is not a regular file.");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM executions").all();
    return rows.map(row => {
      if (typeof row.data !== "string") throw new Error("Fixture execution record is invalid.");
      try { return JSON.parse(row.data) as Execution; }
      catch { throw new Error("Fixture execution record is invalid."); }
    });
  } finally { db.close(); }
};

// A failed or unproven stop retains the original directory outside runner cleanup.
export const finalizeFixtureRoot = async (input: { root: string; stopConfirmed: boolean; workerGroupStopped: boolean; recover: () => Promise<void> }): Promise<void> => {
  if (!input.stopConfirmed) {
    if (!input.workerGroupStopped) throw new Error(`Fixture Worker process group stop is unconfirmed; original state retained at ${input.root}.`);
    try { await input.recover(); }
    catch (cause) { throw new Error(`Fixture Controller stop is unconfirmed; original state retained at ${input.root}.`, { cause }); }
  }
  await rm(input.root, { recursive: true, force: true });
};
