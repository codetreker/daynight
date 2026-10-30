import { randomUUID } from "node:crypto";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import type { ExecutionConfiguration as FrozenExecutionConfiguration, WorkerProject, ResourceOwner } from "../types.js";
import type { LocalTask, ClaimIdentity, CleanupState, WorktreeBinding, WebExecutionState } from "./web-types.js";
import { backendResourcesClosed, taskAgentControlMode } from "./web-types.js";
import { webRecordInteger as integer, webRecordChoice as oneOf, webRecordText as text, webRecordId as id, parseWebWorktreeV1 as parseWorktree, parseWebExecutionV1 as parseWebExecution, parseWebCleanupV1 as parseCleanup, webClaimKey as key, parseWebTaskV1 as validate } from "./web-record.js";
import { webExecutionStoreFormat } from "./web-store-format.js";

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
// The Worker owns Web execution state here; claim scheduling stays in the minimal index.
export const openWebExecutionStore = (filename: string, options: { onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file: filename, format: webExecutionStoreFormat, allowEmpty: true,
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
  return {
    close: (): void => { closeSqliteDatabase(db, { file: filename, format: webExecutionStoreFormat }); }, getTask,
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
      if (cleanup.kind !== "shutdown" || !cleanup.agentStopped || !backendResourcesClosed(cleanup)) throw new Error("The original cleanup has not completed.");
      return { ...task, cleanup: null, webExecution: task.webExecution === null ? null : { ...task.webExecution, restartAfterShutdown: true } };
    }),
    beginRecovery: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active") throw new Error("Only an active execution can recover.");
      const recovery = task.recovery;
      if (recovery.pauseReason !== null && !recovery.retryAuthorized) throw new Error("The paused execution requires an explicit recovery retry.");
      if (task.configuration === null) throw new Error("The original frozen execution configuration is missing.");
      if (recovery.count >= task.configuration.recoveryLimit && !recovery.retryAuthorized) throw new Error("The execution recovery budget is exhausted.");
      return { ...task, recovery: { count: integer(recovery.count + 1, "Recovery count"), pauseReason: null, retryAuthorized: false } };
    }),
    authorizeRecoveryRetry: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => { requireOrdinary(task); return { ...task, recovery: { ...task.recovery, retryAuthorized: true } }; }),
    bindNativeSession: (identity: ClaimIdentity, reference: { source: "controller"; sessionId: string }, now: number): LocalTask => change(identity, now, task => {
      id(reference.sessionId, "Native session");
      if (task.resources.nativeSession !== null && task.resources.nativeSession.sessionId !== reference.sessionId) throw new Error("The original native session cannot be replaced.");
      return { ...task, resources: { ...task.resources, nativeSession: reference } };
    }),
    completeTask: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "terminal" || !cleanup.agentStopped || !backendResourcesClosed(cleanup) || !cleanup.worktreeDeleted) throw new Error("Web completion requires original resources to be stopped and removed.");
      return { ...task, status: "done" };
    }),
    initializeWebExecution: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      if (task.configuration?.agentControlMode !== "web" || task.status !== "active") throw new Error("Web execution requires its active frozen claim.");
      if (task.webExecution != null) return task;
      return { ...task, nativeExecution: null, webExecution: { executionId: randomUUID(), registrationId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), launchId: randomUUID(), sessionId: null, executionGeneration: "1", initialOperationId: randomUUID(), initialPrompt: null, launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, nativeHome: null, summary: null, initialInputState: "not_submitted", activity: "initializing" } };
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
      return { ...task, webExecution: { ...execution, executionGeneration: String(BigInt(execution.executionGeneration) + 1n), controllerInstanceId: randomUUID(), launchId: randomUUID(), launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, activity: "initializing" } };
    }),
    confirmBackendResourcesClosed: (identity: ClaimIdentity, proof: { controllerStopped: true; endpointClosed: true }, now: number): LocalTask => change(identity, now, task => {
      const cleanup = needCleanup(task);
      if (cleanup.mode !== "web" || !cleanup.agentStopped || proof.controllerStopped !== true || proof.endpointClosed !== true) throw new Error("Web resource closure requires stopped original controller and endpoint.");
      return { ...task, cleanup: { ...cleanup, backendResourcesClosed: true } };
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
      return { ...task, status: "active", cleanup: parseCleanup({ kind: input.kind, startedAt: now, deadline: input.deadline, input: "not-submitted", baseline: null, result: null, error: null, agentStopped: false, workspaceClosed: taskAgentControlMode(task) === "web" ? null : false, ...(taskAgentControlMode(task) === "web" ? { mode: "web" as const, backendResourcesClosed: false } : {}), worktreeDeleted: false }) };
    }),
    markCleanupInputSubmitting: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (cleanup.input !== "not-submitted" || cleanup.agentStopped || cleanup.result !== null) throw new Error("Cleanup input cannot be submitted again or after cleanup completion or agent stop.");
      if (now >= cleanup.deadline) throw new Error("The original cleanup deadline has elapsed; no new input may be submitted.");
      return { ...task, cleanup: { ...cleanup, input: "unknown" } };
    }),
    recordCleanupInputOutcome: (identity: ClaimIdentity, input: "submitted" | "rejected" | "unavailable", now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      oneOf(input, ["submitted", "rejected", "unavailable"], "Cleanup input outcome");
      if (cleanup.input !== "unknown" && !(cleanup.input === "not-submitted" && input === "unavailable") && cleanup.input !== input) throw new Error("The cleanup input outcome conflicts with the original submission.");
      return { ...task, cleanup: { ...cleanup, input } };
    }),
    recordCleanupResult: (identity: ClaimIdentity, result: NonNullable<CleanupState["result"]>, error: string | null, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      oneOf(result, ["completed", "timed-out", "failed", "unavailable"], "Cleanup result");
      if (cleanup.result !== null && cleanup.result !== result) throw new Error("The original cleanup result cannot be replaced.");
      if (result === "timed-out" && now < cleanup.deadline) throw new Error("The original cleanup deadline has not elapsed.");
      return { ...task, cleanup: { ...cleanup, result, error: error === null ? null : text(error, "Cleanup error") } };
    }),
    confirmAgentStopped: (identity: ClaimIdentity, proof: { agentStopped: true }, now: number): LocalTask => change(identity, now, (task) => {
      if (proof.agentStopped !== true) throw new Error("The caller must confirm the original agent has stopped.");
      return { ...task, cleanup: { ...needCleanup(task), agentStopped: true } };
    }),
    confirmWorktreeDeleted: (identity: ClaimIdentity, proof: { worktreeDeleted: true }, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "terminal" || !backendResourcesClosed(cleanup) || proof.worktreeDeleted !== true) throw new Error("Worktree deletion requires confirmed workspace closure and terminal cleanup.");
      return { ...task, cleanup: { ...cleanup, worktreeDeleted: true } };
    }),
  };
};
export type WebExecutionStore = ReturnType<typeof openWebExecutionStore>;
