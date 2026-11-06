import { randomUUID } from "node:crypto";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, type SqliteDatabaseSource, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../../platform/sqlite-sql.js";
import { assertTerminalBinding, parseSessionV2Message, parseTerminalBinding } from "../../../session/v2/protocol.js";
import { bool, canonicalSessionJson, choice, decodeStrictSessionJson, exact, hash, integer, list, nullable, seq, timestamp, unique, uuid } from "../../../session/v2/values.js";
import type { SessionV2Message, SessionV2Payloads } from "../../../session/v2/types.js";
import type { HerdrInitialOutcome, HerdrInputOperation, HerdrInputRecord, HerdrInputTarget } from "./input-types.js";
const same = (a: unknown, b: unknown) => canonicalSessionJson(a) === canonicalSessionJson(b);
const fail = (message: string): never => { throw new Error(message); };
const steps = loadSqliteSequence(new URL("./input-sqlite/", import.meta.url)), schema = sqliteSchemaSnapshots(steps);
const normalize = (value: string | null) => value?.replace(/\s+/g, " ").trim().replace(/;$/, "");
const format: SqliteFormat = { name: "Herdr input arbitration", baseline: { version: steps[0].version, create: db => { db.exec(steps[0].sql); } }, migrations: [], validateVersioned: (db, version) => {
  const expected = schema.get(version), actual = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (!expected || expected.length !== actual.length || actual.some((item, i) => item.type !== expected[i]!.type || item.name !== expected[i]!.name || normalize(item.sql) !== normalize(expected[i]!.sql))) fail("The Herdr input SQLite schema does not match its version.");
} };
export const parseHerdrInputTarget = (value: unknown): HerdrInputTarget => {
  const o = exact(value, ["sessionId", "claimId", "executionGeneration", "connectionEpoch", "segmentId", "binding"]);
  return { sessionId: uuid(o.sessionId), claimId: uuid(o.claimId), executionGeneration: seq(o.executionGeneration), connectionEpoch: seq(o.connectionEpoch), segmentId: uuid(o.segmentId), binding: parseTerminalBinding(o.binding) };
};
export const herdrInputEnvelope = (target: HerdrInputTarget) => ({ protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const, sessionId: target.sessionId, claimId: target.claimId, executionGeneration: target.executionGeneration });
const payload = <K extends SessionV2Message["type"]>(target: HerdrInputTarget, type: K, value: unknown): SessionV2Payloads[K] => {
  const parsed = parseSessionV2Message({ ...herdrInputEnvelope(target), type, payload: value });
  if (parsed.type !== type) return fail("The input journal contains a different message type.");
  return parsed.payload as SessionV2Payloads[K];
};
const parseOperation = (value: unknown): HerdrInputOperation => {
  const o = exact(value, ["operationId", "source", "digest", "target", "controlEpoch", "leaseId", "leaseSeq", "result", "controlAck"]), target = parseHerdrInputTarget(o.target);
  const result = payload(target, "operation_result", o.result), controlAck = o.controlAck === null ? null : payload(target, "control_ack", o.controlAck);
  const operationId = uuid(o.operationId), source = choice(o.source, ["initial", "continuation", "cleanup", "web", "control"]);
  if (result.operationId !== operationId || controlAck !== null && (source !== "control" || !same(result, controlAck.result))) return fail("The input operation receipt belongs to another operation.");
  return { operationId, source, digest: hash(o.digest), target, controlEpoch: seq(o.controlEpoch), leaseId: nullable(o.leaseId, uuid), leaseSeq: nullable(o.leaseSeq, seq), result, controlAck };
};
export const parseHerdrInputRecord = (value: unknown): HerdrInputRecord => {
  const o = exact(value, ["target", "version", "controlEpoch", "state", "lease", "leaseSeq", "initialOperationId", "initialAttemptOperationId", "initialDigest", "cleanupOperationId", "initialOutcome", "initialDisposition", "draftRisk", "unknownInput", "cleanupEligible", "automationBeforeClosing", "operations", "recoveries"]);
  const target = parseHerdrInputTarget(o.target), state = choice(o.state, ["automation", "manual", "suspended", "closing", "closed"]), controlEpoch = seq(o.controlEpoch, true);
  const initialOutcome = choice(o.initialOutcome, ["pending", "dispatching", "transport_completed", "unknown", "unconfirmed"]);
  const initialDisposition = nullable(o.initialDisposition, value => { const d = exact(value, ["operationId", "actorUserId", "decidedAt", "disposition"]); return { operationId: uuid(d.operationId), actorUserId: uuid(d.actorUserId), decidedAt: timestamp(d.decidedAt), disposition: choice(d.disposition, ["delivered_continue"]) }; });
  const recoveries = unique(list(o.recoveries, value => {
    const entry = exact(value, ["prepare", "request"]), prepare = parseSessionV2Message(entry.prepare);
    const request = entry.request === null ? null : parseSessionV2Message(entry.request);
    if (prepare.type !== "automation_recovery_prepare" || prepare.sessionId !== target.sessionId || prepare.claimId !== target.claimId || request !== null && (request.type !== "automation_recovery" || request.sessionId !== target.sessionId || request.claimId !== target.claimId || request.payload.recoveryId !== prepare.payload.recoveryId || request.payload.previousGeneration !== prepare.executionGeneration || request.payload.stopOperationId !== prepare.payload.stopOperationId || request.payload.binding.nativeSessionId !== prepare.payload.binding.nativeSessionId)) return fail("The recovery intent belongs to another original execution.");
    return { prepare, request };
  }, 100_000), value => value.prepare.payload.recoveryId);
  // v2 projects a human disposition as resumable initial progress, while the original outcome remains immutable here.
  const control = payload(target, "control_state", { connectionEpoch: target.connectionEpoch, controlEpoch, state, lease: o.lease, initialAssignment: initialDisposition === null ? initialOutcome : "transport_completed", availableActions: [], unavailableReason: null });
  const record: HerdrInputRecord = { recoveries, target, version: integer(o.version, 1, Number.MAX_SAFE_INTEGER), controlEpoch, state, lease: control.lease, leaseSeq: seq(o.leaseSeq, true), initialOperationId: uuid(o.initialOperationId), initialAttemptOperationId: uuid(o.initialAttemptOperationId), initialDigest: nullable(o.initialDigest, hash), cleanupOperationId: uuid(o.cleanupOperationId), initialOutcome, initialDisposition, draftRisk: bool(o.draftRisk), unknownInput: bool(o.unknownInput), cleanupEligible: bool(o.cleanupEligible), automationBeforeClosing: bool(o.automationBeforeClosing), operations: unique(list(o.operations, parseOperation, 100_000), operation => operation.operationId) };
  if (record.initialOperationId === record.cleanupOperationId || record.operations.some(op => op.target.sessionId !== target.sessionId || op.target.claimId !== target.claimId) || record.initialDisposition !== null && !["unknown", "unconfirmed"].includes(record.initialOutcome)) return fail("The input journal has conflicting original execution identities.");
  return record;
};
const validateChange = (before: HerdrInputRecord, after: HerdrInputRecord) => {
  if (before.target.sessionId !== after.target.sessionId || before.target.claimId !== after.target.claimId || before.initialOperationId !== after.initialOperationId || before.cleanupOperationId !== after.cleanupOperationId && before.target.executionGeneration === after.target.executionGeneration) fail("The original input identity cannot change.");
  if (BigInt(after.controlEpoch) < BigInt(before.controlEpoch) || BigInt(after.target.executionGeneration) < BigInt(before.target.executionGeneration) || BigInt(after.target.connectionEpoch) < BigInt(before.target.connectionEpoch)) fail("Input fences cannot move backwards.");
  if (before.initialDigest !== null && before.initialDigest !== after.initialDigest) fail("The original assignment payload digest cannot change.");
  if (before.initialAttemptOperationId !== after.initialAttemptOperationId && (before.initialOutcome !== "pending" || before.operations.find(op => op.operationId === before.initialAttemptOperationId)?.result.state !== "rejected" || before.operations.some(op => op.operationId === after.initialAttemptOperationId))) fail("Only a definitely unsent initial attempt permits another admission attempt.");
  if (before.initialDisposition !== null && !same(before.initialDisposition, after.initialDisposition)) fail("An original human disposition cannot be replaced.");
  if (["unknown", "unconfirmed", "transport_completed"].includes(before.initialOutcome) && before.initialOutcome !== after.initialOutcome) fail("The original initial input outcome cannot be rewritten.");
  if (before.state === "closed" && after.state !== "closed" || before.state === "closing" && before.target.executionGeneration === after.target.executionGeneration && !["closing", "closed"].includes(after.state)) fail("Closed input admission cannot reopen.");
  if (after.recoveries.length < before.recoveries.length || before.recoveries.some((entry, index) => !same(entry.prepare, after.recoveries[index]!.prepare) || entry.request !== null && !same(entry.request, after.recoveries[index]!.request))) fail("A dispatched recovery intent cannot be replaced.");
  if (after.operations.length < before.operations.length || before.operations.some((op, index) => { const next = after.operations[index]!; return op.operationId !== next.operationId || op.source !== next.source || op.digest !== next.digest || op.controlEpoch !== next.controlEpoch || op.leaseId !== next.leaseId || op.leaseSeq !== next.leaseSeq || !same(op.target, next.target) || !["queued", "dispatching"].includes(op.result.state) && !same(op.result, next.result) || op.controlAck !== null && !same(op.controlAck, next.controlAck); })) fail("Durable operation identity and final results cannot change.");
};
export const openHerdrInputStore = (filename: SqliteDatabaseSource, options: { onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file: filename, format, allowCreate: true, ...options, assertMigrationAllowed: (_db, source) => { if (source.kind === "unversioned") fail("Unversioned input evidence must be retained for explicit recovery."); } });
  const read = <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(action).deferred();
  const get = (sessionId: string): HerdrInputRecord | null => read(() => {
    assertCurrentSqlite(db, format); const row = db.prepare("SELECT version,data FROM input_sessions WHERE session_id=?").get(uuid(sessionId)) as { version: number; data: string } | undefined;
    if (!row) return null; const record = parseHerdrInputRecord(decodeStrictSessionJson(row.data, 64 * 1024 * 1024));
    if (record.target.sessionId !== sessionId || record.version !== row.version) return fail("The input journal row and owner are inconsistent."); return record;
  });
  const update = (expected: HerdrInputRecord, change: (draft: HerdrInputRecord) => void) => runSqliteImmediate(db, () => {
    const original = get(expected.target.sessionId); if (original === null || !same(original, expected)) return fail("The input journal version changed; reread before deciding.");
    const draft = structuredClone(original); change(draft); draft.version++; const next = parseHerdrInputRecord(draft); validateChange(original, next);
    const json = canonicalSessionJson(next); if (Buffer.byteLength(json) > 64 * 1024 * 1024) return fail("The input journal is full; retained operation IDs cannot be evicted.");
    const result = db.prepare("UPDATE input_sessions SET version=?,data=? WHERE session_id=? AND version=?").run(next.version, json, next.target.sessionId, original.version); if (result.changes !== 1) return fail("The input journal commit was not confirmed."); return next;
  });
  return {
    get, update,
    bind: (raw: HerdrInputTarget, initial: HerdrInitialOutcome = "pending", controlEpoch = "0", options: { allowRecovery?: boolean } = {}): HerdrInputRecord => {
      const target = parseHerdrInputTarget(raw), existing = get(target.sessionId);
      if (existing !== null) {
        if (existing.target.claimId !== target.claimId) return fail("The Session input journal belongs to another claim.");
        if (same(existing.target, target)) return existing;
        if (existing.target.executionGeneration === target.executionGeneration) assertTerminalBinding(existing.target.binding, target.binding);
        const enrichment = same({ ...existing.target, binding: target.binding }, target) && existing.target.binding.nativeSessionId === null;
        const newGeneration = target.executionGeneration !== existing.target.executionGeneration;
        if (newGeneration && options.allowRecovery && (existing.target.binding.nativeSessionId === null || existing.target.binding.nativeSessionId !== target.binding.nativeSessionId)) return fail("Automatic recovery requires the same originally recorded native conversation.");
        const clean = !existing.draftRisk && !existing.unknownInput && !existing.operations.some(op => op.result.state === "dispatching") && (existing.initialOutcome === "transport_completed" || existing.initialDisposition !== null);
        return update(existing, draft => { draft.target = target; if (!enrichment) { draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.lease = null; draft.leaseSeq = "0"; if (newGeneration) draft.cleanupOperationId = randomUUID(); if (newGeneration && draft.state !== "closed") draft.state = options.allowRecovery && clean && existing.state === "closing" && existing.automationBeforeClosing ? "automation" : "suspended"; else if (!["closing", "closed"].includes(draft.state) && !(draft.state === "automation" && !newGeneration && clean)) draft.state = "suspended"; draft.cleanupEligible = false; if (newGeneration) draft.automationBeforeClosing = false; for (const op of draft.operations) if (op.result.state === "dispatching") { op.result = { operationId: op.operationId, state: "unknown", errorCode: "input_unknown" }; draft.unknownInput = true; } if (draft.initialOutcome === "dispatching") draft.initialOutcome = "unknown"; } });
      }
      return runSqliteImmediate(db, () => {
        if (get(target.sessionId) !== null) return fail("The original input journal was concurrently created.");
        const initialOperationId = randomUUID();
        const record = parseHerdrInputRecord({ target, version: 1, controlEpoch: controlEpoch === "0" ? "1" : controlEpoch, state: ["unknown", "unconfirmed", "dispatching"].includes(initial) ? "suspended" : "automation", lease: null, leaseSeq: "0", initialOperationId, initialAttemptOperationId: initialOperationId, initialDigest: null, cleanupOperationId: randomUUID(), initialOutcome: initial === "dispatching" ? "unknown" : initial, initialDisposition: null, draftRisk: false, unknownInput: ["unknown", "unconfirmed", "dispatching"].includes(initial), cleanupEligible: false, automationBeforeClosing: false, operations: [], recoveries: [] });
        db.prepare("INSERT INTO input_sessions(session_id,version,data) VALUES (?,?,?)").run(target.sessionId, record.version, canonicalSessionJson(record)); return record;
      });
    },
    recover: (sessionId: string) => {
      const record = get(sessionId); if (!record) return fail("The original input journal is missing.");
      return update(record, draft => {
        draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); draft.lease = null; draft.leaseSeq = "0"; draft.cleanupEligible = false;
        if (draft.state === "manual") draft.state = "suspended";
        for (const op of draft.operations) if (op.result.state === "dispatching" || op.result.state === "queued") { op.result = { operationId: op.operationId, state: op.result.state === "dispatching" ? "unknown" : "rejected", errorCode: op.result.state === "dispatching" ? "input_unknown" : "stale_fence" }; if (!["closing", "closed"].includes(draft.state)) draft.state = "suspended"; if (op.source !== "control") draft.unknownInput = true; }
        if (draft.initialOutcome === "dispatching") draft.initialOutcome = "unknown";
        if (draft.unknownInput) draft.automationBeforeClosing = false;
      });
    },
    close: () => closeSqliteDatabase(db, { file: db.name, format }),
  };
};
export type HerdrInputStore = ReturnType<typeof openHerdrInputStore>;
