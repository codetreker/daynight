import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";
import { controllerMetadataBudget, CONTROLLER_METADATA_BYTES, CONTROLLER_SETTLEMENT_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
import { createLocalSessionContent } from "../../../src/commands/controller/local-content.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";
const faults = vi.hoisted(() => ({ syncAt: 0, calls: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => { if (faults.syncAt && ++faults.calls === faults.syncAt) throw new Error("candidate sync failed"); fs.fsyncSync(fd); } };
});

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(async () => {
  faults.syncAt = 0; faults.calls = 0;
  for (const db of connections.splice(0)) if (db.open) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/pending-publication-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), sessionId = randomUUID();
  const db = openSqliteDatabase({ file, format: controllerJournalFormat, allowCreate: true, onMigration: () => {} }); connections.push(db);
  const content = openPendingContent(file, sessionId, db);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "reasoning" as const, text: "original" };
  db.transaction(() => content.saveEntry(entry)).immediate();
  return { file, sessionId, db, content, entry };
};

test("a rolled-back entry candidate never replaces the committed snapshot", async () => {
  const f = await fixture();
  expect(() => f.db.transaction(() => {
    f.content.saveEntry({ ...f.entry, revision: "2", text: "uncommitted" });
    f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','new')").run();
    throw new Error("publication failed");
  }).immediate()).toThrow("publication failed");
  expect(f.content.entries.get(f.entry.entryId)).toEqual(f.entry);
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(openPendingContent(f.file, f.sessionId, observer).entries.get(f.entry.entryId)).toEqual(f.entry);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toBeUndefined();
});

test("a WAL reader retains one entry and metadata snapshot across another connection's commit", async () => {
  const f = await fixture();
  f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','old')").run();
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  const content = openPendingContent(f.file, f.sessionId, observer);
  const inspection = createLocalSessionContent(content, f.sessionId, { read: action => observer.transaction(action).deferred(), write: action => observer.transaction(action).immediate() });
  observer.exec("BEGIN DEFERRED");
  expect(content.getEntry(f.entry.entryId)).toEqual(f.entry);
  f.db.transaction(() => {
    f.content.saveEntry({ ...f.entry, revision: "2", text: "committed" });
    f.db.prepare("UPDATE image_runtime_state SET value='new' WHERE key='publication'").run();
  }).immediate();
  expect(inspection.readInspection({ historyEpoch: "epoch", cursor: null, limit: 10, responseOverhead: 0 }).items[0]?.body).toEqual(f.entry);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: "old" });
  observer.exec("COMMIT");
  expect(content.getEntry(f.entry.entryId)).toMatchObject({ revision: "2", text: "committed" });
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: "new" });
});

test("an outer rollback discards nested publications without consuming sequence numbers", async () => {
  const f = await fixture(), entryId = randomUUID();
  expect(() => f.db.transaction(() => {
    f.db.transaction(() => f.content.saveEntry({ ...f.entry, entryId, entrySeq: "2" })).immediate();
    throw new Error("outer rollback");
  }).immediate()).toThrow("outer rollback");
  expect(f.content.hasEntry(entryId)).toBe(false);
  expect(f.content.nextEntrySequence()).toBe("2");
  f.db.transaction(() => f.content.saveEntry({ ...f.entry, entryId, entrySeq: "10" })).immediate();
  expect(f.content.nextEntrySequence()).toBe("11");
});

test("orphan candidates consume real metadata capacity without entering the history", async () => {
  const f = await fixture(), budget = controllerMetadataBudget(f.file, f.db);
  const filename = path.join(`${f.file}.pending-content`, "entries", `${randomUUID()}.json`), file = await open(filename, "wx", 0o600);
  try { await file.truncate(CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES - budget.bytes()); } finally { await file.close(); }
  expect(() => f.db.transaction(() => f.content.saveEntry({ ...f.entry, revision: "2", text: "refused" })).immediate()).toThrow("metadata budget");
  expect(f.content.getEntry(f.entry.entryId)).toEqual(f.entry);
  expect(openPendingContent(f.file, f.sessionId, f.db).entries.size).toBe(1);
});

test.each(process.platform === "win32" ? [1] : [1, 2])("candidate durability failure at sync %s leaves the old pointer readable", async syncAt => {
  const f = await fixture(); faults.syncAt = syncAt; faults.calls = 0;
  expect(() => f.db.transaction(() => f.content.saveEntry({ ...f.entry, revision: "2", text: "not durable" })).immediate()).toThrow("candidate sync failed");
  faults.syncAt = 0;
  expect(f.content.getEntry(f.entry.entryId)).toEqual(f.entry);
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(openPendingContent(f.file, f.sessionId, observer).getEntry(f.entry.entryId)).toEqual(f.entry);
});

test.each(["missing", "bytes", "pointer"] as const)("a committed entry with invalid %s fails instead of selecting another candidate", async variant => {
  const f = await fixture();
  const pointer = f.db.prepare("SELECT content_file FROM content_index WHERE id=?").get(f.entry.entryId) as { content_file: string };
  const filename = path.join(`${f.file}.pending-content`, "entries", pointer.content_file);
  if (variant === "missing") await rm(filename);
  if (variant === "bytes") await writeFile(filename, "corrupt");
  if (variant === "pointer") f.db.prepare("UPDATE content_index SET revision='2' WHERE id=?").run(f.entry.entryId);
  expect(() => openPendingContent(f.file, f.sessionId, f.db)).toThrow(/incomplete|corrupt|differs/);
});

test.each(["before", "after"] as const)("process termination %s COMMIT exposes only the complete durable publication", async phase => {
  const f = await fixture(); f.db.prepare("INSERT INTO image_runtime_state VALUES('publication','old')").run();
  const child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("../../fixtures/pending-publication-child.mjs", import.meta.url)), f.file, f.sessionId, JSON.stringify({ ...f.entry, revision: "2", text: "committed" }), phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let diagnostics = ""; child.stderr!.on("data", value => { diagnostics = (diagnostics + String(value)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", message => message === phase ? resolve() : reject(new Error("Unexpected commit barrier.")));
      child.once("exit", code => reject(new Error(`Publication child exited ${code}: ${diagnostics}`)));
    });
    child.kill("SIGKILL"); await exited;
    const observer = new Database(f.file, { readonly: true }); connections.push(observer);
    const content = openPendingContent(f.file, f.sessionId, observer);
    expect(content.getEntry(f.entry.entryId)).toMatchObject({ revision: phase === "before" ? "1" : "2", text: phase === "before" ? "original" : "committed" });
    expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='publication'").get()).toEqual({ value: phase === "before" ? "old" : "new" });
    expect(await readdir(path.join(content.root, "entries"))).toHaveLength(2);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
}, 15000);

const legacyFixture = async () => {
  const f = await fixture(); f.db.close();
  const file = path.join(path.dirname(f.file), "legacy.sqlite"), db = new Database(file); connections.push(db);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 7)) db.exec(step.sql);
  db.pragma("user_version=7");
  const state = '{ "unknownAction": "commit", "captureId": "original", "phase": "query" }';
  const operation = '{ "state": "unknown", "operationId": "original" }';
  db.prepare("INSERT INTO execution(id,ticket_hash,snapshot) VALUES(1,'original',?)").run(JSON.stringify({ sessionId: f.sessionId }));
  db.prepare("INSERT INTO image_runtime_state VALUES('native_provider:original',?)").run(state);
  db.prepare("INSERT INTO operations(id,value) VALUES('original',?)").run(operation);
  db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(f.entry.entryId, controllerPayloadHash(f.entry), f.entry.revision, f.entry.entrySeq);
  const directory = `${file}.pending-content`;
  await mkdir(path.join(directory, "timeline"), { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId: f.sessionId }));
  const original = JSON.stringify(f.entry), filename = path.join(directory, "timeline", `${createHash("sha256").update(f.entry.entryId).digest("hex")}.json`);
  await writeFile(filename, original); db.close();
  return { ...f, file, filename, original, state, operation };
};

test("v7 migration preserves exact native unknown state and legacy source bytes", async () => {
  const f = await legacyFixture();
  const db = openSqliteDatabase({ file: f.file, format: controllerJournalFormat, allowCreate: false, onMigration: () => {} }); connections.push(db);
  expect(openPendingContent(f.file, f.sessionId, db).getEntry(f.entry.entryId)).toEqual(f.entry);
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
  expect(() => openSqliteDatabase({ file: f.file, format: controllerJournalFormat, allowCreate: false, onMigration: () => {} })).toThrow("migration-failed");
  const db = new Database(f.file, { readonly: true }); connections.push(db);
  expect(db.pragma("user_version", { simple: true })).toBe(7);
  expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:original'").get()).toEqual({ value: f.state });
  expect(db.prepare("SELECT value FROM operations WHERE id='original'").get()).toEqual({ value: f.operation });
});

test("v7 admission rollback retains its original state and retries only the unchanged source", async () => {
  const f = await legacyFixture();
  expect(() => openSqliteDatabase({ file: f.file, format: controllerJournalFormat, allowCreate: false, onMigration: () => {}, onReady: () => { throw new Error("admission failed"); } })).toThrow("admission failed");
  const observer = new Database(f.file, { readonly: true }); connections.push(observer);
  expect(observer.pragma("user_version", { simple: true })).toBe(7);
  expect(observer.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:original'").get()).toEqual({ value: f.state });
  expect(await readFile(f.filename, "utf8")).toBe(f.original);
  const db = openSqliteDatabase({ file: f.file, format: controllerJournalFormat, allowCreate: false, onMigration: () => {} }); connections.push(db);
  expect(openPendingContent(f.file, f.sessionId, db).getEntry(f.entry.entryId)).toEqual(f.entry);
  expect(await readdir(path.join(`${f.file}.pending-content`, "entries"))).toHaveLength(2);
});
