import { parseStartupObservation, type StartupObservation, type SessionStartupReport } from "../../../session/startup.js";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import type { ExecutionConfiguration as FrozenExecutionConfiguration, WorkerProject, ResourceOwner } from "../types.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import type { LocalTask, ClaimIdentity, CleanupState, WorktreeBinding, WebExecutionState, RecoveryState } from "./web-types.js";
import { webRecordInteger as integer, webRecordChoice as oneOf, webRecordText as text, webRecordId as id, parseWebWorktreeV1 as parseWorktree, parseWebExecutionV1 as parseWebExecution, parseWebCleanupV1 as parseCleanup, webClaimKey as key, parseWebTaskV1 as validate } from "./web-record.js";
import { webExecutionStoreFormat } from "./web-store-format.js";
import { continuingInitialGeneration, healthyOriginalGeneration, stoppedOriginalGeneration, legacyBranchLatch, orchestrationIdentity, sameOrchestrationIdentity, type OrchestrationBlocker, type OrchestrationFailure } from "./orchestration.js";

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
// The Worker owns Web execution state here; claim scheduling stays in the minimal index.
export const openWebExecutionStore = (filename: string, options: { onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file: filename, format: webExecutionStoreFormat, allowCreate: true,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  const atomic = <T>(operation: () => T): T => {
    let guardFailure: unknown;
    try {
      return db.transaction(() => {
        try { assertCurrentSqlite(db, webExecutionStoreFormat); }
        catch (error) { guardFailure = error; throw error; }
        return operation();
      }).immediate();
    } catch (error) {
      if (guardFailure !== undefined && error !== guardFailure) throw new AggregateError([guardFailure, error], "Web SQLite format assertion and rollback failed.");
      throw error;
    }
  };
  const read = <T>(operation: () => T): T => {
    if (db.inTransaction) { assertCurrentSqlite(db, webExecutionStoreFormat); return operation(); }
    return db.transaction(() => { assertCurrentSqlite(db, webExecutionStoreFormat); return operation(); }).deferred();
  };
  const getTask = (identity: ClaimIdentity): LocalTask | null => read(() => {
    const row = db.prepare("SELECT data FROM executions WHERE identity = ?").get(key(identity)) as { data: string } | undefined;
    return row === undefined ? null : validate(JSON.parse(row.data) as LocalTask);
  });
  const write = (task: LocalTask): LocalTask => { validate(task); db.prepare("INSERT INTO executions(identity,data) VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data").run(key(task), JSON.stringify(task)); return getTask(task)!; };
  const change = (identity: ClaimIdentity, now: number, operation: (task: LocalTask) => LocalTask): LocalTask => atomic(() => {
    const task = getTask(identity); if (task === null || task.status === "done") throw new Error("The original Web execution is missing or done.");
    return write({ ...operation(task), updatedAt: integer(now, "Execution time") });
  });
  const requireOrdinary = (task: LocalTask): void => { if (task.cleanup !== null || task.configuration === null) throw new Error("Cleanup fences ordinary execution."); };
  const needCleanup = (task: LocalTask): CleanupState => { if (task.cleanup === null) throw new Error("Cleanup has not started."); return task.cleanup; };
  const getOrchestrationBlocker = (identity: ClaimIdentity): OrchestrationBlocker | null => read(() => {
    const row = db.prepare("SELECT data FROM orchestration_blockers WHERE identity=?").get(key(identity)) as { data: string } | undefined;
    if (row === undefined) return null;
    const value = JSON.parse(row.data) as OrchestrationBlocker;
    oneOf(value.source, ["worktree", "coordinator", "legacy_worktree"], "Orchestration source");
    oneOf(value.code, ["branch_mismatch", "validation_failed", "advance_failed"], "Orchestration reason");
    text(value.message, "Orchestration failure"); integer(value.observedAt, "Orchestration observation");
    if (value.identity === null || typeof value.identity !== "object") throw new Error("Orchestration ownership evidence is missing.");
    return value;
  });
  return {
    close: (): void => { closeSqliteDatabase(db, { file: filename, format: webExecutionStoreFormat }); }, getTask, getOrchestrationBlocker,
    blockOrchestration: (identity: ClaimIdentity, failure: OrchestrationFailure, now: number): OrchestrationBlocker => atomic(() => {
      const task = getTask(identity);
      if (task === null || task.status !== "active" || task.cleanup !== null) throw new Error("Orchestration failure requires the original active execution.");
      const previous = getOrchestrationBlocker(identity);
      if (previous !== null) {
        if (!sameOrchestrationIdentity(task, previous)) throw new Error("The blocked orchestration belongs to another execution identity.");
        return previous;
      }
      const blocker: OrchestrationBlocker = { ...failure, identity: orchestrationIdentity(task), observedAt: integer(now, "Orchestration observation") };
      db.prepare("INSERT INTO orchestration_blockers(identity,data) VALUES (?,?)").run(key(identity), JSON.stringify(blocker));
      return getOrchestrationBlocker(identity)!;
    }),
    clearOrchestration: (identity: ClaimIdentity, expected: OrchestrationBlocker, observed: ControllerSnapshot | null, now: number, legacyReport?: SessionStartupReport): LocalTask => atomic(() => {
      const task = getTask(identity);
      if (task === null || task.status !== "active") throw new Error("The original active orchestration is missing.");
      requireOrdinary(task);
      if (!same(expected, getOrchestrationBlocker(identity)) || !sameOrchestrationIdentity(task, expected)) throw new Error("The blocked orchestration changed during verification.");
      const execution = task.webExecution;
      const stoppedRecovery = observed !== null && stoppedOriginalGeneration(task, observed)
        && (task.recovery.retryAuthorized || (expected.source !== "legacy_worktree" && task.recovery.pauseReason === null));
      const correctLegacyLatch = expected.source === "legacy_worktree" && !stoppedRecovery;
      const initialContinuation = expected.source !== "legacy_worktree" && observed !== null && continuingInitialGeneration(task, observed);
      if (execution?.launchSubmission !== undefined && execution.launchSubmission !== "not-submitted" && !stoppedRecovery && !initialContinuation && (observed === null || !healthyOriginalGeneration(task, observed))) throw new Error("Orchestration recovery requires the healthy original generation or an authorized proven stop.");
      if (correctLegacyLatch && (!legacyBranchLatch(task) || legacyReport === undefined || !same(legacyReport, execution?.startupReport))) throw new Error("A native recovery block cannot be cleared without the original legacy report revision.");
      const recovery = correctLegacyLatch ? { count: task.recovery.count, pauseReason: null, retryAuthorized: false } : task.recovery;
      const previous = execution?.startupReport;
      const report = previous === undefined ? undefined : { ...previous, revision: String(BigInt(previous.revision) + 1n), observedAt: new Date(integer(now, "Orchestration verification")).toISOString(), recovery: recovery.pauseReason === null ? { state: "none" as const, reasonCode: null } : { state: "blocked" as const, reasonCode: task.recovery.reasonCode ?? "recovery_blocked" as const } };
      const result = write({ ...task, recovery, updatedAt: now, webExecution: execution === null ? null : { ...execution, ...(report === undefined ? {} : { startupReport: report }) } });
      db.prepare("DELETE FROM orchestration_blockers WHERE identity=?").run(key(identity));
      return result;
    }),
    listCompletedTasks: (): LocalTask[] => read(() => (db.prepare("SELECT data FROM executions").all() as { data: string }[]).map(row => validate(JSON.parse(row.data) as LocalTask)).filter(task => task.status === "done")),
    listUnfinishedTasks: (): LocalTask[] => read(() => (db.prepare("SELECT data FROM executions").all() as { data: string }[]).map(row => validate(JSON.parse(row.data) as LocalTask)).filter(task => task.status !== "done")),
    register: (input: ResourceOwner & { project: WorkerProject; serverOrigin: string; workerId: string; userId: string; configuration: FrozenExecutionConfiguration }, now: number): LocalTask => atomic(() => {
      const existing = getTask(input);
      if (existing !== null) {
        if (existing.worktreeId !== input.worktreeId || existing.serverOrigin !== input.serverOrigin || existing.workerId !== input.workerId || existing.userId !== input.userId || existing.configuration?.agent !== input.configuration.agent || existing.repositoryPath !== input.project.localPath || existing.repoUrl !== input.project.repoUrl) throw new Error("The frozen Web execution does not match the original claim.");
        return existing;
      }
      return write({ projectId: input.projectId, taskId: input.taskId, claimId: input.claimId, worktreeId: input.worktreeId, serverOrigin: input.serverOrigin, workerId: input.workerId, userId: input.userId, status: "active", repoUrl: input.project.repoUrl, repositoryPath: input.project.localPath, configuration: { ...input.configuration, agentControlMode: "web" }, resources: { mode: "web", worktree: null, herdr: null, nativeSession: null }, nativeExecution: null, webExecution: null, recovery: { count: 0, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null, createdAt: now, updatedAt: now });
    }),
    clearShutdown: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      const cleanup = task.cleanup;
      if (cleanup === null) return task;
      if (cleanup.kind !== "shutdown") throw new Error("Terminal cleanup cannot resume ordinary execution.");
      return { ...task, cleanup: null, webExecution: task.webExecution === null ? null : { ...task.webExecution, restartAfterShutdown: true } };
    }),
    beginRecovery: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active") throw new Error("Only an active execution can recover.");
      const recovery = task.recovery;
      if (recovery.retryAuthorized) throw new Error("An explicit retry must consume its authorization with the original generation transition.");
      if (recovery.pauseReason !== null) return task;
      if (task.configuration === null) throw new Error("The original frozen execution configuration is missing.");
      if (recovery.count >= task.configuration.recoveryLimit) return { ...task, recovery: { ...recovery, pauseReason: "The execution recovery budget is exhausted.", retryAuthorized: false, reasonCode: "recovery_limit" } };
      return { ...task, recovery: { count: integer(recovery.count + 1, "Recovery count"), pauseReason: null, retryAuthorized: false } };
    }),
    pauseRecovery: (identity: ClaimIdentity, reason: string, now: number, reasonCode?: RecoveryState["reasonCode"]): LocalTask => change(identity, now, task => {
      if (task.status !== "active") throw new Error("Only an active execution can pause recovery.");
      const { reasonCode: previousCode, ...recovery } = task.recovery; void previousCode;
      return { ...task, recovery: { ...recovery, pauseReason: text(reason, "Recovery pause reason"), retryAuthorized: false, ...(reasonCode === undefined ? {} : { reasonCode }) } };
    }),
    authorizeRecoveryRetry: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      requireOrdinary(task);
      if (task.recovery.retryAuthorized) return task;
      // A reason marks unconsumed authorization; clearing it with a new generation marks the one in-flight attempt.
      return { ...task, recovery: { ...task.recovery, pauseReason: task.recovery.pauseReason ?? "An explicit recovery retry is awaiting original process stop verification.", retryAuthorized: true } };
    }),
    completeRecoveryRetry: (identity: ClaimIdentity, observed: ControllerSnapshot, now: number): LocalTask => change(identity, now, task => {
      requireOrdinary(task);
      const execution = task.webExecution;
      if (execution === null || (observed.lifecycle !== "ready" && observed.lifecycle !== "working") || observed.executionId !== execution.executionId || observed.claimId !== task.claimId || observed.executionGeneration !== execution.executionGeneration || observed.controllerInstanceId !== execution.controllerInstanceId || observed.nativeSessionId === null || observed.nativeSessionId !== task.resources.nativeSession?.sessionId || task.recovery.pauseReason !== null) throw new Error("Explicit recovery completion requires the ready original generation and native identity.");
      return { ...task, recovery: { ...task.recovery, retryAuthorized: false } };
    }),
    bindNativeSession: (identity: ClaimIdentity, reference: { source: "controller"; sessionId: string }, now: number): LocalTask => change(identity, now, task => {
      id(reference.sessionId, "Native session");
      if (task.resources.nativeSession !== null && task.resources.nativeSession.sessionId !== reference.sessionId) throw new Error("The original native session cannot be replaced.");
      return { ...task, resources: { ...task.resources, nativeSession: reference } };
    }),
    completeTask: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "terminal") throw new Error("Web completion requires terminal cleanup intent.");
      return { ...task, status: "done" };
    }),
    initializeWebExecution: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      if (task.configuration?.agentControlMode !== "web" || task.status !== "active") throw new Error("Web execution requires its active frozen claim.");
      if (task.webExecution != null) return task;
      return { ...task, nativeExecution: null, webExecution: { executionId: randomUUID(), registrationId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), launchId: randomUUID(), sessionId: null, executionGeneration: "1", initialOperationId: randomUUID(), initialPrompt: null, launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, nativeHome: null, summary: null, initialInputState: "not_submitted", activity: "initializing" } };
    }),
    observeStartup: (identity: ClaimIdentity & Partial<Pick<LocalTask, "webExecution">>, startup: StartupObservation, now: number): SessionStartupReport | null => atomic(() => {
      const task = getTask(identity), execution = task?.webExecution;
      if (task === null || execution == null || execution.sessionId === null || task.status === "done") return null;
      if (identity.webExecution != null && (identity.webExecution.executionGeneration !== execution.executionGeneration || identity.webExecution.controllerInstanceId !== execution.controllerInstanceId || identity.webExecution.sessionId !== execution.sessionId)) throw new Error("Startup observation belongs to another execution generation.");
      const observation = parseStartupObservation(startup);
      const recovery: SessionStartupReport["recovery"] = task.recovery.pauseReason === null
        ? { state: "none", reasonCode: null }
        : { state: "blocked", reasonCode: task.recovery.reasonCode ?? "recovery_blocked" };
      const previous = execution.startupReport;
      if (previous !== undefined && same(previous.startup, observation) && same(previous.recovery, recovery)) return previous;
      const report: SessionStartupReport = { schemaVersion: 1, source: "worker", sessionId: execution.sessionId, claimId: task.claimId,
        executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId,
        revision: String(BigInt(previous?.revision ?? "0") + 1n), observedAt: new Date(integer(now, "Startup observation time")).toISOString(), startup: observation, recovery };
      return write({ ...task, updatedAt: now, webExecution: { ...execution, startupReport: report } }).webExecution!.startupReport!;
    }),
    updateWebExecution: (identity: ClaimIdentity, patch: Partial<WebExecutionState>, now: number): LocalTask => change(identity, now, task => {
      if (task.configuration?.agentControlMode !== "web" || task.webExecution == null) throw new Error("The web execution identity is missing.");
      const previous = task.webExecution;
      if (patch.restartAfterShutdown !== undefined && patch.restartAfterShutdown !== previous.restartAfterShutdown) throw new Error("Orderly restart provenance requires confirmed shutdown.");
      for (const key of ["executionGeneration", "controllerInstanceId", "launchId"] as const) if (patch[key] !== undefined && patch[key] !== previous[key]) throw new Error("A new web generation requires verified original process stop.");
      for (const key of ["executionId", "registrationId", "controllerId", "initialOperationId"] as const) if (patch[key] !== undefined && patch[key] !== previous[key]) throw new Error("The web execution identity cannot be replaced.");
      if (previous.nativeHome !== null && patch.nativeHome !== undefined && patch.nativeHome !== previous.nativeHome) throw new Error("The original native profile cannot change.");
      if (previous.initialPrompt !== null && patch.initialPrompt !== undefined && patch.initialPrompt !== previous.initialPrompt) throw new Error("The original managed prompt cannot change.");
      if (previous.sessionId !== null && patch.sessionId !== undefined && patch.sessionId !== previous.sessionId) throw new Error("The registered session cannot change.");
      return { ...task, webExecution: parseWebExecution({ ...previous, ...patch }) };
    }),
    beginWebGeneration: (identity: ClaimIdentity, previous: { executionGeneration: string; controllerInstanceId: string; nativeSessionId: string | null; nativeStopped: boolean }, now: number): LocalTask => change(identity, now, task => {
      requireOrdinary(task); const execution = task.webExecution;
      if (execution == null || task.configuration?.agentControlMode !== "web" || previous.executionGeneration !== execution.executionGeneration || previous.controllerInstanceId !== execution.controllerInstanceId || !previous.nativeStopped || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession?.sessionId) throw new Error("Web recovery requires the exact stopped generation and native identity.");
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) throw new Error("The paused execution requires an explicit recovery retry.");
      if (task.recovery.retryAuthorized && task.recovery.pauseReason === null) throw new Error("The authorized recovery generation is still awaiting a successful observation.");
      // Persist consumption and its sole replacement identity together across Worker interruption.
      const recovery = task.recovery.retryAuthorized ? { count: integer(task.recovery.count + 1, "Recovery count"), pauseReason: null, retryAuthorized: true } : task.recovery;
      const { startupReport: previousReport, ...previousExecution } = execution; void previousReport;
      return { ...task, recovery, webExecution: { ...previousExecution, executionGeneration: String(BigInt(execution.executionGeneration) + 1n), controllerInstanceId: randomUUID(), launchId: randomUUID(), launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, activity: "initializing" } };
    }),
    retryUnsubmittedWebGeneration: (identity: ClaimIdentity, previous: ControllerSnapshot, now: number): LocalTask => change(identity, now, task => {
      requireOrdinary(task); const execution = task.webExecution;
      if (execution === null || task.status !== "active" || !task.recovery.retryAuthorized || task.recovery.pauseReason === null || execution.launchSubmission !== "not-submitted" || execution.controllerProcess !== null || execution.nativeProcesses.length !== 0 || previous.executionId !== execution.executionId || previous.claimId !== task.claimId || previous.sessionId !== execution.sessionId || String(BigInt(previous.executionGeneration) + 1n) !== execution.executionGeneration || previous.controllerInstanceId === execution.controllerInstanceId || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession?.sessionId || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null || previous.controllerProcess === null) throw new Error("Unsubmitted recovery requires the exact preceding stopped generation and no current launch evidence.");
      // A failed preparation retains the allocated launch intent; another explicit allowance cannot allocate it again.
      return { ...task, recovery: { count: integer(task.recovery.count + 1, "Recovery count"), pauseReason: null, retryAuthorized: true }, webExecution: { ...execution, restartAfterShutdown: false, activity: "initializing" } };
    }),
    bindWorktree: (identity: ClaimIdentity, binding: WorktreeBinding, now: number): LocalTask => change(identity, now, (task) => {
      if (task.status !== "active") throw new Error("Resource creation requires an active execution.");
      const value = parseWorktree(binding);
      if (value.repositoryPath !== task.repositoryPath) throw new Error("The worktree repository does not match the original project binding.");
      if (task.resources.worktree !== null && !same(task.resources.worktree, value)) throw new Error("The execution already has a different worktree binding.");
      return { ...task, resources: { ...task.resources, worktree: value } };
    }),
    beginCleanup: (identity: ClaimIdentity, input: { kind: CleanupState["kind"]; deadline: number }, now: number): LocalTask => change(identity, now, (task) => {
      oneOf(input.kind, ["terminal", "shutdown"], "Cleanup kind");
      const existing = task.cleanup;
      if (existing !== null) return { ...task, cleanup: { ...existing, kind: existing.kind === "terminal" ? "terminal" : input.kind } };
      if (task.control !== null && input.kind !== "terminal") throw new Error("A source control intent requires terminal cleanup.");
      return { ...task, status: "active", cleanup: parseCleanup({ kind: input.kind, startedAt: now, deadline: input.deadline }) };
    }),

  };
};
export type WebExecutionStore = ReturnType<typeof openWebExecutionStore>;
