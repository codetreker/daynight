import path from "node:path";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter, type SqliteDatabaseSource } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { workerStoreFormat } from "./store-format.js";
import { canonicalId } from "../../api/parse.js";
import { readWorkerClaim } from "../../api/task-properties.js";
import type { AgentControlMode, Task, WorkerAgent } from "../../api/types.js";
import type { ArchiveBackfillIdentity, ArchiveBackfillSchedule, ArchiveBackfillScheduleRecord, ClaimIdentity, CleanupSchedule, CleanupScheduleRecord, LocalTask, ProjectIdentity, ResourceOwner, WorkerProject } from "./types.js";
import { parseWorkerCloudNative, type WorkerCloudNative } from "../../api/worker-configuration.js";
import { parseResolvedToolLaunch } from "../../platform/tool-launch-record.js";
import type { ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { parseFrozenToolObservation } from "./tool-observation.js";
import type { FrozenToolObservation } from "./types.js";
export type FrozenNativeConfiguration = WorkerCloudNative & { validateNativeSelection?: true; toolLaunch?: ResolvedToolLaunch; toolObservation?: FrozenToolObservation; herdrLaunch?: ResolvedToolLaunch; herdrObservation?: FrozenToolObservation };
const parseFrozenNative = (value: unknown): FrozenNativeConfiguration => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid frozen native configuration.");
  const data = value as Record<string, unknown>, selection = Object.hasOwn(data, "validateNativeSelection");
  if (selection && data.validateNativeSelection !== true) throw new Error("Invalid frozen native validation policy.");
  const { validateNativeSelection: _selection, toolLaunch, toolObservation, herdrLaunch, herdrObservation, ...native } = data;
  const configuration = parseWorkerCloudNative(native);
  if (Object.hasOwn(data, "toolLaunch") && configuration.agent === "claude") throw new Error("Claude cannot acquire a Worker tool launch.");
  if (Object.hasOwn(data, "toolObservation") && !Object.hasOwn(data, "toolLaunch")) throw new Error("Frozen tool observation requires its original recipe.");
  if (Object.hasOwn(data, "herdrObservation") && !Object.hasOwn(data, "herdrLaunch")) throw new Error("Frozen Herdr observation requires its original recipe.");
  return { ...configuration, ...(selection ? { validateNativeSelection: true as const } : {}),
    ...(Object.hasOwn(data, "toolLaunch") ? { toolLaunch: parseResolvedToolLaunch(toolLaunch, { tool: configuration.agent as "codex" | "copilot" }) } : {}),
    ...(Object.hasOwn(data, "toolObservation") ? { toolObservation: parseFrozenToolObservation(toolObservation) } : {}),
    ...(Object.hasOwn(data, "herdrLaunch") ? { herdrLaunch: parseResolvedToolLaunch(herdrLaunch, { tool: "herdr", context: "herdr" }) } : {}),
    ...(Object.hasOwn(data, "herdrObservation") ? { herdrObservation: parseFrozenToolObservation(herdrObservation) } : {}) };
};

export type ClaimToolReservation = ResourceOwner & {
  workerId: string;
  version: bigint;
  agentControlMode: AgentControlMode;
  nativeConfiguration: FrozenNativeConfiguration;
};
// Recovery policy remains live; only the native selection belongs to a claim.
const canonicalFrozenNative = (input: FrozenNativeConfiguration): FrozenNativeConfiguration => parseFrozenNative({
  agent: input.agent, model: input.model, args: input.args,
  ...(input.validateNativeSelection === undefined ? {} : { validateNativeSelection: input.validateNativeSelection }),
  ...(input.toolLaunch === undefined ? {} : { toolLaunch: input.toolLaunch }),
  ...(input.toolObservation === undefined ? {} : { toolObservation: input.toolObservation }),
  ...(input.herdrLaunch === undefined ? {} : { herdrLaunch: input.herdrLaunch }),
  ...(input.herdrObservation === undefined ? {} : { herdrObservation: input.herdrObservation }),
});

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
  return value;
};
const id = (value: unknown, name: string): string => {
  const result = canonicalId(text(value, name));
  if (result === null) throw new TypeError(`${name} must be a UUID.`);
  return result;
};
const absolutePath = (value: unknown, name: string): string => {
  const result = text(value, name);
  if (!path.isAbsolute(result)) throw new TypeError(`${name} must be absolute.`);
  return result;
};
const agent = (value: unknown): WorkerAgent => {
  if (value !== "copilot" && value !== "codex" && value !== "claude") throw new TypeError("Worker agent must be copilot, codex or claude.");
  return value;
};
const mode = (value: unknown): AgentControlMode => { if (value === undefined || value === "herdr") return "herdr"; if (value === "web") return "web"; throw new TypeError("Worker control mode must be herdr or web."); };
const projectKey = (value: ProjectIdentity): ProjectIdentity => ({ projectId: id(value.projectId, "Project ID") });
const claimKey = (value: ClaimIdentity): ClaimIdentity => ({ ...projectKey(value), taskId: id(value.taskId, "Task ID"), claimId: id(value.claimId, "Claim ID") });
const projectColumns = "project_id AS projectId, repo_url AS repoUrl, local_path AS localPath";
const taskColumns = "project_id AS projectId, task_id AS taskId, claim_id AS claimId, status, agent, session_id AS sessionId, agent_control_mode AS agentControlMode";
const cleanupColumns = "project_id AS projectId, task_id AS taskId, claim_id AS claimId, worktree_id AS worktreeId, deadline, failures, next_attempt_at AS nextAttemptAt, stage, last_error AS lastError, archive_repair_code AS archiveRepairCode";
const nonnegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer.`);
  return value;
};
const asCleanupState = (value: CleanupSchedule): CleanupSchedule => {
  const code = value.archiveRepairCode ?? null;
  if (code !== null && code !== "archive_incomplete" && code !== "projection_gap") throw new TypeError("Invalid archive repair code.");
  if (code !== null && value.stage !== "archive") throw new TypeError("Archive repair requires the archive cleanup stage.");
  return { deadline: nonnegativeInteger(value.deadline, "Cleanup deadline"), failures: nonnegativeInteger(value.failures, "Cleanup failures"), nextAttemptAt: nonnegativeInteger(value.nextAttemptAt, "Cleanup next attempt"),
    ...(code === null ? {} : { archiveRepairCode: code }), stage: text(value.stage, "Cleanup stage"), lastError: value.lastError === null ? null : text(value.lastError, "Cleanup scheduling error") };
};
const asCleanupRecord = (row: CleanupScheduleRecord): CleanupScheduleRecord => ({
  ...claimKey(row), worktreeId: id(row.worktreeId, "Worktree ID"), ...asCleanupState(row),
});
const archiveBackfillKey = (value: ArchiveBackfillIdentity) => ({ serverOrigin: text(value.serverOrigin, "Archive server origin"), executionId: id(value.executionId, "Archive execution ID") });
const asArchiveBackfillIdentity = (value: ArchiveBackfillIdentity): ArchiveBackfillIdentity => {
  const generation = text(value.executionGeneration, "Archive execution generation");
  if (!/^[1-9][0-9]{0,18}$/.test(generation) || BigInt(generation) > 9_223_372_036_854_775_807n) throw new TypeError("Invalid archive execution generation.");
  return { ...archiveBackfillKey(value), ...claimKey(value), executionGeneration: generation, launchId: id(value.launchId, "Archive launch ID") };
};
const asArchiveBackfillSchedule = (value: ArchiveBackfillSchedule): ArchiveBackfillSchedule => {
  if (value.archiveRepairCode !== "archive_incomplete" && value.archiveRepairCode !== "projection_gap") throw new TypeError("Invalid archive repair code.");
  return { archiveRepairCode: value.archiveRepairCode, nextAttemptAt: nonnegativeInteger(value.nextAttemptAt, "Archive next attempt") };
};
const asProject = (row: WorkerProject): WorkerProject => ({ ...projectKey(row), repoUrl: text(row.repoUrl, "Repository URL"), localPath: absolutePath(row.localPath, "Project local path") });
const asTask = (row: LocalTask): LocalTask => {
  if (row.status !== "pending" && row.status !== "active" && row.status !== "done") throw new TypeError("Worker task status must be pending, active or done.");
  return { ...claimKey(row), status: row.status, agent: agent(row.agent), agentControlMode: mode(row.agentControlMode), sessionId: row.sessionId === null ? null : id(row.sessionId, "Native session ID") };
};
const taskVersion = (value: unknown): bigint => {
  if (typeof value !== "bigint" || value < 1n || value > 9_223_372_036_854_775_807n) throw new TypeError("Claim reservation task version must be a positive int64 BigInt.");
  return value;
};
const asClaimToolReservation = (input: ClaimToolReservation): ClaimToolReservation => {
  const configuration = canonicalFrozenNative(input.nativeConfiguration), controlMode = mode(input.agentControlMode);
  if (configuration.toolLaunch !== undefined && configuration.toolLaunch.context !== controlMode) throw new Error("Reserved native tools differ from the requested control mode.");
  if (configuration.herdrLaunch !== undefined && controlMode !== "herdr") throw new Error("Web claim reservations cannot acquire a Herdr launch.");
  return { ...claimKey(input), worktreeId: id(input.worktreeId, "Worktree ID"), workerId: id(input.workerId, "Worker ID"), version: taskVersion(input.version), agentControlMode: controlMode, nativeConfiguration: configuration };
};
const sameClaimToolReservation = (left: ClaimToolReservation, right: ClaimToolReservation): boolean =>
  left.projectId === right.projectId && left.taskId === right.taskId && left.claimId === right.claimId
  && left.worktreeId === right.worktreeId && left.workerId === right.workerId && left.version === right.version
  && left.agentControlMode === right.agentControlMode && JSON.stringify(left.nativeConfiguration) === JSON.stringify(right.nativeConfiguration);
const reservationColumns = "project_id AS projectId, task_id AS taskId, claim_id AS claimId, worktree_id AS worktreeId, worker_id AS workerId, task_version AS version, agent_control_mode AS agentControlMode, configuration";
type ReservationRow = Omit<ClaimToolReservation, "version" | "nativeConfiguration"> & { version: string; configuration: string };
const asReservationRow = (row: ReservationRow): ClaimToolReservation => {
  if (typeof row.version !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.version)) throw new TypeError("The original claim reservation version is invalid.");
  return asClaimToolReservation({ ...row, version: BigInt(row.version), nativeConfiguration: parseFrozenNative(JSON.parse(row.configuration)) });
};

export const openWorkerStore = (databaseFile: SqliteDatabaseSource, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  if (typeof databaseFile === "string") absolutePath(databaseFile, "The SQLite database path");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.");
  const db = openSqliteDatabase({ file: databaseFile, format: workerStoreFormat, allowCreate: true, timeoutMs: busyTimeoutMs,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  const atomic = <T>(operation: () => T): T => {
    let guardFailure: unknown;
    try {
      return db.transaction(() => {
        try { assertCurrentSqlite(db, workerStoreFormat); }
        catch (error) { guardFailure = error; throw error; }
        return operation();
      }).immediate();
    } catch (error) {
      if (guardFailure !== undefined && error !== guardFailure) throw new AggregateError([guardFailure, error], "Worker SQLite format assertion and rollback failed.");
      throw error;
    }
  };
  const read = <T>(operation: () => T): T => {
    if (db.inTransaction) { assertCurrentSqlite(db, workerStoreFormat); return operation(); }
    return db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return operation(); }).deferred();
  };
  const getProject = (identity: ProjectIdentity): WorkerProject | null => read(() => {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE project_id = @projectId`).get(projectKey(identity)) as WorkerProject | undefined;
    return row === undefined ? null : asProject(row);
  });
  const getTask = (identity: ClaimIdentity): LocalTask | null => read(() => {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as LocalTask | undefined;
    return row === undefined ? null : asTask(row);
  });
  const getCleanupSchedule = (identity: ClaimIdentity): CleanupScheduleRecord | null => read(() => {
    const row = db.prepare(`SELECT ${cleanupColumns} FROM cleanup_schedules WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as CleanupScheduleRecord | undefined;
    return row === undefined ? null : asCleanupRecord(row);
  });
  const getArchiveBackfillSchedule = (identity: ArchiveBackfillIdentity): ArchiveBackfillScheduleRecord | null => read(() => {
    const row = db.prepare(`SELECT server_origin AS serverOrigin, execution_id AS executionId, execution_generation AS executionGeneration,
      launch_id AS launchId, project_id AS projectId, task_id AS taskId, claim_id AS claimId,
      archive_repair_code AS archiveRepairCode, next_attempt_at AS nextAttemptAt
      FROM archive_backfill_schedules WHERE server_origin = @serverOrigin AND execution_id = @executionId`).get(archiveBackfillKey(identity)) as ArchiveBackfillScheduleRecord | undefined;
    if (row === undefined) return null;
    const owner = asArchiveBackfillIdentity(identity);
    if (Object.entries(owner).some(([key, value]) => row[key as keyof ArchiveBackfillIdentity] !== value)) throw new Error("Archive backfill schedule identity changed.");
    return { ...owner, ...asArchiveBackfillSchedule(row) };
  });
  const needTask = (identity: ClaimIdentity): LocalTask => {
    const task = getTask(identity);
    if (task === null) throw new Error("The claimed task is not registered.");
    return task;
  };
  const getNativeConfiguration = (identity: ClaimIdentity): FrozenNativeConfiguration | null => read(() => {
    const row = db.prepare("SELECT configuration FROM claim_native_configurations WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").get(claimKey(identity)) as { configuration: string } | undefined;
    if (row === undefined) return null;
    const configuration = parseFrozenNative(JSON.parse(row.configuration)), task = needTask(identity);
    if (configuration.agent !== task.agent || configuration.toolLaunch !== undefined && configuration.toolLaunch.context !== mode(task.agentControlMode)) throw new Error("Frozen native configuration differs from its original claim.");
    if (configuration.herdrLaunch !== undefined && mode(task.agentControlMode) !== "herdr") throw new Error("Web claims cannot acquire a Herdr launch.");
    return configuration;
  });
  const freezeNativeConfiguration = (identity: ClaimIdentity, input: FrozenNativeConfiguration): FrozenNativeConfiguration => atomic(() => {
    const task = needTask(identity), configuration = canonicalFrozenNative(input), previous = getNativeConfiguration(identity);
    if (task.agent !== configuration.agent) throw new Error("Frozen configuration does not match the claimed agent.");
    if (configuration.toolLaunch !== undefined && configuration.toolLaunch.context !== mode(task.agentControlMode)) throw new Error("Frozen tool launch does not match the claimed control mode.");
    if (configuration.herdrLaunch !== undefined && mode(task.agentControlMode) !== "herdr") throw new Error("Web claims cannot acquire a Herdr launch.");
    if (previous !== null) {
      if (JSON.stringify(previous) !== JSON.stringify(configuration)) throw new Error("The claim's native configuration is already frozen.");
      return previous;
    }
    if (task.sessionId !== null) throw new Error("An existing native session cannot acquire an invented frozen configuration.");
    if (task.status === "done") throw new Error("The local execution is already done.");
    db.prepare("INSERT INTO claim_native_configurations(project_id, task_id, claim_id, configuration) VALUES (@projectId, @taskId, @claimId, @configuration)").run({ ...claimKey(identity), configuration: JSON.stringify(configuration) });
    return configuration;
  });
  const reservationForTask = (identity: { projectId: string; taskId: string }): ClaimToolReservation | null => read(() => {
    const row = db.prepare(`SELECT ${reservationColumns} FROM claim_tool_reservations WHERE project_id = @projectId AND task_id = @taskId`)
      .get({ ...projectKey(identity), taskId: id(identity.taskId, "Task ID") }) as ReservationRow | undefined;
    return row === undefined ? null : asReservationRow(row);
  });
  const getClaimToolReservation = (identity: ClaimIdentity): ClaimToolReservation | null => read(() => {
    const key = claimKey(identity), reservation = reservationForTask(key);
    if (reservation !== null && reservation.claimId !== key.claimId) throw new Error("The task has an unresolved reservation for another claim.");
    return reservation;
  });
  const registerPending = (input: ClaimIdentity & { agent: WorkerAgent; agentControlMode?: AgentControlMode; sessionId?: string | null; nativeConfiguration?: FrozenNativeConfiguration }): LocalTask => atomic(() => {
    const key = claimKey(input), tool = agent(input.agent);
    const sessionId = input.sessionId === undefined || input.sessionId === null ? null : id(input.sessionId, "Native session ID");
    if (getProject(key) === null) throw new Error("The project repository binding must be registered before its claimed tasks.");
    const existing = getTask(key);
    if (existing !== null) {
      if (existing.agent !== tool || (input.agentControlMode !== undefined && existing.agentControlMode !== mode(input.agentControlMode))) throw new Error("The claimed task is already registered for a different agent.");
      return existing;
    }
    db.prepare(`INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id, agent_control_mode)
      VALUES (@projectId, @taskId, @claimId, 'pending', @agent, @sessionId, @agentControlMode)`).run({ ...key, agent: tool, sessionId, agentControlMode: mode(input.agentControlMode) });
    if (input.nativeConfiguration !== undefined) freezeNativeConfiguration(key, input.nativeConfiguration);
    return needTask(key);
  });
  const deleteClaimToolReservation = (reservation: ClaimToolReservation): void => {
    db.prepare("DELETE FROM claim_tool_reservations WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(reservation));
  };

  return {
    close: (): void => { closeSqliteDatabase(db, { file: typeof databaseFile === "string" ? databaseFile : databaseFile.name, format: workerStoreFormat }); },
    getClaimToolReservation,
    listClaimToolReservations: (): ClaimToolReservation[] => read(() => (db.prepare(`SELECT ${reservationColumns} FROM claim_tool_reservations ORDER BY project_id, task_id`).all() as ReservationRow[]).map(asReservationRow)),
    reserveClaimTools: (input: ClaimToolReservation): ClaimToolReservation => atomic(() => {
      const reservation = asClaimToolReservation(input), previous = reservationForTask(reservation);
      if (previous !== null) {
        if (!sameClaimToolReservation(previous, reservation)) throw new Error("The claim tool reservation is already frozen for its original request.");
        return previous;
      }
      if (getProject(reservation) === null) throw new Error("The project repository binding must be registered before reserving claim tools.");
      if (getTask(reservation) !== null) throw new Error("A registered claim cannot acquire a pre-grant tool reservation.");
      db.prepare(`INSERT INTO claim_tool_reservations(project_id, task_id, claim_id, worktree_id, worker_id, task_version, agent_control_mode, configuration)
        VALUES (@projectId, @taskId, @claimId, @worktreeId, @workerId, @version, @agentControlMode, @configuration)`)
        .run({ ...claimKey(reservation), worktreeId: reservation.worktreeId, workerId: reservation.workerId, version: reservation.version.toString(), agentControlMode: reservation.agentControlMode, configuration: JSON.stringify(reservation.nativeConfiguration) });
      return getClaimToolReservation(reservation)!;
    }),
    acceptClaimToolReservation: (task: Task, workerId: string): LocalTask | null => atomic(() => {
      const reservation = reservationForTask({ projectId: task.projectId, taskId: task.id });
      if (reservation === null) return null;
      const claim = readWorkerClaim(task.properties);
      if (task.status !== "in_progress" || taskVersion(task.version) <= reservation.version || claim === undefined || claim.state !== "active"
        || claim.claimId !== reservation.claimId || claim.worktreeId !== reservation.worktreeId || claim.workerId !== reservation.workerId || id(workerId, "Worker ID") !== reservation.workerId
        || claim.agent !== reservation.nativeConfiguration.agent || claim.agentControlMode !== reservation.agentControlMode) throw new Error("The granted claim differs from its original tool reservation.");
      if (getTask(reservation) !== null) throw new Error("A pre-grant reservation cannot replace an already registered claim.");
      const local = registerPending({ ...claimKey(reservation), agent: reservation.nativeConfiguration.agent, agentControlMode: reservation.agentControlMode, nativeConfiguration: reservation.nativeConfiguration });
      deleteClaimToolReservation(reservation);
      return local;
    }),
    // The caller must prove a definite rejection, a later authoritative task
    // version, or a confirmed deletion of the original task.
    releaseClaimToolReservation: (input: ClaimToolReservation): boolean => atomic(() => {
      const expected = asClaimToolReservation(input), previous = reservationForTask(expected);
      if (previous === null) return false;
      if (!sameClaimToolReservation(previous, expected)) throw new Error("The claim tool reservation changed before release.");
      deleteClaimToolReservation(previous);
      return true;
    }),
    getProject,
    listProjects: (): WorkerProject[] => read(() => (db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY project_id`).all() as WorkerProject[]).map(asProject)),
    registerProject: (input: WorkerProject): WorkerProject => atomic(() => {
      const project = asProject(input);
      const existing = getProject(project);
      if (existing !== null && (existing.repoUrl !== project.repoUrl || existing.localPath !== project.localPath)) {
        const unfinished = db.prepare("SELECT 1 FROM tasks WHERE project_id = @projectId AND status <> 'done' LIMIT 1").get(project);
        if (unfinished !== undefined) throw new Error("An unfinished execution prevents changing its project repository binding.");
        if (db.prepare("SELECT 1 FROM claim_tool_reservations WHERE project_id = @projectId LIMIT 1").get(project) !== undefined) throw new Error("An unresolved claim request prevents changing its project repository binding.");
        if (db.prepare("SELECT 1 FROM cleanup_schedules WHERE project_id = @projectId LIMIT 1").get(project) !== undefined) throw new Error("Outstanding cleanup prevents changing its project repository binding.");
      }
      db.prepare(`INSERT INTO projects(project_id, repo_url, local_path) VALUES (@projectId, @repoUrl, @localPath)
        ON CONFLICT(project_id) DO UPDATE SET repo_url = excluded.repo_url, local_path = excluded.local_path`).run(project);
      return getProject(project)!;
    }),
    getArchiveBackfillSchedule,
    saveArchiveBackfillSchedule: (identity: ArchiveBackfillIdentity, state: ArchiveBackfillSchedule): void => atomic(() => {
      const record = { ...asArchiveBackfillIdentity(identity), ...asArchiveBackfillSchedule(state) };
      getArchiveBackfillSchedule(record);
      db.prepare(`INSERT INTO archive_backfill_schedules(server_origin, execution_id, execution_generation, launch_id, project_id, task_id, claim_id, archive_repair_code, next_attempt_at)
        VALUES (@serverOrigin, @executionId, @executionGeneration, @launchId, @projectId, @taskId, @claimId, @archiveRepairCode, @nextAttemptAt)
        ON CONFLICT(server_origin, execution_id) DO UPDATE SET archive_repair_code = excluded.archive_repair_code, next_attempt_at = excluded.next_attempt_at`).run(record);
    }),
    deleteArchiveBackfillSchedule: (identity: ArchiveBackfillIdentity): void => atomic(() => {
      if (getArchiveBackfillSchedule(identity) === null) return;
      db.prepare("DELETE FROM archive_backfill_schedules WHERE server_origin = @serverOrigin AND execution_id = @executionId").run(archiveBackfillKey(identity));
    }),
    getCleanupSchedule,
    listCleanupSchedules: (): CleanupScheduleRecord[] => read(() => (db.prepare(`SELECT ${cleanupColumns} FROM cleanup_schedules ORDER BY project_id, task_id, claim_id`).all() as CleanupScheduleRecord[]).map(asCleanupRecord)),
    saveCleanupSchedule: (owner: ResourceOwner, state: CleanupSchedule): CleanupScheduleRecord => atomic(() => {
      const record = { ...claimKey(owner), worktreeId: id(owner.worktreeId, "Worktree ID"), ...asCleanupState(state) };
      if (getProject(record) === null) throw new Error("The project repository binding must be registered before cleanup.");
      const previous = getCleanupSchedule(record);
      if (previous !== null) {
        if (previous.worktreeId !== record.worktreeId) throw new Error("The cleanup claim is already bound to a different worktree.");
        if (previous.deadline !== record.deadline) throw new Error("The original cleanup deadline cannot change.");
      }
      db.prepare(`INSERT INTO cleanup_schedules(project_id, task_id, claim_id, worktree_id, deadline, failures, next_attempt_at, stage, last_error, archive_repair_code)
        VALUES (@projectId, @taskId, @claimId, @worktreeId, @deadline, @failures, @nextAttemptAt, @stage, @lastError, @archiveRepairCode)
        ON CONFLICT(project_id, task_id, claim_id) DO UPDATE SET failures = excluded.failures, next_attempt_at = excluded.next_attempt_at, stage = excluded.stage, last_error = excluded.last_error, archive_repair_code = excluded.archive_repair_code`)
        .run({ ...record, archiveRepairCode: record.archiveRepairCode ?? null });
      return getCleanupSchedule(record)!;
    }),
    deleteCleanupSchedule: (identity: ClaimIdentity): void => atomic(() => {
      db.prepare("DELETE FROM cleanup_schedules WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(identity));
    }),
    getTask,
    getNativeConfiguration,
    freezeNativeConfiguration,
    listTasks: (): LocalTask[] => read(() => (db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask)),
    listUnfinishedTasks: (): LocalTask[] => read(() => (db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status <> 'done' ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask)),
    registerPending,
    activateTask: (identity: ClaimIdentity): LocalTask => atomic(() => {
      const task = needTask(identity);
      if (task.status === "done") throw new Error("The local execution is already done.");
      db.prepare("UPDATE tasks SET status = 'active' WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(task));
      return needTask(task);
    }),
    completeTask: (identity: ClaimIdentity): LocalTask => atomic(() => {
      const task = needTask(identity);
      db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(task));
      return needTask(task);
    }),
    setSessionId: (identity: ClaimIdentity, sessionId: string): LocalTask => atomic(() => {
      const task = needTask(identity);
      if (task.status === "done") throw new Error("The local execution is already done.");
      const nativeSessionId = id(sessionId, "Native session ID");
      if (task.sessionId !== null) {
        if (task.sessionId !== nativeSessionId) throw new Error("The claimed task is already bound to a different native session.");
        return task;
      }
      db.prepare("UPDATE tasks SET session_id = @sessionId WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run({ ...claimKey(task), sessionId: nativeSessionId });
      return needTask(task);
    }),
  };
};

export type WorkerStore = ReturnType<typeof openWorkerStore>;
