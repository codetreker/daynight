import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "win32")("reads committed WAL data after a writer is forcibly terminated", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/sqlite-wal-crash");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), file = path.join(home, "journal.sqlite");
  const script = `
    import Database from "better-sqlite3";
    const db = new Database(process.argv[1]);
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
    db.exec("CREATE TABLE evidence(value TEXT); PRAGMA user_version=9; INSERT INTO evidence VALUES ('committed'); BEGIN IMMEDIATE; INSERT INTO evidence VALUES ('uncommitted')");
    process.send("ready"); setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "", passed = false;
  child.stderr?.on("data", chunk => { if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length); });
  const exited = once(child, "exit"), join = () => Promise.race([exited, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("WAL writer did not exit.")), 10_000).unref())]);
  const sizes = async () => Object.fromEntries(await Promise.all([file, `${file}-wal`, `${file}-shm`].map(async name => [path.basename(name), await stat(name).then(value => value.size, () => null)])));
  try {
    const [ready] = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(15_000) }), exited.then(() => { throw new Error("WAL writer exited before committing its fixture."); })]);
    expect(ready).toBe("ready");
    const before = await sizes();
    expect(before["journal.sqlite-wal"]).toBeGreaterThan(0);
    child.kill("SIGKILL"); await join();
    const evidence = path.join(home, "before-recovery"); await mkdir(evidence);
    for (const name of [file, `${file}-wal`, `${file}-shm`]) {
      try { await copyFile(name, path.join(evidence, path.basename(name))); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    const read = (readonly: boolean) => {
      const db = new Database(file, { readonly, fileMustExist: true });
      try { return db.transaction(() => ({ version: db.pragma("user_version", { simple: true }), rows: db.prepare("SELECT value FROM evidence").all() })).deferred(); }
      finally { db.close(); }
    };
    let first: ReturnType<typeof read> | undefined, failure: unknown;
    try { first = read(true); } catch (error) { failure = error; }
    let writable: ReturnType<typeof read> | undefined, writableFailure: unknown;
    try { writable = read(false); } catch (error) { writableFailure = error; }
    if (failure || writableFailure) {
      const describe = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message, code: "code" in error ? error.code : undefined } : error;
      console.error(JSON.stringify({ kind: "windows-wal-crash-read", before, after: await sizes(), readonlyError: describe(failure), writableError: describe(writableFailure) }));
      throw new AggregateError([failure, writableFailure].filter(error => error !== undefined), "WAL crash recovery was not readable.");
    }
    expect(first).toEqual({ version: 9, rows: [{ value: "committed" }] });
    expect(writable).toEqual(first);
    passed = true;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await join(); }
    if (passed) await rm(home, { recursive: true, force: true });
    else console.error(JSON.stringify({ kind: "windows-wal-crash-evidence", home, files: await sizes(), stderr }));
  }
}, 40_000);
