import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalId } from "../../../api/parse.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { validateWorkerAgentMode, workerAgentControlMode } from "../../../api/worker-mode.js";
import type { ExecutionConfiguration as FrozenExecutionConfiguration, WorkerProject, ResourceOwner } from "../types.js";
import type { LocalTask, ClaimIdentity, CleanupState, WorktreeBinding, WebExecutionState, ExecutionSummary } from "./web-types.js";
import { backendResourcesClosed, taskAgentControlMode } from "./web-types.js";
const integer = (value: unknown, name: string, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer of at least ${minimum}.`);
  return value;
};
const text = (value: unknown, name: string, empty = false): string => {
  if (typeof value !== "string" || (!empty && value.trim().length === 0)) throw new Error(`${name} must be ${empty ? "a" : "a nonempty"} string.`);
  return value;
};
const id = (value: unknown, name: string): string => {
  const normalized = canonicalId(text(value, name));
  if (normalized === null) throw new Error(`${name} must be a UUID.`);
  return normalized;
};
const absolutePath = (value: unknown, name: string): string => {
  const result = text(value, name);
  if (!path.isAbsolute(result)) throw new Error(`${name} must be absolute.`);
  return result;
};
const bool = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`);
  return value;
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[], name: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} is invalid.`);
  return value as T;
};
const record = (value: unknown, fields: readonly string[], name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new Error(`${name} has invalid fields.`);
  return value as Record<string, unknown>;
};
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const version = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error("Remote version must be a positive int64 decimal string.");
  return value;
};
const parseConfiguration = (value: unknown): FrozenExecutionConfiguration => {
  const data = record(value, ["agent", "agentControlMode", "model", "args", "recoveryLimit"], "Frozen execution configuration");
  if (!Array.isArray(data.args)) throw new Error("Agent arguments must be an array.");
  const agentControlMode = workerAgentControlMode(data);
  return { agent: validateWorkerAgentMode(data.agent, agentControlMode), agentControlMode, model: nullable(data.model, (entry) => text(entry, "Model")),
    args: data.args.map((entry) => text(entry, "Agent argument", true)), recoveryLimit: integer(data.recoveryLimit, "Recovery limit") };
};
const parseWorktree = (value: unknown): WorktreeBinding => {
  const data = record(value, ["repositoryPath", "commonDirectory", "worktreePath", "branch"], "Worktree binding");
  return { repositoryPath: absolutePath(data.repositoryPath, "Repository path"), commonDirectory: absolutePath(data.commonDirectory, "Git common directory"), worktreePath: absolutePath(data.worktreePath, "Worktree path"), branch: text(data.branch, "Worktree branch") };
};
const parseCleanupBaseline = (value: unknown): NonNullable<CleanupState["baseline"]> => {
  const data = record(value, ["stateChangeSeq", "completionSeq"], "Cleanup completion baseline");
  return { stateChangeSeq: integer(data.stateChangeSeq, "Cleanup state-change sequence"), completionSeq: integer(data.completionSeq, "Cleanup completion sequence") };
};
const parseExecutionSummary = (value: unknown): ExecutionSummary => { if (value !== null) throw new Error("Web execution summaries are derived from fresh remote inventory."); return value as never; };
const parseWebExecution = (value: unknown): WebExecutionState => {
  const data = record(value, ["executionId", "registrationId", "controllerId", "controllerInstanceId", "launchId", "sessionId", "executionGeneration", "initialOperationId", "initialPrompt", "launchSubmission", "controllerProcess", "nativeProcesses", "cleanupOperationId", "ticketPath", ...["summary", "initialInputState", "activity", "nativeHome", "restartAfterShutdown"].filter(key => typeof value === "object" && value !== null && Object.hasOwn(value,key))], "Web execution");
  for (const key of ["executionId", "registrationId", "controllerId", "controllerInstanceId", "launchId", "initialOperationId"]) id(data[key], key);
  for (const key of ["sessionId", "cleanupOperationId"]) nullable(data[key], entry => id(entry, key));
  version(data.executionGeneration); oneOf(data.launchSubmission, ["not-submitted", "unknown", "acknowledged"], "Controller launch submission");
  nullable(data.initialPrompt, entry => text(entry, "Initial prompt")); nullable(data.ticketPath, entry => absolutePath(entry, "Controller ticket"));
  const proof = (value: unknown): void => { const hasJob = typeof value === "object" && value !== null && "jobObjectName" in value; const p = record(value, ["pid", "parentPid", "processGroupId", "startedAt", "commandHash", ...(hasJob ? ["jobObjectName"] : [])], "Process proof"); if (hasJob && (typeof p.jobObjectName !== "string" || !/^Local\\Daynight-[0-9a-f-]{36}$/.test(p.jobObjectName))) throw new Error("Invalid Windows job identity."); integer(p.pid, "Process ID", 1); integer(p.parentPid, "Parent ID"); nullable(p.processGroupId, entry => integer(entry, "Process group", 1)); text(p.startedAt, "Process creation"); if (typeof p.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(p.commandHash)) throw new Error("Invalid process command proof."); };
  if (data.controllerProcess !== null) proof(data.controllerProcess);
  if (!Array.isArray(data.nativeProcesses)) throw new Error("Native process evidence must be an array."); data.nativeProcesses.forEach(proof);
  data.restartAfterShutdown ??= false; bool(data.restartAfterShutdown, "Orderly controller restart");
  data.nativeHome ??= null; nullable(data.nativeHome, entry => absolutePath(entry, "Native profile home"));
  data.summary ??= null; data.initialInputState ??= "unknown"; data.activity ??= "unknown";
  nullable(data.summary, parseExecutionSummary);
  oneOf(data.initialInputState, ["not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"], "Initial input state");
  oneOf(data.activity, ["initializing", "idle", "working", "waiting_input", "stopped", "unknown"], "Controller activity");
  return data as WebExecutionState;
};
const parseCleanup = (value: unknown): CleanupState => {
  const web = typeof value === "object" && value !== null && "mode" in value && value.mode === "web";
  const data = record(value, ["kind", "startedAt", "deadline", "input", "baseline", "result", "error", "agentStopped", "workspaceClosed", "worktreeDeleted", ...(web ? ["mode", "backendResourcesClosed"] : [])], "Cleanup state");
  if (web && data.workspaceClosed !== null) throw new Error("Web cleanup cannot carry a Herdr workspace closure.");
  const result: CleanupState = { kind: oneOf(data.kind, ["terminal", "shutdown"], "Cleanup kind"), startedAt: integer(data.startedAt, "Cleanup start"), deadline: integer(data.deadline, "Cleanup deadline"),
    input: oneOf(data.input, ["not-submitted", "unknown", "submitted", "rejected", "unavailable"], "Cleanup input state"),
    baseline: nullable(data.baseline, parseCleanupBaseline),
    result: nullable(data.result, (entry) => oneOf(entry, ["completed", "timed-out", "failed", "unavailable"], "Cleanup result")), error: nullable(data.error, (entry) => text(entry, "Cleanup error")),
    agentStopped: bool(data.agentStopped, "Agent stopped"), workspaceClosed: web && data.workspaceClosed === null ? null : bool(data.workspaceClosed, "Workspace closed"), ...(web ? { mode: "web" as const, backendResourcesClosed: bool(data.backendResourcesClosed, "Backend resources closed") } : {}), worktreeDeleted: bool(data.worktreeDeleted, "Worktree deleted") };
  if (result.deadline < result.startedAt || result.deadline - result.startedAt > 600_000) throw new Error("Cleanup deadline must be within ten minutes of its original start.");
  if ((backendResourcesClosed(result) && !result.agentStopped) || (result.worktreeDeleted && !backendResourcesClosed(result))) throw new Error("Cleanup progress is out of order.");
  if (result.baseline !== null && result.input !== "submitted") throw new Error("A cleanup completion baseline requires confirmed input submission.");
  return result;
};

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const key = (identity: ClaimIdentity): string => [identity.projectId, identity.taskId, identity.claimId].map(value => id(value, "Execution identity")).join("/");
const validate = (task: LocalTask): LocalTask => {
  record(task, ["projectId", "taskId", "claimId", "worktreeId", "serverOrigin", "workerId", "userId", "status", "repoUrl", "repositoryPath", "configuration", "resources", "nativeExecution", "webExecution", "recovery", "cleanup", "control", "createdAt", "updatedAt"], "Web execution record");
  key(task); normalizeServerUrl(task.serverOrigin); id(task.workerId, "Worker ID"); id(task.worktreeId, "Worktree ID");
  nullable(task.userId, value => id(value, "Execution owner"));
  if (task.configuration === null || task.configuration.agentControlMode !== "web") throw new Error("Web execution requires its frozen configuration.");
  parseConfiguration(task.configuration);
  text(task.repoUrl, "Repository URL"); absolutePath(task.repositoryPath, "Repository path");
  integer(task.createdAt, "Execution creation time"); integer(task.updatedAt, "Execution update time");
  record(task.resources, ["mode", "worktree", "herdr", "nativeSession"], "Web resources");
  if (task.resources.mode !== "web" || task.resources.herdr !== null || task.nativeExecution !== null || task.control !== null) throw new Error("Web execution contains incompatible backend resources.");
  if (task.resources.nativeSession !== null) { const native = record(task.resources.nativeSession, ["source", "sessionId"], "Native session"); if (native.source !== "controller") throw new Error("The native session does not belong to the Controller."); id(native.sessionId, "Native session ID"); }
  record(task.recovery, ["count", "pauseReason", "retryAuthorized"], "Recovery state"); integer(task.recovery.count, "Recovery count"); nullable(task.recovery.pauseReason, value => text(value, "Recovery pause")); bool(task.recovery.retryAuthorized, "Recovery authorization");
  oneOf(task.status, ["pending", "active", "done"], "Web execution state");
  nullable(task.resources.worktree, parseWorktree); nullable(task.cleanup, parseCleanup); nullable(task.webExecution, parseWebExecution);
  return task;
};
// This store contains Controller delivery and stop evidence only. Claim scheduling remains in the minimal Worker store.
export const openWebExecutionStore = (filename: string) => {
  const db = new Database(filename);
  try { db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL"); db.exec("CREATE TABLE IF NOT EXISTS executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;"); }
  catch (error) { db.close(); throw error; }
  const getTask = (identity: ClaimIdentity): LocalTask | null => {
    const row = db.prepare("SELECT data FROM executions WHERE identity = ?").get(key(identity)) as { data: string } | undefined;
    return row === undefined ? null : validate(JSON.parse(row.data) as LocalTask);
  };
  const write = (task: LocalTask): LocalTask => { validate(task); db.prepare("INSERT INTO executions(identity,data) VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data").run(key(task), JSON.stringify(task)); return getTask(task)!; };
  const change = (identity: ClaimIdentity, now: number, operation: (task: LocalTask) => LocalTask): LocalTask => db.transaction(() => {
    const task = getTask(identity); if (task === null || task.status === "done") throw new Error("The original Web execution is missing or done.");
    return write({ ...operation(task), updatedAt: integer(now, "Execution time") });
  }).immediate();
  const requireOrdinary = (task: LocalTask): void => { if (task.cleanup !== null || task.configuration === null) throw new Error("Cleanup fences ordinary execution."); };
  const needCleanup = (task: LocalTask): CleanupState => { if (task.cleanup === null) throw new Error("Cleanup has not started."); return task.cleanup; };
  return {
    close: (): void => { db.close(); }, getTask,
    listUnfinishedTasks: (): LocalTask[] => (db.prepare("SELECT data FROM executions").all() as { data: string }[]).map(row => validate(JSON.parse(row.data) as LocalTask)).filter(task => task.status !== "done"),
    register: (input: ResourceOwner & { project: WorkerProject; serverOrigin: string; workerId: string; userId: string; configuration: FrozenExecutionConfiguration }, now: number): LocalTask => db.transaction(() => {
      const existing = getTask(input);
      if (existing !== null) {
        if (existing.worktreeId !== input.worktreeId || existing.serverOrigin !== input.serverOrigin || existing.workerId !== input.workerId || existing.userId !== input.userId || existing.configuration?.agent !== input.configuration.agent || existing.repositoryPath !== input.project.localPath || existing.repoUrl !== input.project.repoUrl) throw new Error("The frozen Web execution does not match the original claim.");
        return existing;
      }
      return write({ projectId: input.projectId, taskId: input.taskId, claimId: input.claimId, worktreeId: input.worktreeId, serverOrigin: input.serverOrigin, workerId: input.workerId, userId: input.userId, status: "active", repoUrl: input.project.repoUrl, repositoryPath: input.project.localPath, configuration: { ...input.configuration, agentControlMode: "web" }, resources: { mode: "web", worktree: null, herdr: null, nativeSession: null }, nativeExecution: null, webExecution: null, recovery: { count: 0, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null, createdAt: now, updatedAt: now });
    }).immediate(),
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
