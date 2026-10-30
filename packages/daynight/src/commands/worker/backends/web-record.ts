import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import { normalizeServerUrl } from "../../../config/server.js";
import type { ExecutionConfiguration as FrozenExecutionConfiguration } from "../types.js";
import type { LocalTask, ClaimIdentity, CleanupState, WorktreeBinding, WebExecutionState, ExecutionSummary } from "./web-types.js";
import { backendResourcesClosed } from "./web-types.js";

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
  const agentControlMode = oneOf(data.agentControlMode, ["web"], "Web agent control mode");
  return { agent: oneOf(data.agent, ["copilot", "codex", "claude"], "Web execution agent"), agentControlMode, model: nullable(data.model, (entry) => text(entry, "Model")),
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

const key = (identity: ClaimIdentity): string => [identity.projectId, identity.taskId, identity.claimId].map(value => id(value, "Execution identity")).join("/");
// Baseline adoption uses this parser without rewriting records; new persisted contracts require a separate parser.
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

export {
  integer as webRecordInteger,
  oneOf as webRecordChoice,
  text as webRecordText,
  id as webRecordId,
  parseWorktree as parseWebWorktreeV1,
  parseWebExecution as parseWebExecutionV1,
  parseCleanup as parseWebCleanupV1,
  key as webClaimKey,
  validate as parseWebTaskV1,
};
