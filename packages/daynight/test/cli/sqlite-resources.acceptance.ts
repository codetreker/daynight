import { currentSqliteVersion } from "../../src/platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots } from "../../src/platform/sqlite-sql.js";
import { workerStoreFormat } from "../../src/commands/worker/store-format.js";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
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

it("ships exact SQL resources and initializes each installed store", () => {
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
const { openSqliteDatabase } = await load("platform/sqlite-access.js");
const { acquireControllerStoragePermit, controllerStorageConnectionIsOpen } = await load("commands/controller/storage-lock.js");
const { controllerJournalWriteOptions } = await load("commands/controller/storage-preparation.js");
const owners = [
  ["commands/review/store-format.js", "reviewFormat", 2, ["pull_requests", "repositories", "review_publications", "reviews"]],
  ["commands/worker/store-format.js", "workerStoreFormat", worker.version, worker.tables],
  ["commands/worker/backends/web-store-format.js", "webExecutionStoreFormat", 4, ["executions", "orchestration_blockers"]],
  ["commands/controller/journal-format.js", "controllerJournalFormat", 9, ["content_index", "execution", "image_captures", "image_chunks", "image_occurrences", "image_pins", "image_preparations", "image_runtime_state", "input_intents", "input_message_origins", "input_observations", "native_input_publication_images", "native_input_publications", "operations", "outbox"]],
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
console.log(JSON.stringify(versions));
`, [installed, databases, JSON.stringify({ version: workerVersion, tables: workerTables })], cwd);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([2, workerVersion, 4, 9, 1]);
});
