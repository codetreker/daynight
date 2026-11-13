import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, type SqliteDatabaseSource, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite } from "../../../platform/sqlite-format.js";
import { assertTerminalBinding, isPreparedSessionV2StopProof, parseSessionV2Message, parseSessionV2Owner, parseSessionV2Runs, parseTerminalBinding } from "../../../session/v2/protocol.js";
import { bool, canonicalSessionJson, choice, decodeStrictSessionJson, exact, hash, integer, list, nativeText, nullable, seq, text, timestamp, unique, uuid } from "../../../session/v2/values.js";
import type { SessionV2Owner, SessionV2Payloads, SessionV2Run } from "../../../session/v2/types.js";
import type { ClaimIdentity } from "../types.js";
import { parseResolvedToolLaunch } from "../../../platform/tool-launch-record.js";
import { parseFrozenToolObservation } from "../tool-observation.js";
import type { HerdrExecutionTools, HerdrInstanceObservation, HerdrLifecycleRecord, HerdrLocalRun, HerdrLocalSegment, HerdrNativeLaunchRejection, HerdrPreparation, HerdrRunPhase, MacProcessIdentity } from "./lifecycle-types.js";
import { createHerdrLifecycleStoreFormat, herdrLifecycleStoreFormat } from "./lifecycle-store-format.js";

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
const toolFields = (value: unknown): string[] => value !== null && typeof value === "object" ? ["launches", "instanceObservation"].filter(field => Object.hasOwn(value, field)) : [];
const parseTools = (value: unknown): HerdrExecutionTools => {
  const o = exact(value, ["agent", "agentObservation", "herdr", "herdrObservation"]);
  const agent = nullable(o.agent, value => parseResolvedToolLaunch(value, { context: "herdr" }));
  if (agent?.tool === "herdr" || (agent === null) !== (o.agentObservation === null)) return reject("The original Herdr agent launch and observation must agree.");
  return { agent, agentObservation: nullable(o.agentObservation, parseFrozenToolObservation), herdr: parseResolvedToolLaunch(o.herdr, { tool: "herdr", context: "herdr" }), herdrObservation: parseFrozenToolObservation(o.herdrObservation) };
};
export const parseHerdrExecutionTools = parseTools;
const parseInstanceObservation = (value: unknown): HerdrInstanceObservation => {
  const o = exact(value, ["version", "checkedAt", "protocol"]);
  if (o.protocol !== 22) return reject("A private Herdr observation requires protocol 22.");
  return { ...parseFrozenToolObservation({ version: o.version, checkedAt: o.checkedAt }), protocol: 22 };
};
const parseToolFields = (o: Record<string, unknown>) => ({ ...(Object.hasOwn(o, "launches") ? { launches: parseTools(o.launches) } : {}), ...(Object.hasOwn(o, "instanceObservation") ? { instanceObservation: parseInstanceObservation(o.instanceObservation) } : {}) });
export const parseMacProcessIdentity = (value: unknown): MacProcessIdentity => {
  const o = exact(value, ["role", "pid", "birthToken", "bootId", "auditToken", "ppid", "pgid", "sid"]);
  const result = { role: choice(o.role, ["daemon", "shell", "agent"]), pid: integer(o.pid, 1, 2147483647), birthToken: nativeText(o.birthToken), bootId: nativeText(o.bootId), auditToken: list(o.auditToken, n => integer(n, 0, 4294967295), 8, 8), ppid: integer(o.ppid, 0, 2147483647), pgid: integer(o.pgid, 1, 2147483647), sid: integer(o.sid, 1, 2147483647) };
  if (result.auditToken[5] !== result.pid) return reject("The audit token does not identify its recorded process.");
  return result;
};
const parsePreparation = (value: unknown): HerdrPreparation => {
  const o = exact(value, ["instanceId", "instanceDirectory", "phase", "daemon", ...toolFields(value)]);
  const result = { instanceId: nativeText(o.instanceId), instanceDirectory: absolute(o.instanceDirectory), phase: choice(o.phase, ["prepared", "launch_requested"]), daemon: nullable(o.daemon, parseMacProcessIdentity), ...parseToolFields(o) };
  if (result.daemon !== null && result.daemon.role !== "daemon") return reject("Preparation requires the original daemon identity.");
  return result;
};
const localRunKeys = ["run", "phase", "instanceDirectory", "daemon", "processes", "stopOperationId", "stopReason", "error", "admission"] as const;
const parseLocalRun = (value: unknown, run: SessionV2Run, legacy: boolean): HerdrLocalRun => {
  const o = exact(value, [...(legacy ? localRunKeys : [...localRunKeys, "nativeLaunch"]), ...toolFields(value)]);
  const result: HerdrLocalRun = { run, nativeLaunch: legacy ? "unknown" : choice(o.nativeLaunch, ["not_submitted", "requested", "observed", "unknown"]), phase: choice(o.phase, phases), instanceDirectory: absolute(o.instanceDirectory), daemon: nullable(o.daemon, parseMacProcessIdentity), processes: unique(list(o.processes, parseMacProcessIdentity), processKey), stopOperationId: nullable(o.stopOperationId, uuid), stopReason: nullable(o.stopReason, v => choice(v, ["shutdown", "terminal"])), error: nullable(o.error, v => text(v, 16_384)), admission: nullable(o.admission, uuid), ...parseToolFields(o) };
  if (result.daemon !== null && result.daemon.role !== "daemon" || result.processes.some(p => p.role === "daemon")) return reject("Daemon and native process responsibilities must remain distinct.");
  if (result.daemon !== null && result.processes.some(p => p.bootId !== result.daemon!.bootId)) return reject("A native runtime cannot combine process evidence from different boots.");
  if ((result.stopOperationId === null) !== (result.stopReason === null)) return reject("A stop operation requires its original reason.");
  if (["stop_intent", "close_requested", "stopped_confirmed"].includes(result.phase) && result.stopOperationId === null) return reject("The stop journal intent is missing.");
  if (result.admission !== null && result.phase !== "active") return reject("Only an active original run may admit input.");
  if (result.phase === "active" && (result.daemon === null || !result.processes.some(p => p.role === "shell") || !result.processes.some(p => p.role === "agent"))) return reject("Input admission requires the original daemon, shell and agent birth identities.");
  if ((result.phase === "stopped_confirmed") !== (run.stopProof !== null)) return reject("Confirmed stopping requires a durable original stop proof.");
  if (legacy) {
    if (run.stopProof !== null && isPreparedSessionV2StopProof(run.stopProof)) return reject("A legacy run cannot contain a prepared-resource stop proof.");
    result.nativeLaunch = result.processes.some(p => p.role === "agent") ? "observed" : result.phase === "launch_requested" ? "requested"
      : result.phase === "prepared" && result.daemon !== null && result.processes.length === 1 && result.processes[0]!.role === "shell" && result.stopOperationId === null && result.admission === null && run.segmentIds.length === 0 ? "not_submitted" : "unknown";
  }
  if (result.nativeLaunch === "not_submitted" && (result.processes.some(p => p.role === "agent") || run.segmentIds.length !== 0 || result.admission !== null || ["launch_requested", "active"].includes(result.phase))) return reject("Unsubmitted native launch cannot contain execution or input evidence.");
  if (result.phase === "active" && result.nativeLaunch !== "observed" || result.nativeLaunch === "observed" && !result.processes.some(p => p.role === "agent")) return reject("Observed launch requires its original agent birth evidence.");
  if (result.phase === "launch_requested" && result.nativeLaunch !== "requested") return reject("A native launch requires its durable requested provenance.");
  if (result.phase === "prepared" && !["not_submitted", "unknown"].includes(result.nativeLaunch)) return reject("A prepared runtime cannot have submitted launch evidence.");
  if (run.stopProof !== null) {
    if (isPreparedSessionV2StopProof(run.stopProof)) {
      const daemon = result.daemon;
      if (result.nativeLaunch !== "not_submitted" || daemon === null || !same(run.stopProof.daemon, { pid: daemon.pid, birthToken: daemon.birthToken, bootId: daemon.bootId })) return reject("Prepared stopping requires the original daemon and unsubmitted launch provenance.");
    } else if (result.nativeLaunch !== "observed") return reject("Native stopping requires the original observed agent launch.");
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
const parseLifecycleRecord = (value: unknown, legacy = false): HerdrLifecycleRecord => {
  const o = exact(value, ["owner", "claimId", "cwd", "sessionId", "registrationId", "connectionEpoch", "registrationRequest", "ledgerRequest", "publishedLedgerHash", "controlEpoch", "initialAssignment", "initialPrompt", "automationBlocked", "preparation", "runs", "segments", "version"]);
  const raws = list(o.runs, value => exact(value, [...(legacy ? localRunKeys : [...localRunKeys, "nativeLaunch"]), ...toolFields(value)]));
  const runs = raws.length === 0 ? [] : parseSessionV2Runs(raws.map(raw => raw.run), String(raws.length), false);
  const record: HerdrLifecycleRecord = { owner: parseSessionV2Owner(o.owner), claimId: uuid(o.claimId), cwd: absolute(o.cwd), sessionId: uuid(o.sessionId), registrationId: uuid(o.registrationId), connectionEpoch: nullable(o.connectionEpoch, seq), registrationRequest: null, ledgerRequest: null, publishedLedgerHash: nullable(o.publishedLedgerHash, hash), controlEpoch: seq(o.controlEpoch, true), initialAssignment: choice(o.initialAssignment, ["pending", "dispatching", "transport_completed", "unknown", "unconfirmed"]), initialPrompt: nullable(o.initialPrompt, v => text(v, 1024 * 1024)), automationBlocked: bool(o.automationBlocked), preparation: nullable(o.preparation, parsePreparation), runs: raws.map((raw, index) => parseLocalRun(raw, runs[index]!, legacy)), segments: unique(list(o.segments, parseSegment), segment => segment.segmentId), version: integer(o.version, 1, Number.MAX_SAFE_INTEGER) };
  if (record.runs.some(run => !same(run.run.owner, record.owner))) return reject("Every run must retain its original execution owner.");
  for (const local of [...record.runs, ...(record.preparation === null ? [] : [record.preparation])]) {
    if (local.launches && (record.owner.provider === "claude" ? local.launches.agent !== null : local.launches.agent?.tool !== record.owner.provider)) return reject("Frozen Herdr launches must retain their original provider.");
  }
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
export const parseHerdrLifecycleRecord = (value: unknown): HerdrLifecycleRecord => parseLifecycleRecord(value);
/** Empty registration is only a candidate; retirement also requires terminal and resource evidence. */
export const isHerdrNeverStarted = (record: HerdrLifecycleRecord): boolean =>
  record.preparation === null && record.runs.length === 0 && record.segments.length === 0
  && record.connectionEpoch === null && record.registrationRequest === null && record.ledgerRequest === null
  && record.publishedLedgerHash === null && record.initialAssignment === "pending" && record.initialPrompt === null && !record.automationBlocked;

const transitions: Record<HerdrRunPhase, readonly HerdrRunPhase[]> = {
  prepared: ["prepared", "launch_requested", "stop_intent", "stop_unknown"],
  launch_requested: ["launch_requested", "active", "stop_intent", "stop_unknown"],
  active: ["active", "stop_intent", "stop_unknown"],
  stop_intent: ["stop_intent", "close_requested", "stopped_confirmed", "stop_unknown"],
  close_requested: ["close_requested", "stopped_confirmed", "stop_unknown"],
  stopped_confirmed: ["stopped_confirmed"],
  stop_unknown: ["stop_unknown", "stop_intent", "close_requested", "stopped_confirmed"],
};
const launchTransitions: Record<HerdrLocalRun["nativeLaunch"], readonly HerdrLocalRun["nativeLaunch"][]> = { not_submitted: ["not_submitted", "requested"], requested: ["requested", "observed"], observed: ["observed"], unknown: ["unknown"] };
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
    if (!same(previous.launches ?? null, next.launches ?? null) || !same(previous.instanceObservation ?? null, next.instanceObservation ?? null)) reject("The original runtime launch selections and handshake cannot change.");
    if (!launchTransitions[previous.nativeLaunch].includes(next.nativeLaunch)) reject("Native launch provenance cannot be downgraded or reconstructed.");
    if (previous.nativeLaunch !== next.nativeLaunch && (previous.nativeLaunch === "not_submitted" ? previous.phase !== "prepared" || next.phase !== "launch_requested" : previous.phase !== "launch_requested" || next.phase !== "active")) reject("Native launch provenance must follow its original launch boundary.");
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
    if (next.phase !== "prepared" || next.nativeLaunch !== "not_submitted" || next.run.stopProof !== null) reject("A new run starts at its durable preparation boundary.");
    if (previous !== undefined) {
      if (!same(previous.launches ?? null, next.launches ?? null)) reject("Recovery must retain the original claim's launch selections.");
      const native = previous.run.stopProof?.binding.nativeSessionId;
      if (previous.phase !== "stopped_confirmed" || isPreparedSessionV2StopProof(previous.run.stopProof!) || native === null || native === undefined || native !== next.run.binding.nativeSessionId) reject("Replacement requires the confirmed original stop and native session identity.");
    }
  }
  if (before.preparation !== null) {
    const old = before.preparation, next = after.preparation;
    if (next === null) {
      const run = after.runs.at(-1);
      if (run?.run.binding.instanceId !== old.instanceId || run.instanceDirectory !== old.instanceDirectory || old.daemon !== null && !same(old.daemon, run.daemon) || !same(old.launches ?? null, run.launches ?? null) || !same(old.instanceObservation ?? null, run.instanceObservation ?? null)) reject("Clearing preparation requires its original registered runtime and launch selections.");
    } else if (old.instanceId !== next.instanceId || old.instanceDirectory !== next.instanceDirectory || old.phase === "launch_requested" && next.phase !== old.phase || old.daemon !== null && !same(old.daemon, next.daemon)) reject("The original pre-binding preparation cannot be replaced.");
    else if (!same(old.launches ?? null, next.launches ?? null) || old.instanceObservation !== undefined && !same(old.instanceObservation, next.instanceObservation)) reject("The original preparation launch selections and handshake cannot change.");
  } else if (after.preparation !== null) {
    const previous = before.runs.at(-1);
    if (previous !== undefined && !same(previous.launches ?? null, after.preparation.launches ?? null)) reject("Recovery preparation must retain the original claim's launch selections.");
    if (previous !== undefined && (previous.phase !== "stopped_confirmed" || previous.run.stopProof === null || isPreparedSessionV2StopProof(previous.run.stopProof) || previous.run.stopProof.binding.nativeSessionId == null)) reject("Replacement preparation requires the confirmed original stop and native session.");
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
const validateNativeLaunchRejection = (before: HerdrLifecycleRecord, after: HerdrLifecycleRecord, evidence: HerdrNativeLaunchRejection): void => {
  const run = before.runs.at(-1), generation = seq(evidence.executionGeneration), binding = parseTerminalBinding(evidence.binding);
  if (evidence.method !== "agent.start" || evidence.code !== "agent_pane_busy" || run === undefined || run.run.executionGeneration !== generation
    || run.phase !== "launch_requested" || run.nativeLaunch !== "requested" || !same(run.run.binding, binding)
    || run.processes.some(process => process.role === "agent") || run.run.segmentIds.length !== 0 || run.admission !== null
    || run.stopOperationId !== null || run.run.stopProof !== null) reject("A busy rejection must identify the exact unstarted native launch.");
  const expected = structuredClone(before), latest = expected.runs.at(-1)!;
  expected.version = after.version; latest.phase = "prepared"; latest.nativeLaunch = "not_submitted";
  if (!same(expected, after)) reject("A definite native rejection cannot change other execution evidence.");
};
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

export const openHerdrLifecycleStore = (filename: SqliteDatabaseSource, options: { onMigration?: SqliteMigrationReporter } = {}) => {
  const format = createHerdrLifecycleStoreFormat(db => {
    for (const table of ["executions", "never_started_retirements"] as const) {
      const rows = db.prepare(`SELECT identity, version, data FROM ${table} ORDER BY identity`).all() as LifecycleRow[];
      for (const row of rows) {
        const record = parseLifecycleRecord(decodeStrictSessionJson(row.data, 8 * 1024 * 1024), true);
        if (key(record) !== row.identity || record.version !== row.version || table === "never_started_retirements" && !isHerdrNeverStarted(record)) reject("Legacy lifecycle ownership, version or retirement is inconsistent.");
        const data = canonicalSessionJson(record);
        if (Buffer.byteLength(data) > 8 * 1024 * 1024) reject("Migrated lifecycle metadata exceeds its size limit.");
        if (table === "never_started_retirements") {
          const original = db.prepare("SELECT data FROM executions WHERE identity = ?").get(row.identity) as { data: string } | undefined;
          if (!original || original.data !== data) reject("The legacy retirement differs from its original lifecycle evidence.");
        }
        db.prepare(`UPDATE ${table} SET data = ? WHERE identity = ?`).run(data, row.identity);
      }
    }
  });
  const db = openSqliteDatabase({ file: filename, format, allowCreate: true,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }),
    // An unversioned journal may be the only remaining proof of a native launch.
    assertMigrationAllowed: (_db, source) => { if (source.kind === "unversioned") throw new Error("Unversioned Herdr lifecycle evidence must be retained for explicit recovery."); },
  });
  const read = <T>(action: () => T): T => {
    if (db.inTransaction) { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); }
    return db.transaction(() => { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); }).deferred();
  };
  const get = (identity: ClaimIdentity): HerdrLifecycleRecord | null => read(() => { const row = db.prepare("SELECT identity, version, data FROM executions WHERE identity = ?").get(identityKey(identity)) as { identity: string; version: number; data: string } | undefined; return row === undefined ? null : parseRow(row); });
  const retired = (identity: ClaimIdentity): HerdrLifecycleRecord | null => read(() => {
    const row = db.prepare("SELECT identity, version, data FROM never_started_retirements WHERE identity = ?").get(identityKey(identity)) as LifecycleRow | undefined;
    if (!row) return null;
    const record = parseRow(row), original = get(identity);
    if (!isHerdrNeverStarted(record) || !same(record, original)) return reject("The never-started retirement differs from its original lifecycle evidence.");
    return record;
  });
  const atomic = <T>(action: () => T): T => runSqliteImmediate(db, () => { assertCurrentSqlite(db, herdrLifecycleStoreFormat); return action(); });
  const mutate = (expected: HerdrLifecycleRecord, change: (draft: HerdrLifecycleRecord) => void, validate: typeof validateChange): HerdrLifecycleRecord => atomic(() => {
    if (retired({ ...expected.owner, claimId: expected.claimId })) return reject("A retired never-started claim cannot acquire new execution evidence.");
    const original = get({ ...expected.owner, claimId: expected.claimId });
    if (original === null || original.version !== expected.version) return reject("The Herdr lifecycle version changed; reread the original execution before deciding.");
    if (!same(original, expected)) return reject("The expected lifecycle record differs from its stored version.");
    const draft = structuredClone(original); change(draft); draft.version = original.version + 1;
    const next = parseHerdrLifecycleRecord(draft); validate(original, next);
    const data = canonicalSessionJson(next); if (Buffer.byteLength(data) > 8 * 1024 * 1024) return reject("Herdr lifecycle metadata exceeds its size limit.");
    const result = db.prepare("UPDATE executions SET version = ?, data = ? WHERE identity = ? AND version = ?").run(next.version, data, key(original), original.version);
    if (result.changes !== 1) return reject("The Herdr lifecycle compare-and-swap was not confirmed.");
    return get({ ...next.owner, claimId: next.claimId })!;
  });
  const update = (expected: HerdrLifecycleRecord, change: (draft: HerdrLifecycleRecord) => void): HerdrLifecycleRecord => mutate(expected, change, validateChange);
  return {
    close: (): void => { closeSqliteDatabase(db, { file: db.name, format: herdrLifecycleStoreFormat }); },
    get,
    retired,
    listRetired: (): HerdrLifecycleRecord[] => read(() => (db.prepare("SELECT identity, version, data FROM never_started_retirements ORDER BY identity").all() as LifecycleRow[]).map(row => { const record = parseRow(row); return retired({ ...record.owner, claimId: record.claimId })!; })),
    retireNeverStarted: (expected: HerdrLifecycleRecord): void => atomic(() => {
      const original = get({ ...expected.owner, claimId: expected.claimId });
      if (!same(original, expected) || !isHerdrNeverStarted(expected)) return reject("The never-started lifecycle version or evidence changed before retirement.");
      if (retired({ ...expected.owner, claimId: expected.claimId })) return;
      db.prepare("INSERT INTO never_started_retirements(identity, version, data) VALUES (?, ?, ?)").run(key(expected), expected.version, canonicalSessionJson(expected));
    }),
    list: (): HerdrLifecycleRecord[] => read(() => (db.prepare("SELECT identity, version, data FROM executions ORDER BY identity").all() as { identity: string; version: number; data: string }[]).map(parseRow)),
    create: (input: { owner: SessionV2Owner; claimId: string; cwd: string }, now = new Date().toISOString()): HerdrLifecycleRecord => atomic(() => {
      timestamp(now); const owner = parseSessionV2Owner(input.owner), claimId = uuid(input.claimId), cwd = absolute(input.cwd);
      if (retired({ ...owner, claimId })) return reject("A retired never-started claim cannot be registered again.");
      const existing = get({ ...owner, claimId });
      if (existing !== null) { if (!same(existing.owner, owner) || existing.cwd !== cwd) return reject("The original execution cannot be rebound to a different owner or worktree."); return existing; }
      const record = parseHerdrLifecycleRecord({ owner, claimId, cwd, sessionId: randomUUID(), registrationId: randomUUID(), connectionEpoch: null, registrationRequest: null, ledgerRequest: null, publishedLedgerHash: null, controlEpoch: "0", initialAssignment: "pending", initialPrompt: null, automationBlocked: false, preparation: null, runs: [], segments: [], version: 1 });
      db.prepare("INSERT INTO executions(identity, version, data) VALUES (?, ?, ?)").run(key(record), record.version, canonicalSessionJson(record));
      return get({ ...owner, claimId })!;
    }),
    update,
    confirmNativeLaunchRejected: (expected: HerdrLifecycleRecord, evidence: HerdrNativeLaunchRejection): HerdrLifecycleRecord => mutate(expected, draft => {
      const run = draft.runs.at(-1)!;
      run.phase = "prepared"; run.nativeLaunch = "not_submitted";
    }, (before, after) => validateNativeLaunchRejection(before, after, evidence)),
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
