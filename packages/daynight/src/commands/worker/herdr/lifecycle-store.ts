import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite } from "../../../platform/sqlite-format.js";
import { assertTerminalBinding, parseSessionV2Message, parseSessionV2Owner, parseSessionV2Runs, parseTerminalBinding } from "../../../session/v2/protocol.js";
import { bool, canonicalSessionJson, choice, decodeStrictSessionJson, exact, hash, integer, list, nativeText, nullable, seq, text, timestamp, unique, uuid } from "../../../session/v2/values.js";
import type { SessionV2Owner, SessionV2Payloads, SessionV2Run } from "../../../session/v2/types.js";
import type { ClaimIdentity } from "../types.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, HerdrLocalSegment, HerdrPreparation, HerdrRunPhase, MacProcessIdentity } from "./lifecycle-types.js";
import { herdrLifecycleStoreFormat } from "./lifecycle-store-format.js";

const same = (left: unknown, right: unknown): boolean => canonicalSessionJson(left) === canonicalSessionJson(right);
const reject = (message: string): never => { throw new Error(message); };
const absolute = (value: unknown): string => { const result = text(value, 16_384); if (!path.isAbsolute(result) || result.includes("\0")) return reject("Herdr lifecycle paths must be absolute."); return result; };
const identityKey = (identity: ClaimIdentity): string => [uuid(identity.projectId), uuid(identity.taskId), uuid(identity.claimId)].join("/");
const key = (record: HerdrLifecycleRecord): string => identityKey({ ...record.owner, claimId: record.claimId });
export const herdrLedgerPayloadHash = (payload: SessionV2Payloads["generation_ledger"]): string => createHash("sha256").update(canonicalSessionJson(payload)).digest("hex");
export const herdrLedgerHash = (record: Pick<HerdrLifecycleRecord, "runs">): string => herdrLedgerPayloadHash({ runs: record.runs.map(run => run.run), finalizationId: null });
const phases: readonly HerdrRunPhase[] = ["prepared", "launch_requested", "active", "stop_intent", "close_requested", "stopped_confirmed", "stop_unknown"];
const closing = (phase: HerdrRunPhase): boolean => ["stop_intent", "close_requested", "stopped_confirmed", "stop_unknown"].includes(phase);
const processKey = (value: MacProcessIdentity): string => canonicalSessionJson([value.role, value.bootId, value.pid, value.birthToken]);
export const parseMacProcessIdentity = (value: unknown): MacProcessIdentity => {
  const o = exact(value, ["role", "pid", "birthToken", "bootId", "auditToken", "ppid", "pgid", "sid"]);
  const result = { role: choice(o.role, ["daemon", "shell", "agent"]), pid: integer(o.pid, 1, 2147483647), birthToken: nativeText(o.birthToken), bootId: nativeText(o.bootId), auditToken: list(o.auditToken, n => integer(n, 0, 4294967295), 8, 8), ppid: integer(o.ppid, 0, 2147483647), pgid: integer(o.pgid, 1, 2147483647), sid: integer(o.sid, 1, 2147483647) };
  if (result.auditToken[5] !== result.pid) return reject("The audit token does not identify its recorded process.");
  return result;
};
const parsePreparation = (value: unknown): HerdrPreparation => {
  const o = exact(value, ["instanceId", "instanceDirectory", "phase", "daemon"]);
  const result = { instanceId: nativeText(o.instanceId), instanceDirectory: absolute(o.instanceDirectory), phase: choice(o.phase, ["prepared", "launch_requested"]), daemon: nullable(o.daemon, parseMacProcessIdentity) };
  if (result.daemon !== null && result.daemon.role !== "daemon") return reject("Preparation requires the original daemon identity.");
  return result;
};
const parseLocalRun = (value: unknown, run: SessionV2Run): HerdrLocalRun => {
  const o = exact(value, ["run", "phase", "instanceDirectory", "daemon", "processes", "stopOperationId", "stopReason", "error", "admission"]);
  const result: HerdrLocalRun = { run, phase: choice(o.phase, phases), instanceDirectory: absolute(o.instanceDirectory), daemon: nullable(o.daemon, parseMacProcessIdentity), processes: unique(list(o.processes, parseMacProcessIdentity), processKey), stopOperationId: nullable(o.stopOperationId, uuid), stopReason: nullable(o.stopReason, v => choice(v, ["shutdown", "terminal"])), error: nullable(o.error, v => text(v, 16_384)), admission: nullable(o.admission, uuid) };
  if (result.daemon !== null && result.daemon.role !== "daemon" || result.processes.some(p => p.role === "daemon")) return reject("Daemon and native process responsibilities must remain distinct.");
  if (result.daemon !== null && result.processes.some(p => p.bootId !== result.daemon!.bootId)) return reject("A native runtime cannot combine process evidence from different boots.");
  if ((result.stopOperationId === null) !== (result.stopReason === null)) return reject("A stop operation requires its original reason.");
  if (["stop_intent", "close_requested", "stopped_confirmed"].includes(result.phase) && result.stopOperationId === null) return reject("The stop journal intent is missing.");
  if (result.admission !== null && result.phase !== "active") return reject("Only an active original run may admit input.");
  if (result.phase === "active" && (result.daemon === null || !result.processes.some(p => p.role === "shell") || !result.processes.some(p => p.role === "agent"))) return reject("Input admission requires the original daemon, shell and agent birth identities.");
  if ((result.phase === "stopped_confirmed") !== (run.stopProof !== null)) return reject("Confirmed stopping requires a durable original stop proof.");
  if (run.stopProof !== null) {
    if (run.stopProof.recordId !== result.stopOperationId || result.daemon === null) return reject("The stopped run has no original stop operation or daemon evidence.");
    const expected = result.processes.map(({ role, pid, birthToken, bootId }) => ({ role, pid, birthToken, bootId }));
    if (!same(expected, run.stopProof.processes)) return reject("The stop proof must refer to the originally recorded process instances.");
  }
  return result;
};
const parseSegment = (value: unknown): HerdrLocalSegment => {
  const o = exact(value, ["segmentId", "segmentOrdinal", "executionGeneration", "binding", "startedAt", "endedAt", "durationMs", "gap"]);
  const result: HerdrLocalSegment = { segmentId: uuid(o.segmentId), segmentOrdinal: seq(o.segmentOrdinal), executionGeneration: seq(o.executionGeneration), binding: parseTerminalBinding(o.binding), startedAt: timestamp(o.startedAt), endedAt: nullable(o.endedAt, timestamp), durationMs: nullable(o.durationMs, v => seq(v, true)), gap: null };
  if ((result.endedAt === null) !== (result.durationMs === null) || result.endedAt !== null && Date.parse(result.endedAt) < Date.parse(result.startedAt)) return reject("A segment requires a consistent end boundary.");
  if (o.gap !== null) {
    const gap = exact(o.gap, ["kind", "reason", "from", "to"]);
    if (gap.kind !== "boundary" || gap.reason !== "restart") return reject("A lifecycle segment gap must identify a restart boundary.");
    const endpoint = (value: unknown) => { const e = exact(value, ["executionGeneration", "segmentId"]); return { executionGeneration: seq(e.executionGeneration), segmentId: nullable(e.segmentId, uuid) }; };
    result.gap = { kind: "boundary", reason: "restart", from: endpoint(gap.from), to: endpoint(gap.to) };
    if (result.gap.to.executionGeneration !== result.executionGeneration || result.gap.to.segmentId !== result.segmentId) return reject("The restart gap must end at its own segment.");
  }
  return result;
};
export const parseHerdrLifecycleRecord = (value: unknown): HerdrLifecycleRecord => {
  const o = exact(value, ["owner", "claimId", "cwd", "sessionId", "registrationId", "connectionEpoch", "registrationRequest", "ledgerRequest", "publishedLedgerHash", "controlEpoch", "initialAssignment", "initialPrompt", "automationBlocked", "preparation", "runs", "segments", "version"]);
  const raws = list(o.runs, value => exact(value, ["run", "phase", "instanceDirectory", "daemon", "processes", "stopOperationId", "stopReason", "error", "admission"]));
  const runs = raws.length === 0 ? [] : parseSessionV2Runs(raws.map(raw => raw.run), String(raws.length), false);
  const record: HerdrLifecycleRecord = { owner: parseSessionV2Owner(o.owner), claimId: uuid(o.claimId), cwd: absolute(o.cwd), sessionId: uuid(o.sessionId), registrationId: uuid(o.registrationId), connectionEpoch: nullable(o.connectionEpoch, seq), registrationRequest: null, ledgerRequest: null, publishedLedgerHash: nullable(o.publishedLedgerHash, hash), controlEpoch: seq(o.controlEpoch, true), initialAssignment: choice(o.initialAssignment, ["pending", "dispatching", "transport_completed", "unknown", "unconfirmed"]), initialPrompt: nullable(o.initialPrompt, v => text(v, 1024 * 1024)), automationBlocked: bool(o.automationBlocked), preparation: nullable(o.preparation, parsePreparation), runs: raws.map((raw, index) => parseLocalRun(raw, runs[index]!)), segments: unique(list(o.segments, parseSegment), segment => segment.segmentId), version: integer(o.version, 1, Number.MAX_SAFE_INTEGER) };
  if (record.runs.some(run => !same(run.run.owner, record.owner))) return reject("Every run must retain its original execution owner.");
  if (o.registrationRequest !== null) {
    const request = parseSessionV2Message(o.registrationRequest);
    if (request.type !== "registration" || request.sessionId !== record.sessionId || request.claimId !== record.claimId || request.payload.registrationId !== record.registrationId || !same(request.payload.owner, record.owner)) return reject("The pending registration belongs to another execution.");
    record.registrationRequest = request;
  }
  if (o.ledgerRequest !== null) {
    const pending = exact(o.ledgerRequest, ["message", "connectionEpoch"]), message = parseSessionV2Message(pending.message), connectionEpoch = seq(pending.connectionEpoch);
    if (message.type !== "generation_ledger" || message.sessionId !== record.sessionId || message.claimId !== record.claimId || message.payload.finalizationId !== null || connectionEpoch !== record.connectionEpoch || record.registrationRequest !== null || message.payload.runs.length > runs.length) return reject("The pending ledger belongs to another execution or connection.");
    for (const [index, previous] of message.payload.runs.entries()) {
      const current = runs[index]!;
      if (!same(previous.owner, record.owner) || previous.executionGeneration !== current.executionGeneration || previous.startedAt !== current.startedAt || previous.segmentIds.length > current.segmentIds.length || !same(previous.segmentIds, current.segmentIds.slice(0, previous.segmentIds.length)) || previous.stopProof !== null && !same(previous, current)) return reject("The pending ledger conflicts with original runtime history.");
      assertTerminalBinding(previous.binding, current.binding);
    }
    record.ledgerRequest = { message, connectionEpoch };
  }
  for (const [index, segment] of record.segments.entries()) {
    const local = record.runs[Number(segment.executionGeneration) - 1];
    if (segment.segmentOrdinal !== String(index + 1) || local === undefined || !local.run.segmentIds.includes(segment.segmentId)) return reject("The segment ordinal and run ownership must be durably registered together.");
    assertTerminalBinding(segment.binding, local.run.binding);
  }
  for (const local of record.runs) if (local.run.segmentIds.some(id => !record.segments.some(segment => segment.segmentId === id && segment.executionGeneration === local.run.executionGeneration))) return reject("A run references an unregistered segment.");
  return record;
};
const transitions: Record<HerdrRunPhase, readonly HerdrRunPhase[]> = {
  prepared: ["prepared", "launch_requested", "stop_intent", "stop_unknown"],
  launch_requested: ["launch_requested", "active", "stop_intent", "stop_unknown"],
  active: ["active", "stop_intent", "stop_unknown"],
  stop_intent: ["stop_intent", "close_requested", "stopped_confirmed", "stop_unknown"],
  close_requested: ["close_requested", "stopped_confirmed", "stop_unknown"],
  stopped_confirmed: ["stopped_confirmed"],
  stop_unknown: ["stop_unknown", "stop_intent", "close_requested", "stopped_confirmed"],
};
const validateChange = (before: HerdrLifecycleRecord, after: HerdrLifecycleRecord): void => {
  for (const field of ["owner", "claimId", "cwd", "sessionId", "registrationId"] as const) if (!same(before[field], after[field])) reject("The original Herdr lifecycle identity cannot change.");
  if (before.initialPrompt !== null && before.initialPrompt !== after.initialPrompt) reject("The original managed assignment cannot change.");
  if (before.automationBlocked && !after.automationBlocked) reject("Uncertain automatic input requires an explicit resolution mechanism.");
  const pendingReceipt = before.ledgerRequest === null ? null : herdrLedgerPayloadHash(before.ledgerRequest.message.payload);
  if (before.publishedLedgerHash !== after.publishedLedgerHash && after.publishedLedgerHash !== herdrLedgerHash(after) && (pendingReceipt === null || after.publishedLedgerHash !== pendingReceipt)) reject("A publication receipt must identify the current or pending original run ledger.");
  if (before.ledgerRequest !== null) {
    if (after.connectionEpoch !== before.connectionEpoch || after.registrationRequest !== null) reject("An unconfirmed ledger must be observed before reconnecting.");
    if (after.ledgerRequest === null ? after.publishedLedgerHash !== pendingReceipt : !same(before.ledgerRequest, after.ledgerRequest)) reject("An unconfirmed ledger cannot be replaced or cleared without its receipt.");
  } else if (after.ledgerRequest !== null && (after.ledgerRequest.message.executionGeneration !== after.runs.at(-1)?.run.executionGeneration || !same(after.ledgerRequest.message.payload, { runs: after.runs.map(run => run.run), finalizationId: null }))) reject("A publication intent must capture the complete current run ledger.");
  if (BigInt(after.controlEpoch) < BigInt(before.controlEpoch) || before.connectionEpoch !== null && (after.connectionEpoch === null || BigInt(after.connectionEpoch) < BigInt(before.connectionEpoch))) reject("A confirmed connection or control epoch cannot move backwards.");
  const inputs: Record<HerdrLifecycleRecord["initialAssignment"], readonly HerdrLifecycleRecord["initialAssignment"][]> = { pending: ["pending", "dispatching", "unconfirmed"], dispatching: ["dispatching", "transport_completed", "unknown", "pending"], transport_completed: ["transport_completed"], unknown: ["unknown"], unconfirmed: ["unconfirmed"] };
  if (!inputs[before.initialAssignment].includes(after.initialAssignment)) reject("An uncertain or delivered initial assignment cannot be replayed.");
  if (before.initialAssignment !== "dispatching" && after.initialAssignment === "dispatching" && (after.automationBlocked || after.runs.at(-1)?.phase !== "active" || after.runs.at(-1)?.admission === null)) reject("Dispatch requires a durable active-run admission.");
  if (after.runs.length < before.runs.length || after.runs.length > before.runs.length + 1) reject("Runtime history is append-only, one generation at a time.");
  for (const [index, previous] of before.runs.entries()) {
    const next = after.runs[index]!;
    if (!transitions[previous.phase].includes(next.phase)) reject("The runtime transition bypasses a durable lifecycle boundary.");
    if (next.phase === "close_requested" && previous.stopOperationId === null) reject("A close requires an already committed stop intent.");
    if (previous.phase === "stopped_confirmed" && !same(previous, next)) reject("A confirmed original run is immutable.");
    if (previous.instanceDirectory !== next.instanceDirectory || previous.run.startedAt !== next.run.startedAt) reject("The original runtime location and start boundary cannot change.");
    assertTerminalBinding(previous.run.binding, next.run.binding);
    if (previous.daemon !== null && !same(previous.daemon, next.daemon)) reject("The original daemon identity cannot be replaced.");
    if (next.processes.length < previous.processes.length || previous.processes.some((process, i) => !same(process, next.processes[i]))) reject("Original process evidence is append-only.");
    if (closing(previous.phase)) {
      const parents = new Map(previous.processes.map(process => [process.pid, process]));
      for (const process of next.processes.slice(previous.processes.length)) {
        const parent = parents.get(process.ppid);
        if (process.role !== "agent" || parent === undefined || parent.bootId !== process.bootId) reject("New stop evidence requires a previously recorded original parent.");
        parents.set(process.pid, process);
      }
    }
    if (previous.stopOperationId !== null && (previous.stopOperationId !== next.stopOperationId || previous.stopReason !== next.stopReason)) reject("The original stop operation cannot be replaced.");
    if (next.run.segmentIds.length < previous.run.segmentIds.length || previous.run.segmentIds.some((id, i) => next.run.segmentIds[i] !== id)) reject("Segment ownership is append-only.");
  }
  if (after.runs.length > before.runs.length) {
    const previous = before.runs.at(-1), next = after.runs.at(-1)!;
    if (next.phase !== "prepared" || next.run.stopProof !== null) reject("A new run starts at its durable preparation boundary.");
    if (previous !== undefined) {
      const native = previous.run.stopProof?.binding.nativeSessionId;
      if (previous.phase !== "stopped_confirmed" || native === null || native === undefined || native !== next.run.binding.nativeSessionId) reject("Replacement requires the confirmed original stop and native session identity.");
    }
  }
  if (before.preparation !== null) {
    const old = before.preparation, next = after.preparation;
    if (next === null) {
      const run = after.runs.at(-1);
      if (run?.run.binding.instanceId !== old.instanceId || run.instanceDirectory !== old.instanceDirectory || old.daemon !== null && !same(old.daemon, run.daemon)) reject("Clearing preparation requires its original registered runtime.");
    } else if (old.instanceId !== next.instanceId || old.instanceDirectory !== next.instanceDirectory || old.phase === "launch_requested" && next.phase !== old.phase || old.daemon !== null && !same(old.daemon, next.daemon)) reject("The original pre-binding preparation cannot be replaced.");
  } else if (after.preparation !== null) {
    const previous = before.runs.at(-1);
    if (previous !== undefined && (previous.phase !== "stopped_confirmed" || previous.run.stopProof?.binding.nativeSessionId == null)) reject("Replacement preparation requires the confirmed original stop and native session.");
  }
  if (after.segments.length < before.segments.length) reject("Capture segment history cannot be removed.");
  for (const [index, previous] of before.segments.entries()) {
    const next = after.segments[index]!;
    if (previous.endedAt !== null && !same({ ...previous, binding: next.binding }, next)) reject("A closed capture segment observation boundary is immutable.");
    assertTerminalBinding(previous.binding, next.binding);
    const { endedAt: _end, durationMs: _duration, binding: _binding, ...stable } = previous;
    const { endedAt: _nextEnd, durationMs: _nextDuration, binding: _nextBinding, ...nextStable } = next;
    if (!same(stable, nextStable)) reject("The original capture segment identity cannot change.");
  }
  for (const segment of after.segments.slice(before.segments.length)) if (after.runs[Number(segment.executionGeneration) - 1]!.phase !== "active") reject("New capture segments require an active original run.");
};

type LifecycleRow = { identity: string; version: number; data: string };
const parseRow = (row: LifecycleRow): HerdrLifecycleRecord => {
  const record = parseHerdrLifecycleRecord(decodeStrictSessionJson(row.data, 8 * 1024 * 1024));
  if (key(record) !== row.identity || record.version !== row.version) return reject("Persisted Herdr lifecycle ownership or version is inconsistent.");
  return record;
};

/** Attach observes responsibility without acquiring recovery or migration ownership. */
export const readHerdrLifecycleRecords = (filename: string): HerdrLifecycleRecord[] => {
  const db = new Database(absolute(filename), { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    return db.transaction(() => {
      if (inspectSqlite(db, herdrLifecycleStoreFormat).kind !== "current") return reject("The Herdr lifecycle journal requires an owner-managed upgrade before attach.");
      return (db.prepare("SELECT identity, version, data FROM executions ORDER BY identity").all() as LifecycleRow[]).map(parseRow);
    }).deferred();
  } finally { db.close(); }
};

export const openHerdrLifecycleStore = (filename: string, options: { onMigration?: SqliteMigrationReporter } = {}) => {
  const db = openSqliteDatabase({ file: filename, format: herdrLifecycleStoreFormat, allowCreate: true,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }),
    // An unversioned journal may be the only remaining proof of a native launch.
    assertMigrationAllowed: (_db, source) => { if (source.kind === "unversioned") throw new Error("Unversioned Herdr lifecycle evidence must be retained for explicit recovery."); },
  });
  const read = <T>(action: () => T): T => {
    if (db.inTransaction) { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); }
    return db.transaction(() => { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); }).deferred();
  };
  const get = (identity: ClaimIdentity): HerdrLifecycleRecord | null => read(() => { const row = db.prepare("SELECT identity, version, data FROM executions WHERE identity = ?").get(identityKey(identity)) as { identity: string; version: number; data: string } | undefined; return row === undefined ? null : parseRow(row); });
  const atomic = <T>(action: () => T): T => runSqliteImmediate(db, () => { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); });
  const update = (expected: HerdrLifecycleRecord, change: (draft: HerdrLifecycleRecord) => void): HerdrLifecycleRecord => atomic(() => {
    const original = get({ ...expected.owner, claimId: expected.claimId });
    if (original === null || original.version !== expected.version) return reject("The Herdr lifecycle version changed; reread the original execution before deciding.");
    if (!same(original, expected)) return reject("The expected lifecycle record differs from its stored version.");
    const draft = structuredClone(original); change(draft); draft.version = original.version + 1;
    const next = parseHerdrLifecycleRecord(draft); validateChange(original, next);
    const data = canonicalSessionJson(next); if (Buffer.byteLength(data) > 8 * 1024 * 1024) return reject("Herdr lifecycle metadata exceeds its size limit.");
    const result = db.prepare("UPDATE executions SET version = ?, data = ? WHERE identity = ? AND version = ?").run(next.version, data, key(original), original.version);
    if (result.changes !== 1) return reject("The Herdr lifecycle compare-and-swap was not confirmed.");
    return get({ ...next.owner, claimId: next.claimId })!;
  });
  return {
    close: (): void => { closeSqliteDatabase(db, { file: filename, format: herdrLifecycleStoreFormat }); },
    get,
    list: (): HerdrLifecycleRecord[] => read(() => (db.prepare("SELECT identity, version, data FROM executions ORDER BY identity").all() as { identity: string; version: number; data: string }[]).map(parseRow)),
    create: (input: { owner: SessionV2Owner; claimId: string; cwd: string }, now = new Date().toISOString()): HerdrLifecycleRecord => atomic(() => {
      timestamp(now); const owner = parseSessionV2Owner(input.owner), claimId = uuid(input.claimId), cwd = absolute(input.cwd);
      const existing = get({ ...owner, claimId });
      if (existing !== null) { if (!same(existing.owner, owner) || existing.cwd !== cwd) return reject("The original execution cannot be rebound to a different owner or worktree."); return existing; }
      const record = parseHerdrLifecycleRecord({ owner, claimId, cwd, sessionId: randomUUID(), registrationId: randomUUID(), connectionEpoch: null, registrationRequest: null, ledgerRequest: null, publishedLedgerHash: null, controlEpoch: "0", initialAssignment: "pending", initialPrompt: null, automationBlocked: false, preparation: null, runs: [], segments: [], version: 1 });
      db.prepare("INSERT INTO executions(identity, version, data) VALUES (?, ?, ?)").run(key(record), record.version, canonicalSessionJson(record));
      return get({ ...owner, claimId })!;
    }),
    update,
    recover: (expected: HerdrLifecycleRecord): HerdrLifecycleRecord => update(expected, draft => {
      draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n);
      if (draft.initialAssignment === "dispatching" || draft.runs.some(run => run.admission !== null)) draft.automationBlocked = true;
      if (draft.initialAssignment === "dispatching") draft.initialAssignment = "unknown";
      for (const run of draft.runs) {
        run.admission = null;
        if (run.phase === "launch_requested") { run.phase = "stop_unknown"; run.error = "Native launch completion was not durably observed before recovery."; }
      }
    }),
  };
};
export type HerdrLifecycleStore = ReturnType<typeof openHerdrLifecycleStore>;
