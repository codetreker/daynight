import path from "node:path";
import Database from "better-sqlite3";
import { canonicalId } from "../../api/parse.js";
import { normalizeServerUrl } from "../../config/server.js";
import type { WorkerHerdr } from "../../api/types.js";
import type { ClaimIdentity, CleanupState, ControlIntent, ControlState, ExecutionResources, FrozenExecutionConfiguration, LocalTask, NativeSessionReference, PendingClaim, PendingConfiguration, ProjectIdentity, RecoveryState, WorkerProject, WorktreeBinding } from "./types.js";

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
const parseRecovery = (value: unknown): RecoveryState => {
  const data = record(value, ["count", "pauseReason", "retryAuthorized"], "Recovery state");
  return { count: integer(data.count, "Recovery count"), pauseReason: nullable(data.pauseReason, (entry) => text(entry, "Pause reason")), retryAuthorized: bool(data.retryAuthorized, "Recovery retry authorization") };
};
const parseCleanup = (value: unknown): CleanupState => {
  const data = record(value, ["kind", "startedAt", "deadline", "input", "result", "error", "agentStopped", "workspaceClosed", "worktreeDeleted"], "Cleanup state");
  const result: CleanupState = { kind: oneOf(data.kind, ["terminal", "shutdown"], "Cleanup kind"), startedAt: integer(data.startedAt, "Cleanup start"), deadline: integer(data.deadline, "Cleanup deadline"),
    input: oneOf(data.input, ["not-submitted", "unknown", "submitted", "rejected", "unavailable"], "Cleanup input state"),
    result: nullable(data.result, (entry) => oneOf(entry, ["completed", "timed-out", "failed", "unavailable"], "Cleanup result")), error: nullable(data.error, (entry) => text(entry, "Cleanup error")),
    agentStopped: bool(data.agentStopped, "Agent stopped"), workspaceClosed: bool(data.workspaceClosed, "Workspace closed"), worktreeDeleted: bool(data.worktreeDeleted, "Worktree deleted") };
  if (result.deadline < result.startedAt || result.deadline - result.startedAt > 600_000) throw new Error("Cleanup deadline must be within ten minutes of its original start.");
  if ((result.workspaceClosed && !result.agentStopped) || (result.worktreeDeleted && !result.workspaceClosed)) throw new Error("Cleanup progress is out of order.");
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

const projectColumns = "server_origin AS serverOrigin, project_id AS projectId, repo_url AS repoUrl, local_path AS localPath";
const taskColumns = `server_origin AS serverOrigin, project_id AS projectId, task_id AS taskId, claim_id AS claimId,
  worker_id AS workerId, worktree_id AS worktreeId, status, repo_url AS repoUrl, repository_path AS repositoryPath,
  configuration, resources, recovery, cleanup, control, created_at AS createdAt, updated_at AS updatedAt`;
type TaskRow = Omit<LocalTask, "configuration" | "resources" | "recovery" | "cleanup" | "control"> & {
  configuration: string | null; resources: string; recovery: string; cleanup: string | null; control: string | null;
};
const asTask = (row: TaskRow): LocalTask => ({ ...row,
  configuration: row.configuration === null ? null : parseConfiguration(JSON.parse(row.configuration) as unknown),
  resources: parseResources(JSON.parse(row.resources) as unknown), recovery: parseRecovery(JSON.parse(row.recovery) as unknown),
  cleanup: row.cleanup === null ? null : parseCleanup(JSON.parse(row.cleanup) as unknown), control: row.control === null ? null : parseControl(JSON.parse(row.control) as unknown) });
const schema = `
  CREATE TABLE projects (
    server_origin TEXT NOT NULL, project_id TEXT NOT NULL, repo_url TEXT NOT NULL, local_path TEXT NOT NULL,
    PRIMARY KEY(server_origin, project_id)
  ) STRICT;
  CREATE TABLE tasks (
    server_origin TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    worker_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
    repo_url TEXT NOT NULL, repository_path TEXT NOT NULL,
    configuration TEXT CHECK(configuration IS NULL OR json_valid(configuration)),
    resources TEXT NOT NULL CHECK(json_valid(resources)), recovery TEXT NOT NULL CHECK(json_valid(recovery)),
    cleanup TEXT CHECK(cleanup IS NULL OR json_valid(cleanup)), control TEXT CHECK(control IS NULL OR json_valid(control)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(server_origin, project_id, task_id, claim_id), UNIQUE(server_origin, claim_id)
  ) STRICT;
  CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(server_origin, project_id, task_id) WHERE status = 'active';
  PRAGMA user_version = 1;
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
      if (currentVersion !== 0 && currentVersion !== 1) throw new Error(`Unsupported worker SQLite schema version ${currentVersion}; supported version is 1.`);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      if (currentVersion === 0) {
        if (tables.length !== 0) throw new Error("An unversioned worker database must not contain existing tables.");
        db.exec(schema);
      } else if (!same(tables.map(({ name }) => name), ["projects", "tasks"])) throw new Error("The worker database does not contain its projects/tasks schema.");
      db.prepare(`SELECT ${projectColumns} FROM projects LIMIT 0`).all();
      db.prepare(`SELECT ${taskColumns} FROM tasks LIMIT 0`).all();
    }).immediate();
  } catch (error) {
    try { db.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Worker SQLite startup and connection cleanup failed."); }
    throw error;
  }
  const atomic = <T>(operation: () => T): T => db.transaction(operation).immediate();
  const getProject = (identity: ProjectIdentity): WorkerProject | null => db.prepare(`SELECT ${projectColumns} FROM projects WHERE server_origin = @serverOrigin AND project_id = @projectId`).get(projectKey(identity)) as WorkerProject | undefined ?? null;
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
    const values = { ...task, configuration: task.configuration === null ? null : JSON.stringify(parseConfiguration(task.configuration)), resources: JSON.stringify(parseResources(task.resources)), recovery: JSON.stringify(parseRecovery(task.recovery)),
      cleanup: task.cleanup === null ? null : JSON.stringify(parseCleanup(task.cleanup)), control: task.control === null ? null : JSON.stringify(parseControl(task.control)) };
    db.prepare(`UPDATE tasks SET status = @status, configuration = @configuration, resources = @resources, recovery = @recovery,
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
    listProjects: (): WorkerProject[] => db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY server_origin, project_id`).all() as WorkerProject[],
    registerProject: (project: WorkerProject): WorkerProject => atomic(() => {
      const value = { ...projectKey(project), repoUrl: text(project.repoUrl, "Repository URL"), localPath: absolutePath(project.localPath, "Project local path") };
      const existing = getProject(value);
      if (existing !== null && (existing.repoUrl !== value.repoUrl || existing.localPath !== value.localPath)) {
        const unfinished = db.prepare("SELECT 1 FROM tasks WHERE server_origin = @serverOrigin AND project_id = @projectId AND status <> 'done' LIMIT 1").get(value);
        if (unfinished !== undefined) throw new Error("An unfinished execution prevents changing its project repository binding.");
      }
      db.prepare(`INSERT INTO projects(server_origin, project_id, repo_url, local_path) VALUES (@serverOrigin, @projectId, @repoUrl, @localPath)
        ON CONFLICT(server_origin, project_id) DO UPDATE SET repo_url = excluded.repo_url, local_path = excluded.local_path`).run(value);
      return value;
    }),
    getTask,
    listTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at, server_origin, project_id, task_id, claim_id`).all() as TaskRow[]).map(asTask),
    listUnfinishedTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status <> 'done' ORDER BY created_at, server_origin, project_id, task_id, claim_id`).all() as TaskRow[]).map(asTask),
    registerPending: (claim: PendingClaim, input: PendingConfiguration, now: number): LocalTask => atomic(() => {
      const key = { ...claimKey(claim), workerId: id(claim.workerId, "Worker ID"), worktreeId: id(claim.worktreeId, "Worktree ID") };
      integer(now, "Task creation time");
      oneOf(input.kind, ["new", "recovered"], "Pending registration kind");
      if (input.kind === "new" && input.configuration === null) throw new Error("A new execution requires its frozen configuration.");
      const configuration = input.configuration === null ? null : parseConfiguration(input.configuration);
      const existing = getTask(key);
      if (existing !== null) {
        if (existing.workerId !== key.workerId || existing.worktreeId !== key.worktreeId) throw new Error("The claim is already bound to a different worker or worktree identity.");
        return existing;
      }
      const project = getProject(key);
      if (project === null) throw new Error("The project repository binding must be persisted before claiming a task.");
      const values = { ...key, configuration: configuration === null ? null : JSON.stringify(configuration), repoUrl: project.repoUrl, repositoryPath: project.localPath,
        resources: JSON.stringify({ worktree: null, herdr: null, nativeSession: null }), recovery: JSON.stringify({ count: 0, pauseReason: configuration === null ? "Original frozen execution configuration is missing." : null, retryAuthorized: false }), now };
      db.prepare(`INSERT INTO tasks(server_origin, project_id, task_id, claim_id, worker_id, worktree_id, status, repo_url, repository_path, configuration, resources, recovery, created_at, updated_at)
        VALUES (@serverOrigin, @projectId, @taskId, @claimId, @workerId, @worktreeId, 'pending', @repoUrl, @repositoryPath, @configuration, @resources, @recovery, @now, @now)`).run(values);
      return needTask(key);
    }),
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
    rebindHerdr: (identity: ClaimIdentity, expectedPrevious: WorkerHerdr, next: WorkerHerdr, proof: { originalAgentStopped: true; oldWorkspaceClosed: true }, now: number): LocalTask => change(identity, now, (task) => {
      requireOrdinary(task);
      if (task.status !== "active" || task.resources.worktree === null || task.resources.herdr === null) throw new Error("Herdr rebinding requires the active original worktree and workspace binding.");
      if (!same(task.resources.herdr, parseHerdr(expectedPrevious))) throw new Error("The previous Herdr binding does not match the original execution.");
      if (proof.originalAgentStopped !== true || proof.oldWorkspaceClosed !== true) throw new Error("Herdr rebinding requires confirmed original agent stop and old workspace closure.");
      return { ...task, resources: { ...task.resources, herdr: parseHerdr(next) } };
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
      return { ...task, status: "active", cleanup: parseCleanup({ kind: input.kind, startedAt: now, deadline: input.deadline, input: "not-submitted", result: null, error: null, agentStopped: false, workspaceClosed: false, worktreeDeleted: false }) };
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
      return { ...task, cleanup: null, resources: { ...task.resources, herdr: null } };
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
  };
};

export type WorkerStore = ReturnType<typeof openWorkerStore>;
