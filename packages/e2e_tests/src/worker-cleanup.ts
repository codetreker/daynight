import { DatabaseSync } from "node:sqlite";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { aggregateFailures } from "./failures.ts";
import type { ManagedCommand } from "./command.ts";

export type FixtureProcessProof = { pid: number; parentPid: number; processGroupId: number | null; startedAt: string; commandHash: string };
type Execution = { projectId: string; taskId: string; claimId: string; workerId: string; worktreeId: string; userId: string; serverOrigin: string;
  resources: { worktree: { worktreePath: string; branch: string } | null; nativeSession: { sessionId: string } | null };
  webExecution: { executionId: string; launchId: string; sessionId: string; controllerId: string; controllerInstanceId: string; executionGeneration: string;
    initialOperationId: string; initialPrompt: string; ticketPath: string; launchSubmission: string;
    controllerProcess: FixtureProcessProof | null; nativeProcesses: FixtureProcessProof[] } | null };
type Ticket = { executionId: string; launchId: string; sessionId: string; controllerId: string; controllerInstanceId: string; executionGeneration: string;
  initialOperationId: string; initialPrompt: string; claimId: string; projectId: string; taskId: string; workerId: string; worktreeId: string; userId: string; serverOrigin: string; cwd: string;
  testExecutionId?: string; ownerUserId?: string; codexBotRecovery?: { botId: string } };
type Snapshot = { controllerProcess: FixtureProcessProof | null; nativeProcesses: FixtureProcessProof[]; nativeSessionId: string | null };
type LaunchObservation = { kind: "observed" | "running-unobserved" | "controller-exited" | "pre-writer-exited" | "unknown"; cause?: unknown };
export type FixtureStopProofs = {
  parseLaunchTicket: (input: unknown) => Ticket;
  readCurrentControllerSnapshot: (filename: string, ticket: Ticket, deadline: number) => Snapshot;
  preservesControllerProcessProof: (previous: FixtureProcessProof, observed: FixtureProcessProof | null, launchId: string) => boolean;
  preservesNativeProcessPrefix: (previous: readonly FixtureProcessProof[], observed: readonly FixtureProcessProof[]) => boolean;
  preservesControllerEvidence: (previous: Snapshot, observed: Snapshot, launchId: string) => boolean;
  stopControllerProcesses: (controller: FixtureProcessProof, native: readonly FixtureProcessProof[], deadline: number) => Promise<void>;
  confirmControllerProcessesStopped: (controller: FixtureProcessProof, native: readonly FixtureProcessProof[], deadline: number) => Promise<boolean>;
  reconcileSubmittedControllerLaunch: (input: { journalFile: string; ticket: Ticket; spawnProof: FixtureProcessProof; signal: AbortSignal; deadline: number }) => Promise<LaunchObservation>;
  stopControllerBootstrap: (proof: FixtureProcessProof, deadline: number) => Promise<void>;
  ControllerBootstrapReplacedError: new (...args: never[]) => Error;
};

export const loadFixtureStopProofs = async (load: (name: string) => Promise<Record<string, unknown>>): Promise<FixtureStopProofs> => {
  const [processProof, ticket, journal, orchestration, launch] = await Promise.all([
    load("commands/controller/process-proof.js"), load("commands/controller/launch-ticket.js"),
    load("commands/controller/lifecycle-store.js"), load("commands/worker/backends/orchestration.js"),
    load("commands/controller/launch-observation.js"),
  ]);
  const functions = {
    stopControllerProcesses: processProof.stopControllerProcesses, confirmControllerProcessesStopped: processProof.confirmControllerProcessesStopped,
    parseLaunchTicket: ticket.parseLaunchTicket, readCurrentControllerSnapshot: journal.readCurrentControllerSnapshot,
    preservesControllerProcessProof: orchestration.preservesControllerProcessProof, preservesNativeProcessPrefix: orchestration.preservesNativeProcessPrefix,
    preservesControllerEvidence: orchestration.preservesControllerEvidence,
    reconcileSubmittedControllerLaunch: launch.reconcileSubmittedControllerLaunch, stopControllerBootstrap: launch.stopControllerBootstrap,
    ControllerBootstrapReplacedError: launch.ControllerBootstrapReplacedError,
  };
  if (Object.values(functions).some(value => typeof value !== "function")) throw new Error("Fixture Controller proof implementation is unavailable.");
  return functions as FixtureStopProofs;
};

// A zero exit from worker run includes its normal shutdown proof; other outcomes do not.
export class FixtureWorkerStopError extends Error {
  readonly groupStopped: boolean;
  readonly diagnostics: ReturnType<ManagedCommand["diagnostics"]>;
  constructor(groupStopped: boolean, diagnostics: ReturnType<ManagedCommand["diagnostics"]>, failures: unknown[]) {
    const detail = inspect({ groupStopped, diagnostics, failures }, { depth: 8, maxStringLength: 1024 * 1024, maxArrayLength: 50 });
    super(`Fixture Worker shutdown was not confirmed successful.\n${detail}`, { cause: new AggregateError(failures, "Fixture Worker stop failures") });
    this.name = "FixtureWorkerStopError";
    this.groupStopped = groupStopped;
    this.diagnostics = diagnostics;
  }
}
export const stopFixtureWorker = async (worker: ManagedCommand, exited: boolean): Promise<ReturnType<ManagedCommand["diagnostics"]>> => {
  const failures: unknown[] = [];
  let exitCode: number | undefined, signalFailure = false;
  if (!exited) {
    try { process.kill(worker.pid, "SIGINT"); }
    catch (error) { failures.push(error); signalFailure = true; }
  }
  if (!signalFailure) {
    try { exitCode = (await worker.finished).exitCode; }
    catch (error) { failures.push(error); }
  }
  let groupStopped = false;
  try { await worker.stopProcesses(); groupStopped = true; }
  catch (error) { if (!failures.includes(error)) failures.push(error); }
  if (signalFailure && groupStopped) {
    try { exitCode = (await worker.finished).exitCode; }
    catch (error) { if (!failures.includes(error)) failures.push(error); }
  }
  const diagnostics = worker.diagnostics();
  const targetFailed = "targetExit" in diagnostics && (diagnostics.targetExit?.code !== 0 || diagnostics.targetExit.signal !== null);
  if (!groupStopped || exitCode !== 0 || targetFailed || failures.length > 0) throw new FixtureWorkerStopError(groupStopped, diagnostics, failures);
  return diagnostics;
};

export const stopAndRecordFixtureWorker = async (input: { worker: ManagedCommand; exited: boolean; runDirectory: string; workerId: string; launchNumber: number }): Promise<void> => {
  let failure: unknown, diagnostics;
  try { diagnostics = await stopFixtureWorker(input.worker, input.exited); }
  catch (error) { failure = error; diagnostics = error instanceof FixtureWorkerStopError ? error.diagnostics : input.worker.diagnostics(); }
  try {
    await writeFile(path.join(input.runDirectory, "logs", `worker-patrol-${input.launchNumber}.json`), JSON.stringify({
      workerId: input.workerId, launchNumber: input.launchNumber,
      groupStopped: failure instanceof FixtureWorkerStopError ? failure.groupStopped : failure === undefined,
      diagnostics, failure: failure === undefined ? null : inspect(failure, { depth: 8, maxStringLength: 1024 * 1024 }),
    }, null, 2));
  } catch (recordFailure) {
    if (failure !== undefined) throw aggregateFailures("Fixture Worker stop and diagnostic recording failed.", [failure, recordFailure]);
    throw recordFailure;
  }
  if (failure !== undefined) throw failure;
};

export type FixtureExecutionIdentity = { projectId: string; taskId: string; workerId: string; userId: string; serverOrigin: string; repository: string; claimId?: string; botId?: string };
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
  await stopJournaledController({ journal, ticket, launchId: execution.launchId, controllerProcess: execution.controllerProcess,
    nativeProcesses: execution.nativeProcesses, nativeSessionId: record.resources.nativeSession?.sessionId ?? null }, proofs, deadline);
};

// The journal may append native processes after the recorded evidence; each observation must extend that evidence.
const stopJournaledController = async (original: { journal: string; ticket: Ticket; launchId: string; controllerProcess: FixtureProcessProof;
  nativeProcesses: readonly FixtureProcessProof[]; nativeSessionId: string | null }, proofs: FixtureStopProofs, deadline: number): Promise<void> => {
  const read = (): Snapshot => proofs.readCurrentControllerSnapshot(original.journal, original.ticket, deadline);
  const check = (snapshot: Snapshot): Snapshot => {
    if (!proofs.preservesControllerProcessProof(original.controllerProcess, snapshot.controllerProcess, original.launchId)
      || !proofs.preservesNativeProcessPrefix(original.nativeProcesses, snapshot.nativeProcesses)
      || original.nativeSessionId !== null && snapshot.nativeSessionId !== original.nativeSessionId) throw new Error("Fixture Controller journal conflicts with the original process evidence.");
    return snapshot;
  };
  const observe = (): Snapshot => check(read());
  const stop = async (snapshot: Snapshot): Promise<void> => {
    if (!await proofs.confirmControllerProcessesStopped(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline)) {
      await proofs.stopControllerProcesses(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline);
      if (!await proofs.confirmControllerProcessesStopped(snapshot.controllerProcess!, snapshot.nativeProcesses, deadline)) throw new Error("Fixture Controller process stop remains unconfirmed.");
    }
  };
  let initial: Snapshot;
  try { initial = read(); }
  catch (failure) {
    try { await stopPreJournalController(original, proofs, deadline); initial = read(); }
    catch (recovery) { throw new AggregateError([failure, recovery], "Fixture Controller journal is unavailable and bootstrap recovery did not confirm the process tree.", { cause: failure }); }
  }
  const first = check(initial); await stop(first);
  const latest = observe();
  if (!proofs.preservesControllerEvidence(first, latest, original.launchId)) throw new Error("Fixture Controller journal changed incompatibly during stop.");
  await stop(latest);
  const final = observe();
  if (!proofs.preservesControllerEvidence(latest, final, original.launchId) || JSON.stringify(latest.nativeProcesses) !== JSON.stringify(final.nativeProcesses)
    || !await proofs.confirmControllerProcessesStopped(final.controllerProcess!, final.nativeProcesses, deadline)) throw new Error("Fixture Controller final process evidence is not settled.");
};

// The Worker persists the spawn proof before the Controller commits its first journal snapshot.
// As in production Bot shutdown, a launch without a readable snapshot is classified from that proof, its verified
// bootstrap process is stopped within the deadline, and the journal is then rechecked for native children.
// A Controller that exits before committing its generation leaves no evidence that native children stopped.
const stopPreJournalController = async (original: { journal: string; ticket: Ticket; controllerProcess: FixtureProcessProof }, proofs: FixtureStopProofs, deadline: number): Promise<void> => {
  const reconcile = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Fixture Controller recovery exceeded its deadline.");
    return proofs.reconcileSubmittedControllerLaunch({ journalFile: original.journal, ticket: original.ticket, spawnProof: original.controllerProcess, signal: AbortSignal.timeout(remaining), deadline });
  };
  let observation = await reconcile();
  if (observation.kind === "observed" || observation.kind === "running-unobserved") {
    try { await proofs.stopControllerBootstrap(original.controllerProcess, deadline); }
    catch (error) { if (!(error instanceof proofs.ControllerBootstrapReplacedError)) throw error; }
    observation = await reconcile();
  }
  if (observation.kind === "pre-writer-exited") throw new Error("Fixture Controller exited before committing its journal; native process stop remains unconfirmed.");
  if (observation.kind !== "controller-exited") throw new Error("Fixture Controller pre-journal launch could not be classified; process stop remains unconfirmed.", { cause: observation.cause });
};

type BotLaunchIntent = { launchId: string; executionId: string; controllerInstanceId: string; sessionId: string | null; executionGeneration: string;
  ticketPath: string; journalPath: string; registration: { testExecutionId: string; controllerId: string } };
type BotExecution = { launchId: string; executionId: string; executionGeneration: string; launchSubmission: string;
  controllerProcess: FixtureProcessProof | null; snapshot: { nativeSessionId: string | null; nativeProcesses: FixtureProcessProof[] } | null };
export type FixtureBotRecord = { serverOrigin: string; ownerUserId: string; workerId: string; botId: string; intent: BotLaunchIntent | null; execution: BotExecution | null };

/** A Bot hosted by the fixture Worker keeps its execution evidence in its own private store. */
export const readFixtureBot = async (workerConfigDirectory: string, botId: string): Promise<FixtureBotRecord | null> => {
  const filename = path.join(workerConfigDirectory, "bots", botId, "store.sqlite");
  if (await absent(filename)) return null;
  if (!(await stat(filename)).isFile()) throw new Error("Fixture Bot store is not a regular file.");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = (table: string) => db.prepare(`SELECT server_origin, owner_user_id, worker_id, bot_id, record FROM ${table}`).all();
    const bots = rows("bots"), executions = rows("bot_executions");
    if (bots.length > 1 || executions.length > 1 || bots.length === 0 && executions.length > 0) throw new Error("Fixture Bot records are ambiguous.");
    const bot = bots[0];
    if (bot === undefined) return null;
    const execution = executions[0];
    for (const row of [bot, execution]) {
      if (row !== undefined && (typeof row.record !== "string" || row.server_origin !== bot.server_origin || row.owner_user_id !== bot.owner_user_id
        || row.worker_id !== bot.worker_id || row.bot_id !== bot.bot_id)) throw new Error("Fixture Bot record is invalid.");
    }
    try {
      const record = JSON.parse(bot.record as string) as { botId: string; intent: BotLaunchIntent | null };
      return { serverOrigin: String(bot.server_origin), ownerUserId: String(bot.owner_user_id), workerId: String(bot.worker_id), botId: record.botId,
        intent: record.intent, execution: execution === undefined ? null : JSON.parse(execution.record as string) as BotExecution };
    } catch { throw new Error("Fixture Bot record is invalid."); }
  } finally { db.close(); }
};

// Ticket, journal and the Worker's recorded process evidence fence the Bot's current launch.
export const stopRecordedFixtureBot = async (record: FixtureBotRecord | null, expected: FixtureExecutionIdentity, directory: string, proofs: FixtureStopProofs, deadline: number): Promise<void> => {
  const botId = expected.botId;
  if (botId === undefined) return;
  // The Worker records the Bot before preparing any launch, so an absent store proves nothing was launched.
  if (record === null) return;
  if (record.botId !== botId || record.workerId !== expected.workerId || record.ownerUserId !== expected.userId
    || record.serverOrigin !== expected.serverOrigin) throw new Error("Fixture Bot identity conflicts with the original Worker.");
  const execution = record.execution, intent = record.intent;
  if (execution === null) return;
  if (intent === null || execution.launchId !== intent.launchId || execution.executionId !== intent.executionId || execution.executionGeneration !== intent.executionGeneration
    || !/^[0-9a-f-]{36}$/.test(execution.launchId) || !/^[0-9a-f-]{36}$/.test(execution.executionId)) throw new Error("Fixture Bot execution conflicts with its launch intent.");
  const storage = path.join(directory, "bots", botId, "controller");
  const ticketPath = path.join(storage, "launches", `${execution.launchId}.json`), journal = path.join(storage, "executions", execution.executionId, "journal.sqlite");
  if (intent.ticketPath !== ticketPath || intent.journalPath !== journal) throw new Error("Fixture Bot private paths differ from its original storage.");
  if (execution.launchSubmission === "not-submitted") {
    if (execution.controllerProcess !== null || execution.snapshot !== null || !await absent(journal)) throw new Error("Fixture Bot unsubmitted launch has process evidence.");
    return;
  }
  if (!["unknown", "acknowledged"].includes(execution.launchSubmission)) throw new Error("Fixture Bot launch submission evidence is invalid.");
  if (execution.controllerProcess === null) throw new Error("Fixture Bot original Controller process proof is unavailable.");
  if ((await stat(ticketPath)).size > 6 * 1024 * 1024) throw new Error("Fixture Bot Controller ticket is too large.");
  let ticket: Ticket;
  try { ticket = proofs.parseLaunchTicket(JSON.parse(await readFile(ticketPath, "utf8"))); }
  catch { throw new Error("Fixture Bot Controller ticket is unavailable or invalid."); }
  if (ticket.executionId !== execution.executionId || ticket.launchId !== execution.launchId || ticket.controllerInstanceId !== intent.controllerInstanceId
    || ticket.executionGeneration !== intent.executionGeneration || ticket.sessionId !== intent.sessionId || ticket.controllerId !== intent.registration.controllerId
    || ticket.testExecutionId !== intent.registration.testExecutionId || ticket.ownerUserId !== record.ownerUserId || ticket.serverOrigin !== record.serverOrigin
    || ticket.claimId !== undefined || ticket.codexBotRecovery?.botId !== botId) throw new Error("Fixture Bot Controller ticket conflicts with the original execution.");
  await stopJournaledController({ journal, ticket, launchId: execution.launchId, controllerProcess: execution.controllerProcess,
    nativeProcesses: execution.snapshot?.nativeProcesses ?? [], nativeSessionId: execution.snapshot?.nativeSessionId ?? null }, proofs, deadline);
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
