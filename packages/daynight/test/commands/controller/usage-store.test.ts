import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { countRetainedUsage, openUsageStore, usageBodyHash } from "../../../src/commands/controller/usage/store.js";
import { openControllerOutbox } from "../../../src/commands/controller/outbox-store.js";
import type { UsageAck, UsageQueuedEvent } from "../../../src/commands/controller/usage/types.js";

const schema = readFileSync(new URL("../../../src/commands/controller/sqlite/journal/014-usage.sql", import.meta.url), "utf8");
const databases: Database.Database[] = [], roots: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const storeFor = (db: Database.Database) => openUsageStore(db, { read: action => db.transaction(action).deferred(), write: action => db.transaction(action).immediate() });
const fixture = () => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/usage-store", randomUUID());
  mkdirSync(root, { recursive: true }); roots.push(root);
  const db = new Database(path.join(root, "journal.sqlite")); databases.push(db); db.exec(schema);
  return { db, store: storeFor(db) };
};
const measurement = (sourceKey = "copilot-event-v1:call-1") => ({ sourceKey, nativeTurnId: null, nativeCallId: null, model: "model", profileId: "copilot-event-1.0.11-v1", revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted", includedInSourceKey: null, metrics: { inputTokens: null, outputTokens: "9007199254740993", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: "0", totalTokens: null, providerTotalTokens: null }, nativeMetrics: { outputTokens: "9007199254740993" }, reasonCodes: ["input_cache_semantics_unknown"], observedAt: "2026-11-18T03:00:00Z" });
const ack = (item: UsageQueuedEvent): UsageAck => ({ eventId: item.eventId, sourceKey: item.payload.sourceKey as string ?? null, outcome: "inserted", bodyHash: item.bodyHash, sourceRevision: item.payload.sourceRevision as string ?? null, stateSequence: item.payload.stateSequence as string ?? null, finality: item.payload.finality as string ?? null });

test("disk recovery preserves source identity, grants, state sequence and the original pending event", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "1.0.11/1.0.105");
  store.markRegistrationAttempted(state.stateId); store.saveGrant(state.stateId, { token: "private-token", expiresAt: "2026-11-25T00:00:00Z" }, "2");
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("inserted");
  const pending = store.pending(state.stateId); db.close();
  const reopened = new Database(db.name); databases.push(reopened); const recovered = storeFor(reopened);
  expect(recovered.pending(state.stateId)).toEqual(pending);
  expect(recovered.ensureState("1", "native", "1.0.11/1.0.105").grant?.token).toBe("private-token");
  expect(recovered.enqueueMeasurement(state.stateId, { ...measurement(), observedAt: "later" })).toBe("duplicate");
  const generation2 = recovered.ensureState("2", "native", "1.0.11/1.0.105");
  expect(recovered.enqueueMeasurement(generation2.stateId, measurement())).toBe("duplicate");
  expect(recovered.pending(generation2.stateId)).toEqual([]);
  expect(pending[0]!.payload.originatingStateId).toBe(state.stateId);
  expect(() => recovered.ensureState("1", "changed", "1.0.11/1.0.105")).toThrow("identity changed");
});

test("legacy cumulative ACK and usage exact ACK cannot delete one another's events", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  db.exec("CREATE TABLE outbox(sequence INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE outbox_totals(id INTEGER PRIMARY KEY,byte_length INTEGER NOT NULL); INSERT INTO outbox_totals VALUES(1,0)");
  const legacy = openControllerOutbox(db, { assertWrite: () => { if (!db.inTransaction) throw new Error("transaction required"); } });
  db.transaction(() => legacy.append(1n, "legacy")).immediate();
  store.enqueueMeasurement(state.stateId, measurement()); const flight = store.pending(state.stateId);
  db.transaction(() => legacy.acknowledgeThrough(9_000_000_000n)).immediate();
  expect(store.pending(state.stateId)).toEqual(flight);
  db.transaction(() => legacy.append(2n, "retained")).immediate();
  expect(store.acknowledge(flight, flight.map(ack))).toBe(true);
  expect(legacy.pending(null, 10)).toEqual([{ sequence: "2", value: "retained" }]);
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("duplicate");
});

test("unknown, incomplete, duplicate, contradictory and unsent ACKs retain the complete flight", () => {
  const { store } = fixture(), state = store.ensureState("1", "native", "v");
  store.enqueueMeasurement(state.stateId, measurement("one")); store.enqueueMeasurement(state.stateId, measurement("two"));
  const flight = store.pending(state.stateId), results = flight.map(ack);
  for (const invalid of [[], [results[0]!], [results[0]!, results[0]!], [{ ...results[0]!, bodyHash: "wrong" }, results[1]!], [{ ...results[0]!, eventId: randomUUID() }, results[1]!], [{ ...results[0]!, outcome: "stale", sourceRevision: "2" }, results[1]!]]) {
    expect(store.acknowledge(flight, invalid)).toBe(false); expect(store.pending(state.stateId)).toEqual(flight);
  }
  expect(store.acknowledge([flight[0]!, flight[0]!], results)).toBe(false);
  expect(store.acknowledge([{ ...flight[0]!, stateId: randomUUID() }, flight[1]!], results)).toBe(false);
  expect(store.acknowledge([{ ...flight[0]!, payload: { ...flight[0]!.payload, originatingStateId: randomUUID() } }, flight[1]!], results)).toBe(false);
  expect(store.pending(state.stateId)).toEqual(flight);
  expect(store.acknowledge(flight, [...results].reverse())).toBe(true);
});

test("registration attempt admission changes only through explicit no-write recovery", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  store.markRegistrationAttempted(state.stateId); store.markGrantAttempted(state.stateId);
  db.close(); const reopened = new Database(db.name); databases.push(reopened); const recovered = storeFor(reopened);
  expect(recovered.getState(state.stateId)).toMatchObject({ registrationAttempted: true, grantRequestAttempted: true });
  recovered.clearRegistrationAttempted(state.stateId);
  expect(recovered.getState(state.stateId)).toMatchObject({ registrationAttempted: false, grantRequestAttempted: true });
  recovered.saveGrant(state.stateId, { token: "receipt-token", expiresAt: "2026-11-25T00:00:00Z" }, "2");
  expect(recovered.getState(state.stateId).grantRequestAttempted).toBe(false);
});

test("same-source contradictions retain the original value and quarantine does not block unrelated sources", () => {
  const { store } = fixture(), state = store.ensureState("1", "native", "v");
  store.enqueueMeasurement(state.stateId, measurement());
  expect(store.enqueueMeasurement(state.stateId, { ...measurement(), model: "contradiction" })).toBe("conflict");
  expect(store.getState(state.stateId).reasons).toContain("source_conflict");
  const original = store.pending(state.stateId)[0]!;
  store.quarantine(original.eventId, "source_conflict"); store.enqueueMeasurement(state.stateId, measurement("unrelated"));
  expect(store.pending(state.stateId).map(row => row.payload.sourceKey)).toEqual(["unrelated"]);
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("duplicate");
});

test("ACKs cannot resolve local contradictions or release their journal across restart", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  expect(countRetainedUsage(db)).toBe(0);
  store.enqueueMeasurement(state.stateId, measurement());
  expect(store.enqueueMeasurement(state.stateId, { ...measurement(), model: "contradiction" })).toBe("conflict");
  store.enqueueState(state.stateId, { collectionState: "partial", capability: {}, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: null, observedAt: "2026-11-18T03:00:00Z", seal: true });
  const conflict = db.prepare("SELECT value FROM usage_meta WHERE key='source_conflict'").get();
  const flight = store.pending(state.stateId);
  expect(store.acknowledge(flight, flight.map(ack))).toBe(true);
  expect(store.pending(state.stateId)).toEqual([]);
  expect(countRetainedUsage(db)).toBe(1);
  db.close(); const reopened = new Database(db.name); databases.push(reopened);
  expect(countRetainedUsage(reopened)).toBe(1);
  expect(reopened.prepare("SELECT value FROM usage_meta WHERE key='source_conflict'").get()).toEqual(conflict);
});

test("legacy journals and null conflict slots have no unresolved retention", () => {
  const legacy = new Database(":memory:"); databases.push(legacy);
  expect(countRetainedUsage(legacy)).toBe(0);
  legacy.exec(schema); legacy.prepare("INSERT INTO usage_meta(key,value) VALUES('source_conflict','null')").run();
  expect(countRetainedUsage(legacy)).toBe(0);
});

test("state events retain monotonic sequences and hashes across restart", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  const body = { collectionState: "partial", capability: {}, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: null, observedAt: "2026-11-18T03:00:00Z", seal: true };
  store.gap(state.stateId, "native_recovery_gap");
  const first = store.enqueueState(state.stateId, body);
  expect(first.payload.stateSequence).toBe("1"); expect(first.payload.reasonCodes).toEqual(["native_recovery_gap"]);
  expect(first.bodyHash).toBe(usageBodyHash(state, first.payload));
  db.close(); const reopened = new Database(db.name); databases.push(reopened);
  expect(storeFor(reopened).enqueueState(state.stateId, body).payload.stateSequence).toBe("2");
});

test("an interrupted transaction cannot advance sources or pending accounting", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  db.exec("CREATE TRIGGER reject_source BEFORE INSERT ON usage_sources BEGIN SELECT RAISE(ABORT,'disk fault'); END");
  expect(() => store.enqueueMeasurement(state.stateId, measurement())).toThrow("disk fault");
  expect(store.pending(state.stateId)).toEqual([]);
  db.exec("DROP TRIGGER reject_source");
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("inserted");
});

test("capacity rejection retains a reserved gap and prevents another measurement admission", () => {
  const { db, store } = fixture(), state = store.ensureState("1", "native", "v");
  // Fill the real queue's byte budget with retained poison evidence. The event
  // cannot be deleted by the normal pending uploader to make room implicitly.
  const filler = "x".repeat(16 * 1024 * 1024 - 4096);
  db.prepare("INSERT INTO usage_outbox VALUES(?,1,?,'hash',?,?,1)").run(randomUUID(), state.stateId, filler, Buffer.byteLength(filler));
  expect(store.nearCapacity()).toBe(true);
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("rejected");
  expect(store.getState(state.stateId).reasons).toContain("local_capacity_exceeded");
  expect(JSON.parse((db.prepare("SELECT value FROM usage_meta WHERE key='collection_gap'").get() as { value: string }).value)).toEqual({ stateId: state.stateId, reason: "local_capacity_exceeded" });
  db.exec("DELETE FROM usage_outbox");
  expect(store.enqueueMeasurement(state.stateId, measurement())).toBe("rejected");
});
