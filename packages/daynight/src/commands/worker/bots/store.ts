import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath } from "../../controller/launch-ticket.js";
import { workerStoreFormat } from "../store-format.js";
import { botUUID, botVersion, parseBot, parseBotOwner, parseBotRole, type Bot, type BotOwner, type BotRecord, type BotLaunchIntent, type BotRoleConfiguration } from "./types.js";

const same = (left: unknown, right: unknown): boolean => controllerPayloadHash(left) === controllerPayloadHash(right);
const time = (value: number): number => { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Bot observation time must be a nonnegative safe integer."); return value; };
const key = (owner: BotOwner, botId: string) => ({ ...parseBotOwner(owner), botId: botUUID(botId, "Bot ID") });
const predicate = "server_origin = @serverOrigin AND owner_user_id = @ownerUserId AND worker_id = @workerId";

/** The caller holds the Worker instance lock throughout inventory and execution access. */
export const openBotStore = (databaseFile: string, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file: databaseFile, format: workerStoreFormat, allowCreate: true,
    ...(options.busyTimeoutMs === undefined ? {} : { timeoutMs: options.busyTimeoutMs }),
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  const atomic = <T>(action: () => T): T => db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return action(); }).immediate();
  const read = <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return action(); }).deferred();
  const parseRecord = (value: string, owner: BotOwner): BotRecord => {
    const record = JSON.parse(value) as BotRecord;
    if (!same(record.owner, owner) || record.botId !== record.observed.id) throw new Error("Stored Bot inventory identity is inconsistent.");
    parseBot(record.observed, owner);
    if (record.definition !== null) {
      const definition = parseBot(record.definition, owner);
      if (definition.deletion !== null || definition.id !== record.botId) throw new Error("Stored Bot definition is inconsistent.");
    }
    time(record.observedAt);
    if (record.intent !== null) {
      const intent = record.intent;
      for (const id of [intent.launchId, intent.executionId, intent.initialOperationId, intent.registration.registrationId, intent.registration.testExecutionId, intent.registration.controllerId, intent.registration.controllerInstanceId]) botUUID(id, "Bot launch identity");
      if (intent.executionId !== intent.registration.testExecutionId || intent.registration.initialInput !== "none" || intent.registration.protocol !== "daynight.session.v1" || intent.registration.schemaVersion !== 1 || intent.registration.projectionVersion !== 1 || record.definition === null || intent.registration.provider !== record.definition.resolvedConfiguration.provider) throw new Error("Stored Bot launch binding is inconsistent.");
      botVersion(intent.botVersion); botVersion(intent.executionGeneration);
      if (intent.sessionId !== null) botUUID(intent.sessionId, "Bot session ID");
      if (intent.nativeSessionId !== null) botUUID(intent.nativeSessionId, "Bot native session ID");
      for (const file of [intent.ticketPath, intent.journalPath, intent.credentialFile]) if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error("Stored Bot private path is invalid.");
      if (!Number.isSafeInteger(intent.recoveryLimit) || intent.recoveryLimit < 0) throw new Error("Stored Bot recovery limit is invalid.");
      if (intent.roleConfiguration !== null) parseBotRole(intent.roleConfiguration);
    }
    return record;
  };
  const get = (owner: BotOwner, botId: string): BotRecord | null => read(() => {
    const identity = key(owner, botId);
    const row = db.prepare(`SELECT record FROM bots WHERE ${predicate} AND bot_id = @botId`).get(identity) as { record: string } | undefined;
    return row === undefined ? null : parseRecord(row.record, owner);
  });
  const put = (record: BotRecord): BotRecord => {
    const serialized = JSON.stringify(record);
    parseRecord(serialized, record.owner);
    db.prepare(`INSERT INTO bots(server_origin, owner_user_id, worker_id, bot_id, record) VALUES (@serverOrigin, @ownerUserId, @workerId, @botId, @record)
      ON CONFLICT(server_origin, owner_user_id, worker_id, bot_id) DO UPDATE SET record = excluded.record`).run({ ...key(record.owner, record.botId), record: serialized });
    return get(record.owner, record.botId)!;
  };
  const required = (owner: BotOwner, botId: string): BotRecord => {
    const record = get(owner, botId);
    if (record === null) throw new Error("Bot has not been observed in this Worker inventory.");
    return record;
  };
  return {
    close: (): void => closeSqliteDatabase(db, { file: databaseFile, format: workerStoreFormat }),
    get,
    list: (owner: BotOwner): BotRecord[] => read(() => {
      const identity = parseBotOwner(owner);
      return (db.prepare(`SELECT record FROM bots WHERE ${predicate} ORDER BY bot_id`).all(identity) as { record: string }[]).map(row => parseRecord(row.record, identity));
    }),
    observe: (owner: BotOwner, input: Bot, observedAt: number): BotRecord => atomic(() => {
      const observed = parseBot(input, owner); time(observedAt);
      const previous = get(owner, observed.id);
      if (previous !== null) {
        if (BigInt(observed.version) < BigInt(previous.observed.version)) throw new Error("Bot observation version regressed.");
        if (observed.version === previous.observed.version && !same(observed, previous.observed)) throw new Error("Bot observation changed without a new version.");
        if (previous.observed.deletion !== null && (observed.deletion === null || observed.deletion.deletionId !== previous.observed.deletion.deletionId)) throw new Error("Bot deletion responsibility cannot be replaced.");
        if (observed.deletion === null && previous.definition !== null) {
          if (!same(observed.resolvedConfiguration, previous.definition.resolvedConfiguration)) throw new Error("Bot frozen configuration cannot change.");
          if (previous.definition.sessionId !== null && (observed.sessionId !== previous.definition.sessionId || observed.testExecutionId !== previous.definition.testExecutionId)) throw new Error("Bot stable session binding cannot change.");
          const role = previous.intent?.roleConfiguration ?? previous.definition.roleConfiguration;
          if (role !== null && observed.roleConfiguration !== null && !same(role, observed.roleConfiguration)) throw new Error("Bot frozen role configuration cannot change.");
          if (previous.definition.roleConfiguration !== null && observed.roleConfiguration === null) throw new Error("Bot frozen role configuration cannot disappear.");
        }
      }
      const definition = observed.deletion === null ? observed : previous?.definition ?? null;
      const intent = previous?.intent ?? null;
      if (intent !== null && observed.deletion === null) {
        if (observed.testExecutionId !== null && observed.testExecutionId !== intent.registration.testExecutionId) throw new Error("Bot registered execution differs from the durable launch intent.");
        if (intent.sessionId !== null && observed.sessionId !== intent.sessionId) throw new Error("Bot stable session binding cannot change.");
        if (observed.sessionId !== null) intent.sessionId = observed.sessionId;
        if (observed.roleConfiguration !== null) intent.roleConfiguration = observed.roleConfiguration;
      }
      return put({ owner: parseBotOwner(owner), botId: observed.id, observed, definition, intent, observedAt });
    }),
    /** Persist the first registration identity before any register, ticket write or spawn. */
    prepare: (owner: BotOwner, botId: string, input: { homeDirectory: string; recoveryLimit: number }): BotLaunchIntent => atomic(() => {
      const record = required(owner, botId);
      if (record.observed.deletion !== null) throw new Error("A deleting Bot cannot prepare a launch.");
      if (record.intent !== null) return record.intent;
      if (record.definition === null || record.definition.sessionId !== null) throw new Error("An existing bound Bot session requires its original execution evidence.");
      if (!path.isAbsolute(input.homeDirectory) || /[\0\r\n]/.test(input.homeDirectory)) throw new Error("Bot home directory must be absolute.");
      if (!Number.isSafeInteger(input.recoveryLimit) || input.recoveryLimit < 0) throw new Error("Bot recovery limit must be a nonnegative safe integer.");
      const executionId = randomUUID(), launchId = randomUUID();
      const directory = controllerExecutionDirectory(input.homeDirectory, executionId);
      record.intent = { botVersion: record.observed.version,
        registration: { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, registrationId: randomUUID(), testExecutionId: executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), provider: record.definition.resolvedConfiguration.provider, initialInput: "none" },
        launchId, executionId, initialOperationId: randomUUID(), sessionId: null, executionGeneration: "1", nativeSessionId: null,
        ticketPath: controllerTicketPath(input.homeDirectory, launchId), journalPath: path.join(directory, "journal.sqlite"), credentialFile: path.join(directory, "credential.json"), recoveryLimit: input.recoveryLimit, roleConfiguration: record.definition.roleConfiguration };
      return put(record).intent!;
    }),
    /** First preparation owns the role; neither retries nor template upgrades replace it. */
    freezeRole: (owner: BotOwner, botId: string, value: BotRoleConfiguration): BotLaunchIntent => atomic(() => {
      const record = required(owner, botId), role = parseBotRole(value);
      if (record.observed.deletion !== null || record.intent === null) throw new Error("Bot role requires an active durable launch intent.");
      if (record.intent.roleConfiguration !== null && !same(record.intent.roleConfiguration, role)) throw new Error("Bot role configuration is already frozen.");
      record.intent.roleConfiguration = role;
      return put(record).intent!;
    }),
  };
};
export type BotStore = ReturnType<typeof openBotStore>;
