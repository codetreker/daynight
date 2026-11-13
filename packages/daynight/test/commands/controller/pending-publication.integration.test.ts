import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerTestDatabase, closeControllerTestDatabase } from "../../helpers/controller-sqlite.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { controllerMetadataBudget, CONTROLLER_METADATA_BYTES, CONTROLLER_SETTLEMENT_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
import { createLocalSessionContent } from "../../../src/commands/controller/local-content.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) closeControllerTestDatabase(db);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const readContent = (file: string, sessionId: string, db: Database.Database) => openSessionContent(file, sessionId, db, {
  assertWrite: () => { throw new Error("Observer content is read-only."); },
  read: action => db.inTransaction ? action() : db.transaction(action).deferred(),
});
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/pending-publication-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), sessionId = randomUUID();
  const db = openControllerTestDatabase({ file, allowCreate: true, onMigration: () => {} }); connections.push(db);
  const budget = controllerMetadataBudget(file, db); let writeDepth = 0;
  const content = openSessionContent(file, sessionId, db, {
    assertWrite: additional => { if (!writeDepth || !db.inTransaction) throw new Error("Not the original publication transaction."); budget.assert(additional, true); },
    read: action => db.inTransaction ? action() : db.transaction(action).deferred(),
  });
  const write = <T>(action: () => T): T => db.transaction(() => { writeDepth++; try { return action(); } finally { writeDepth--; } }).immediate();
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "reasoning" as const, text: "original" };
  write(() => content.timeline.save(entry));
  return { file, sessionId, db, content, entry, write };
};

test("a rolled-back SQL body and totals never replace the committed publication", async () => {
  const f = await fixture(), beforeTotals = f.content.timeline.totals();
  expect(() => f.write(() => {
    f.content.timeline.save({ ...f.entry, revision: "2", text: "uncommitted" });
    f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','new')").run();
    f.db.prepare("INSERT INTO outbox(sequence,value) VALUES(1,'uncommitted')").run();
    throw new Error("publication failed");
  })).toThrow("publication failed");
  expect(f.content.timeline.get(f.entry.entryId)).toEqual(f.entry);
  expect(f.content.timeline.totals()).toEqual(beforeTotals);
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(readContent(f.file, f.sessionId, observer).timeline.get(f.entry.entryId)).toEqual(f.entry);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toBeUndefined();
  expect(observer.prepare("SELECT 1 FROM outbox").get()).toBeUndefined();
});

test("a WAL reader retains one body, totals and metadata snapshot across another connection's commit", async () => {
  const f = await fixture();
  f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','old')").run();
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  const content = readContent(f.file, f.sessionId, observer);
  const inspection = createLocalSessionContent(content, f.sessionId, { read: action => observer.transaction(action).deferred(), write: action => observer.transaction(action).immediate() });
  observer.exec("BEGIN DEFERRED");
  expect(content.timeline.get(f.entry.entryId)).toEqual(f.entry); const beforeTotals = content.timeline.totals();
  f.write(() => {
    f.content.timeline.save({ ...f.entry, revision: "2", text: "committed" });
    f.db.prepare("UPDATE image_runtime_state SET value='new' WHERE key='publication'").run();
  });
  expect(inspection.readInspection({ historyEpoch: "epoch", cursor: null, limit: 10, responseOverhead: 0 }).items[0]?.body).toEqual(f.entry);
  expect(content.timeline.totals()).toEqual(beforeTotals);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: "old" });
  observer.exec("COMMIT");
  expect(content.timeline.get(f.entry.entryId)).toMatchObject({ revision: "2", text: "committed" });
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: "new" });
});

test("an outer rollback discards nested publications without consuming sequence numbers", async () => {
  const f = await fixture(), entryId = randomUUID();
  expect(() => f.write(() => {
    f.write(() => f.content.timeline.save({ ...f.entry, entryId, entrySeq: "2" }));
    throw new Error("outer rollback");
  })).toThrow("outer rollback");
  expect(f.content.timeline.has(entryId)).toBe(false); expect(f.content.timeline.nextSequence()).toBe("2");
  f.write(() => f.content.timeline.save({ ...f.entry, entryId, entrySeq: "10" }));
  expect(f.content.timeline.nextSequence()).toBe("11");
});

test("retained migration artifacts consume metadata without becoming current SQL history", async () => {
  const f = await fixture();
  await mkdir(path.join(`${f.file}.pending-content`, "entries"), { mode: 0o700 });
  const budget = controllerMetadataBudget(f.file, f.db), filename = path.join(`${f.file}.pending-content`, "entries", `${randomUUID()}.json`), file = await open(filename, "wx", 0o600);
  try { await file.truncate(CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES - budget.bytes()); } finally { await file.close(); }
  expect(() => f.write(() => f.content.timeline.save({ ...f.entry, revision: "2", text: "refused" }))).toThrow("metadata budget");
  expect(f.content.timeline.get(f.entry.entryId)).toEqual(f.entry);
  expect(readContent(f.file, f.sessionId, f.db).timeline.totals().entryCount).toBe(1);
});

test.each(["entry", "totals"] as const)("a %s SQL write failure leaves the old publication readable", async phase => {
  const f = await fixture(), beforeTotals = f.content.timeline.totals(), prepare = f.db.prepare.bind(f.db);
  const failure = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (phase === "entry" && sql.startsWith("INSERT INTO timeline_entries(") || phase === "totals" && sql.startsWith("UPDATE timeline_totals SET")) throw new Error("publication write failed");
    return prepare(sql);
  });
  expect(() => f.write(() => f.content.timeline.save({ ...f.entry, revision: "2", text: "not committed" }))).toThrow("publication write failed");
  failure.mockRestore();
  expect(f.content.timeline.get(f.entry.entryId)).toEqual(f.entry); expect(f.content.timeline.totals()).toEqual(beforeTotals);
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(readContent(f.file, f.sessionId, observer).timeline.get(f.entry.entryId)).toEqual(f.entry);
});

test.each(["missing", "bytes", "revision"] as const)("a current SQL entry with invalid %s fails without adopting an orphan candidate", async variant => {
  const f = await fixture(), directory = `${f.file}.pending-content/entries`;
  await mkdir(directory, { mode: 0o700 }); const orphan = path.join(directory, `${randomUUID()}.json`);
  await writeFile(orphan, JSON.stringify({ ...f.entry, revision: "2", text: "not a SQL commit" }), { mode: 0o600 });
  if (variant === "missing") f.db.prepare("DELETE FROM timeline_entries WHERE id=?").run(f.entry.entryId);
  if (variant === "bytes") f.db.prepare("UPDATE timeline_entries SET value='corrupt' WHERE id=?").run(f.entry.entryId);
  if (variant === "revision") f.db.prepare("UPDATE timeline_entries SET revision=2 WHERE id=?").run(f.entry.entryId);
  expect(() => readContent(f.file, f.sessionId, f.db)).toThrow();
  expect(JSON.parse(await readFile(orphan, "utf8"))).toMatchObject({ revision: "2", text: "not a SQL commit" });
});

test.each(["before", "after"] as const)("process termination %s COMMIT exposes only the complete durable SQL publication", async phase => {
  const f = await fixture(); f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','old')").run();
  closeControllerTestDatabase(f.db);
  const child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("../../fixtures/pending-publication-child.mjs", import.meta.url)), f.file, f.sessionId, JSON.stringify({ ...f.entry, revision: "2", text: "committed" }), phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let diagnostics = ""; child.stderr!.on("data", value => { diagnostics = (diagnostics + String(value)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("message", message => message === phase ? resolve() : reject(new Error("Unexpected commit barrier.")));
      child.once("exit", code => reject(new Error(`Publication child exited ${code}: ${diagnostics}`)));
    });
    child.kill("SIGKILL"); await exited;
    const observer = new Database(f.file, { readonly: true }); connections.push(observer);
    const content = readContent(f.file, f.sessionId, observer);
    expect(content.timeline.get(f.entry.entryId)).toMatchObject({ revision: phase === "before" ? "1" : "2", text: phase === "before" ? "original" : "committed" });
    expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: phase === "before" ? "old" : "new" });
    expect(content.timeline.totals().entryCount).toBe(1);
    expect(await readdir(content.resourceFiles.root)).not.toContain("entries");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
}, 15000);

const legacyFixture = async () => {
  const f = await fixture(); closeControllerTestDatabase(f.db);
  const file = path.join(path.dirname(f.file), "legacy.sqlite"), db = new Database(file); connections.push(db);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 7)) db.exec(step.sql);
  db.pragma("user_version=7");
  const state = '{ "unknownAction": "commit", "captureId": "original", "phase": "query" }';
  const operation = '{ "state": "unknown", "operationId": "original" }';
  db.prepare("INSERT INTO execution(id,ticket_hash,snapshot) VALUES(1,'original',?)").run(JSON.stringify({ executionId: randomUUID(), sessionId: f.sessionId }));
  db.prepare("INSERT INTO image_runtime_state VALUES('native_provider:original',?)").run(state);
  db.prepare("INSERT INTO operations(id,value) VALUES('original',?)").run(operation);
  db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(f.entry.entryId, controllerPayloadHash(f.entry), f.entry.revision, f.entry.entrySeq);
  const directory = `${file}.pending-content`;
  await mkdir(path.join(directory, "timeline"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId: f.sessionId }), { mode: 0o600 });
  const original = JSON.stringify(f.entry), filename = path.join(directory, "timeline", `${createHash("sha256").update(f.entry.entryId).digest("hex")}.json`);
  await writeFile(filename, original, { mode: 0o600 }); closeControllerTestDatabase(db);
  return { ...f, file, filename, original, state, operation };
};

test("v7 migration preserves exact native unknown state and legacy source bytes", async () => {
  const f = await legacyFixture();
  const db = openControllerTestDatabase({ file: f.file, allowCreate: false, onMigration: () => {} }); connections.push(db);
  expect(readContent(f.file, f.sessionId, db).timeline.get(f.entry.entryId)).toEqual(f.entry);
  expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:original'").get()).toEqual({ value: f.state });
  expect(db.prepare("SELECT value FROM operations WHERE id='original'").get()).toEqual({ value: f.operation });
  expect(await readFile(f.filename, "utf8")).toBe(f.original);
});

test.each(["ahead", "missing", "unindexed", "missing-manifest"] as const)("v7 %s source fails closed without changing native unknown state", async variant => {
  const f = await legacyFixture();
  if (variant === "ahead") await writeFile(f.filename, JSON.stringify({ ...f.entry, revision: "2", text: "uncommitted" }));
  if (variant === "missing") await rm(f.filename);
  if (variant === "missing-manifest") await rm(path.join(`${f.file}.pending-content`, "manifest.json"));
  if (variant === "unindexed") await writeFile(path.join(path.dirname(f.filename), `${"a".repeat(64)}.json`), JSON.stringify({ ...f.entry, entryId: randomUUID(), entrySeq: "2" }));
  expect(() => openControllerTestDatabase({ file: f.file, allowCreate: false, onMigration: () => {} })).toThrow("migration-failed");
  const db = new Database(f.file, { readonly: true }); connections.push(db);
  expect(db.pragma("user_version", { simple: true })).toBe(7);
  expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:original'").get()).toEqual({ value: f.state });
  expect(db.prepare("SELECT value FROM operations WHERE id='original'").get()).toEqual({ value: f.operation });
});

test("v7 admission rollback retains its original state and retries only the unchanged source", async () => {
  const f = await legacyFixture();
  expect(() => openControllerTestDatabase({ file: f.file, allowCreate: false, onMigration: () => {}, onReady: () => { throw new Error("admission failed"); } })).toThrow("admission failed");
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(observer.pragma("user_version", { simple: true })).toBe(7);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:original'").get()).toEqual({ value: f.state });
  expect(await readFile(f.filename, "utf8")).toBe(f.original);
  const db = openControllerTestDatabase({ file: f.file, allowCreate: false, onMigration: () => {} }); connections.push(db);
  expect(readContent(f.file, f.sessionId, db).timeline.get(f.entry.entryId)).toEqual(f.entry);
  expect(await readdir(path.join(`${f.file}.pending-content`, "entries"))).toHaveLength(2);
});
