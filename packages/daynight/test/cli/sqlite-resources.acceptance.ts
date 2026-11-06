import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";


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
  fixture = await createAcceptanceCli({ writablePackage: true });
  installed = path.dirname(path.dirname(fixture.receipt.entryPath));
}, 180_000);
afterAll(async () => { if (fixture !== undefined) await fixture.cleanup(); });

it("ships exact SQL resources and initializes and resets every installed store from its filename-ordered sequence", () => {
  let count = 0;
  for (const directory of sqlDirectories) {
    const source = files(path.join(packageDirectory, "src", directory));
    expect(Object.keys(source).every(name => name.endsWith(".sql"))).toBe(true);
    count += Object.keys(source).length;
    expect(files(path.join(installed, "dist", directory))).toEqual(source);
  }
  expect(count).toBe(20);
  const cwd = path.join(fixture.receipt.root, "different caller 中文");
  const databases = path.join(fixture.receipt.root, "databases");
  mkdirSync(cwd); mkdirSync(databases);
  const result = run(String.raw`
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [installed, directory] = process.argv.slice(1);
const load = relative => import(pathToFileURL(path.join(installed, "dist", relative)).href);
const { openSqliteDatabase } = await load("platform/sqlite-access.js");
const owners = [
  ["commands/review/store-format.js", "reviewFormat", 2, ["pull_requests", "repositories", "review_publications", "reviews"]],
  ["commands/worker/store-format.js", "workerStoreFormat", 12, ["bot_executions", "bots", "claim_native_configurations", "cleanup_schedules", "projects", "tasks"]],
  ["commands/worker/backends/web-store-format.js", "webExecutionStoreFormat", 3, ["executions", "orchestration_blockers"]],
  ["commands/controller/journal-format.js", "controllerJournalFormat", 6, ["content_index", "execution", "operations", "outbox"]],
  ["commands/controller/resume-lease-format.js", "nativeResumeLeaseFormat", 1, ["leases"]],
];
const versions = [];
for (const [module, name, version, tables] of owners) {
  const format = (await load(module))[name];
  const file = path.join(directory, name + ".sqlite");
  const db = openSqliteDatabase({ file, format, allowCreate: true, onMigration: () => {} });
  try {
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name), tables);
    db.exec("CREATE TABLE obsolete(value TEXT); INSERT INTO obsolete VALUES('discarded'); CREATE VIEW obsolete_view AS SELECT * FROM obsolete;");
    db.exec("CREATE TABLE search_content(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO search_content VALUES(1, 'discarded external content'); CREATE VIRTUAL TABLE search USING fts5(body, content='search_content', content_rowid='id'); INSERT INTO search(search) VALUES('rebuild');");
    db.pragma("user_version = 0");
    versions.push(version);
  } finally { db.close(); }
  const reset = openSqliteDatabase({ file, format, allowCreate: false, onMigration: () => {} });
  try {
    assert.equal(reset.pragma("user_version", { simple: true }), version);
    assert.deepEqual(reset.prepare("SELECT name FROM sqlite_schema WHERE name IN ('obsolete','obsolete_view')").all(), []);
    assert.deepEqual(reset.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name), tables);
    for (const table of tables) assert.equal(reset.prepare('SELECT count(*) AS count FROM "' + table + '"').get().count, 0);
  } finally { reset.close(); }
}
console.log(JSON.stringify(versions));
`, [installed, databases], cwd);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([2, 12, 3, 6, 1]);
});

it("rejects a missing installed SQL resource without repository fallback or retained-data changes", () => {
  const databaseFile = path.join(fixture.receipt.root, "retained-review.sqlite");
  const db = new Database(databaseFile);
  try {
    db.exec(readFileSync(new URL("../commands/review/fixtures/schema-v1.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO repositories(host, github_id, remote, local_path) VALUES(?,?,?,?)").run("github.com", "42", "https://github.com/owner/retained.git", path.join(fixture.receipt.root, "retained repository"));
  }
  finally { db.close(); }
  const original = readFileSync(databaseFile);
  const resource = path.join(installed, "dist/commands/review/sqlite");
  const unavailable = `${resource}.unavailable`;
  const program = String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
const [installed, databaseFile] = process.argv.slice(1);
const { openStore } = await import(pathToFileURL(path.join(installed, "dist/commands/review/store.js")).href);
const db = openStore(databaseFile);
db.close();
`;
  renameSync(resource, unavailable);
  try {
    // The repository SQL exists in this cwd; an installed package must not use it as fallback.
    const result = run(program, [installed, databaseFile], workspace);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain("scandir");
    expect(result.stderr).toContain("sqlite");
    expect(readFileSync(databaseFile)).toEqual(original);
  } finally { renameSync(unavailable, resource); }
  const restored = run(program, [installed, databaseFile], workspace);
  expect(restored.status, restored.stderr).toBe(0);
  const upgraded = new Database(databaseFile, { readonly: true });
  try {
    expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
    expect(upgraded.prepare("SELECT remote FROM repositories WHERE github_id='42'").get()).toEqual({ remote: "https://github.com/owner/retained.git" });
  }
  finally { upgraded.close(); }
});
it("discovers newly added installed migrations and executes them only in filename order", () => {
  const directory = path.join(installed, "dist/commands/worker/sqlite");
  const first = path.join(directory, "013-create-order-probe.sql");
  const second = path.join(directory, "014-record-order-probe.sql");
  expect(existsSync(first)).toBe(false); expect(existsSync(second)).toBe(false);
  const databaseFile = path.join(fixture.receipt.root, "filename-ordered-worker.sqlite");
  const original = new Database(databaseFile);
  try {
    original.exec(readFileSync(path.join(directory, "005-baseline.sql"), "utf8"));
    original.pragma("user_version = 5");
  } finally { original.close(); }
  try {
    writeFileSync(second, "INSERT INTO filename_order_probe(value) VALUES('sorted');\n");
    writeFileSync(first, "CREATE TABLE filename_order_probe(value TEXT NOT NULL);\n");
    const result = run(String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
const [installed, databaseFile] = process.argv.slice(1);
const { openWorkerStore } = await import(pathToFileURL(path.join(installed, "dist/commands/worker/store.js")).href);
const store = openWorkerStore(databaseFile);
store.close();
`, [installed, databaseFile], workspace);
    expect(result.status, result.stderr).toBe(0);
    const upgraded = new Database(databaseFile, { readonly: true });
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(14);
      expect(upgraded.prepare("SELECT value FROM filename_order_probe").all()).toEqual([{ value: "sorted" }]);
    } finally { upgraded.close(); }
  } finally { rmSync(first, { force: true }); rmSync(second, { force: true }); }
});

it("rejects an invalid installed SQL candidate without changing an existing database", () => {
  const directory = path.join(installed, "dist/commands/worker/sqlite");
  const invalid = path.join(directory, "006-upgrade.SQL");
  expect(existsSync(invalid)).toBe(false);
  const databaseFile = path.join(fixture.receipt.root, "invalid-filename-worker.sqlite");
  const db = new Database(databaseFile);
  try {
    db.exec(readFileSync(path.join(directory, "005-baseline.sql"), "utf8"));
    db.pragma("user_version = 5");
  } finally { db.close(); }
  const original = readFileSync(databaseFile);
  try {
    writeFileSync(invalid, "ALTER TABLE projects ADD COLUMN invalid_probe TEXT;\n");
    const result = run(String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
const [installed, databaseFile] = process.argv.slice(1);
const { openWorkerStore } = await import(pathToFileURL(path.join(installed, "dist/commands/worker/store.js")).href);
openWorkerStore(databaseFile).close();
`, [installed, databaseFile], workspace);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid SQLite SQL filename");
    expect(result.stderr).toContain("006-upgrade.SQL");
    expect(readFileSync(databaseFile)).toEqual(original);
  } finally { rmSync(invalid, { force: true }); }
});
