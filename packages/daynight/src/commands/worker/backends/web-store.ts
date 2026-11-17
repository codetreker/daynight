import { parseStartupObservation, type StartupObservation, type SessionStartupReport } from "../../../session/startup.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { decodeStrictSessionJson } from "../../../session/v2/values.js";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteDatabaseSource, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite } from "../../../platform/sqlite-format.js";
import { parseResolvedToolLaunch } from "../../../platform/tool-launch-record.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { ExecutionConfiguration as FrozenExecutionConfiguration, WorkerProject, ResourceOwner } from "../types.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { parseWebTerminationClosure, parseWebTerminationRun, type WebTerminationClosure, type WebTerminationLaunch, type WebTerminationRun } from "./web-termination.js";
import { readTerminationPending } from "../../session-termination/domain.js";
import type { LocalTask, ClaimIdentity, CleanupState, WorktreeBinding, WebExecutionState, RecoveryState } from "./web-types.js";
import { webRecordInteger as integer, webRecordChoice as oneOf, webRecordText as text, webRecordId as id, parseWebWorktreeV1 as parseWorktree, parseWebExecutionV1 as parseWebExecution, parseWebCleanupV1 as parseCleanup, webClaimKey as key, parseWebTaskV1 as validate } from "./web-record.js";
import { webExecutionStoreFormat } from "./web-store-format.js";
import { continuingInitialGeneration, healthyOriginalGeneration, stoppedOriginalGeneration, legacyBranchLatch, orchestrationIdentity, preservesControllerProcessProof, preservesNativeProcessPrefix, sameOrchestrationIdentity, type OrchestrationBlocker, type OrchestrationFailure } from "./orchestration.js";

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
export type { WebTerminationClosure, WebTerminationLaunch, WebTerminationRun } from "./web-termination.js";
type LaunchRow = { generation: string; execution_id: string; launch_id: string; controller_id: string; controller_instance_id: string; session_id: string | null; submission: WebExecutionState["launchSubmission"]; stop_proof: string | null };
type OwnerRow = { identity: string; server_origin: string; owner_user_id: string | null; worker_id: string; project_id: string; task_id: string; claim_id: string; worktree_id: string; provider: string | null; status: LocalTask["status"]; cleanup: "terminal" | "shutdown" | null; session_id: string | null; execution_id: string | null; controller_id: string | null; generation: string | null };
// The Worker owns Web execution state here; claim scheduling stays in the minimal index.
export const openWebExecutionStore = (filename: SqliteDatabaseSource, options: { onMigration?: SqliteMigrationReporter; existingOnly?: boolean } = {}) => {
  const openExisting = (): Database.Database => {
    if (typeof filename !== "string") throw new Error("Existing-only Web recovery requires an original file.");
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Original Web execution inventory is not a regular file.");
    const probe = new Database(filename, { readonly: true, fileMustExist: true });
    try { if (probe.transaction(() => inspectSqlite(probe, webExecutionStoreFormat)).deferred().kind !== "current") throw new Error("Original Web execution inventory is not at the current format; it was retained."); }
    finally { probe.close(); }
    const existing = new Database(filename, { fileMustExist: true });
    try {
      if (existing.transaction(() => inspectSqlite(existing, webExecutionStoreFormat)).deferred().kind !== "current") throw new Error("Original Web execution inventory changed before recovery.");
      existing.pragma("busy_timeout = 5000"); existing.pragma("synchronous = FULL");
      return existing;
    } catch (error) { existing.close(); throw error; }
  };
  const pendingWebRecovery = typeof filename === "string" && path.basename(filename) === "web-executions.sqlite" && readTerminationPending(path.join(path.dirname(filename), "termination-domain"))?.key.startsWith("web/");
  const db = options.existingOnly || pendingWebRecovery ? openExisting() : openSqliteDatabase({ file: filename, format: webExecutionStoreFormat, allowCreate: true,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  let quarantined = false;
  const atomic = <T>(operation: () => T): T => {
    if (quarantined) throw new Error("Web execution storage has an unresolved transaction; reopen it before reading or writing.");
    let guardFailure: unknown;
    try {
      return db.transaction(() => {
        try { assertCurrentSqlite(db, webExecutionStoreFormat); }
        catch (error) { guardFailure = error; throw error; }
        return operation();
      }).immediate();
    } catch (error) {
      if (db.open && db.inTransaction) quarantined = true;
      if (guardFailure !== undefined && error !== guardFailure) throw new AggregateError([guardFailure, error], "Web SQLite format assertion and rollback failed.");
      throw error;
    }
  };
  const read = <T>(operation: () => T): T => {
    if (quarantined) throw new Error("Web execution storage has an unresolved transaction; reopen it before reading or writing.");
    if (db.inTransaction) { assertCurrentSqlite(db, webExecutionStoreFormat); return operation(); }
    return db.transaction(() => { assertCurrentSqlite(db, webExecutionStoreFormat); return operation(); }).deferred();
  };
  const getTask = (identity: ClaimIdentity): LocalTask | null => read(() => {
    const row = db.prepare("SELECT data FROM executions WHERE identity = ?").get(key(identity)) as { data: string } | undefined;
    return row === undefined ? null : validate(JSON.parse(row.data) as LocalTask);
  });
  const getTerminationOwner = (identity: ClaimIdentity): OwnerRow | null => {
    const owner = db.prepare("SELECT * FROM termination_owners WHERE identity=?").get(key(identity)) as OwnerRow | undefined;
    if (owner === undefined) return null;
    if (owner.identity !== key(identity) || owner.project_id !== identity.projectId || owner.task_id !== identity.taskId || owner.claim_id !== identity.claimId || [owner.project_id, owner.task_id, owner.claim_id, owner.worker_id, owner.worktree_id, ...(owner.owner_user_id === null ? [] : [owner.owner_user_id]), ...(owner.session_id === null ? [] : [owner.session_id]), ...(owner.execution_id === null ? [] : [owner.execution_id]), ...(owner.controller_id === null ? [] : [owner.controller_id])].some(value => id(value, "Web termination owner") !== value) || normalizeServerUrl(owner.server_origin) !== owner.server_origin || !["pending", "active", "done"].includes(owner.status) || ![null, "terminal", "shutdown"].includes(owner.cleanup) || ![null, "codex", "claude", "copilot"].includes(owner.provider) || owner.generation !== null && (!/^[1-9][0-9]{0,18}$/.test(owner.generation) || BigInt(owner.generation) > 9_223_372_036_854_775_807n)) throw new Error("Web termination owner projection is invalid.");
    return owner;
  };
  const write = (task: LocalTask): LocalTask => {
    validate(task);
    const execution = task.webExecution;
    const previousOwner = getTerminationOwner(task);
    if (previousOwner !== null && (previousOwner.server_origin !== task.serverOrigin || previousOwner.worker_id !== task.workerId || previousOwner.worktree_id !== task.worktreeId || previousOwner.owner_user_id !== null && previousOwner.owner_user_id !== task.userId || previousOwner.provider !== null && previousOwner.provider !== (task.configuration?.agent ?? null) || previousOwner.session_id !== null && previousOwner.session_id !== execution?.sessionId || previousOwner.execution_id !== null && previousOwner.execution_id !== execution?.executionId || previousOwner.controller_id !== null && previousOwner.controller_id !== execution?.controllerId)) throw new Error("Web termination owner cannot be replaced.");
    db.prepare("INSERT INTO termination_owners(identity,server_origin,owner_user_id,worker_id,project_id,task_id,claim_id,worktree_id,provider,status,cleanup,session_id,execution_id,controller_id,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET owner_user_id=excluded.owner_user_id,provider=excluded.provider,status=excluded.status,cleanup=excluded.cleanup,session_id=excluded.session_id,execution_id=excluded.execution_id,controller_id=excluded.controller_id,generation=excluded.generation").run(key(task), task.serverOrigin, task.userId, task.workerId, task.projectId, task.taskId, task.claimId, task.worktreeId, task.configuration?.agent ?? null, task.status, task.cleanup?.kind ?? null, execution?.sessionId ?? null, execution?.executionId ?? null, execution?.controllerId ?? null, execution?.executionGeneration ?? null);
    if (execution !== null) {
      const previous = db.prepare("SELECT * FROM termination_launches WHERE identity=? AND generation=?").get(key(task), execution.executionGeneration) as LaunchRow | undefined;
      if (previous !== undefined && (previous.execution_id !== execution.executionId || previous.launch_id !== execution.launchId || previous.controller_id !== execution.controllerId || previous.controller_instance_id !== execution.controllerInstanceId || previous.session_id !== null && previous.session_id !== execution.sessionId || ["not-submitted", "unknown", "acknowledged"].indexOf(execution.launchSubmission) < ["not-submitted", "unknown", "acknowledged"].indexOf(previous.submission))) throw new Error("Web launch inventory conflicts with its original generation.");
      db.prepare("INSERT INTO termination_launches(identity,generation,execution_id,launch_id,controller_id,controller_instance_id,session_id,submission) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(identity,generation) DO UPDATE SET session_id=excluded.session_id,submission=excluded.submission").run(key(task), execution.executionGeneration, execution.executionId, execution.launchId, execution.controllerId, execution.controllerInstanceId, execution.sessionId, execution.launchSubmission);
    }
    db.prepare("INSERT INTO executions(identity,data) VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data").run(key(task), JSON.stringify(task)); return getTask(task)!;
  };
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
    close: (): void => { closeSqliteDatabase(db, { file: db.name, format: webExecutionStoreFormat }); }, getTask, getOrchestrationBlocker,
    readTerminationSource: (identity: ClaimIdentity) => read(() => {
      const owner = getTerminationOwner(identity);
      if (owner === null) return null;
      const domain = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      return { serverOrigin: owner.server_origin, ownerUserId: owner.owner_user_id, workerId: owner.worker_id, projectId: owner.project_id, taskId: owner.task_id, claimId: owner.claim_id, worktreeId: owner.worktree_id, provider: owner.provider, status: owner.status, cleanup: owner.cleanup, sessionId: owner.session_id, executionId: owner.execution_id, generation: owner.generation, domainId: domain === undefined ? null : id(domain.domain_id, "Termination domain ID") };
    }),
    readTerminationDomain: (identity: ClaimIdentity): string | null => read(() => {
      const row = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      return row === undefined ? null : id(row.domain_id, "Termination domain ID");
    }),
    bindTerminationDomain: (identity: ClaimIdentity, domainId: string): void => atomic(() => {
      const checked = id(domainId, "Termination domain ID");
      if (getTerminationOwner(identity) === null) throw new Error("The original Web execution is missing.");
      const previous = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      if (previous !== undefined && previous.domain_id !== checked) throw new Error("The original Web termination domain cannot be replaced.");
      if (previous === undefined) db.prepare("INSERT INTO termination_domains(identity,domain_id) VALUES(?,?)").run(key(identity), checked);
    }),
    listTerminationInventory: () => read(() => (db.prepare("SELECT identity FROM executions UNION SELECT identity FROM termination_owners UNION SELECT identity FROM termination_launches UNION SELECT identity FROM termination_domains UNION SELECT identity FROM termination_closures").all() as { identity: string }[]).map(row => {
      const [projectId = "", taskId = "", claimId = ""] = row.identity.split("/");
      const identity = { projectId, taskId, claimId };
      try {
      if (row.identity !== key(identity) || db.prepare("SELECT 1 FROM executions WHERE identity=?").get(row.identity) === undefined) throw new Error("Web termination identity has no original execution owner.");
      const task = getTerminationOwner(identity);
      if (task === null) throw new Error("Web termination owner projection is missing.");
      const domain = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      if (domain !== undefined && id(domain.domain_id, "Termination domain ID") !== domain.domain_id) throw new Error("Web termination domain identity is not canonical.");
      const rows = db.prepare("SELECT * FROM termination_launches WHERE identity=?").all(key(identity)) as LaunchRow[];
      rows.sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? -1 : 1);
      const launches = rows.map(row => {
        if (!/^[1-9][0-9]{0,18}$/.test(row.generation) || BigInt(row.generation) > 9_223_372_036_854_775_807n || [row.execution_id, row.launch_id, row.controller_id, row.controller_instance_id].some(value => id(value, "Web launch identity") !== value) || row.session_id !== null && id(row.session_id, "Web Session ID") !== row.session_id || !["not-submitted", "unknown", "acknowledged"].includes(row.submission)) throw new Error("Web launch inventory is invalid.");
        const launch: WebTerminationLaunch = { executionId: row.execution_id, launchId: row.launch_id, controllerId: row.controller_id, controllerInstanceId: row.controller_instance_id, generation: row.generation, submission: row.submission };
        const stopProof = row.stop_proof === null ? null : row.session_id === null ? (() => { throw new Error("Web stop proof has no Session identity."); })() : parseWebTerminationRun(decodeStrictSessionJson(row.stop_proof, Number.POSITIVE_INFINITY), launch, task.claim_id, row.session_id);
        return { ...launch, sessionId: row.session_id, stopProof };
      });
      const closed = db.prepare("SELECT value FROM termination_closures WHERE identity=?").get(key(identity)) as { value: string } | undefined;
      const closure = closed === undefined ? null : parseWebTerminationClosure(decodeStrictSessionJson(closed.value, Number.POSITIVE_INFINITY));
      if (closure !== null && (closure.claimId !== task.claim_id || closure.owner.projectId !== task.project_id || closure.owner.taskId !== task.task_id || closure.owner.workerId !== task.worker_id || closure.owner.worktreeId !== task.worktree_id || closure.owner.ownerUserId !== task.owner_user_id || closure.owner.provider !== task.provider || closure.owner.serverOrigin !== task.server_origin || closure.sessionId !== task.session_id || closure.highestExecutionGeneration !== task.generation || closure.domainId !== domain?.domain_id || closure.launches.length !== launches.length || launches.some(launch => {
        const saved = closure.launches.find(item => item.generation === launch.generation), proof = closure.runs.find(item => item.generation === launch.generation);
        return saved === undefined || ["executionId", "launchId", "controllerId", "controllerInstanceId", "submission"].some(field => saved[field as keyof WebTerminationLaunch] !== launch[field as keyof WebTerminationLaunch]) || launch.sessionId !== closure.sessionId || (launch.stopProof === null ? proof !== undefined : proof === undefined || controllerPayloadHash(launch.stopProof) !== controllerPayloadHash(proof));
      }))) throw new Error("Web closure inventory conflicts with its original owner or launches.");
      return { serverOrigin: task.server_origin, ownerUserId: task.owner_user_id, workerId: task.worker_id, projectId: task.project_id, taskId: task.task_id, claimId: task.claim_id, worktreeId: task.worktree_id, provider: task.provider, status: task.status, cleanup: task.cleanup, domainId: domain?.domain_id ?? null, sessionId: task.session_id, launches, closure, error: null };
      } catch (error) {
        return { ...identity, serverOrigin: null, ownerUserId: null, workerId: null, worktreeId: null, provider: null, status: null, cleanup: null, domainId: null, sessionId: null, launches: [], closure: null, error };
      }
    })),
    readTerminationClosure: (identity: ClaimIdentity): WebTerminationClosure | null => read(() => {
      const row = db.prepare("SELECT value FROM termination_closures WHERE identity=?").get(key(identity)) as { value: string } | undefined;
      if (row === undefined) return null;
      const value = parseWebTerminationClosure(decodeStrictSessionJson(row.value, Number.POSITIVE_INFINITY));
      const task = getTerminationOwner(identity);
      const domain = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      if (domain?.domain_id !== value.domainId) throw new Error("Web termination closure conflicts with its original domain.");
      if (task === null || value.claimId !== identity.claimId || value.owner.projectId !== identity.projectId || value.owner.taskId !== identity.taskId || value.owner.workerId !== task.worker_id || value.owner.worktreeId !== task.worktree_id || value.owner.ownerUserId !== task.owner_user_id || value.owner.serverOrigin !== task.server_origin || value.owner.provider !== task.provider || value.sessionId !== task.session_id || value.highestExecutionGeneration !== task.generation) throw new Error("Web termination closure conflicts with its original owner.");
      const rows = db.prepare("SELECT * FROM termination_launches WHERE identity=?").all(key(identity)) as LaunchRow[];
      if (rows.length !== value.launches.length || rows.some(row => {
        const launch = value.launches.find(item => item.generation === row.generation), proof = value.runs.find(item => item.generation === row.generation);
        return launch === undefined || launch.executionId !== row.execution_id || launch.launchId !== row.launch_id || launch.controllerId !== row.controller_id || launch.controllerInstanceId !== row.controller_instance_id || launch.submission !== row.submission || row.session_id !== value.sessionId || (row.stop_proof === null ? proof !== undefined : proof === undefined || controllerPayloadHash(decodeStrictSessionJson(row.stop_proof, Number.POSITIVE_INFINITY)) !== controllerPayloadHash(proof));
      })) throw new Error("Web termination closure conflicts with its retained launch inventory.");
      return value;
    }),
    recordTerminationStop: (ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot): void => atomic(() => {
      if (ticket.claimId === undefined || ticket.projectId === undefined || ticket.taskId === undefined) throw new Error("A Web termination stop requires its original Task ticket.");
      const identity = { projectId: ticket.projectId, taskId: ticket.taskId, claimId: ticket.claimId };
      const task = getTerminationOwner(identity);
      const binding = db.prepare("SELECT domain_id FROM termination_domains WHERE identity=?").get(key(identity)) as { domain_id: string } | undefined;
      if (ticket.terminationDomain !== undefined && binding?.domain_id !== ticket.terminationDomain.domainId) throw new Error("The stopped Web ticket conflicts with its original termination domain.");
      if (task === null || task.worker_id !== ticket.workerId || task.owner_user_id !== ticket.userId || task.worktree_id !== ticket.worktreeId || task.server_origin !== ticket.serverOrigin || task.session_id !== ticket.sessionId) throw new Error("The stopped Web ticket conflicts with its original owner.");
      const row = db.prepare("SELECT * FROM termination_launches WHERE identity=? AND generation=?").get(key(identity), ticket.executionGeneration) as LaunchRow | undefined;
      if (row === undefined || row.launch_id !== ticket.launchId || row.execution_id !== ticket.executionId || row.controller_id !== ticket.controllerId || row.controller_instance_id !== ticket.controllerInstanceId || row.session_id !== ticket.sessionId || row.submission === "not-submitted" || snapshot.executionId !== ticket.executionId || snapshot.claimId !== ticket.claimId || snapshot.sessionId !== ticket.sessionId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || snapshot.stoppedAt === null || snapshot.controllerProcess === null) throw new Error("The stopped Web generation lacks its original launch or trusted stop evidence.");
      const proof: WebTerminationRun = { executionId: ticket.executionId, launchId: ticket.launchId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, generation: ticket.executionGeneration, ticketHash: controllerPayloadHash(ticket), stoppedSnapshotHash: controllerPayloadHash(snapshot), snapshot };
      const encoded = JSON.stringify(proof);
      if (row.stop_proof !== null && controllerPayloadHash(decodeStrictSessionJson(row.stop_proof, Number.POSITIVE_INFINITY)) !== controllerPayloadHash(proof)) throw new Error("The original Web stop proof cannot be replaced.");
      if (row.stop_proof === null) db.prepare("UPDATE termination_launches SET stop_proof=? WHERE identity=? AND generation=?").run(encoded, key(identity), ticket.executionGeneration);
    }),
    freezeTerminationClosure: (identity: ClaimIdentity, domainId: string, sequence: string, dryRun = false): WebTerminationClosure => atomic(() => {
      const old = db.prepare("SELECT value FROM termination_closures WHERE identity=?").get(key(identity)) as { value: string } | undefined;
      if (old !== undefined) {
        const value = parseWebTerminationClosure(decodeStrictSessionJson(old.value, Number.POSITIVE_INFINITY));
        if (value.domainId !== domainId || !dryRun && value.sequence !== sequence) throw new Error("The retained Web closure conflicts with the original domain or sequence.");
        return value;
      }
      const task = getTerminationOwner(identity);
      if (task === null || task.cleanup !== "terminal" || task.owner_user_id === null || task.provider === null || task.session_id === null || task.execution_id === null || task.controller_id === null || task.generation === null) throw new Error("Web closure requires the original terminal cleanup and Session identity.");
      const rows = db.prepare("SELECT * FROM termination_launches WHERE identity=?").all(key(identity)) as LaunchRow[];
      rows.sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? -1 : 1);
      const launches: WebTerminationLaunch[] = [], runs: WebTerminationRun[] = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        if (row.generation !== String(index + 1) || row.session_id !== task.session_id || row.execution_id !== task.execution_id || row.controller_id !== task.controller_id) throw new Error("The original Web launch inventory is incomplete or conflicts with its Session.");
        launches.push({ executionId: row.execution_id, launchId: row.launch_id, controllerId: row.controller_id, controllerInstanceId: row.controller_instance_id, generation: row.generation, submission: row.submission });
        if (row.submission === "not-submitted") { if (row.stop_proof !== null) throw new Error("An unsubmitted Web launch has conflicting stop evidence."); continue; }
        if (row.stop_proof === null) throw new Error(`Web generation ${row.generation} has no trusted stop proof.`);
        const proof = decodeStrictSessionJson(row.stop_proof, Number.POSITIVE_INFINITY) as WebTerminationRun;
        if (proof.executionId !== row.execution_id || proof.launchId !== row.launch_id || proof.controllerId !== row.controller_id || proof.controllerInstanceId !== row.controller_instance_id || proof.generation !== row.generation || proof.stoppedSnapshotHash !== controllerPayloadHash(proof.snapshot) || !/^[a-f0-9]{64}$/.test(proof.ticketHash) || proof.snapshot.lifecycle !== "stopped" || !proof.snapshot.nativeStopped) throw new Error("Retained Web stop proof is invalid.");
        runs.push(proof);
      }
      if (rows.length === 0 || rows.at(-1)!.generation !== task.generation) throw new Error("The original Web launch inventory does not include its highest generation.");
      const body = { schemaVersion: 1 as const, closureId: randomUUID(), backend: "web" as const, owner: { projectId: task.project_id, taskId: task.task_id, workerId: task.worker_id, worktreeId: task.worktree_id, ownerUserId: task.owner_user_id, serverOrigin: task.server_origin, provider: task.provider }, claimId: task.claim_id, sessionId: task.session_id, highestExecutionGeneration: task.generation, launchesSettled: true as const, launches, runs, domainId, sequence };
      const value = parseWebTerminationClosure({ ...body, closureDigest: controllerPayloadHash(body) });
      if (!dryRun) db.prepare("INSERT INTO termination_closures(identity,value) VALUES(?,?)").run(key(identity), JSON.stringify(value));
      return value;
    }),
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
    /** The caller proves no Controller writer exists and reads back any immutable sidecar. */
    freezeToolLaunch: (identity: ClaimIdentity, launch: ResolvedToolLaunch, now: number, options: { sidecarLaunchId?: string; observation?: import("../types.js").FrozenToolObservation } = {}): LocalTask => change(identity, now, task => {
      requireOrdinary(task);
      const configuration = task.configuration!, execution = task.webExecution;
      if (configuration.agent === "claude") throw new Error("Claude cannot acquire a Worker tool launch.");
      const selected = parseResolvedToolLaunch(launch, { tool: configuration.agent, context: "web" });
      if (configuration.toolLaunch !== undefined) {
        if (!same(configuration.toolLaunch, selected)) throw new Error("The original Web tool selection is already frozen.");
        return task;
      }
      if (task.resources.nativeSession !== null || task.recovery.count !== 0 || task.recovery.retryAuthorized || execution !== null && (execution.executionGeneration !== "1" || execution.ticketPath !== null && options.sidecarLaunchId !== execution.launchId || execution.launchSubmission !== "not-submitted" || execution.controllerProcess !== null || execution.nativeProcesses.length !== 0 || execution.initialInputState !== "not_submitted" || execution.restartAfterShutdown)) throw new ToolSelectionError(configuration.agent, "web", "launch", "legacy_tool_identity_missing");
      return { ...task, configuration: { ...configuration, toolLaunch: selected, ...(options.observation === undefined ? {} : { toolObservation: options.observation }) } };
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
    bindNativeSession: (identity: ClaimIdentity, reference: { source: "controller"; sessionId: string }, now: number, observed?: ControllerSnapshot): LocalTask => change(identity, now, task => {
      id(reference.sessionId, "Native session");
      if (task.resources.nativeSession !== null && task.resources.nativeSession.sessionId !== reference.sessionId) throw new Error("The original native session cannot be replaced.");
      const blocker = getOrchestrationBlocker(task);
      if (blocker !== null) {
        if (!sameOrchestrationIdentity(task, blocker)) throw new Error("The blocked orchestration belongs to another execution identity.");
        if (task.resources.nativeSession === null) {
          const execution = task.webExecution;
          if (execution === null || execution.executionGeneration !== "1" || observed === undefined
            || observed.executionId !== execution.executionId || observed.claimId !== task.claimId || observed.testExecutionId !== undefined
            || observed.sessionId !== execution.sessionId || observed.executionGeneration !== execution.executionGeneration
            || observed.controllerInstanceId !== execution.controllerInstanceId || observed.nativeSessionId !== reference.sessionId
            || observed.controllerProcess === null || execution.controllerProcess === null || !preservesControllerProcessProof(execution.controllerProcess, observed.controllerProcess, execution.launchId)
            || observed.nativeProcesses.length === 0 || !preservesNativeProcessPrefix(execution.nativeProcesses, observed.nativeProcesses)) {
            throw new Error("Binding a blocked native session requires evidence from the original generation.");
          }
          // A lost initial response can leave only the native ID unknown. Persist its verified
          // first binding with the blocker; shutdown must not leave their ownership diverged.
          db.prepare("UPDATE orchestration_blockers SET data=? WHERE identity=?").run(JSON.stringify({ ...blocker, identity: { ...blocker.identity, nativeSessionId: reference.sessionId } }), key(task));
        }
      }
      return { ...task, resources: { ...task.resources, nativeSession: reference } };
    }),
    completeTask: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      const cleanup = needCleanup(task);
      if (cleanup.kind !== "terminal") throw new Error("Web completion requires terminal cleanup intent.");
      return { ...task, status: "done" };
    }),
    initializeWebExecution: (identity: ClaimIdentity, now: number): LocalTask => change(identity, now, task => {
      if (db.prepare("SELECT 1 FROM termination_closures WHERE identity=?").get(key(identity))) throw new Error("The original Web Session is closed; another launch is forbidden.");
      if (task.configuration?.agentControlMode !== "web" || task.status !== "active") throw new Error("Web execution requires its active frozen claim.");
      if (task.webExecution != null) return task;
      return { ...task, nativeExecution: null, webExecution: { executionId: randomUUID(), registrationId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), launchId: randomUUID(), sessionId: null, executionGeneration: "1", initialOperationId: randomUUID(), initialPrompt: null, launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, nativeHome: null, summary: null, initialInputState: "not_submitted", activity: "initializing" } };
    }),
    observeStartup: (identity: ClaimIdentity & Partial<Pick<LocalTask, "webExecution">>, startup: StartupObservation, now: number): SessionStartupReport | null => atomic(() => {
      const task = getTask(identity), execution = task?.webExecution;
      if (task === null || execution == null || execution.sessionId === null || task.status === "done") return null;
      if (identity.webExecution != null && (identity.webExecution.executionGeneration !== execution.executionGeneration || identity.webExecution.controllerInstanceId !== execution.controllerInstanceId || identity.webExecution.sessionId !== execution.sessionId)) throw new Error("Startup observation belongs to another execution generation.");
      const incoming = parseStartupObservation(startup), previous = execution.startupReport;
      // Every producer must preserve the later launch outcome over an unfinished journal.
      const observation = incoming.state === "starting" && previous?.startup.reasonCode === "controller_start_unknown"
        ? previous.startup : incoming;
      const recovery: SessionStartupReport["recovery"] = task.recovery.pauseReason === null
        ? { state: "none", reasonCode: null }
        : { state: "blocked", reasonCode: task.recovery.reasonCode ?? "recovery_blocked" };
      if (previous !== undefined && same(previous.startup, observation) && same(previous.recovery, recovery)) return previous;
      const report: SessionStartupReport = { schemaVersion: 1, source: "worker", sessionId: execution.sessionId, claimId: task.claimId,
        executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId,
        revision: String(BigInt(previous?.revision ?? "0") + 1n), observedAt: new Date(integer(now, "Startup observation time")).toISOString(), startup: observation, recovery };
      return write({ ...task, updatedAt: now, webExecution: { ...execution, startupReport: report } }).webExecution!.startupReport!;
    }),
    updateWebExecution: (identity: ClaimIdentity, patch: Partial<WebExecutionState>, now: number): LocalTask => change(identity, now, task => {
      if (db.prepare("SELECT 1 FROM termination_closures WHERE identity=?").get(key(identity))) throw new Error("The original Web Session is closed; execution changes are forbidden.");
      if (task.configuration?.agentControlMode !== "web" || task.webExecution == null) throw new Error("The web execution identity is missing.");
      const previous = task.webExecution;
      const submissions = ["not-submitted", "unknown", "acknowledged"];
      if (patch.launchSubmission !== undefined && submissions.indexOf(patch.launchSubmission) < submissions.indexOf(previous.launchSubmission)) throw new Error("A Web launch submission cannot regress after a possible dispatch.");
      if (patch.restartAfterShutdown !== undefined && patch.restartAfterShutdown !== previous.restartAfterShutdown) throw new Error("Orderly restart provenance requires confirmed shutdown.");
      for (const key of ["executionGeneration", "controllerInstanceId", "launchId"] as const) if (patch[key] !== undefined && patch[key] !== previous[key]) throw new Error("A new web generation requires verified original process stop.");
      for (const key of ["executionId", "registrationId", "controllerId", "initialOperationId"] as const) if (patch[key] !== undefined && patch[key] !== previous[key]) throw new Error("The web execution identity cannot be replaced.");
      if (previous.nativeHome !== null && patch.nativeHome !== undefined && patch.nativeHome !== previous.nativeHome) throw new Error("The original native profile cannot change.");
      if (previous.initialPrompt !== null && patch.initialPrompt !== undefined && patch.initialPrompt !== previous.initialPrompt) throw new Error("The original managed prompt cannot change.");
      if (previous.sessionId !== null && patch.sessionId !== undefined && patch.sessionId !== previous.sessionId) throw new Error("The registered session cannot change.");
      return { ...task, webExecution: parseWebExecution({ ...previous, ...patch }) };
    }),
    beginWebGeneration: (identity: ClaimIdentity, previous: { executionGeneration: string; controllerInstanceId: string; nativeSessionId: string | null; nativeStopped: boolean }, now: number, toolLaunch?: ResolvedToolLaunch): LocalTask => change(identity, now, task => {
      if (db.prepare("SELECT 1 FROM termination_closures WHERE identity=?").get(key(identity))) throw new Error("The original Web Session is closed; another generation is forbidden.");
      requireOrdinary(task); const execution = task.webExecution;
      if (execution == null || task.configuration?.agentControlMode !== "web" || previous.executionGeneration !== execution.executionGeneration || previous.controllerInstanceId !== execution.controllerInstanceId || !previous.nativeStopped || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession?.sessionId) throw new Error("Web recovery requires the exact stopped generation and native identity.");
      if (db.prepare("SELECT 1 FROM termination_domains WHERE identity=?").get(key(identity)) !== undefined) {
        const row = db.prepare("SELECT * FROM termination_launches WHERE identity=? AND generation=?").get(key(identity), execution.executionGeneration) as LaunchRow | undefined;
        if (row === undefined || row.stop_proof === null || row.session_id === null || row.submission === "not-submitted") throw new Error("Web recovery requires retained proof for its original stopped generation.");
        const launch: WebTerminationLaunch = { executionId: row.execution_id, launchId: row.launch_id, controllerId: row.controller_id, controllerInstanceId: row.controller_instance_id, generation: row.generation, submission: row.submission };
        const proof = parseWebTerminationRun(decodeStrictSessionJson(row.stop_proof, Number.POSITIVE_INFINITY), launch, task.claimId, row.session_id);
        if (proof.snapshot.nativeSessionId !== previous.nativeSessionId || proof.snapshot.controllerInstanceId !== previous.controllerInstanceId) throw new Error("Web recovery conflicts with its retained stopped generation.");
      }
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) throw new Error("The paused execution requires an explicit recovery retry.");
      if (task.recovery.retryAuthorized && task.recovery.pauseReason === null) throw new Error("The authorized recovery generation is still awaiting a successful observation.");
      let configuration = task.configuration;
      if (configuration.agent !== "claude") {
        const selected = toolLaunch ?? configuration.toolLaunch;
        if (selected === undefined) throw new ToolSelectionError(configuration.agent, "web", "launch", "legacy_tool_identity_missing");
        const checked = parseResolvedToolLaunch(selected, { tool: configuration.agent, context: "web" });
        if (configuration.toolLaunch !== undefined && !same(configuration.toolLaunch, checked)) throw new Error("Recovery cannot replace the original Web tool selection.");
        configuration = { ...configuration, toolLaunch: checked };
      }
      // Persist consumption and its sole replacement identity together across Worker interruption.
      const recovery = task.recovery.retryAuthorized ? { count: integer(task.recovery.count + 1, "Recovery count"), pauseReason: null, retryAuthorized: true } : task.recovery;
      const { startupReport: previousReport, ...previousExecution } = execution; void previousReport;
      return { ...task, configuration, recovery, webExecution: { ...previousExecution, executionGeneration: String(BigInt(execution.executionGeneration) + 1n), controllerInstanceId: randomUUID(), launchId: randomUUID(), launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], restartAfterShutdown: false, cleanupOperationId: null, ticketPath: null, activity: "initializing" } };
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
