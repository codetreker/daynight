import path from "node:path";
import Database from "better-sqlite3";
import { canonicalId } from "../../api/parse.js";
import { normalizeServerUrl } from "../../config/server.js";
import type { WorkerHerdr } from "../../api/types.js";
import { parseHerdrExecutionLabel } from "./herdr/agents.js";
import type { HerdrLaunchEvidence, HerdrStopObservation, HerdrTaskBinding, HerdrWorkspaceEvidence } from "./herdr/agents.js";
import type { ClaimAttempt, ClaimIdentity, CleanupState, ControlIntent, ControlState, ExecutionResources, ExecutionSummary, FrozenExecutionConfiguration, LocalTask, NativeExecutionState, NativeSessionReference, PendingClaim, PendingConfiguration, ProjectIdentity, RecoveryState, WorkerProject, WorkerProjectRecord, WorktreeBinding } from "./types.js";

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
const exactVersion = (value: bigint): string => {
  if (typeof value !== "bigint") throw new Error("Remote version must be provided as bigint.");
  return version(value.toString());
};
const projectKey = (value: ProjectIdentity): ProjectIdentity => ({ serverOrigin: normalizeServerUrl(value.serverOrigin), projectId: id(value.projectId, "Project ID") });
const claimKey = (value: ClaimIdentity): ClaimIdentity => ({ ...projectKey(value), taskId: id(value.taskId, "Task ID"), claimId: id(value.claimId, "Claim ID") });
const parseConfiguration = (value: unknown): FrozenExecutionConfiguration => {
  const data = record(value, ["agent", "model", "args", "recoveryLimit"], "Frozen execution configuration");
  if (!Array.isArray(data.args)) throw new Error("Agent arguments must be an array.");
  return { agent: oneOf(data.agent, ["copilot", "codex"], "Agent"), model: nullable(data.model, (entry) => text(entry, "Model")),
    args: data.args.map((entry) => text(entry, "Agent argument", true)), recoveryLimit: integer(data.recoveryLimit, "Recovery limit") };
};
const parseClaimAttempt = (value: unknown): ClaimAttempt => {
  const data = record(value, ["taskId", "claimId", "worktreeId", "workerId", "userId", "expectedVersion", "configuration"], "Claim attempt");
  return { taskId: id(data.taskId, "Attempt task ID"), claimId: id(data.claimId, "Attempt claim ID"), worktreeId: id(data.worktreeId, "Attempt worktree ID"), workerId: id(data.workerId, "Attempt worker ID"), userId: id(data.userId, "Attempt user ID"), expectedVersion: version(data.expectedVersion), configuration: parseConfiguration(data.configuration) };
};
const parseWorktree = (value: unknown): WorktreeBinding => {
  const data = record(value, ["repositoryPath", "commonDirectory", "worktreePath", "branch"], "Worktree binding");
  return { repositoryPath: absolutePath(data.repositoryPath, "Repository path"), commonDirectory: absolutePath(data.commonDirectory, "Git common directory"), worktreePath: absolutePath(data.worktreePath, "Worktree path"), branch: text(data.branch, "Worktree branch") };
};
const parseHerdr = (value: unknown): WorkerHerdr => {
  const data = record(value, ["session", "workspaceId", "paneId"], "Herdr binding");
  return { session: text(data.session, "Herdr session"), workspaceId: text(data.workspaceId, "Herdr workspace ID"), paneId: text(data.paneId, "Herdr pane ID") };
};
const parseNative = (value: unknown): NativeSessionReference => {
  const data = record(value, ["sessionId", "source"], "Native session reference");
  return { sessionId: text(data.sessionId, "Native session ID"), source: oneOf(data.source, ["herdr", "native-history"], "Native reference source") };
};
const parseResources = (value: unknown): ExecutionResources => {
  const data = record(value, ["worktree", "herdr", "nativeSession"], "Execution resources");
  return { worktree: nullable(data.worktree, parseWorktree), herdr: nullable(data.herdr, parseHerdr), nativeSession: nullable(data.nativeSession, parseNative) };
};
const parseTaskBinding = (value: unknown): HerdrTaskBinding => {
  const data = record(value, ["session", "workspaceId", "paneId", "terminalId"], "Local Herdr binding");
  return { session: text(data.session, "Herdr session"), workspaceId: text(data.workspaceId, "Herdr workspace ID"), paneId: text(data.paneId, "Herdr pane ID"), terminalId: text(data.terminalId, "Herdr terminal ID") };
};
const parseWorkspaceEvidence = (value: unknown): HerdrWorkspaceEvidence => {
  const data = record(value, ["binding", "ownerLabel", "environment"], "Herdr workspace evidence");
  const environment = record(data.environment, ["XDG_CONFIG_HOME", "XDG_STATE_HOME"], "Herdr workspace environment");
  const config = text(environment.XDG_CONFIG_HOME, "Workspace XDG_CONFIG_HOME", true);
  const state = text(environment.XDG_STATE_HOME, "Workspace XDG_STATE_HOME", true);
  if (config.includes("\0") || state.includes("\0")) throw new Error("The workspace environment cannot contain NUL.");
  return { binding: parseTaskBinding(data.binding), ownerLabel: text(data.ownerLabel, "Workspace owner label"), environment: { XDG_CONFIG_HOME: config, XDG_STATE_HOME: state } };
};
const parseLaunchEvidence = (value: unknown): HerdrLaunchEvidence => {
  const data = record(value, ["binding", "ownerLabel", "agent", "argv", "referenceBaseline", "workspaceEvidence"], "Herdr launch evidence");
  if (!Array.isArray(data.argv) || data.argv.length === 0) throw new Error("Herdr launch arguments must be a nonempty array.");
  return { binding: parseTaskBinding(data.binding), ownerLabel: text(data.ownerLabel, "Launch owner label"), agent: oneOf(data.agent, ["codex", "copilot"], "Launch agent"), argv: data.argv.map((value) => text(value, "Launch argument", true)), referenceBaseline: oneOf(data.referenceBaseline, ["empty"], "Launch reference baseline"), workspaceEvidence: parseWorkspaceEvidence(data.workspaceEvidence) };
};
const processId = (value: unknown): number => {
  const result = integer(value, "Herdr process ID", 1);
  if (result > 2_147_483_647) throw new Error("Herdr process ID exceeds the supported process identifier range.");
  return result;
};
const parseStopObservation = (value: unknown): HerdrStopObservation => {
  const data = record(value, ["binding", "ownerLabel", "agent", "nativeSessionId", "shellPid", "processIds", "observedAt"], "Herdr stop observation");
  if (!Array.isArray(data.processIds) || data.processIds.length === 0) throw new Error("The original native process observation must be nonempty.");
  const shellPid = processId(data.shellPid);
  const processIds = data.processIds.map(processId);
  if (new Set(processIds).size !== processIds.length || processIds.includes(shellPid)) throw new Error("The original native process observation contains duplicate or shell process IDs.");
  return { binding: parseTaskBinding(data.binding), ownerLabel: text(data.ownerLabel, "Stop owner label"), agent: oneOf(data.agent, ["codex", "copilot"], "Stop agent"), nativeSessionId: nullable(data.nativeSessionId, (value) => id(value, "Stopped native session ID")), shellPid, processIds, observedAt: integer(data.observedAt, "Stop observation time") };
};
const parseExecutionSummary = (value: unknown): ExecutionSummary => {
  const data = record(value, ["version", "herdr", "nativeSessionId", "phase", "submission"], "Execution summary mutation");
  return { version: version(data.version), herdr: nullable(data.herdr, parseHerdr), nativeSessionId: nullable(data.nativeSessionId, (value) => id(value, "Summary native session ID")), phase: oneOf(data.phase, ["preparing", "executing", "verifying", "completing", "waiting", "paused"], "Summary phase"), submission: oneOf(data.submission, ["unknown", "confirmed", "rejected"], "Summary submission") };
};
const parseNativeExecution = (value: unknown): NativeExecutionState => {
  const data = record(value, ["terminalId", "workspaceSubmission", "workspaceEvidence", "launchEvidence", "launchSubmission", "promptSubmission", "stopObservation", "summary"], "Native execution state");
  const result = { terminalId: nullable(data.terminalId, (value) => text(value, "Herdr terminal ID")), workspaceSubmission: oneOf(data.workspaceSubmission, ["not-submitted", "unknown", "acknowledged"], "Herdr workspace submission"), workspaceEvidence: nullable(data.workspaceEvidence, parseWorkspaceEvidence), launchEvidence: nullable(data.launchEvidence, parseLaunchEvidence), launchSubmission: oneOf(data.launchSubmission, ["never-submitted", "unknown", "acknowledged"], "Native launch submission"), promptSubmission: oneOf(data.promptSubmission, ["not-submitted", "unknown", "submitted"], "Native prompt submission"), stopObservation: nullable(data.stopObservation, parseStopObservation), summary: nullable(data.summary, parseExecutionSummary) };
  if ((result.launchSubmission === "acknowledged") !== (result.launchEvidence !== null)) throw new Error("Acknowledged native launch requires its original launch evidence.");
  if (result.launchSubmission === "never-submitted" && (result.promptSubmission !== "not-submitted" || result.stopObservation !== null)) throw new Error("An unlaunched native execution cannot have submitted input or original native process evidence.");
  return result;
};
const freshNativeExecution = (): NativeExecutionState => ({ terminalId: null, workspaceSubmission: "not-submitted", workspaceEvidence: null, launchEvidence: null, launchSubmission: "never-submitted", promptSubmission: "not-submitted", stopObservation: null, summary: null });
const unknownNativeExecution = (): NativeExecutionState => ({ ...freshNativeExecution(), workspaceSubmission: "unknown", launchSubmission: "unknown", promptSubmission: "unknown" });
const withUserScope = (task: LocalTask, userId: string): LocalTask => {
  const owner = id(userId, "Claim user ID");
  if (task.userId !== null && task.userId !== owner) throw new Error("The original authenticated claim owner cannot be replaced.");
  if (task.userId === null && (task.cleanup?.kind === "terminal" || task.control !== null)) throw new Error("An existing terminal or control intent with unknown authenticated scope cannot acquire an inferred owner.");
  return { ...task, userId: owner };
};
export const isUnstartedPending = (task: LocalTask): boolean => {
  const native = task.nativeExecution;
  return task.status === "pending" && task.cleanup === null && task.control === null && task.resources.worktree === null && task.resources.herdr === null && task.resources.nativeSession === null
    && native !== null && native.terminalId === null && native.workspaceSubmission === "not-submitted" && native.workspaceEvidence === null
    && native.launchSubmission === "never-submitted" && native.launchEvidence === null && native.promptSubmission === "not-submitted" && native.stopObservation === null && native.summary === null;
};
const parseRecovery = (value: unknown): RecoveryState => {
  const data = record(value, ["count", "pauseReason", "retryAuthorized"], "Recovery state");
  return { count: integer(data.count, "Recovery count"), pauseReason: nullable(data.pauseReason, (entry) => text(entry, "Pause reason")), retryAuthorized: bool(data.retryAuthorized, "Recovery retry authorization") };
};
const parseCleanupBaseline = (value: unknown): NonNullable<CleanupState["baseline"]> => {
  const data = record(value, ["stateChangeSeq", "completionSeq"], "Cleanup completion baseline");
  return { stateChangeSeq: integer(data.stateChangeSeq, "Cleanup state-change sequence"), completionSeq: integer(data.completionSeq, "Cleanup completion sequence") };
};
const parseCleanup = (value: unknown): CleanupState => {
  const data = record(value, ["kind", "startedAt", "deadline", "input", "baseline", "result", "error", "agentStopped", "workspaceClosed", "worktreeDeleted"], "Cleanup state");
  const result: CleanupState = { kind: oneOf(data.kind, ["terminal", "shutdown"], "Cleanup kind"), startedAt: integer(data.startedAt, "Cleanup start"), deadline: integer(data.deadline, "Cleanup deadline"),
    input: oneOf(data.input, ["not-submitted", "unknown", "submitted", "rejected", "unavailable"], "Cleanup input state"),
    baseline: nullable(data.baseline, parseCleanupBaseline),
    result: nullable(data.result, (entry) => oneOf(entry, ["completed", "timed-out", "failed", "unavailable"], "Cleanup result")), error: nullable(data.error, (entry) => text(entry, "Cleanup error")),
    agentStopped: bool(data.agentStopped, "Agent stopped"), workspaceClosed: bool(data.workspaceClosed, "Workspace closed"), worktreeDeleted: bool(data.worktreeDeleted, "Worktree deleted") };
  if (result.deadline < result.startedAt || result.deadline - result.startedAt > 600_000) throw new Error("Cleanup deadline must be within ten minutes of its original start.");
  if ((result.workspaceClosed && !result.agentStopped) || (result.worktreeDeleted && !result.workspaceClosed)) throw new Error("Cleanup progress is out of order.");
  if (result.baseline !== null && result.input !== "submitted") throw new Error("A cleanup completion baseline requires confirmed input submission.");
  return result;
};
const parseIntent = (value: unknown): ControlIntent => {
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("Control intent must be an object.");
  if (value.kind === "release") {
    const data = record(value, ["kind", "sourceClaimId", "version"], "Release intent");
    return { kind: "release", sourceClaimId: id(data.sourceClaimId, "Source claim ID"), version: version(data.version) };
  }
  const data = record(value, ["kind", "sourceClaimId", "version", "targetClaimId", "target"], "Transfer intent");
  const target = record(data.target, ["userId", "workerId", "machine", "platform", "agent", "worktreeId"], "Transfer target");
  const machine = record(target.machine, ["id", "name"], "Transfer machine");
  return { kind: oneOf(data.kind, ["transfer"], "Control kind"), sourceClaimId: id(data.sourceClaimId, "Source claim ID"), version: version(data.version), targetClaimId: id(data.targetClaimId, "Target claim ID"),
    target: { userId: id(target.userId, "Target user ID"), workerId: id(target.workerId, "Target worker ID"), machine: { id: id(machine.id, "Machine ID"), name: text(machine.name, "Machine name") },
      platform: oneOf(target.platform, ["linux", "windows", "macos"], "Target platform"), agent: oneOf(target.agent, ["copilot", "codex"], "Target agent"), worktreeId: id(target.worktreeId, "Target worktree ID") } };
};
const parseControl = (value: unknown): ControlState => {
  const data = record(value, ["intent", "requestedAt", "submission", "submittedAt", "outcome", "resultVersion", "error"], "Control state");
  const result: ControlState = { intent: parseIntent(data.intent), requestedAt: integer(data.requestedAt, "Control request time"), submission: oneOf(data.submission, ["not-submitted", "unknown", "confirmed", "rejected"], "Control submission"),
    submittedAt: nullable(data.submittedAt, (entry) => integer(entry, "Control submission time")), outcome: nullable(data.outcome, (entry) => oneOf(entry, ["applied", "ownership-ended"], "Control outcome")), resultVersion: nullable(data.resultVersion, version), error: nullable(data.error, (entry) => text(entry, "Control error")) };
  if ((result.submission === "confirmed") !== (result.outcome !== null)) throw new Error("Control outcome does not match its submission state.");
  if ((result.outcome === "applied") !== (result.resultVersion !== null)) throw new Error("Only an applied remote control outcome has a result version.");
  if (result.submission === "unknown" && result.submittedAt === null) throw new Error("Unknown control submission is missing its submission time.");
  return result;
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const validateNativeExecution = (task: LocalTask): LocalTask => {
  const state = task.nativeExecution;
  if (state === null) return task;
  const binding = task.resources.herdr === null || state.terminalId === null ? null : { ...task.resources.herdr, terminalId: state.terminalId };
  if (state.terminalId !== null && task.resources.herdr === null) throw new Error("The local terminal requires its core Herdr binding.");
  if (state.workspaceSubmission === "acknowledged" && binding === null) throw new Error("An acknowledged workspace requires its full original Herdr binding.");
  const owner = { ...claimKey(task), worktreeId: task.worktreeId };
  const evidence = (value: { binding: HerdrTaskBinding; ownerLabel: string }): void => {
    if (binding === null || !same(value.binding, binding)) throw new Error("Native execution evidence differs from its original Herdr binding.");
    if (!same(parseHerdrExecutionLabel(value.ownerLabel), owner)) throw new Error("Native execution evidence belongs to another claim or worktree.");
  };
  if (state.workspaceEvidence !== null) evidence(state.workspaceEvidence);
  if (state.launchEvidence !== null) {
    evidence(state.launchEvidence);
    evidence(state.launchEvidence.workspaceEvidence);
    if (!same(state.workspaceEvidence, state.launchEvidence.workspaceEvidence)) throw new Error("The native launch does not preserve its original workspace evidence.");
    if (task.configuration !== null && state.launchEvidence.agent !== task.configuration.agent) throw new Error("The native launch agent differs from its frozen configuration.");
    if (state.launchEvidence.argv[0] !== state.launchEvidence.agent) throw new Error("The native launch arguments name another executable.");
  }
  if (state.stopObservation !== null) {
    evidence(state.stopObservation);
    if (task.configuration !== null && state.stopObservation.agent !== task.configuration.agent) throw new Error("The stopped agent differs from its frozen configuration.");
    if (state.stopObservation.nativeSessionId !== null && task.resources.nativeSession !== null && state.stopObservation.nativeSessionId !== task.resources.nativeSession.sessionId) throw new Error("The stopped native session differs from the original session.");
  }
  return task;
};

const projectColumns = "server_origin AS serverOrigin, project_id AS projectId, repo_url AS repoUrl, local_path AS localPath, claim_attempt AS claimAttempt";
type ProjectRow = WorkerProject & { claimAttempt: string | null };
const asProject = (row: ProjectRow): WorkerProjectRecord => ({ ...row, claimAttempt: row.claimAttempt === null ? null : parseClaimAttempt(JSON.parse(row.claimAttempt) as unknown) });
const taskColumns = `server_origin AS serverOrigin, project_id AS projectId, task_id AS taskId, claim_id AS claimId,
  worker_id AS workerId, worktree_id AS worktreeId, user_id AS userId, status, repo_url AS repoUrl, repository_path AS repositoryPath,
  configuration, resources, native_execution AS nativeExecution, recovery, cleanup, control, created_at AS createdAt, updated_at AS updatedAt`;
type TaskRow = Omit<LocalTask, "configuration" | "resources" | "nativeExecution" | "recovery" | "cleanup" | "control"> & {
  configuration: string | null; resources: string; nativeExecution: string | null; recovery: string; cleanup: string | null; control: string | null;
};
const asTask = (row: TaskRow): LocalTask => validateNativeExecution({ ...row,
  userId: row.userId === null ? null : id(row.userId, "Claim user ID"),
  configuration: row.configuration === null ? null : parseConfiguration(JSON.parse(row.configuration) as unknown),
  nativeExecution: row.nativeExecution === null ? null : parseNativeExecution(JSON.parse(row.nativeExecution) as unknown),
  resources: parseResources(JSON.parse(row.resources) as unknown), recovery: parseRecovery(JSON.parse(row.recovery) as unknown),
  cleanup: row.cleanup === null ? null : parseCleanup(JSON.parse(row.cleanup) as unknown), control: row.control === null ? null : parseControl(JSON.parse(row.control) as unknown) });
const schema = `
  CREATE TABLE projects (
    server_origin TEXT NOT NULL, project_id TEXT NOT NULL, repo_url TEXT NOT NULL, local_path TEXT NOT NULL,
    claim_attempt TEXT CHECK(claim_attempt IS NULL OR json_valid(claim_attempt)),
    PRIMARY KEY(server_origin, project_id)
  ) STRICT;
  CREATE TABLE tasks (
    server_origin TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    worker_id TEXT NOT NULL, worktree_id TEXT NOT NULL, user_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
    repo_url TEXT NOT NULL, repository_path TEXT NOT NULL,
    configuration TEXT CHECK(configuration IS NULL OR json_valid(configuration)),
    resources TEXT NOT NULL CHECK(json_valid(resources)), native_execution TEXT CHECK(native_execution IS NULL OR json_valid(native_execution)), recovery TEXT NOT NULL CHECK(json_valid(recovery)),
    cleanup TEXT CHECK(cleanup IS NULL OR json_valid(cleanup)), control TEXT CHECK(control IS NULL OR json_valid(control)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(server_origin, project_id, task_id, claim_id), UNIQUE(server_origin, claim_id)
  ) STRICT;
  CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(server_origin, project_id, task_id) WHERE status = 'active';
  PRAGMA user_version = 2;
`;

export const openWorkerStore = (databaseFile: string, options: { busyTimeoutMs?: number } = {}) => {
  absolutePath(databaseFile, "The SQLite database path");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : integer(options.busyTimeoutMs, "SQLite busy timeout", 1);
  if (busyTimeoutMs > 60_000) throw new Error("SQLite busy timeout must not exceed 60000 milliseconds.");
  const db = new Database(databaseFile, { timeout: busyTimeoutMs });
  try {
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    if (journalMode !== "wal") throw new Error(`SQLite refused WAL mode: ${String(journalMode)}.`);
    db.pragma("synchronous = FULL");
    if (db.pragma("synchronous", { simple: true }) !== 2) throw new Error("SQLite refused synchronous=FULL.");
    db.transaction(() => {
      const currentVersion = db.pragma("user_version", { simple: true }) as number;
      if (currentVersion !== 0 && currentVersion !== 1 && currentVersion !== 2) throw new Error(`Unsupported worker SQLite schema version ${currentVersion}; supported version is 2.`);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      if (currentVersion === 0) {
        if (tables.length !== 0) throw new Error("An unversioned worker database must not contain existing tables.");
        db.exec(schema);
      } else if (!same(tables.map(({ name }) => name), ["projects", "tasks"])) throw new Error("The worker database does not contain its projects/tasks schema.");
      if (currentVersion === 1) db.exec("ALTER TABLE tasks ADD COLUMN native_execution TEXT CHECK(native_execution IS NULL OR json_valid(native_execution)); ALTER TABLE tasks ADD COLUMN user_id TEXT; ALTER TABLE projects ADD COLUMN claim_attempt TEXT CHECK(claim_attempt IS NULL OR json_valid(claim_attempt)); UPDATE tasks SET cleanup = json_set(cleanup, '$.baseline', json('null')) WHERE cleanup IS NOT NULL; PRAGMA user_version = 2;");
      db.prepare(`SELECT ${projectColumns} FROM projects LIMIT 0`).all();
      db.prepare(`SELECT ${taskColumns} FROM tasks LIMIT 0`).all();
    }).immediate();
  } catch (error) {
    try { db.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Worker SQLite startup and connection cleanup failed."); }
    throw error;
  }
  const atomic = <T>(operation: () => T): T => db.transaction(operation).immediate();
  const getProject = (identity: ProjectIdentity): WorkerProjectRecord | null => {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE server_origin = @serverOrigin AND project_id = @projectId`).get(projectKey(identity)) as ProjectRow | undefined;
    return row === undefined ? null : asProject(row);
  };
  const getTask = (identity: ClaimIdentity): LocalTask | null => {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE server_origin = @serverOrigin AND project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as TaskRow | undefined;
    return row === undefined ? null : asTask(row);
  };
  const needTask = (identity: ClaimIdentity): LocalTask => {
    const task = getTask(identity);
    if (task === null) throw new Error("The claimed task is not registered.");
    return task;
  };
  const writeTask = (task: LocalTask): LocalTask => {
    validateNativeExecution(task);
    const values = { ...task, configuration: task.configuration === null ? null : JSON.stringify(parseConfiguration(task.configuration)), resources: JSON.stringify(parseResources(task.resources)), nativeExecution: task.nativeExecution === null ? null : JSON.stringify(parseNativeExecution(task.nativeExecution)), recovery: JSON.stringify(parseRecovery(task.recovery)),
      cleanup: task.cleanup === null ? null : JSON.stringify(parseCleanup(task.cleanup)), control: task.control === null ? null : JSON.stringify(parseControl(task.control)) };
    db.prepare(`UPDATE tasks SET user_id = @userId, status = @status, configuration = @configuration, resources = @resources, native_execution = @nativeExecution, recovery = @recovery,
      cleanup = @cleanup, control = @control, updated_at = @updatedAt
      WHERE server_origin = @serverOrigin AND project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).run(values);
    return needTask(task);
  };
  const change = (identity: ClaimIdentity, now: number, operation: (task: LocalTask) => LocalTask): LocalTask => atomic(() => {
    integer(now, "Task update time");
    const task = needTask(identity);
    if (task.status === "done") throw new Error("The local execution is already done.");
    return writeTask({ ...operation(task), updatedAt: now });
  });
  const requireOrdinary = (task: LocalTask): void => {
    if (task.control !== null || task.cleanup !== null) throw new Error("A control or cleanup intent prevents ordinary execution.");
    if (task.configuration === null) throw new Error("The original frozen execution configuration is missing.");
  };
  const needCleanup = (task: LocalTask): CleanupState => {
    if (task.cleanup === null) throw new Error("Cleanup has not started.");
    return task.cleanup;
  };
  const fullyCleaned = (task: LocalTask): void => {
    const cleanup = needCleanup(task);
    if (cleanup.kind !== "terminal" || cleanup.result === null || !cleanup.agentStopped || !cleanup.workspaceClosed || !cleanup.worktreeDeleted) throw new Error("Terminal cleanup must record its result and confirm agent stopped, workspace closed and worktree deleted.");
  };
  return {
    close: (): void => { db.close(); },
    getProject,
    listProjects: (): WorkerProjectRecord[] => (db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY server_origin, project_id`).all() as ProjectRow[]).map(asProject),
    registerProject: (project: WorkerProject): WorkerProjectRecord => atomic(() => {
      const value = { ...projectKey(project), repoUrl: text(project.repoUrl, "Repository URL"), localPath: absolutePath(project.localPath, "Project local path") };
      const existing = getProject(value);
      if (existing !== null && (existing.repoUrl !== value.repoUrl || existing.localPath !== value.localPath)) {
        if (existing.claimAttempt !== null) throw new Error("An unresolved claim attempt prevents changing its project repository binding.");
        const unfinished = db.prepare("SELECT 1 FROM tasks WHERE server_origin = @serverOrigin AND project_id = @projectId AND status <> 'done' LIMIT 1").get(value);
        if (unfinished !== undefined) throw new Error("An unfinished execution prevents changing its project repository binding.");
      }
      db.prepare(`INSERT INTO projects(server_origin, project_id, repo_url, local_path) VALUES (@serverOrigin, @projectId, @repoUrl, @localPath)
        ON CONFLICT(server_origin, project_id) DO UPDATE SET repo_url = excluded.repo_url, local_path = excluded.local_path`).run(value);
      return getProject(value)!;
    }),
    getClaimAttempt: (identity: ProjectIdentity): ClaimAttempt | null => {
      const project = getProject(identity);
      if (project === null) throw new Error("The project repository binding is not registered.");
      return project.claimAttempt;
    },
    listClaimAttempts: (): (ProjectIdentity & { attempt: ClaimAttempt })[] => (db.prepare(`SELECT ${projectColumns} FROM projects WHERE claim_attempt IS NOT NULL ORDER BY server_origin, project_id`).all() as ProjectRow[]).map(asProject).map((project) => ({ ...projectKey(project), attempt: project.claimAttempt! })),
    beginClaimAttempt: (identity: ProjectIdentity, input: ClaimAttempt): ClaimAttempt => atomic(() => {
      const key = projectKey(identity);
      const project = getProject(key);
      if (project === null) throw new Error("The project repository binding must be persisted before claiming a task.");
      const attempt = parseClaimAttempt(input);
      if (project.claimAttempt !== null) throw new Error("The project already has an unresolved claim attempt; it cannot be replayed or replaced.");
      db.prepare("UPDATE projects SET claim_attempt = @claimAttempt WHERE server_origin = @serverOrigin AND project_id = @projectId").run({ ...key, claimAttempt: JSON.stringify(attempt) });
      return attempt;
    }),
    rejectClaimAttempt: (identity: ProjectIdentity, expectedClaimId: string, proof: { definiteRejection: true } | { notSubmitted: true }): void => atomic(() => {
      const key = projectKey(identity);
      const project = getProject(key);
      if (project === null || project.claimAttempt === null || project.claimAttempt.claimId !== id(expectedClaimId, "Rejected claim ID")) throw new Error("The original unresolved claim attempt does not match.");
      if (!("definiteRejection" in proof && proof.definiteRejection === true) && !("notSubmitted" in proof && proof.notSubmitted === true)) throw new Error("Clearing a claim attempt requires definite rejection or proven non-submission of the original mutation.");
      db.prepare("UPDATE projects SET claim_attempt = NULL WHERE server_origin = @serverOrigin AND project_id = @projectId").run(key);
    }),
    getTask,
    listTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at, server_origin, project_id, task_id, claim_id`).all() as TaskRow[]).map(asTask),
    listUnfinishedTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status <> 'done' ORDER BY created_at, server_origin, project_id, task_id, claim_id`).all() as TaskRow[]).map(asTask),
    registerPending: (claim: PendingClaim, input: PendingConfiguration, now: number, verifiedUserId: string | null = null): LocalTask => atomic(() => {
      const key = { ...claimKey(claim), workerId: id(claim.workerId, "Worker ID"), worktreeId: id(claim.worktreeId, "Worktree ID") };
      const owner = verifiedUserId === null ? null : id(verifiedUserId, "Verified claim user ID");
      integer(now, "Task creation time");
      oneOf(input.kind, ["new", "recovered"], "Pending registration kind");
      if (input.kind === "new" && input.configuration === null) throw new Error("A new execution requires its frozen configuration.");
      const configuration = input.configuration === null ? null : parseConfiguration(input.configuration);
      const project = getProject(key);
      if (project === null) throw new Error("The project repository binding must be persisted before claiming a task.");
      const confirmAttempt = (originalConfiguration: FrozenExecutionConfiguration | null): FrozenExecutionConfiguration | null => {
        const attempt = project.claimAttempt;
        if (attempt === null || attempt.claimId !== key.claimId) return originalConfiguration;
        if (attempt.taskId !== key.taskId || attempt.worktreeId !== key.worktreeId || attempt.workerId !== key.workerId || (originalConfiguration !== null && !same(attempt.configuration, originalConfiguration))) throw new Error("The actual granted claim does not preserve its original claim attempt and frozen configuration.");
        if (owner === null) return originalConfiguration;
        if (attempt.userId !== owner) throw new Error("The actual granted claim does not preserve its original authenticated claim attempt owner.");
        db.prepare("UPDATE projects SET claim_attempt = NULL WHERE server_origin = @serverOrigin AND project_id = @projectId").run(projectKey(key));
        return originalConfiguration === null ? attempt.configuration : originalConfiguration;
      };
      const existing = getTask(key);
      if (existing !== null) {
        if (existing.workerId !== key.workerId || existing.worktreeId !== key.worktreeId) throw new Error("The claim is already bound to a different worker or worktree identity.");
        const scoped = owner === null ? existing : withUserScope(existing, owner);
        const originalConfiguration = confirmAttempt(existing.configuration);
        if (scoped.userId !== existing.userId || originalConfiguration !== existing.configuration) {
          if (existing.status === "done") throw new Error("The local execution is already done; its unknown authenticated scope cannot be replaced.");
          return writeTask({ ...scoped, configuration: originalConfiguration, updatedAt: now });
        }
        return existing;
      }
      const originalConfiguration = confirmAttempt(configuration);
      const values = { ...key, userId: owner, configuration: originalConfiguration === null ? null : JSON.stringify(originalConfiguration), repoUrl: project.repoUrl, repositoryPath: project.localPath,
        resources: JSON.stringify({ worktree: null, herdr: null, nativeSession: null }), nativeExecution: input.kind === "new" ? JSON.stringify(freshNativeExecution()) : null, recovery: JSON.stringify({ count: 0, pauseReason: originalConfiguration === null ? "Original frozen execution configuration is missing." : null, retryAuthorized: false }), now };
      db.prepare(`INSERT INTO tasks(server_origin, project_id, task_id, claim_id, worker_id, worktree_id, user_id, status, repo_url, repository_path, configuration, resources, native_execution, recovery, created_at, updated_at)
        VALUES (@serverOrigin, @projectId, @taskId, @claimId, @workerId, @worktreeId, @userId, 'pending', @repoUrl, @repositoryPath, @configuration, @resources, @nativeExecution, @recovery, @now, @now)`).run(values);
      return needTask(key);
    }),
    bindUserScope: (identity: ClaimIdentity, userId: string, now: number): LocalTask => change(identity, now, (task) => withUserScope(task, userId)),
    restoreOriginalConfiguration: (identity: ClaimIdentity, configuration: FrozenExecutionConfiguration, now: number): LocalTask => change(identity, now, (task) => {
      const original = parseConfiguration(configuration);
      if (task.configuration !== null && !same(task.configuration, original)) throw new Error("The frozen execution configuration cannot be replaced.");
      return { ...task, configuration: original };
    }),
    activateTask: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.recovery.pauseReason !== null) throw new Error("The execution is paused.");
      return { ...task, status: "active" };
    }),
    activatePausedRecovery: (identity: ClaimIdentity, reason: string, now: number): LocalTask => change(identity, now, (task) => {
      if (task.control !== null || task.cleanup !== null) throw new Error("A control or cleanup intent prevents recovery promotion.");
      if (task.nativeExecution !== null && task.resources.worktree === null && task.resources.herdr === null && task.resources.nativeSession === null) throw new Error("Paused recovery requires unknown original provenance or existing execution resources.");
      return { ...task, status: "active", recovery: { ...task.recovery, pauseReason: text(reason, "Recovery pause reason") } };
    }),
    bindWorktree: (identity: ClaimIdentity, binding: WorktreeBinding, now: number): LocalTask => change(identity, now, (task) => {
      if (task.status !== "active") throw new Error("Resource creation requires an active execution.");
      const value = parseWorktree(binding);
      if (value.repositoryPath !== task.repositoryPath) throw new Error("The worktree repository does not match the original project binding.");
      if (task.resources.worktree !== null && !same(task.resources.worktree, value)) throw new Error("The execution already has a different worktree binding.");
      return { ...task, resources: { ...task.resources, worktree: value } };
    }),
    bindHerdr: (identity: ClaimIdentity, binding: WorkerHerdr, now: number): LocalTask => change(identity, now, (task) => {
      if (task.status !== "active" || task.resources.worktree === null) throw new Error("Herdr binding requires an active execution and its original worktree.");
      const value = parseHerdr(binding);
      if (task.resources.herdr !== null && !same(task.resources.herdr, value)) throw new Error("The execution already has a different Herdr binding.");
      return { ...task, resources: { ...task.resources, herdr: value } };
    }),
    bindHerdrExecution: (identity: ClaimIdentity, binding: HerdrTaskBinding, workspaceEvidence: HerdrWorkspaceEvidence | null, now: number): LocalTask => change(identity, now, (task) => {
      if (task.status !== "active" || task.resources.worktree === null) throw new Error("Herdr binding requires an active execution and its original worktree.");
      const value = parseTaskBinding(binding);
      const core = { session: value.session, workspaceId: value.workspaceId, paneId: value.paneId };
      if (task.resources.herdr !== null && !same(task.resources.herdr, core)) throw new Error("The execution already has a different Herdr binding.");
      const state = task.nativeExecution === null ? unknownNativeExecution() : task.nativeExecution;
      if (state.terminalId !== null && state.terminalId !== value.terminalId) throw new Error("The original terminal cannot change without confirmed stop and workspace closure.");
      if (state.workspaceSubmission === "unknown" && state.terminalId !== null && task.resources.herdr !== null) throw new Error("An unresolved replacement workspace cannot be acknowledged by its previous binding.");
      const evidence = workspaceEvidence === null ? state.workspaceEvidence : parseWorkspaceEvidence(workspaceEvidence);
      if (state.workspaceEvidence !== null && !same(state.workspaceEvidence, evidence)) throw new Error("The original workspace evidence cannot be replaced.");
      return { ...task, resources: { ...task.resources, herdr: core }, nativeExecution: { ...state, terminalId: value.terminalId, workspaceSubmission: "acknowledged", workspaceEvidence: evidence } };
    }),
    markWorkspaceSubmitting: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      const state = task.nativeExecution;
      if (task.status !== "active" || task.resources.worktree === null || state === null) throw new Error("Workspace creation requires its active original worktree and persisted provenance.");
      if (state.workspaceSubmission === "unknown") throw new Error("The original workspace creation is unresolved and cannot be replayed.");
      if (state.launchSubmission !== "never-submitted" && task.resources.nativeSession === null) throw new Error("The original native session ID is missing; workspace replacement cannot start a new conversation.");
      if (task.resources.herdr !== null && state.launchSubmission !== "never-submitted" && state.stopObservation === null) throw new Error("Workspace replacement requires its durable original native stop observation.");
      return { ...task, nativeExecution: { ...state, workspaceSubmission: "unknown" } };
    }),
    recordWorkspaceNotSubmitted: (identity: ClaimIdentity, proof: { notSubmitted: true } | { definiteRejection: true }, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      if (state === null || state.workspaceSubmission !== "unknown") throw new Error("Workspace non-submission requires its original unresolved create attempt.");
      if (!("notSubmitted" in proof && proof.notSubmitted === true) && !("definiteRejection" in proof && proof.definiteRejection === true)) throw new Error("Resetting workspace creation requires proven non-submission or definite rejection before dispatch.");
      return { ...task, nativeExecution: { ...state, workspaceSubmission: "not-submitted" } };
    }),
    markNativeLaunchSubmitting: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      const state = task.nativeExecution;
      if (task.status !== "active" || task.recovery.pauseReason !== null || state === null || state.terminalId === null || state.workspaceSubmission !== "acknowledged" || state.workspaceEvidence === null || state.launchSubmission !== "never-submitted") throw new Error("Native launch requires a proven unlaunched active execution and its verified workspace.");
      return { ...task, nativeExecution: { ...state, launchSubmission: "unknown", promptSubmission: "unknown" } };
    }),
    recordNativeLaunchNotSubmitted: (identity: ClaimIdentity, proof: { notSubmitted: true } | { definiteRejection: true }, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      if (task.status !== "active" || state === null || state.launchSubmission !== "unknown" || state.launchEvidence !== null || state.stopObservation !== null || state.promptSubmission === "submitted") throw new Error("A native launch can be unsubmitted only before acknowledged launch, prompt submission or native process evidence.");
      if (!("notSubmitted" in proof && proof.notSubmitted === true) && !("definiteRejection" in proof && proof.definiteRejection === true)) throw new Error("Resetting a native launch requires proven non-submission or definite rejection before native dispatch.");
      return { ...task, nativeExecution: { ...state, launchSubmission: "never-submitted", promptSubmission: "not-submitted" } };
    }),
    markNativePromptSubmitting: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      const state = task.nativeExecution;
      if (task.status !== "active" || task.recovery.pauseReason !== null || state === null || state.workspaceSubmission !== "acknowledged" || state.launchSubmission !== "acknowledged" || state.launchEvidence === null || state.promptSubmission !== "not-submitted") throw new Error("Deferred startup input requires its original acknowledged launch and a proven unsubmitted prompt.");
      return { ...task, nativeExecution: { ...state, promptSubmission: "unknown" } };
    }),
    recordNativeStartOutcome: (identity: ClaimIdentity, input: { launchEvidence?: HerdrLaunchEvidence; promptSubmission: NativeExecutionState["promptSubmission"] }, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      if (task.status !== "active" || state === null || state.terminalId === null || state.launchSubmission === "never-submitted") throw new Error("Native startup outcome requires the original persisted submission attempt.");
      const promptSubmission = oneOf(input.promptSubmission, ["not-submitted", "unknown", "submitted"], "Native prompt outcome");
      if (state.promptSubmission === "submitted" && promptSubmission !== "submitted") throw new Error("A confirmed startup prompt cannot become unsubmitted or unknown.");
      const launchEvidence = input.launchEvidence === undefined ? state.launchEvidence : parseLaunchEvidence(input.launchEvidence);
      if (state.launchEvidence !== null && !same(state.launchEvidence, launchEvidence)) throw new Error("The original native launch evidence cannot be replaced.");
      return { ...task, nativeExecution: { ...state, launchEvidence, launchSubmission: launchEvidence === null ? state.launchSubmission : "acknowledged", promptSubmission } };
    }),
    recordStopObservation: (identity: ClaimIdentity, observation: HerdrStopObservation, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      if (task.status !== "active" || state === null || state.terminalId === null || state.launchSubmission === "never-submitted") throw new Error("A native stop observation requires the original possibly launched terminal.");
      const evidence = parseStopObservation(observation);
      if (state.stopObservation !== null && !same(state.stopObservation, evidence)) throw new Error("The original native process observation cannot be replaced before confirmed closure.");
      return { ...task, nativeExecution: { ...state, stopObservation: evidence } };
    }),
    markExecutionSummarySubmitting: (identity: ClaimIdentity, input: Omit<ExecutionSummary, "submission">, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active") throw new Error("Execution summary publication requires an active execution.");
      const state = task.nativeExecution === null ? unknownNativeExecution() : task.nativeExecution;
      if (state.summary?.submission === "unknown") throw new Error("The original execution summary mutation is unresolved and cannot be replayed or replaced.");
      const summary = parseExecutionSummary({ ...input, submission: "unknown" });
      if (!same(summary.herdr, task.resources.herdr) || summary.nativeSessionId !== (task.resources.nativeSession === null ? null : task.resources.nativeSession.sessionId)) throw new Error("Execution summary must describe its original actual resource bindings.");
      return { ...task, nativeExecution: { ...state, summary } };
    }),
    recordExecutionSummaryOutcome: (identity: ClaimIdentity, expectedVersion: string, submission: "confirmed" | "rejected", now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      const summary = state === null ? null : state.summary;
      const outcome = oneOf(submission, ["confirmed", "rejected"], "Summary mutation outcome");
      if (summary === null || summary.version !== version(expectedVersion) || (summary.submission !== "unknown" && summary.submission !== outcome)) throw new Error("The original execution summary submission does not match this outcome.");
      return { ...task, nativeExecution: { ...state!, summary: { ...summary, submission: outcome } } };
    }),
    recordExecutionSummaryNotSubmitted: (identity: ClaimIdentity, expectedVersion: string, proof: { notSubmitted: true }, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      const summary = state === null ? null : state.summary;
      if (summary === null || summary.submission !== "unknown" || summary.version !== version(expectedVersion)) throw new Error("The original unresolved execution summary does not match this non-submission.");
      if (proof.notSubmitted !== true) throw new Error("Clearing an execution summary requires proven non-submission before dispatch.");
      return { ...task, nativeExecution: { ...state!, summary: null } };
    }),
    reconcileExecutionSummary: (identity: ClaimIdentity, input: Omit<ExecutionSummary, "submission">, now: number): LocalTask => change(identity, now, (task) => {
      const state = task.nativeExecution;
      const summary = state === null ? null : state.summary;
      const observed = parseExecutionSummary({ ...input, submission: "confirmed" });
      if (summary === null || summary.submission !== "unknown" || BigInt(observed.version) <= BigInt(summary.version)) return task;
      const matched = same(observed.herdr, summary.herdr) && observed.nativeSessionId === summary.nativeSessionId && observed.phase === summary.phase;
      return { ...task, nativeExecution: { ...state!, summary: matched ? { ...summary, submission: "confirmed" } : null } };
    }),
    rebindHerdr: (identity: ClaimIdentity, expectedPrevious: WorkerHerdr, next: WorkerHerdr, proof: { originalAgentStopped: true; oldWorkspaceClosed: true }, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active" || task.resources.worktree === null || task.resources.herdr === null) throw new Error("Herdr rebinding requires the active original worktree and workspace binding.");
      if (!same(task.resources.herdr, parseHerdr(expectedPrevious))) throw new Error("The previous Herdr binding does not match the original execution.");
      if (proof.originalAgentStopped !== true || proof.oldWorkspaceClosed !== true) throw new Error("Herdr rebinding requires confirmed original agent stop and old workspace closure.");
      if (task.resources.nativeSession === null && task.nativeExecution?.launchSubmission !== "never-submitted") throw new Error("The original native session ID is missing; rebinding cannot start a new conversation.");
      return { ...task, resources: { ...task.resources, herdr: parseHerdr(next) }, nativeExecution: { ...unknownNativeExecution(), summary: task.nativeExecution === null ? null : task.nativeExecution.summary } };
    }),
    rebindHerdrExecution: (identity: ClaimIdentity, expectedPrevious: HerdrTaskBinding, next: HerdrTaskBinding, workspaceEvidence: HerdrWorkspaceEvidence | null, proof: { originalAgentStopped: true; oldWorkspaceClosed: true }, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      const previous = parseTaskBinding(expectedPrevious);
      const state = task.nativeExecution;
      if (task.status !== "active" || task.resources.worktree === null || task.resources.herdr === null || state === null || !same({ ...task.resources.herdr, terminalId: state.terminalId }, previous)) throw new Error("The previous full Herdr binding does not match the active execution.");
      if (proof.originalAgentStopped !== true || proof.oldWorkspaceClosed !== true || (state.stopObservation === null && state.launchSubmission !== "never-submitted")) throw new Error("Herdr rebinding requires durable original stop provenance and confirmed old workspace closure.");
      if (state.launchSubmission !== "never-submitted" && task.resources.nativeSession === null) throw new Error("The original native session ID is missing; rebinding cannot start a new conversation.");
      if (state.workspaceSubmission !== "unknown") throw new Error("Herdr rebinding requires the persisted new workspace creation attempt.");
      const binding = parseTaskBinding(next);
      if (same(binding, previous)) throw new Error("A fresh Herdr execution must use a new workspace or terminal binding.");
      return { ...task, resources: { ...task.resources, herdr: { session: binding.session, workspaceId: binding.workspaceId, paneId: binding.paneId } }, nativeExecution: { ...freshNativeExecution(), terminalId: binding.terminalId, workspaceSubmission: "acknowledged", workspaceEvidence: workspaceEvidence === null ? null : parseWorkspaceEvidence(workspaceEvidence), summary: state.summary } };
    }),
    bindNativeSession: (identity: ClaimIdentity, reference: NativeSessionReference, now: number): LocalTask => change(identity, now, (task) => {
      if (task.status !== "active" || task.resources.herdr === null) throw new Error("Native history binding requires an active Herdr workspace.");
      const value = parseNative(reference);
      if (task.resources.nativeSession !== null && task.resources.nativeSession.sessionId !== value.sessionId) throw new Error("The original native session cannot be replaced.");
      return { ...task, resources: { ...task.resources, nativeSession: value } };
    }),
    pauseTask: (identity: ClaimIdentity, reason: string, now: number): LocalTask => change(identity, now, (task) => ({ ...task, recovery: { ...task.recovery, pauseReason: text(reason, "Pause reason") } })),
    clearPause: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      return { ...task, recovery: { ...task.recovery, pauseReason: null } };
    }),
    authorizeRecoveryRetry: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active" || task.recovery.pauseReason === null) throw new Error("An extra recovery requires a paused active execution.");
      return { ...task, recovery: { ...task.recovery, retryAuthorized: true } };
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
    beginCleanup: (identity: ClaimIdentity, input: { kind: CleanupState["kind"]; deadline: number }, now: number): LocalTask => change(identity, now, (task) => {
      oneOf(input.kind, ["terminal", "shutdown"], "Cleanup kind");
      const existing = task.cleanup;
      if (existing !== null) return { ...task, cleanup: { ...existing, kind: existing.kind === "terminal" ? "terminal" : input.kind } };
      if (task.control !== null && input.kind !== "terminal") throw new Error("A source control intent requires terminal cleanup.");
      return { ...task, status: "active", cleanup: parseCleanup({ kind: input.kind, startedAt: now, deadline: input.deadline, input: "not-submitted", baseline: null, result: null, error: null, agentStopped: false, workspaceClosed: false, worktreeDeleted: false }) };
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
    recordCleanupInputEvidence: (identity: ClaimIdentity, baseline: NonNullable<CleanupState["baseline"]>, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (cleanup.input !== "submitted") throw new Error("Cleanup completion evidence requires the original confirmed input submission.");
      const evidence = parseCleanupBaseline(baseline);
      if (cleanup.baseline !== null && !same(cleanup.baseline, evidence)) throw new Error("The original cleanup completion baseline cannot be replaced.");
      return { ...task, cleanup: { ...cleanup, baseline: evidence } };
    }),
    recordCleanupResult: (identity: ClaimIdentity, result: NonNullable<CleanupState["result"]>, error: string | null, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      oneOf(result, ["completed", "timed-out", "failed", "unavailable"], "Cleanup result");
      if (cleanup.result !== null && cleanup.result !== result) throw new Error("The original cleanup result cannot be replaced.");
      if (result === "timed-out" && now < cleanup.deadline) throw new Error("The original cleanup deadline has not elapsed.");
      return { ...task, cleanup: { ...cleanup, result, error: error === null ? null : text(error, "Cleanup error") } };
    }),
    recordCleanupError: (identity: ClaimIdentity, error: string, now: number): LocalTask => change(identity, now, (task) => ({ ...task, cleanup: { ...needCleanup(task), error: text(error, "Cleanup error") } })),
    confirmAgentStopped: (identity: ClaimIdentity, proof: { agentStopped: true }, now: number): LocalTask => change(identity, now, (task) => {
      if (proof.agentStopped !== true) throw new Error("The caller must confirm the original agent has stopped.");
      return { ...task, cleanup: { ...needCleanup(task), agentStopped: true } };
    }),
    confirmWorkspaceClosed: (identity: ClaimIdentity, proof: { workspaceClosed: true }, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (!cleanup.agentStopped || proof.workspaceClosed !== true) throw new Error("Workspace closure requires confirmed original agent stop.");
      return { ...task, cleanup: { ...cleanup, workspaceClosed: true } };
    }),
    confirmWorktreeDeleted: (identity: ClaimIdentity, proof: { worktreeDeleted: true }, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "terminal" || !cleanup.workspaceClosed || proof.worktreeDeleted !== true) throw new Error("Worktree deletion requires confirmed workspace closure and terminal cleanup.");
      return { ...task, cleanup: { ...cleanup, worktreeDeleted: true } };
    }),
    resumeAfterShutdown: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "shutdown" || cleanup.result === null || !cleanup.agentStopped || !cleanup.workspaceClosed || task.control !== null) throw new Error("Shutdown resume requires the original agent stopped, workspace closed and its cleanup result recorded.");
      if (task.configuration === null) throw new Error("The original frozen execution configuration is missing.");
      if (task.resources.nativeSession === null && task.nativeExecution?.launchSubmission !== "never-submitted") return { ...task, cleanup: null, recovery: { ...task.recovery, pauseReason: "The original native session ID is missing; recover its exact history identity before resuming this claim." } };
      return { ...task, cleanup: null, resources: { ...task.resources, herdr: null }, nativeExecution: { ...freshNativeExecution(), summary: task.nativeExecution === null ? null : task.nativeExecution.summary } };
    }),
    recordControlIntent: (identity: ClaimIdentity, input: ControlIntent, now: number): LocalTask => change(identity, now, (task) => {
      const intent = parseIntent(input);
      if (intent.sourceClaimId !== task.claimId) throw new Error("The control intent must name the original claim.");
      if (intent.kind === "transfer" && (intent.targetClaimId === task.claimId || intent.target.worktreeId === task.worktreeId)) throw new Error("Transfer requires new claim and worktree identities.");
      if (task.control !== null) {
        if (!same(task.control.intent, intent)) throw new Error("A different source control intent is already recorded.");
        return task;
      }
      return { ...task, cleanup: task.cleanup === null ? null : { ...task.cleanup, kind: "terminal" }, control: { intent, requestedAt: now, submission: "not-submitted", submittedAt: null, outcome: null, resultVersion: null, error: null } };
    }),
    markControlSubmitting: (identity: ClaimIdentity, expectedVersion: bigint, now: number): LocalTask => change(identity, now, (task) => {
      fullyCleaned(task);
      if (task.control === null || task.control.submission !== "not-submitted") throw new Error("A control write requires an unsubmitted original intent; unknown writes cannot be replayed.");
      if (exactVersion(expectedVersion) !== task.control.intent.version) throw new Error("The remote write version does not match the original control decision.");
      return { ...task, control: { ...task.control, submission: "unknown", submittedAt: now } };
    }),
    confirmControlApplied: (identity: ClaimIdentity, resultVersion: bigint, now: number): LocalTask => change(identity, now, (task) => {
      fullyCleaned(task);
      const control = task.control;
      if (control === null) throw new Error("A source control intent is required.");
      const resolvedVersion = exactVersion(resultVersion);
      if (control.submission !== "unknown" && control.submission !== "confirmed") throw new Error("An applied control outcome requires an original submission.");
      if (control.submission === "confirmed" && (control.outcome !== "applied" || control.resultVersion !== resolvedVersion)) throw new Error("The confirmed control result cannot be replaced.");
      return { ...task, control: { ...control, submission: "confirmed", outcome: "applied", resultVersion: resolvedVersion, error: null } };
    }),
    confirmControlOwnershipEnded: (identity: ClaimIdentity, proof: { completeOwnClaimInventory: true; claimAbsent: true }, now: number): LocalTask => change(identity, now, (task) => {
      fullyCleaned(task);
      const control = task.control;
      if (control === null) throw new Error("A source control intent is required.");
      if (proof.completeOwnClaimInventory !== true || proof.claimAbsent !== true) throw new Error("Ownership exit requires the original claim to be absent from a successful complete own-claim inventory.");
      if (control.submission === "confirmed") return task;
      return { ...task, control: { ...control, submission: "confirmed", outcome: "ownership-ended", resultVersion: null, error: null } };
    }),
    rejectControlSubmission: (identity: ClaimIdentity, error: string, now: number): LocalTask => change(identity, now, (task) => {
      if (task.control === null || task.control.submission !== "unknown") throw new Error("A definite control rejection requires an original unknown submission.");
      return { ...task, control: { ...task.control, submission: "rejected", error: text(error, "Control error") } };
    }),
    completeTask: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, (task) => {
      fullyCleaned(task);
      if (task.control !== null && task.control.submission !== "confirmed") throw new Error("The source control outcome must be reconciled before local completion.");
      return { ...task, status: "done" };
    }),
    completeUnstartedPending: (identity: ClaimIdentity, proof: { completeOwnClaimInventory: true; claimAbsent: true; authenticatedUserId: string }, now: number): LocalTask => change(identity, now, (task) => {
      if (proof.completeOwnClaimInventory !== true || proof.claimAbsent !== true) throw new Error("Completing an unstarted pending claim requires its absence from a successful complete own-claim inventory.");
      if (!isUnstartedPending(task)) throw new Error("Only a proven unstarted pending execution with no resources or outstanding actions can complete directly.");
      if (task.userId === null || task.userId !== id(proof.authenticatedUserId, "Authenticated user ID")) throw new Error("The complete own-claim inventory must belong to the original authenticated claim owner.");
      const completed: LocalTask = { ...task, status: "done", cleanup: { kind: "terminal", startedAt: now, deadline: now, input: "unavailable", baseline: null, result: "completed", error: null, agentStopped: true, workspaceClosed: true, worktreeDeleted: true } };
      fullyCleaned(completed);
      return completed;
    }),
  };
};

export type WorkerStore = ReturnType<typeof openWorkerStore>;
