import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { persistCodexInitialSettings } from "../../../src/commands/controller/providers/codex-initial-settings.js";
let home: string, path: string, abort: AbortController;
const metadata = (id = "thread", cwd = process.cwd()) => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
const event = (id = "thread", model = "chosen", effort = "high") => JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id, thread_settings: { model, collaboration_mode: { settings: { reasoning_effort: effort } } } } }) + "\n";
beforeEach(async () => { const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true }); home = await mkdtemp(join(base, "codex-rollout-")); await mkdir(join(home, "sessions")); path = join(home, "sessions", "native.jsonl"); await writeFile(path, metadata());
  const db = new Database(join(home, "state_5.sqlite")); db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT)"); db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("thread", path, process.cwd(), "chosen", "high"); db.close(); abort = new AbortController(); });
afterEach(async () => { abort.abort(); await rm(home, { recursive: true, force: true }); });
const observe = (update: () => Promise<unknown>, overrides: Partial<Parameters<typeof persistCodexInitialSettings>[0]> = {}) => persistCodexInitialSettings({ path, home, cwd: process.cwd(), threadId: "thread", expected: { model: "chosen", effort: "high" }, signal: abort.signal, timeoutMs: 200, env: {}, readConfiguration: async () => ({ config: { config: {} }, requirements: { requirements: null } }), update, ...overrides });

test.each([
  { model: "chosen", effort: "high" }, { model: "chosen" }, { effort: "high" },
])("only explicit fields constrain native persistence: %j", async expected => {
  const update = vi.fn(async () => { await appendFile(path, event("thread", expected.model ?? "native-default", expected.effort ?? "medium")); return {}; });
  await observe(update, { expected }); expect(update).toHaveBeenCalledOnce();
});

test.each(["old", "wrong-owner", "wrong-model", "wrong-effort", "partial", "old-partial"])("%s records cannot confirm the new update", async mode => {
  if (mode === "old") await appendFile(path, event());
  if (mode === "old-partial") await appendFile(path, event().slice(0, -1));
  const update = vi.fn(async () => {
    if (mode === "wrong-owner") await appendFile(path, event("another"));
    if (mode === "wrong-model") await appendFile(path, event("thread", "wrong"));
    if (mode === "wrong-effort") await appendFile(path, event("thread", "chosen", "low"));
    if (mode === "partial") await appendFile(path, event().slice(0, -1));
    if (mode === "old-partial") await appendFile(path, "\n");
    return {};
  });
  await expect(observe(update, { timeoutMs: 45 })).rejects.toMatchObject({ name: "NativeRpcTimeoutError" }); expect(update).toHaveBeenCalledOnce();
});

test("a later complete matching event can resolve wrong or partial preceding observations", async () => {
  let release!: () => void; const dispatched = new Promise<void>(resolve => { release = resolve; });
  const update = vi.fn(async () => { await appendFile(path, event("another") + event().slice(0, -1)); release(); return {}; });
  let ready = false; const pending = observe(update).then(() => { ready = true; });
  await dispatched; expect(ready).toBe(false); await appendFile(path, "\n"); await pending; expect(ready).toBe(true);
});

test.each(["owner", "cwd", "outside", "symlink", "missing-path", "oversized"])("invalid initial rollout %s fails before dispatch", async mode => {
  if (mode === "owner") await writeFile(path, metadata("another"));
  if (mode === "cwd") await writeFile(path, metadata("thread", home));
  if (mode === "outside") { path = join(home, "outside.jsonl"); await writeFile(path, metadata()); }
  if (mode === "symlink") { const target = join(home, "outside.jsonl"); await writeFile(target, metadata()); await rm(path); await symlink(target, path); }
  if (mode === "oversized") await truncate(path, 16 * 1024 * 1024 + 1);
  const update = vi.fn(async () => ({}));
  await expect(observe(update, mode === "missing-path" ? { path: null } : {})).rejects.toBeInstanceOf(Error); expect(update).not.toHaveBeenCalled();
});

test("non-file rollout paths are rejected before open can block on a special file", async () => {
  await rm(path); await mkdir(path);
  const mock = vi.spyOn(fs.promises, "open"); syncBuiltinESMExports();
  try { await expect(observe(async () => ({}))).rejects.toBeInstanceOf(Error); expect(mock).not.toHaveBeenCalled(); }
  finally { mock.mockRestore(); syncBuiltinESMExports(); }
});

test.skipIf(process.platform === "win32")("a FIFO rollout is rejected without opening or waiting for a writer", async () => {
  await rm(path); execFileSync("mkfifo", [path], { timeout: 1000 });
  const mock = vi.spyOn(fs.promises, "open").mockRejectedValue(new Error("Unexpected FIFO open")); syncBuiltinESMExports();
  try { await expect(observe(async () => ({}))).rejects.toBeInstanceOf(Error); expect(mock).not.toHaveBeenCalled(); }
  finally { mock.mockRestore(); syncBuiltinESMExports(); }
});

test.each(["replace", "truncate", "remove", "corrupt", "primitive", "abort", "receipt", "reject"])("%s after dispatch fails closed without replaying the update", async mode => {
  const update = vi.fn(async () => {
    if (mode === "replace") { await rename(path, path + ".old"); await writeFile(path, metadata() + event()); }
    if (mode === "truncate") await truncate(path, 0);
    if (mode === "remove") await rm(path);
    if (mode === "corrupt") await appendFile(path, "not-json\n");
    if (mode === "primitive") await appendFile(path, "null\n");
    if (mode === "abort") { await appendFile(path, event()); abort.abort(new Error("Native child closed")); }
    if (mode === "reject") throw new Error("Native settings rejected");
    return mode === "receipt" ? null : {};
  });
  await expect(observe(update)).rejects.toBeInstanceOf(Error); expect(update).toHaveBeenCalledOnce();
});

test("disconnect interrupts a pending persistence observation", async () => {
  let release!: () => void; const dispatched = new Promise<void>(resolve => { release = resolve; });
  const update = vi.fn(async () => { release(); return {}; });
  const pending = observe(update, { timeoutMs: 30_000 }); const failure = expect(pending).rejects.toBeInstanceOf(Error);
  await dispatched; abort.abort(new Error("Native child closed")); await failure; expect(update).toHaveBeenCalledOnce();
});

test.each(["append-during-verification", "abort-during-close"])("%s cannot race the final persistence confirmation", async mode => {
  const originalOpen = fs.promises.open;
  let dispatched = false, readAfterDispatch = false, intercepted = false;
  const mock = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args), stat = file.stat.bind(file), read = file.read.bind(file), close = file.close.bind(file);
    file.read = (async (...args: unknown[]) => { const result = await Reflect.apply(read, file, args); if (dispatched) readAfterDispatch = true; return result; }) as typeof file.read;
    file.stat = (async () => { if (mode === "append-during-verification" && readAfterDispatch && !intercepted) { intercepted = true; await appendFile(path, event("thread", "wrong")); } return stat(); }) as typeof file.stat;
    file.close = async () => { if (mode === "abort-during-close") { intercepted = true; abort.abort(new Error("Native child closed during file release")); } await close(); };
    return file;
  });
  syncBuiltinESMExports();
  try {
    await expect(observe(async () => { dispatched = true; await appendFile(path, event()); return {}; }, { timeoutMs: 60 })).rejects.toBeInstanceOf(Error);
    expect(intercepted).toBe(true);
  } finally { mock.mockRestore(); syncBuiltinESMExports(); }
});


test("a new JSONL settings record cannot confirm stale SQLite metadata", async () => {
  const db = new Database(join(home, "state_5.sqlite"));
  db.prepare("UPDATE threads SET model = NULL, reasoning_effort = NULL").run();
  let dispatched!: () => void;
  const updated = new Promise<void>(resolve => { dispatched = resolve; });
  let ready = false;
  const pending = observe(async () => { await appendFile(path, event()); dispatched(); return {}; }, { timeoutMs: 1000 }).then(() => { ready = true; });
  try {
    await updated;
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(ready).toBe(false);
    db.prepare("UPDATE threads SET model = ?, reasoning_effort = ? WHERE id = ?").run("chosen", "high", "thread");
    await pending;
    expect(ready).toBe(true);
  } finally { db.close(); await pending.catch(() => {}); }
});

test.each(["missing-database", "missing-row", "wrong-model", "wrong-effort"])("%s never falls back to JSONL-only readiness", async mode => {
  if (mode === "missing-database") await rm(join(home, "state_5.sqlite"));
  else {
    const db = new Database(join(home, "state_5.sqlite"));
    if (mode === "missing-row") db.exec("DELETE FROM threads");
    if (mode === "wrong-model") db.exec("UPDATE threads SET model = 'wrong'");
    if (mode === "wrong-effort") db.exec("UPDATE threads SET reasoning_effort = 'low'");
    db.close();
  }
  await expect(observe(async () => { await appendFile(path, event()); return {}; }, { timeoutMs: 65 })).rejects.toMatchObject({ name: "NativeRpcTimeoutError" });
});
test.each(["configuration", "update"])("the total deadline bounds a stalled %s RPC", async mode => {
  const stalled = () => new Promise<never>(() => {});
  await expect(observe(mode === "update" ? stalled : async () => ({}), { timeoutMs: 40, ...(mode === "configuration" ? { readConfiguration: stalled } : {}) })).rejects.toMatchObject({ name: "NativeRpcTimeoutError" });
});
