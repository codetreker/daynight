import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { codexNativeHome, codexMetadataPath, observeCodexMetadata } from "../../../src/commands/controller/providers/codex-settings-metadata.js";
let home: string, database: string, rollout: string;
const config = (value: unknown = {}, requirements: unknown = null) => ({ config: { config: value }, requirements: { requirements } });
beforeEach(async () => { await mkdir(join(process.cwd(), ".tmp"), { recursive: true }); home = await mkdtemp(join(process.cwd(), ".tmp", "codex-metadata-")); database = join(home, "state_5.sqlite"); rollout = join(home, "rollout.jsonl"); await writeFile(rollout, ""); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const create = () => { const db = new Database(database); db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT)"); db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("own", rollout, home, "chosen", "high"); return db; };
const observe = (expected = { model: "chosen", effort: "high" }) => observeCodexMetadata(database, { threadId: "own", path: rollout, cwd: home }, expected);

test("metadata location follows managed, configured, environment, then native home priority", () => {
  const managed = join(home, "managed"), configured = join(home, "configured");
  expect(codexMetadataPath(config({ sqlite_home: configured }, { sqliteHome: pathToFileURL(managed).href }), { CODEX_SQLITE_HOME: "env" }, home, home)).toBe(join(managed, "state_5.sqlite"));
  expect(codexMetadataPath(config({ sqlite_home: configured }), { CODEX_SQLITE_HOME: "env" }, home, home)).toBe(join(configured, "state_5.sqlite"));
  expect(codexMetadataPath(config(), { CODEX_SQLITE_HOME: "  env  " }, home, home)).toBe(join(home, "env", "state_5.sqlite"));
  expect(codexMetadataPath(config(), { CODEX_SQLITE_HOME: " " }, home, home)).toBe(database);
});
test.each([config({ sqlite_home: "relative" }), config({ sqlite_home: 1 }), config({}, { sqliteHome: "relative" }), config({}, { sqliteHome: "https://example.com/db" }), { config: {}, requirements: {} }])("unknown native configuration cannot select a database: %j", value => {
  expect(() => codexMetadataPath(value, {}, home, home)).toThrow("unconfirmed");
});
test("missing databases are not created and unknown schemas are rejected", async () => {
  expect(await observe()()).toBe(false); await expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
  const db = new Database(database); db.exec("CREATE TABLE unrelated (id TEXT)"); db.close();
  await expect(observe()()).rejects.toThrow("unconfirmed");
});
test("a writer's uncommitted settings do not become evidence and snapshots refresh after commit", async () => {
  const writer = create(); writer.pragma("journal_mode = WAL"); writer.prepare("UPDATE threads SET model = NULL, reasoning_effort = NULL").run();
  const poll = observe(); writer.exec("BEGIN IMMEDIATE"); writer.prepare("UPDATE threads SET model = 'chosen', reasoning_effort = 'high'").run();
  try { expect(await poll()).toBe(false); writer.exec("COMMIT"); expect(await poll()).toBe(true); }
  finally { if (writer.inTransaction) writer.exec("ROLLBACK"); writer.close(); }
});
test("an exclusive lock yields immediately and can be observed again after release", async () => {
  const writer = create(); writer.exec("BEGIN EXCLUSIVE"); const poll = observe();
  try { const started = performance.now(); expect(await poll()).toBe(false); expect(performance.now() - started).toBeLessThan(200); writer.exec("ROLLBACK"); expect(await poll()).toBe(true); }
  finally { if (writer.inTransaction) writer.exec("ROLLBACK"); writer.close(); }
});
test.each(["path", "cwd", "replacement", "symlink", "corrupt"])("metadata %s cannot confirm another persistence owner", async mode => {
  const writer = create();
  if (mode === "path") writer.prepare("UPDATE threads SET rollout_path = ?").run(home);
  if (mode === "cwd") writer.prepare("UPDATE threads SET cwd = ?").run(process.cwd());
  writer.close(); const poll = observe();
  if (mode === "replacement") { expect(await poll()).toBe(true); await rename(database, database + ".old"); create().close(); }
  if (mode === "symlink") { await rename(database, database + ".old"); await symlink(database + ".old", database); }
  if (mode === "corrupt") await writeFile(database, "corrupt");
  await expect(poll()).rejects.toThrow();
});
test("only requested fields constrain the committed row", async () => {
  const writer = create(); writer.prepare("UPDATE threads SET model = 'native-default'").run(); writer.close();
  expect(await observeCodexMetadata(database, { threadId: "own", path: rollout, cwd: home }, { effort: "high" })()).toBe(true);
});


test("native home uses the child working directory and never fills absent child variables from the parent", () => {
  vi.stubEnv("CODEX_HOME", join(home, "parent-codex")); vi.stubEnv("HOME", join(home, "parent-home"));
  try {
    expect(codexNativeHome({ CODEX_HOME: "relative" }, home)).toBe(join(home, "relative"));
    expect(codexNativeHome({}, home)).toBe(join(userInfo().homedir, ".codex"));
    expect(codexNativeHome({ CODEX_HOME: "", HOME: home }, home)).toBe(join(process.platform === "win32" ? userInfo().homedir : home, ".codex"));
    expect(codexMetadataPath(config(), {}, home, home)).toBe(database);
  } finally { vi.unstubAllEnvs(); }
});
