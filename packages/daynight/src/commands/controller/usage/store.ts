import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { UsageAck, UsageGrant, UsagePayload, UsageQueuedEvent, UsageState, UsageStore } from "./types.js";

const MAX_BYTES = 16 * 1024 * 1024, RESERVED_BYTES = 4096, MAX_EVENTS = 20_000, MAX_SOURCES = 100_000;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
/** Local contradictions have no uploadable event, so an ACK cannot resolve them. */
export const countRetainedUsage = (db: Database.Database): number => {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='usage_outbox' AND type='table'").get()) return 0;
  const row = db.prepare("SELECT (SELECT count(*) FROM usage_outbox) + (SELECT count(*) FROM usage_meta WHERE key='source_conflict' AND json_type(value)<>'null') AS count").get() as { count: number };
  return row.count;
};
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
/** Hashes the same admitted JSON values as core/usage/revision.go. */
export const usageBodyHash = (state: UsageState, body: UsagePayload): string => {
  const reasons = [...body.reasonCodes as string[]].sort();
  if (body.kind === "execution_state") return hash(["daynight.usage.state.v1", state.stateId, body.stateSequence, body.collectionState, body.capability, reasons, body.nativeStartedAt, body.nativeEndedAt, body.seal]);
  const metrics = body.metrics as Record<string, unknown>;
  return hash(["daynight.usage.measurement.v1", state.provider, state.nativeSessionId, body.sourceKey, body.profileId, state.providerVersion, body.revisionAuthority, body.sourceRevision, body.finality, body.disposition, body.aggregationRole, body.includedInSourceKey, body.nativeTurnId, body.nativeCallId, body.model, metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens, metrics.cacheWriteTokens, metrics.reasoningTokens, metrics.totalTokens, metrics.providerTotalTokens, body.nativeMetrics, reasons]);
};

/** All mutations run in the owning Controller journal's original write transaction. */
export const openUsageStore = (db: Database.Database, context: { read<T>(action: () => T): T; write<T>(action: () => T): T }): UsageStore => {
  const meta = <T>(key: string): T | undefined => {
    const row = db.prepare("SELECT value FROM usage_meta WHERE key=?").get(key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as T;
  };
  const put = (key: string, value: unknown): void => { db.prepare("INSERT INTO usage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); };
  const state = (stateId: string): UsageState => {
    const value = meta<UsageState>(`state:${stateId}`);
    if (!value) throw new Error("Usage state is not registered in this journal.");
    return value;
  };
  const save = (value: UsageState): void => put(`state:${value.stateId}`, value);
  const gap = (stateId: string, reason: string): void => {
    const value = state(stateId);
    if (!value.reasons.includes(reason)) value.reasons = [...value.reasons, reason].sort().slice(0, 16);
    save(value);
    // This reserved fixed slot does not depend on admitting another outbox row.
    put("collection_gap", { stateId, reason });
  };
  const add = (value: UsageState, payload: UsagePayload, reserved = false): UsageQueuedEvent => {
    const encoded = JSON.stringify(payload), byteLength = Buffer.byteLength(encoded);
    if (byteLength > 16_384) throw new Error("Usage event exceeds its byte limit.");
    const total = db.prepare("SELECT count(*) AS count,coalesce(sum(byte_length),0) AS bytes FROM usage_outbox").get() as { count: number; bytes: number };
    if (total.count >= MAX_EVENTS || total.bytes + byteLength > MAX_BYTES - (reserved ? 0 : RESERVED_BYTES)) throw new Error("Usage outbox capacity exceeded.");
    const sequence = BigInt(meta<string>("last_sequence") ?? "0") + 1n;
    if (sequence > MAX_SEQUENCE) throw new Error("Usage sequence exhausted.");
    const item = { eventId: payload.eventId as string, stateId: value.stateId, bodyHash: usageBodyHash(value, payload), payload, byteLength };
    db.prepare("INSERT INTO usage_outbox(event_id,local_sequence,state_id,body_hash,payload,byte_length) VALUES(?,?,?,?,?,?)").run(item.eventId, sequence, value.stateId, item.bodyHash, encoded, byteLength);
    put("last_sequence", sequence.toString());
    return item;
  };
  return {
    ensureState: (generation, nativeSessionId, providerVersion) => context.write(() => {
      const existing = meta<string>(`generation:${generation}`);
      if (existing) {
        const value = state(existing);
        if (value.nativeSessionId !== nativeSessionId || value.providerVersion !== providerVersion) throw new Error("Usage generation identity changed.");
        return value;
      }
      const value: UsageState = { stateId: randomUUID(), registrationId: randomUUID(), generation, nativeSessionId, providerVersion, provider: "copilot", grant: null, rowVersion: null, stateSequence: "0", reasons: [], stopped: false, registrationAttempted: false, grantRequestAttempted: false };
      save(value); put(`generation:${generation}`, value.stateId); return value;
    }),
    states: () => context.read(() => (db.prepare("SELECT value FROM usage_meta WHERE key LIKE 'state:%' ORDER BY key").all() as { value: string }[]).map(row => JSON.parse(row.value) as UsageState)),
    getState: id => context.read(() => state(id)),
    nearCapacity: () => context.read(() => {
      const total = db.prepare("SELECT count(*) AS count,coalesce(sum(byte_length),0) AS bytes FROM usage_outbox").get() as { count: number; bytes: number };
      const sources = (db.prepare("SELECT count(*) AS count FROM usage_sources").get() as { count: number }).count;
      return total.count >= MAX_EVENTS * 0.9 || total.bytes >= MAX_BYTES * 0.9 || sources >= MAX_SOURCES * 0.9;
    }),
    saveGrant: (id, grant: UsageGrant, rowVersion) => context.write(() => { const value = state(id); value.grant = grant; value.rowVersion = rowVersion; value.grantRequestAttempted = false; save(value); }),
    markRegistrationAttempted: id => context.write(() => { const value = state(id); value.registrationAttempted = true; save(value); }),
    clearRegistrationAttempted: id => context.write(() => { const value = state(id); value.registrationAttempted = false; save(value); }),
    markGrantAttempted: id => context.write(() => { const value = state(id); value.grantRequestAttempted = true; save(value); }),
    clearGrantAttempted: id => context.write(() => { const value = state(id); value.grantRequestAttempted = false; save(value); }),
    pending: (id, limit = 100, kind) => context.read(() => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid usage batch size.");
      return (db.prepare("SELECT event_id AS eventId,state_id AS stateId,body_hash AS bodyHash,payload,byte_length AS byteLength FROM usage_outbox WHERE state_id=? AND quarantined=0 AND (? IS NULL OR json_extract(payload,'$.kind')=?) ORDER BY local_sequence LIMIT ?").all(id, kind ?? null, kind ?? null, limit) as (Omit<UsageQueuedEvent, "payload"> & { payload: string })[]).map(row => ({ ...row, payload: JSON.parse(row.payload) as UsagePayload }));
    }),
    enqueueMeasurement: (id, body) => context.write(() => {
      const value = state(id);
      const payload = { ...body, kind: "measurement", eventId: randomUUID(), originatingStateId: id };
      const sourceKey = JSON.stringify([value.provider, value.nativeSessionId, body.sourceKey]);
      const bodyHash = usageBodyHash(value, payload);
      const existing = db.prepare("SELECT canonical_hash FROM usage_sources WHERE source_key=?").get(sourceKey) as { canonical_hash: string } | undefined;
      if (existing) {
        if (existing.canonical_hash === bodyHash) return "duplicate";
        put("source_conflict", { stateId: id, sourceKey: body.sourceKey, acceptedHash: existing.canonical_hash, rejectedHash: bodyHash });
        gap(id, "source_conflict"); return "conflict";
      }
      if (value.reasons.includes("local_capacity_exceeded")) return "rejected";
      const count = (db.prepare("SELECT count(*) AS count FROM usage_sources").get() as { count: number }).count;
      const total = db.prepare("SELECT count(*) AS count,coalesce(sum(byte_length),0) AS bytes FROM usage_outbox").get() as { count: number; bytes: number };
      if (count >= MAX_SOURCES || total.count >= MAX_EVENTS - 1 || total.bytes + Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES - RESERVED_BYTES || Buffer.byteLength(JSON.stringify(body.nativeMetrics)) > 4096) { gap(id, "local_capacity_exceeded"); return "rejected"; }
      add(value, payload);
      db.prepare("INSERT INTO usage_sources(source_key,canonical_hash,source_revision,originating_state_id,payload) VALUES(?,?,?,?,?)").run(sourceKey, bodyHash, String(body.sourceRevision), id, JSON.stringify(payload));
      return "inserted";
    }),
    enqueueState: (id, body) => context.write(() => {
      const value = state(id), sequence = BigInt(value.stateSequence) + 1n;
      if (value.stopped && (body.seal !== true || body.collectionState === "collecting")) throw new Error("Sealed usage state cannot return to collecting.");
      if (sequence > MAX_SEQUENCE) throw new Error("Usage state sequence exhausted.");
      const payload = { ...body, eventId: randomUUID(), kind: "execution_state", stateSequence: sequence.toString(), reasonCodes: [...new Set([...(body.reasonCodes as string[] ?? []), ...value.reasons])].sort() };
      const result = add(value, payload, true);
      value.stateSequence = sequence.toString(); value.stopped = body.seal === true; save(value); return result;
    }),
    acknowledge: (flight: readonly UsageQueuedEvent[], results: readonly UsageAck[]) => context.write(() => {
      if (!flight.length || results.length !== flight.length || new Set(flight.map(row => row.eventId)).size !== flight.length || new Set(results.map(row => row.eventId)).size !== flight.length) return false;
      for (const item of flight) {
        const result = results.find(row => row.eventId === item.eventId), payload = item.payload;
        if (!result) return false;
        const verifiedStaleState = result.outcome === "stale" && payload.kind === "execution_state" && result.sourceKey === null && result.sourceRevision === null && result.finality === null && /^[a-f0-9]{64}$/.test(result.bodyHash) && typeof result.stateSequence === "string" && /^[1-9][0-9]{0,18}$/.test(result.stateSequence) && BigInt(result.stateSequence) <= MAX_SEQUENCE && BigInt(result.stateSequence) > BigInt(String(payload.stateSequence));
        if (!verifiedStaleState && (!["inserted", "replaced", "duplicate"].includes(result.outcome) || result.bodyHash !== item.bodyHash || result.sourceKey !== (payload.sourceKey ?? null) || result.sourceRevision !== (payload.sourceRevision ?? null) || result.stateSequence !== (payload.stateSequence ?? null) || result.finality !== (payload.finality ?? null))) return false;
        const stored = db.prepare("SELECT state_id,body_hash,payload FROM usage_outbox WHERE event_id=? AND quarantined=0").get(item.eventId) as { state_id: string; body_hash: string; payload: string } | undefined;
        if (!stored || stored.state_id !== item.stateId || stored.body_hash !== item.bodyHash || stored.payload !== JSON.stringify(payload)) return false;
      }
      for (const item of flight) db.prepare("DELETE FROM usage_outbox WHERE event_id=? AND body_hash=?").run(item.eventId, item.bodyHash);
      return true;
    }),
    quarantine: (eventId, reason) => context.write(() => {
      const row = db.prepare("SELECT state_id FROM usage_outbox WHERE event_id=?").get(eventId) as { state_id: string } | undefined;
      if (!row) return;
      db.prepare("UPDATE usage_outbox SET quarantined=1 WHERE event_id=?").run(eventId); gap(row.state_id, reason);
    }),
    gap: (id, reason) => context.write(() => gap(id, reason)),
  };
};
