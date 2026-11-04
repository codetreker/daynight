import path from "node:path";
import { closeSqliteDatabase, openSqliteDatabase, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import { parseStartupObservation, type StartupObservation } from "../../../session/startup.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import type { ProcessProof } from "../../controller/process-proof.js";
import { workerStoreFormat } from "../store-format.js";
import { botUUID, botVersion, parseBotOwner, type BotRecord } from "./types.js";

export type BotExecution = {
  launchId: string; executionId: string; executionGeneration: string;
  launchSubmission: "not-submitted" | "unknown" | "acknowledged";
  controllerProcess: ProcessProof | null; snapshot: ControllerSnapshot | null;
  aliasDirectory: string | null; lastError: string | null; startup: StartupObservation | null;
};
export type BotExecutionPatch = Partial<Omit<BotExecution, "launchId" | "executionId" | "executionGeneration">>;
const fields = ["launchSubmission", "controllerProcess", "snapshot", "aliasDirectory", "lastError", "startup"];
const submissions = ["not-submitted", "unknown", "acknowledged"];
const predicate = "server_origin = @serverOrigin AND owner_user_id = @ownerUserId AND worker_id = @workerId AND bot_id = @botId";
const same = (left: unknown, right: unknown): boolean => controllerPayloadHash(left) === controllerPayloadHash(right);
const identity = (record: BotRecord) => ({ ...parseBotOwner(record.owner), botId: botUUID(record.botId, "Bot ID") });

const checkProcess = (proof: ProcessProof): void => {
  if (proof === null || typeof proof !== "object" || !Number.isSafeInteger(proof.pid) || proof.pid < 1 || proof.pid > 2_147_483_647
    || !Number.isSafeInteger(proof.parentPid) || proof.parentPid < 0 || proof.parentPid > 2_147_483_647
    || !(proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0)
    || typeof proof.startedAt !== "string" || proof.startedAt.trim() === "" || !proof.startedAt.isWellFormed()
    || typeof proof.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(proof.commandHash)
    || proof.jobObjectName !== undefined && (typeof proof.jobObjectName !== "string" || proof.jobObjectName.trim() === "" || /\0/.test(proof.jobObjectName))) {
    throw new Error("Bot controller process evidence is invalid.");
  }
};
// Parent exit may reparent the same writer; match the birth identity used by process-proof.ts.
const sameProcess = (previous: ProcessProof, next: ProcessProof): boolean => previous.pid === next.pid
  && previous.processGroupId === next.processGroupId
  && previous.startedAt === next.startedAt && previous.commandHash === next.commandHash
  && (previous.jobObjectName === undefined || previous.jobObjectName === next.jobObjectName);

const checkSnapshot = (record: BotRecord, snapshot: ControllerSnapshot): void => {
  const intent = record.intent!;
  if (snapshot === null || typeof snapshot !== "object" || snapshot.executionId !== intent.executionId
    || snapshot.testExecutionId !== intent.registration.testExecutionId || snapshot.claimId !== undefined
    || snapshot.sessionId !== intent.sessionId || intent.sessionId === null
    || snapshot.executionGeneration !== intent.executionGeneration || snapshot.controllerInstanceId !== intent.registration.controllerInstanceId
    || snapshot.initialInputState !== "not_required") throw new Error("Bot snapshot does not match the original execution fence or input intent.");
  if (snapshot.nativeSessionId !== null) botUUID(snapshot.nativeSessionId, "Bot native session ID");
  if (intent.nativeSessionId !== null && snapshot.nativeSessionId !== intent.nativeSessionId) throw new Error("Bot snapshot cannot replace the original native session.");
  if (!["starting", "ready", "working", "stopping", "stopped", "paused", "failed"].includes(snapshot.lifecycle)
    || !["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(snapshot.activity)
    || !Array.isArray(snapshot.nativeProcesses) || typeof snapshot.nativeStopped !== "boolean"
    || !(snapshot.stoppedAt === null || typeof snapshot.stoppedAt === "string" && Number.isFinite(Date.parse(snapshot.stoppedAt)))
    || !(snapshot.error === null || typeof snapshot.error === "string")) throw new Error("Bot snapshot lifecycle evidence is invalid.");
  if (snapshot.controllerProcess !== null) checkProcess(snapshot.controllerProcess);
  for (const proof of snapshot.nativeProcesses) checkProcess(proof);
};
const check = (record: BotRecord, value: BotExecution): BotExecution => {
  const intent = record.intent!;
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== [...fields, "launchId", "executionId", "executionGeneration"].sort().join()
    || value.launchId !== intent.launchId || value.executionId !== intent.executionId || value.executionGeneration !== intent.executionGeneration) throw new Error("Bot execution identity differs from its durable launch intent.");
  botUUID(value.launchId, "Bot launch ID"); botUUID(value.executionId, "Bot execution ID"); botVersion(value.executionGeneration);
  if (!submissions.includes(value.launchSubmission)) throw new Error("Bot launch submission evidence is invalid.");
  if (value.startup !== null) parseStartupObservation(value.startup);
  if (value.controllerProcess !== null) checkProcess(value.controllerProcess);
  if (value.snapshot !== null) {
    checkSnapshot(record, value.snapshot);
    if (value.controllerProcess !== null && value.snapshot.controllerProcess !== null && !sameProcess(value.controllerProcess, value.snapshot.controllerProcess)) throw new Error("Bot snapshot has a conflicting controller process.");
  }
  if (value.launchSubmission === "not-submitted" && (value.controllerProcess !== null || value.snapshot !== null)) throw new Error("Bot process evidence requires a submitted launch.");
  if (!(value.aliasDirectory === null || typeof value.aliasDirectory === "string" && path.isAbsolute(value.aliasDirectory) && !/[\0\r\n]/.test(value.aliasDirectory))) throw new Error("Bot alias directory must be an absolute path.");
  if (!(value.lastError === null || typeof value.lastError === "string" && value.lastError.isWellFormed())) throw new Error("Bot execution error must be Unicode text or null.");
  return value;
};

/** The caller retains the Worker instance lock; these rows never enter Task capacity or cleanup inventory. */
export const openBotExecutionStore = (file: string, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file, format: workerStoreFormat, allowCreate: true,
    ...(options.busyTimeoutMs === undefined ? {} : { timeoutMs: options.busyTimeoutMs }),
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  const atomic = <T>(action: () => T): T => db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return action(); }).immediate();
  const read = <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return action(); }).deferred();
  const current = (record: BotRecord): BotRecord => {
    const row = db.prepare(`SELECT record FROM bots WHERE ${predicate}`).get(identity(record)) as { record: string } | undefined;
    if (row === undefined) throw new Error("Bot execution requires its original inventory record.");
    const saved = JSON.parse(row.record) as BotRecord;
    if (!same(saved.owner, record.owner) || saved.botId !== record.botId || saved.intent === null || record.intent === null
      || !same(saved.intent, record.intent)) throw new Error("Bot execution requires the current durable launch intent.");
    if (saved.intent.executionId !== saved.intent.registration.testExecutionId) throw new Error("Bot execution identity differs from its registration.");
    return saved;
  };
  const get = (record: BotRecord): BotExecution | null => read(() => {
    const saved = current(record);
    const row = db.prepare(`SELECT record FROM bot_executions WHERE ${predicate}`).get(identity(saved)) as { record: string } | undefined;
    return row === undefined ? null : check(saved, JSON.parse(row.record) as BotExecution);
  });
  const put = (record: BotRecord, value: BotExecution): BotExecution => {
    check(record, value);
    db.prepare(`INSERT INTO bot_executions(server_origin, owner_user_id, worker_id, bot_id, record) VALUES (@serverOrigin, @ownerUserId, @workerId, @botId, @record)
      ON CONFLICT(server_origin, owner_user_id, worker_id, bot_id) DO UPDATE SET record=excluded.record`).run({ ...identity(record), record: JSON.stringify(value) });
    return get(record)!;
  };
  return {
    get,
    prepare: (record: BotRecord): BotExecution => atomic(() => {
      const saved = current(record);
      if (saved.observed.deletion !== null) throw new Error("A deleting Bot cannot prepare execution.");
      const existing = get(saved); if (existing !== null) return existing;
      const intent = saved.intent!;
      return put(saved, { launchId: intent.launchId, executionId: intent.executionId, executionGeneration: intent.executionGeneration,
        launchSubmission: "not-submitted", controllerProcess: null, snapshot: null, aliasDirectory: null, lastError: null, startup: null });
    }),
    update: (record: BotRecord, patch: BotExecutionPatch): BotExecution => atomic(() => {
      if (patch === null || typeof patch !== "object" || Object.keys(patch).some(field => !fields.includes(field))) throw new Error("Bot execution patch cannot change identity fields.");
      const saved = current(record), previous = get(saved);
      if (previous === null) throw new Error("Bot execution evidence has not been prepared.");
      const next = { ...previous, ...patch };
      if (submissions.indexOf(next.launchSubmission) < submissions.indexOf(previous.launchSubmission)) throw new Error("Bot launch submission cannot regress after a possible dispatch.");
      check(saved, next);
      if (previous.startup !== null && (previous.startup.state === "failed" || previous.startup.state === "ready") && !same(previous.startup, next.startup)) {
        throw new Error("Bot terminal startup evidence cannot change within the original generation.");
      }
      if (previous.controllerProcess !== null && (next.controllerProcess === null || !sameProcess(previous.controllerProcess, next.controllerProcess))) throw new Error("Bot controller process evidence cannot be replaced or discarded.");
      if (previous.snapshot !== null) {
        if (next.snapshot === null) throw new Error("Bot snapshot evidence cannot be discarded.");
        if (previous.snapshot.nativeSessionId !== null && next.snapshot.nativeSessionId !== previous.snapshot.nativeSessionId) throw new Error("Bot snapshot cannot replace the original native session.");
        if (previous.snapshot.controllerProcess !== null && (next.snapshot.controllerProcess === null || !sameProcess(previous.snapshot.controllerProcess, next.snapshot.controllerProcess))) throw new Error("Bot snapshot cannot discard its controller process.");
      }
      if (previous.launchSubmission !== "not-submitted" && previous.aliasDirectory !== next.aliasDirectory) throw new Error("Bot aliases remain owned by the submitted execution.");
      return put(saved, next);
    }),
    close: (): void => closeSqliteDatabase(db, { file, format: workerStoreFormat }),
  };
};
export type BotExecutionStore = ReturnType<typeof openBotExecutionStore>;
