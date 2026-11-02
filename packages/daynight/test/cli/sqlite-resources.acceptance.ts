import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createInstalledCli } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const packageDirectory = path.join(workspace, "packages/daynight");
const sqlDirectories = [
  "commands/review/sqlite", "commands/worker/sqlite", "commands/worker/backends/sqlite",
  "commands/controller/sqlite/journal", "commands/controller/sqlite/resume-lease",
];
let fixture: Awaited<ReturnType<typeof createInstalledCli>>;
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
  fixture = await createInstalledCli();
  installed = path.dirname(path.dirname(fixture.receipt.entryPath));
}, 180_000);
afterAll(async () => { if (fixture !== undefined) await fixture.cleanup(); });

it("ships exact SQL resources and executes every store's explicit installed migration sequence", () => {
  let count = 0;
  for (const directory of sqlDirectories) {
    const source = files(path.join(packageDirectory, "src", directory));
    expect(Object.keys(source).every(name => name.endsWith(".sql"))).toBe(true);
    count += Object.keys(source).length;
    expect(files(path.join(installed, "dist", directory))).toEqual(source);
  }
  expect(count).toBe(12);
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
  ["commands/worker/store-format.js", "workerStoreFormat", 5, ["projects", "tasks"]],
  ["commands/worker/backends/web-store-format.js", "webExecutionStoreFormat", 1, ["executions"]],
  ["commands/controller/journal-format.js", "controllerJournalFormat", 5, ["execution", "operations", "outbox", "projection", "resources"]],
  ["commands/controller/resume-lease-format.js", "nativeResumeLeaseFormat", 1, ["leases"]],
];
const versions = [];
for (const [module, name, version, tables] of owners) {
  const format = (await load(module))[name];
  const db = openSqliteDatabase({ file: path.join(directory, name + ".sqlite"), format, allowEmpty: true, onMigration: () => {} });
  try {
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name), tables);
    versions.push(version);
  } finally { db.close(); }
}
console.log(JSON.stringify(versions));
`, [installed, databases], cwd);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([2, 5, 1, 5, 1]);
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
  const resource = path.join(installed, "dist/commands/review/sqlite/upgrade-2.sql");
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
    expect(result.stderr).toContain("upgrade-2.sql");
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
