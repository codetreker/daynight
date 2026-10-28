import { sessionDisplayEntry } from "./wire-display.js";
import type { SessionControls } from "../../session/controls.js";
import Database from "better-sqlite3";
import { createLocalSessionContent } from "./local-content.js";
import { chmodSync } from "node:fs";
import { sessionBinding, type SessionBinding, type InitialInputState, type OperationState, type SessionCapabilities } from "../../session/protocol.js";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { parseSourceEvent, type SourceTimelineEntry } from "../../session/controller-protocol.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "./process-proof.js";
export type ControllerSnapshot = SessionBinding & {
  executionId: string; sessionId: string; executionGeneration: string; controllerInstanceId: string;
  lifecycle: "starting" | "ready" | "working" | "stopping" | "stopped" | "paused" | "failed";
  nativeSessionId: string | null; initialInputState: InitialInputState;
  activity: "initializing" | "idle" | "working" | "waiting_input" | "stopped" | "unknown";
  currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; controlsRevisionFloor?: string; turnStartedAt?: string | null;
  controllerProcess: ProcessProof | null; nativeProcesses: readonly ProcessProof[];
  nativeStopped: boolean; stoppedAt: string | null; error: string | null;
};
export type ControllerOperation = {
  executionGeneration?: string;
  operationId: string; kind: "initial" | "cleanup" | "send_message" | "cancel" | "interaction_response" | "update_setting" | "execute_command" | "refresh_controls";
  payload: unknown; payloadHash: string; state: OperationState;
  result: unknown; error: string | null; createdAt: number; updatedAt: number;
};
export type ControllerOutboxEvent = { sequence: string; payload: unknown };
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const validSequence = (value: string): bigint => { if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error("Invalid controller outbox sequence."); return BigInt(value); };
export const openControllerLifecycleStore = (file: string, ticket: ControllerLaunchTicket, options: { maxOutboxBytes?: number; contentOwnedLocally?: boolean } = {}) => {
  const maxOutboxBytes = options.maxOutboxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutboxBytes) || maxOutboxBytes < 256) throw new Error("Invalid controller outbox capacity.");
  parseLaunchTicket(ticket);
  const db = new Database(file); chmodSync(file, 0o600); db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  const initial: ControllerSnapshot = { executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", nativeSessionId: ticket.resumeNativeSessionId, initialInputState: ticket.initialInput === "none" ? "not_required" : "not_submitted", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: null, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null };
  const atomic = <T>(action: () => T): T => db.transaction(action).immediate();
  try { atomic(() => {
    const version = db.pragma("user_version", { simple: true }); if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error("Unsupported controller journal version.");
    if (version === 0) db.exec("CREATE TABLE execution (id INTEGER PRIMARY KEY CHECK(id=1), ticket_hash TEXT NOT NULL, owner_pid INTEGER, snapshot TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;");
    if (version < 2) db.exec("ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0; CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL); PRAGMA user_version=2;");
    if (version < 3) db.exec("ALTER TABLE operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;");
    if (version < 4) db.exec("ALTER TABLE execution ADD COLUMN projection_gap TEXT; PRAGMA user_version=4;");
    if (version < 5) db.exec("ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0; CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB); PRAGMA user_version=5;");
    const existing = db.prepare("SELECT ticket_hash, owner_pid, snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; owner_pid: number | null; snapshot: string } | undefined;
    if (existing === undefined) db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,?,?)").run(controllerPayloadHash(ticket), process.pid, JSON.stringify(initial));
    else {
      if (existing.owner_pid !== null) {
        try { process.kill(existing.owner_pid, 0); throw new Error("The original controller journal writer is still running."); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      const previous = json<ControllerSnapshot>(existing.snapshot);
      if (previous.executionId !== ticket.executionId || previous.claimId !== ticket.claimId || previous.testExecutionId !== ticket.testExecutionId || previous.sessionId !== ticket.sessionId) throw new Error("Controller journal belongs to another execution.");
      if (existing.ticket_hash === controllerPayloadHash(ticket) && previous.controllerProcess !== null) throw new Error("A native controller generation cannot be relaunched without a new stopped-generation ticket.");
      if (existing.ticket_hash !== controllerPayloadHash(ticket)) {
        if (BigInt(ticket.executionGeneration) !== BigInt(previous.executionGeneration) + 1n || !previous.nativeStopped || previous.lifecycle !== "stopped" || previous.nativeSessionId === null || previous.nativeSessionId !== ticket.resumeNativeSessionId) throw new Error("Controller recovery requires a stopped original generation and exact native identity.");
        db.prepare("UPDATE execution SET ticket_hash=?,snapshot=? WHERE id=1").run(controllerPayloadHash(ticket), JSON.stringify({ ...initial, initialInputState: previous.initialInputState, controlsRevisionFloor: (() => {
          let floor = BigInt(previous.controls?.revision ?? previous.controlsRevisionFloor ?? "0");
          // Old source events are replayed before new provider state. Keep their
          // highest revision across execution reset without dropping the outbox.
          for (const row of db.prepare("SELECT json_extract(value, '$.payload.controls.revision') AS revision FROM outbox WHERE json_extract(value, '$.kind')='state'").iterate() as Iterable<{ revision: string | null }>) {
            if (row.revision !== null && /^[1-9][0-9]{0,18}$/.test(row.revision) && BigInt(row.revision) > floor) floor = BigInt(row.revision);
          }
          return String(floor);
        })() }));
      }
      db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid);
    }
  }); } catch (error) { db.close(); throw error; }
  const getSnapshot = (): ControllerSnapshot => json((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot);
  const getOperation = (operationId: string): ControllerOperation | null => { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined; return row === undefined ? null : json(row.value); };
  const writeOperation = (operation: ControllerOperation): ControllerOperation => { db.prepare("INSERT INTO operations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,acknowledged=0").run(operation.operationId, JSON.stringify(operation)); return operation; };
  const patchSnapshot = (patch: Partial<Omit<ControllerSnapshot, "executionId" | "claimId" | "testExecutionId" | "sessionId" | "executionGeneration" | "controllerInstanceId">>): ControllerSnapshot => atomic(() => {
    const current = getSnapshot();
    if (Object.keys(patch).some((key) => ["executionId", "claimId", "testExecutionId", "sessionId", "executionGeneration", "controllerInstanceId"].includes(key))) throw new Error("Controller identity cannot change within a generation.");
    if (current.nativeSessionId !== null && patch.nativeSessionId !== undefined && patch.nativeSessionId !== current.nativeSessionId) throw new Error("The original native session cannot be replaced.");
    const value = { ...current, ...patch }; db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); return value;
  });
  const outboxBytes = (): number => (db.prepare("SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM outbox").get() as { bytes: number }).bytes;
  const assertInputCapacity = (): void => { if (!options.contentOwnedLocally && outboxBytes() >= maxOutboxBytes * 0.8) throw new Error("Controller outbox capacity reached; native input is paused until durable events are acknowledged."); };
  const localContent = createLocalSessionContent(db, ticket.sessionId);
  const appendEvent = (payload: unknown): ControllerOutboxEvent => atomic(() => {
    if (options.contentOwnedLocally && payload && typeof payload === "object" && "kind" in payload && payload.kind === "resource" && "payload" in payload) {
      const event = parseSourceEvent({ sourceSeq: "1", ...payload });
      if (event.kind === "resource") localContent.saveResource(event.payload);
    }
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error("Controller event must be serializable.");
    if (outboxBytes() + Buffer.byteLength(encoded) > maxOutboxBytes) {
      if (!options.contentOwnedLocally) throw new Error("Controller outbox capacity exceeded; event was not discarded.");
      // Content is already committed in the local projection. Only transport
      // replay is discarded; the next connection must hydrate from local data.
      db.prepare("DELETE FROM outbox").run();
      db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    }
    const row = db.prepare("UPDATE execution SET last_sequence=last_sequence+1 WHERE id=1 RETURNING CAST(last_sequence AS TEXT) AS sequence").get() as { sequence: string };
    if (options.contentOwnedLocally && Buffer.byteLength(encoded) > maxOutboxBytes) db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    else db.prepare("INSERT INTO outbox(sequence,value) VALUES(?,?)").run(BigInt(row.sequence), encoded);
    return { sequence: row.sequence, payload };
  });
  let closed = false;
  return {
    getSnapshot, patchSnapshot, getOperation, assertInputCapacity,
    ...localContent,
    getSourceFloor: (): string => (db.prepare("SELECT CAST(source_floor AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence,
    getLastSourceSequence: (): string => (db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence,
    markProjectionGap: (reason: string): void => {
      if (typeof reason !== "string" || reason.trim() === "") throw new Error("Projection gap requires a reason.");
      // A single bounded marker survives outbox exhaustion and controller generations.
      let safeReason = "";
      for (const character of reason) {
        if (Buffer.byteLength(JSON.stringify({kind:"gap",payload:{reason:safeReason + character}})) > 256) break;
        safeReason += character;
      }
      db.prepare("UPDATE execution SET projection_gap=COALESCE(projection_gap,?) WHERE id=1").run(safeReason);
    },
    drainProjectionGap: (): ControllerOutboxEvent | null => atomic(() => {
      const row = db.prepare("SELECT projection_gap AS reason FROM execution WHERE id=1").get() as {reason:string|null};
      if (row.reason === null) return null;
      const payload = {kind:"gap",payload:{reason:row.reason}};
      if (outboxBytes() + Buffer.byteLength(JSON.stringify(payload)) > maxOutboxBytes) return null;
      parseSourceEvent({sourceSeq:"1",...payload});
      const event = appendEvent(payload);
      db.prepare("UPDATE execution SET projection_gap=NULL WHERE id=1").run();
      return event;
    }),
    listOperations: (): ControllerOperation[] => (db.prepare("SELECT value FROM operations ORDER BY rowid").all() as { value: string }[]).map(row => json<ControllerOperation>(row.value)),
    listUnacknowledgedOperations: (limit = 100, afterOperationId?: string): ControllerOperation[] => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid operation reconciliation page size.");
      return (db.prepare("SELECT value FROM operations WHERE acknowledged=0 AND rowid > COALESCE((SELECT rowid FROM operations WHERE id=?),0) ORDER BY rowid LIMIT ?").all(afterOperationId ?? null, limit) as { value: string }[]).map(row => json<ControllerOperation>(row.value));
    },
    markOperationAcknowledged: (id: string): void => { const operation = getOperation(id); if (operation === null) throw new Error("Cannot acknowledge an unknown operation."); if (["confirmed", "failed", "rejected", "expired"].includes(operation.state)) db.prepare("UPDATE operations SET acknowledged=1 WHERE id=?").run(id); },
    getLastAcknowledgedSequence: (): string => (db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence,
    projectTimeline: (entry: SourceTimelineEntry): ControllerOutboxEvent | null => atomic(() => {
      const { revision: ignored, entrySeq: ignoredSequence, ...content } = entry;
      void ignored; void ignoredSequence;
      const contentHash = controllerPayloadHash(content);
      const previous = db.prepare("SELECT content_hash, CAST(revision AS TEXT) AS revision, CAST(rowid AS TEXT) AS entrySeq FROM projection WHERE id=?").get(entry.entryId) as { content_hash: string; revision: string; entrySeq: string } | undefined;
      if (previous?.content_hash === contentHash) return null;
      const revision = String(previous === undefined ? 1n : BigInt(previous.revision) + 1n);
      const entrySeq = previous?.entrySeq ?? (db.prepare("SELECT CAST(COALESCE(MAX(rowid),0)+1 AS TEXT) AS value FROM projection").get() as { value: string }).value;
      const payload = { ...content, revision, ...(options.contentOwnedLocally ? { entrySeq } : {}) } as SourceTimelineEntry;
      parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload });
      db.prepare("INSERT INTO projection(id,content_hash,revision,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,revision=excluded.revision,value=excluded.value").run(entry.entryId, contentHash, BigInt(revision), JSON.stringify(payload));
      return appendEvent({ kind: "timeline_upsert", payload: options.contentOwnedLocally ? sessionDisplayEntry(payload) : payload });
    }),
    prepareOperation: (input: Pick<ControllerOperation, "operationId" | "kind" | "payload">): ControllerOperation => atomic(() => {
      if (!/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("Controller operation ID must be a UUID.");
      const hash = controllerPayloadHash({ kind: input.kind, payload: input.payload }); const existing = getOperation(input.operationId);
      if (existing !== null) { if (existing.payloadHash !== hash) throw new Error("The operation ID has different content."); return existing; }
      if (input.kind === "initial" || input.kind === "send_message" || input.kind === "interaction_response" || input.kind === "execute_command" || input.kind === "update_setting") assertInputCapacity();
      return writeOperation({ ...input, executionGeneration: ticket.executionGeneration, payloadHash: hash, state: "accepted", result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
    }),
    markDispatching: (operationId: string): ControllerOperation => atomic(() => {
      const operation = getOperation(operationId); if (operation === null || operation.state !== "accepted") throw new Error("Controller operation cannot replay a possible native dispatch.");
      if (operation.kind === "initial") patchSnapshot({ initialInputState: "dispatching" });
      return writeOperation({ ...operation, state: "dispatching", updatedAt: Date.now() });
    }),
    recordOperation: (operationId: string, state: OperationState, result: unknown = null, error: string | null = null): ControllerOperation => atomic(() => {
      const operation = getOperation(operationId); if (operation === null) throw new Error("Controller operation is not registered.");
      if (["confirmed", "failed", "rejected", "expired"].includes(operation.state) && state !== operation.state) throw new Error("A terminal controller operation cannot be replaced.");
      if (state === "accepted" || state === "offered" || state === "dispatching") throw new Error("Use the durable dispatch boundary before native effects.");
      if (operation.kind === "initial") patchSnapshot({ initialInputState: state === "rejected" || state === "expired" ? "failed" : state });
      return writeOperation({ ...operation, state, result, error, updatedAt: Date.now() });
    }),
    appendEvent,
    pendingEvents: (limit = 100): ControllerOutboxEvent[] => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid controller outbox page size.");
      return (db.prepare("SELECT CAST(sequence AS TEXT) AS sequence,value FROM outbox ORDER BY outbox.sequence LIMIT ?").all(limit) as { sequence: string; value: string }[]).map((row) => ({ sequence: row.sequence, payload: json(row.value) }));
    },
    acknowledgeEvents: (sequence: string): void => atomic(() => {
      const value = validSequence(sequence); const row = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string };
      if (value > BigInt(row.sequence)) throw new Error("Controller ACK exceeds its durable event watermark.");
      db.prepare("DELETE FROM outbox WHERE sequence<=?").run(value);
      db.prepare("UPDATE execution SET last_acknowledged=MAX(last_acknowledged,?) WHERE id=1").run(value);
    }),
    close: (): void => { if (closed) return; db.prepare("UPDATE execution SET owner_pid=NULL WHERE id=1 AND owner_pid=?").run(process.pid); db.close(); closed = true; },
  };
};
export type ControllerLifecycleStore = ReturnType<typeof openControllerLifecycleStore>;

/** Read-only recovery never acquires the native writer lease. */
export const readControllerSnapshot = (file: string): ControllerSnapshot | null => {
  let db: Database.Database;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "SQLITE_CANTOPEN") return null; throw error; }
  try { const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined; return row === undefined ? null : json(row.snapshot); }
  finally { db.close(); }
};

/** Only an independent worker may commit complete process-tree stop after the writer exits. */
export const recordStoppedControllerGeneration = async (file: string, ticket: ControllerLaunchTicket): Promise<ControllerSnapshot> => {
  const observed = readControllerSnapshot(file);
  if (observed === null || observed.controllerProcess === null || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Original controller stop evidence is unavailable.");
  if (!await confirmControllerProcessesStopped(observed.controllerProcess, observed.nativeProcesses)) throw new Error("The original controller or its descendants are still running.");
  const db = new Database(file);
  try { return db.transaction(() => {
    const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
    if (row.snapshot !== JSON.stringify(observed)) throw new Error("The controller state changed during stop verification.");
    const stopped = { ...observed, lifecycle: "stopped" as const, nativeStopped: true, stoppedAt: observed.stoppedAt ?? new Date().toISOString(), activity: "stopped" as const, capabilities: { send: false, steer: false, cancel: false, respond: false } };
    db.prepare("UPDATE execution SET snapshot=?,owner_pid=NULL WHERE id=1").run(JSON.stringify(stopped)); return stopped;
  }).immediate(); } finally { db.close(); }
};
export const readControllerOperation = (file: string, operationId: string): ControllerOperation | null => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined; return row === undefined ? null : json(row.value); }
  finally { db.close(); }
};
