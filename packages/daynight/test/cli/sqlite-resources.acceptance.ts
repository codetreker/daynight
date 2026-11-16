import { currentSqliteVersion } from "../../src/platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots } from "../../src/platform/sqlite-sql.js";
import { workerStoreFormat } from "../../src/commands/worker/store-format.js";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";


const workspace = path.resolve(import.meta.dirname, "../../../..");
const packageDirectory = path.join(workspace, "packages/daynight");
const sqlDirectories = [
  "commands/review/sqlite", "commands/worker/sqlite", "commands/worker/backends/sqlite",
  "commands/controller/sqlite/journal", "commands/controller/sqlite/resume-lease",
];
let fixture: Awaited<ReturnType<typeof createAcceptanceCli>>;
let installed: string;
const files = (directory: string): Record<string, Buffer> => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(directory, file).replaceAll("\\", "/"), readFileSync(file)];
  }));
const run = (program: string, args: readonly string[], cwd: string) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program, ...args], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error !== undefined) throw result.error;
  return result;
};

beforeAll(async () => {
  fixture = await createAcceptanceCli();
  installed = path.dirname(path.dirname(fixture.receipt.entryPath));
}, 180_000);
afterAll(async () => { if (fixture !== undefined) await fixture.cleanup(); });

it("ships exact SQL resources and executes installed stores and canonical timeline content", () => {
  const expectedResources = sqlDirectories.map(directory => ({ directory, source: files(path.join(packageDirectory, "src", directory)) }));
  const expectedCount = expectedResources.reduce((sum, { source }) => sum + Object.keys(source).length, 0);
  let count = 0;
  for (const { directory, source } of expectedResources) {
    expect(Object.keys(source).every(name => name.endsWith(".sql"))).toBe(true);
    const installedResources = files(path.join(installed, "dist", directory));
    count += Object.keys(installedResources).length;
    expect(installedResources).toEqual(source);
  }
  expect(count).toBe(expectedCount);
  expect(expectedResources.find(({ directory }) => directory === "commands/controller/sqlite/journal")!.source).toHaveProperty("011-outbox-accounting.sql");
  expect(expectedResources.find(({ directory }) => directory === "commands/controller/sqlite/journal")!.source).toHaveProperty("012-direct-capture.sql");
  expect(existsSync(path.join(installed, "dist/commands/controller/content/timeline-schema.sql"))).toBe(false);
  const workerVersion = currentSqliteVersion(workerStoreFormat);
  const workerTables = sqliteSchemaSnapshots(loadSqliteSequence(new URL("../../src/commands/worker/sqlite/", import.meta.url)))
    .get(workerVersion)!.filter(object => object.type === "table").map(({ name }) => name);
  const cwd = path.join(fixture.receipt.root, "different caller 中文");
  const databases = path.join(fixture.receipt.root, "databases");
  mkdirSync(cwd); mkdirSync(databases);
  const result = run(String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [installed, directory, workerExpectation] = process.argv.slice(1);
const worker = JSON.parse(workerExpectation);
const load = relative => import(pathToFileURL(path.join(installed, "dist", relative)).href);
const { openSqliteDatabase, runSqliteImmediate } = await load("platform/sqlite-access.js");
const { currentSqliteVersion, inspectSqlite } = await load("platform/sqlite-format.js");
const { acquireControllerStoragePermit, controllerStorageConnectionIsOpen } = await load("commands/controller/storage-lock.js");
const { controllerJournalWriteOptions } = await load("commands/controller/storage-preparation.js");
const owners = [
  ["commands/review/store-format.js", "reviewFormat", 2, ["pull_requests", "repositories", "review_publications", "reviews"]],
  ["commands/worker/store-format.js", "workerStoreFormat", worker.version, worker.tables],
  ["commands/worker/backends/web-store-format.js", "webExecutionStoreFormat", 4, ["executions", "orchestration_blockers"]],
  ["commands/controller/journal-format.js", "controllerJournalFormat", 12, ["execution", "image_captures", "image_chunks", "image_occurrences", "image_pins", "image_preparations", "image_runtime_state", "input_intents", "input_message_origins", "input_observations", "native_input_publication_images", "native_input_publications", "operations", "outbox", "outbox_totals", "timeline_entries", "timeline_totals"]],
  ["commands/controller/resume-lease-format.js", "nativeResumeLeaseFormat", 1, ["leases"]],
];
const versions = [];
for (const [module, name, version, tables] of owners) {
  const format = (await load(module))[name];
  const file = path.join(directory, name + ".sqlite");
  const permit = name === "controllerJournalFormat" ? acquireControllerStoragePermit(file) : undefined;
  let db;
  try { db = openSqliteDatabase({ ...(permit === undefined ? { file, format } : controllerJournalWriteOptions(file, permit, directory)), allowCreate: true, onMigration: () => {} }); }
  catch (error) { if (permit !== undefined && !controllerStorageConnectionIsOpen(error)) permit.release(); throw error; }
  try {
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name), tables);
    versions.push(version);
  } finally { db.close(); if (permit !== undefined) permit.release(); }
}
const { controllerJournalFormat, controllerJournalFormatForMigration } = await load("commands/controller/journal-format.js");
const { createTimelineMaintenanceReservation } = await load("commands/controller/content/maintenance.js");
const { openTimelineStore } = await load("commands/controller/content/timeline-store.js");
assert.equal(currentSqliteVersion(controllerJournalFormat), 12);
const timelineFile = path.join(directory, "canonical-timeline.sqlite"), timelinePermit = acquireControllerStoragePermit(timelineFile);
let reservation, timelineDb;
const timelineFormat = controllerJournalFormatForMigration(db => reservation ??= createTimelineMaintenanceReservation(db, { journalFile: timelineFile, stateDirectory: directory, storagePermit: timelinePermit }));
const entry = { entryId: "00000000-0000-4000-8000-000000000001", entrySeq: "9007199254740993", revision: "9007199254740995", kind: "assistant_message", content: [{ type: "text", text: "Installed 正文 😀" }] };
const replacement = { ...entry, revision: "9007199254740996", content: [{ type: "text", text: "Reopened 当前正文 🧩" }] };
try {
  timelineDb = openSqliteDatabase({ file: timelineFile, format: timelineFormat, allowCreate: false, onMigration: () => {} });
  let writing = false;
  const timeline = openTimelineStore(timelineDb, { assertWrite: bytes => { assert.equal(writing, true); reservation.assertReservedWrite(bytes); } });
  assert.throws(() => timeline.save(entry), /original journal write transaction/);
  runSqliteImmediate(timelineDb, () => { writing = true; try { timeline.save(entry); timeline.save(replacement); } finally { writing = false; } });
  assert.deepEqual(timeline.get(entry.entryId), replacement);
  assert.deepEqual(timeline.totals(), { entryCount: 1, byteLength: Buffer.byteLength(JSON.stringify(replacement)), timelineBytes: Buffer.byteLength('{"entries":[]}') + Buffer.byteLength(JSON.stringify(replacement)) });
  assert.equal(timeline.nextSequence(), "9007199254740994");
  assert.deepEqual(timelineDb.prepare("SELECT COUNT(*) AS count,typeof(entry_seq) AS seq,typeof(revision) AS rev FROM timeline_entries").get(), { count: 1, seq: "integer", rev: "integer" });
  assert.equal(timelineDb.prepare("SELECT name FROM sqlite_schema WHERE name='content_index'").get(), undefined);
  assert.deepEqual(inspectSqlite(timelineDb, controllerJournalFormat), { kind: "current", version: 12 });
  assert.deepEqual(timelineDb.prepare("SELECT id,byte_length FROM outbox_totals").get(), { id: 1, byte_length: 0 });
  timelineDb.close();
  timelineDb = openSqliteDatabase({ file: timelineFile, format: controllerJournalFormat, allowCreate: false, onMigration: () => {} });
  const reopened = openTimelineStore(timelineDb, { assertWrite: () => { throw new Error("Installed readback is read-only."); } });
  assert.deepEqual(reopened.get(entry.entryId), replacement);
  assert.equal(timelineDb.pragma("user_version", { simple: true }), 12);
  versions.push(12);
} finally { if (timelineDb !== undefined && timelineDb.open) timelineDb.close(); timelinePermit.release(); }
console.log(JSON.stringify(versions));
`, [installed, databases, JSON.stringify({ version: workerVersion, tables: workerTables })], cwd);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([2, workerVersion, 4, 12, 1, 12]);
});
