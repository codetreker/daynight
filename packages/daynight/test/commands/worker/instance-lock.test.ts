import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-lock-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "lock 用户 "));
  directories.push(directory);
  return resolveWorkerPaths(directory);
};

describe("worker instance ownership", () => {
  it("creates one runtime SQLite before schema initialization and refuses a second live worker", async () => {
    const paths = await fixture();
    const lock = await acquireWorkerInstanceLock(paths);
    try {
      expect(lock.previousProcessesExcluded).toBe(true);
      expect(await readdir(paths.workerDirectory)).toEqual(["instance.lock", "state.sqlite"]);
      const database = new Database(paths.databaseFile);
      try { expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]); }
      finally { database.close(); }
      await expect(acquireWorkerInstanceLock(paths)).rejects.toMatchObject({ cause: { message: expect.stringContaining("still running") } });
    } finally { await lock.release(); }
    expect(await readdir(paths.workerDirectory)).toEqual(["state.sqlite"]);
  });

  it("uses the existing state database without adding lock tables or another database", async () => {
    const paths = await fixture();
    await mkdir(paths.workerDirectory, { recursive: true });
    const database = new Database(paths.databaseFile);
    database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('retained')");
    database.close();
    const lock = await acquireWorkerInstanceLock(paths);
    await lock.release();
    const reopened = new Database(paths.databaseFile);
    try {
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "marker" }]);
      expect(reopened.prepare("SELECT value FROM marker").get()).toEqual({ value: "retained" });
    } finally { reopened.close(); }
    expect(await readdir(paths.workerDirectory)).toEqual(["state.sqlite"]);
  });

  it("takes over a dead worker with a fresh owner without proving its managed processes stopped", async () => {
    const paths = await fixture();
    await mkdir(paths.workerDirectory, { recursive: true });
    await writeFile(paths.lockFile, JSON.stringify({ owner: "previous", pid: 2_147_483_647, startedAt: "2000-01-01T00:00:00.000Z" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("No process"), { code: "ESRCH" }); });
    const lock = await acquireWorkerInstanceLock(paths);
    expect(lock.previousProcessesExcluded).toBe(false);
    expect(lock.owner).not.toBe("previous");
    expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toMatchObject({ owner: lock.owner, pid: process.pid });
    await lock.release();
  });

  it("retains malformed lock evidence with process-neutral recovery guidance", async () => {
    const paths = await fixture();
    await mkdir(paths.workerDirectory, { recursive: true });
    await writeFile(paths.lockFile, "malformed");
    await expect(acquireWorkerInstanceLock(paths)).rejects.toThrow("all managed processes");
    expect(await readFile(paths.lockFile, "utf8")).toBe("malformed");
  });
});
