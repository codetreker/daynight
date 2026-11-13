import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { controllerJournalReadOptions, prepareControllerStorage } from "../../../src/commands/controller/storage-preparation.js";
import { controllerMetadataBudget, controllerJournalPhysicalBytes } from "../../../src/commands/controller/media/metadata-budget.js";
import { readSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { parseTimelineEntry, type TimelineEntry } from "../../../src/session/protocol.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const fixtures: { close(): void; root: string }[] = [];
afterEach(() => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try { fixture.close(); } catch (failure) { failures.push(failure); }
    try { rmSync(fixture.root, { recursive: true, force: true }); } catch (failure) { failures.push(failure); }
  }
  if (failures.length) throw new AggregateError(failures, "Production capacity fixtures did not clean up.");
});

const id = (number: number): string => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const entry = (number: number, revision: number, text: string): TimelineEntry => parseTimelineEntry({ entryId: id(number), entrySeq: String(number), revision: String(revision), kind: "assistant_message", content: [{ type: "text", text }] });
const digestEntry = (hash: ReturnType<typeof createHash>, value: TimelineEntry): void => { const encoded = JSON.stringify(value); hash.update(`${Buffer.byteLength(encoded)}:`); hash.update(encoded); };
const sources = ["lifecycle-store.ts", "journal-format.ts", "storage-preparation.ts", "content/timeline-store.ts", "content/session-content.ts", "sqlite/journal/010-timeline-content.sql"];
const sourceHashes = (): Record<string, string> => Object.fromEntries(sources.map(name => [name, createHash("sha256").update(readFileSync(new URL(`../../../src/commands/controller/${name}`, import.meta.url))).digest("hex")]));
const loadedSourceHashes = sourceHashes();

const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/session-sqlite-production-capacity"); mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "case-")), file = path.join(root, "journal.sqlite");
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "generated storage acceptance", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const permit = acquireControllerStoragePermit(file);
  const owned = { root, close: (): void => permit.release() }; fixtures.push(owned);
  expect(prepareControllerStorage({ journalFile: file, stateDirectory: root, mode: "writer", ticket }, permit, () => {})).toMatchObject({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
  const db = new Database(file);
  owned.close = (): void => { if (db.open) db.close(); permit.release(); };
  const journal = openControllerLifecycleStore(file, ticket, { database: db, storagePermit: permit, mediaStateDirectory: root, contentOwnedLocally: true, onMigration: () => {} });
  expect(db.pragma("user_version", { simple: true })).toBe(10); expect(db.pragma("journal_mode", { simple: true })).toBe("wal"); expect(db.pragma("synchronous", { simple: true })).toBe(2); expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
  let closed = false, publications = 0, acknowledgements = 0, peakBytes = 0, peakMetadataBytes = 0, peakOutboxBytes = 0;
  let maximumAcknowledgementBatch = 1;
  let peak: Record<string, number | string> = {}, minimumFreeBytes = Number.MAX_SAFE_INTEGER;
  const started = performance.now();
  const initialPhysical = controllerJournalPhysicalBytes(file, db);
  const metadataOverhead = controllerMetadataBudget(file, db).bytes() - initialPhysical.databaseBytes - initialPhysical.walBytes - initialPhysical.shmBytes;
  const samplePhysical = (phase: string): number => {
    const physical = controllerJournalPhysicalBytes(file, db), bytes = physical.databaseBytes + physical.walBytes + physical.shmBytes;
    if (bytes + metadataOverhead > 128 * 1048576) throw new Error("Production capacity fixture exceeded normal metadata admission.");
    if (bytes > peakBytes) { peakBytes = bytes; peak = { ...physical, bytes, phase, publications, acknowledgements }; }
    peakMetadataBytes = Math.max(peakMetadataBytes, bytes + metadataOverhead);
    return bytes;
  };
  const sample = (phase: string): void => {
    journal.assertInputCapacity();
    const bytes = samplePhysical(phase);
    const metadataBytes = controllerMetadataBudget(file, db).bytes();
    const outboxBytes = (db.prepare("SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM outbox").get() as { bytes: number }).bytes;
    peakMetadataBytes = Math.max(peakMetadataBytes, metadataBytes); peakOutboxBytes = Math.max(peakOutboxBytes, outboxBytes);
    expect(metadataBytes - bytes).toBe(metadataOverhead);
    const free = statfsSync(root, { bigint: true }); minimumFreeBytes = Math.min(minimumFreeBytes, Number(free.bavail * free.bsize));
    expect(metadataBytes).toBeLessThanOrEqual(128 * 1048576);
  };
  const publish = (value: TimelineEntry): TimelineEntry => {
    journal.assertInputCapacity();
    const event = journal.projectTimeline(value); expect(event).not.toBeNull(); publications++;
    sample("published-before-ack");
    journal.acknowledgeEvents(event!.sequence); acknowledgements++;
    sample("separate-ack-commit");
    const current = journal.getTimelineEntry(value.entryId); if (current === undefined) throw new Error("Published SQL body is missing.");
    return current;
  };
  const publishBatch = (values: readonly TimelineEntry[]): void => {
    journal.assertInputCapacity();
    let through = "0";
    for (const value of values) {
      const event = journal.projectTimeline(value); publications++;
      if (event === null || event.sequence !== String(publications)) throw new Error("Production publication lost its ordered source event.");
      through = event.sequence; samplePhysical("published-before-batch-ack");
    }
    maximumAcknowledgementBatch = Math.max(maximumAcknowledgementBatch, values.length);
    sample("published-before-batch-ack"); journal.acknowledgeEvents(through); acknowledgements++; sample("separate-batch-ack-commit");
  };
  const totals = () => db.prepare("SELECT entry_count AS count,byte_length AS bytes FROM timeline_totals WHERE id=1").get() as { count: number; bytes: number };
  const assertCurrent = (expected: readonly TimelineEntry[]): string => {
    const hash = createHash("sha256"); let number = 0;
    for (const row of db.prepare("SELECT id,CAST(entry_seq AS TEXT) AS seq,CAST(revision AS TEXT) AS rev,content_hash,byte_length,value FROM timeline_entries ORDER BY entry_seq").iterate() as Iterable<{ id: string; seq: string; rev: string; content_hash: string; byte_length: number; value: string }>) {
      const current = parseTimelineEntry(JSON.parse(row.value)), wanted = expected[number++];
      expect(current).toEqual(wanted); expect(row.id).toBe(wanted!.entryId); expect(row.seq).toBe(wanted!.entrySeq); expect(row.rev).toBe(wanted!.revision);
      expect(row.byte_length).toBe(Buffer.byteLength(JSON.stringify(wanted))); expect(row.content_hash).toBe(controllerPayloadHash(wanted)); digestEntry(hash, current);
    }
    expect(number).toBe(expected.length); expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.prepare("SELECT 1 FROM outbox").get()).toBeUndefined();
    const metadata = `${file}.pending-content`;
    for (const name of ["entries", "timeline", "legacy-sql"]) expect(existsSync(path.join(metadata, name)) ? readdirSync(path.join(metadata, name)) : []).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='content_index'").get()).toBeUndefined();
    return hash.digest("hex");
  };
  const close = (): void => { if (!closed) { journal.close(); if (db.open) throw new Error("Production writer did not close its SQL connection."); permit.release(); closed = true; } };
  owned.close = close;
  const reopen = (expected: readonly TimelineEntry[]): void => {
    close();
    readSqliteDatabase({ ...controllerJournalReadOptions(file), onMissing: () => { throw new Error("Committed journal is missing."); } }, reader => {
      const rows = reader.prepare("SELECT value,content_hash,byte_length,CAST(entry_seq AS TEXT) AS seq,CAST(revision AS TEXT) AS rev FROM timeline_entries ORDER BY entry_seq").all() as { value: string; content_hash: string; byte_length: number; seq: string; rev: string }[];
      expect(rows).toHaveLength(expected.length);
      for (const [index, row] of rows.entries()) { expect(parseTimelineEntry(JSON.parse(row.value))).toEqual(expected[index]); expect(row.content_hash).toBe(controllerPayloadHash(expected[index])); expect(row.byte_length).toBe(Buffer.byteLength(JSON.stringify(expected[index]))); expect(row.seq).toBe(expected[index]!.entrySeq); expect(row.rev).toBe(expected[index]!.revision); }
      expect(reader.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  };
  const report = (name: string, extra: Record<string, unknown>): void => {
    expect(sourceHashes()).toEqual(loadedSourceHashes);
    const settledDbWalShmBytes = ["", "-wal", "-shm"].reduce((sum, suffix) => sum + (existsSync(file + suffix) ? lstatSync(file + suffix).size : 0), 0);
    process.stdout.write(JSON.stringify({ kind: "production-session-sqlite-capacity", name, node: process.version, sourceHashes: loadedSourceHashes, conditions: { api: "prepareControllerStorage(writer) -> openControllerLifecycleStore -> projectTimeline -> separate acknowledgeEvents", originalStoragePermit: true, journal: "WAL/FULL/1000", heldReader: false, relayConnected: false, nativeProcessStarted: false, generatedInput: true, originalIncidentReplay: false, publications, separateAcknowledgementCommits: acknowledgements, maximumAcknowledgementBatch, normalMetadataLimitBytes: 128 * 1048576, minimumObservedVolumeFreeBytes: minimumFreeBytes }, peakDbWalShm: peak, peakMetadataBytes, peakOutboxBytes, settledDbWalShmBytes, reopened: true, integrityCheck: "ok", durationMs: performance.now() - started, ...extra }) + "\n");
  };
  return { root, file, db, journal, ticket, publish, publishBatch, totals, assertCurrent, close, reopen, report, sample };
};

test("production publication admits 100000 current entries, replaces without accumulation and rejects entry 100001", () => {
  const f = fixture(), expected: TimelineEntry[] = [];
  let batch: TimelineEntry[] = [];
  for (let number = 1; number <= 100000; number++) {
    const value = entry(number, 1, `row-${number}`); expected.push(value); batch.push(value);
    if (batch.length === 100) { f.publishBatch(batch); batch = []; }
    if (number % 25000 === 0) process.stdout.write(JSON.stringify({ kind: "production-capacity-progress", entries: number }) + "\n");
  }
  const before = f.totals(), sequence = f.journal.getLastSourceSequence();
  expect(() => f.journal.projectTimeline(entry(100001, 1, "refused"))).toThrow("timeline budget");
  expect(f.totals()).toEqual(before); expect(f.journal.getLastSourceSequence()).toBe(sequence); expect(f.journal.getTimelineEntry(id(100001))).toBeUndefined();
  const replacement = entry(50000, 2, "replacement"); expect(f.publish(replacement)).toEqual(replacement); expected[49999] = replacement;
  expect(f.totals().count).toBe(100000); const finalHash = f.assertCurrent(expected); f.sample("final-current-rows");
  const finalTotals = f.totals(); f.reopen(expected);
  f.report("100000-current-entries", { verifiedFinalRows: expected.length, finalTotals, finalRowsHash: finalHash, overLimitRolledBack: true, replacementCountUnchanged: true });
}, 240000);

test("production publication accepts the exact 64 MiB UTF-8 envelope and rolls back one byte of growth", () => {
  const f = fixture(), count = 64, maximum = 64 * 1048576, available = maximum - 14 - (count - 1), expected: TimelineEntry[] = [];
  let used = 0;
  for (let number = 1; number <= count; number++) {
    const target = number === count ? available - used : Math.floor(available / count), base = entry(number, 1, "界😀");
    const value = entry(number, 1, "界😀" + "x".repeat(target - Buffer.byteLength(JSON.stringify(base))));
    expect(f.publish(value)).toEqual(value); expected.push(value); used += Buffer.byteLength(JSON.stringify(value));
  }
  expect(f.totals()).toEqual({ count, bytes: available }); expect(14 + f.totals().bytes + count - 1).toBe(maximum);
  const last = expected.at(-1)!; if (last.kind !== "assistant_message" || last.content[0]?.type !== "text") throw new Error("Unexpected capacity fixture.");
  const lastText = last.content[0].text;
  const sequence = f.journal.getLastSourceSequence();
  expect(() => f.journal.projectTimeline(entry(count, 2, lastText + "x"))).toThrow("timeline budget");
  expect(f.journal.getTimelineEntry(last.entryId)).toEqual(last); expect(f.journal.getLastSourceSequence()).toBe(sequence); expect(f.totals()).toEqual({ count, bytes: available });
  expect(f.publish(entry(count, 2, lastText.slice(0, -10))).revision).toBe("2");
  const restored = entry(count, 3, lastText); expect(f.publish(restored)).toEqual(restored); expected[count - 1] = restored;
  expect(f.totals()).toEqual({ count, bytes: available }); const finalHash = f.assertCurrent(expected); f.sample("exact-envelope");
  const finalTotals = f.totals(); f.reopen(expected);
  f.report("64MiB-exact-envelope", { verifiedFinalRows: count, finalTotals, envelopeBytes: maximum, finalRowsHash: finalHash, overLimitRolledBack: true, replacementDidNotAccumulate: true });
}, 120000);

test("production publication verifies all 989 generated revisions at the incident aggregate byte scale", () => {
  const f = fixture(), finalSizes = [126417, 126416], counts = [500, 489], hot = [149, 150], pattern = "0123456789abcdefABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const textOf = (length: number, prefix: string): string => prefix + pattern.repeat(Math.ceil((length - prefix.length) / pattern.length)).slice(0, length - prefix.length);
  const texts = finalSizes.map((length, body) => textOf(length, `hot-${body === 0 ? "A" : "B"}-`)), finalHot = counts.map((count, body) => entry(hot[body]!, count + 1, texts[body]!));
  const finalTarget = 1372529, cumulativeTarget = 78744300, seedBudget = finalTarget - finalHot.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  const seeds = Array.from({ length: 148 }, (_, index) => {
    const number = index + 1, bytes = Math.floor(seedBudget / 148) + (number <= seedBudget % 148 ? 1 : 0), header = Buffer.byteLength(JSON.stringify(entry(number, 1, "")));
    return entry(number, 1, textOf(bytes - header, `seed-${String(number).padStart(3, "0")}-`));
  });
  const order: { body: number; index: number }[] = [];
  for (let index = 1; index <= counts[0]!; index++) { order.push({ body: 0, index }); if (index <= counts[1]!) order.push({ body: 1, index }); }
  const headers = order.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(entry(hot[item.body]!, item.index + 1, ""))), 0), textTarget = cumulativeTarget - headers, denominator = 1000000000n;
  const lengthsFor = (fraction: bigint): number[][] => counts.map((count, body) => Array.from({ length: count }, (_, position) => Number(BigInt(finalSizes[body]!) * (fraction * BigInt(count - position - 1) + denominator * BigInt(position + 1)) / (denominator * BigInt(count)))));
  const sumLengths = (rows: number[][]): number => rows.reduce((sum, row) => sum + row.reduce((total, value) => total + value, 0), 0);
  let low = 0n, high = denominator;
  while (low < high) { const mid = (low + high + 1n) / 2n; if (sumLengths(lengthsFor(mid)) <= textTarget) low = mid; else high = mid - 1n; }
  const lengths = lengthsFor(low); let remaining = textTarget - sumLengths(lengths); const adjusted = remaining;
  for (const item of order.toReversed()) { if (!remaining) break; if (item.index < counts[item.body]! && lengths[item.body]![item.index - 1]! + 1 <= lengths[item.body]![item.index]!) { lengths[item.body]![item.index - 1]!++; remaining--; } }
  expect(remaining).toBe(0); expect(sumLengths(lengths)).toBe(textTarget); expect(order).toHaveLength(989);
  for (const [body, row] of lengths.entries()) { expect(row.at(-1)).toBe(finalSizes[body]); for (let index = 1; index < row.length; index++) expect(row[index]).toBeGreaterThanOrEqual(row[index - 1]!); }
  const seedHash = createHash("sha256"), updatesHash = createHash("sha256"), orderHash = createHash("sha256");
  for (const value of [...seeds, ...hot.map(number => entry(number, 1, ""))]) { expect(f.publish(value)).toEqual(value); digestEntry(seedHash, value); }
  let cumulativeBytes = 0, currentBytes = f.totals().bytes;
  const currentHot = hot.map(number => entry(number, 1, ""));
  for (const [position, item] of order.entries()) {
    const wanted = entry(hot[item.body]!, item.index + 1, texts[item.body]!.slice(0, lengths[item.body]![item.index - 1]));
    const current = f.publish(wanted); expect(current).toEqual(wanted);
    const encoded = JSON.stringify(current), raw = f.db.prepare("SELECT CAST(entry_seq AS TEXT) AS seq,CAST(revision AS TEXT) AS rev,content_hash,byte_length,value FROM timeline_entries WHERE id=?").get(current.entryId) as { seq: string; rev: string; content_hash: string; byte_length: number; value: string };
    expect(raw).toEqual({ seq: wanted.entrySeq, rev: wanted.revision, content_hash: controllerPayloadHash(wanted), byte_length: Buffer.byteLength(encoded), value: encoded });
    currentBytes += Buffer.byteLength(encoded) - Buffer.byteLength(JSON.stringify(currentHot[item.body])); currentHot[item.body] = current;
    expect(f.totals()).toEqual({ count: 150, bytes: currentBytes });
    cumulativeBytes += Buffer.byteLength(encoded); digestEntry(updatesHash, current); orderHash.update(JSON.stringify([position + 1, current.entryId, current.entrySeq, current.revision, lengths[item.body]![item.index - 1], raw.content_hash]) + "\n");
  }
  expect(cumulativeBytes).toBe(cumulativeTarget); expect(f.totals()).toEqual({ count: 150, bytes: finalTarget }); expect(finalSizes.reduce((sum, size) => sum + size, 0)).toBe(252833);
  const before = f.journal.getLastSourceSequence(); expect(f.journal.projectTimeline(finalHot[0]!)).toBeNull(); expect(f.journal.getLastSourceSequence()).toBe(before);
  const expected = [...seeds, ...finalHot], finalHash = f.assertCurrent(expected); f.sample("final-generated-current-rows");
  const finalTotals = f.totals(); f.reopen(expected);
  f.report("989-generated-aggregate-scale", { generator: "two-monotone-prefix-bodies-v1", textPattern: pattern, seedRows: 148, initialEmptyBodies: 2, hotEntries: hot, hotUpdates: counts, finalRawTextBytes: finalSizes, seedSha256: seedHash.digest("hex"), orderedUpdatesSha256: updatesHash.digest("hex"), updateOrderSha256: orderHash.digest("hex"), finalRowsHash: finalHash, verifiedUpdates: 989, finalTotals, cumulativeNormalizedUpdateBytes: cumulativeBytes, solver: { denominator: String(denominator), numerator: String(low), oneByteAdjustments: adjusted, formula: "floor(F*(q*(n-k)+D*k)/(D*n))" }, sameContentNoop: true, limits: "Generated production storage/publication/ACK evidence, not the original incident trace, native execution or relay latency." });
}, 180000);
