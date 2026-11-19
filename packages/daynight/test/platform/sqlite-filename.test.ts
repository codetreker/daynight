import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sqliteDisplayFilename, sqliteFilename } from "../../src/platform/sqlite-filename.js";
import { acquireInstanceLockSync } from "../../src/platform/instance-lock.js";

test("deep SQLite roots retain their identity across lock ownership, WAL commits and read-only reopen", () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/sqlite-filename");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "h-"));
  const directory = path.join(root, "a".repeat(160), "b".repeat(160));
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "store.sqlite");
  expect(file.length).toBeGreaterThan(300);
  try {
    const lock = acquireInstanceLockSync(path.join(directory, "instance.lock"), path.join(directory, "ownership.sqlite"));
    try {
      const writer = new Database(sqliteFilename(file));
      try {
        writer.pragma("journal_mode = WAL");
        writer.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('durable');");
        expect(sqliteDisplayFilename(writer.name)).toBe(file);
      } finally { writer.close(); }
      const reader = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true });
      try { expect(reader.prepare("SELECT value FROM retained").pluck().get()).toBe("durable"); }
      finally { reader.close(); }
    } finally { lock.release(); }
  } finally { rmSync(root, { recursive: true }); }
});

test("anonymous databases and relative filenames keep their SQLite meaning", () => {
  for (const file of [":memory:", "", "relative.sqlite"]) expect(sqliteFilename(file)).toBe(file);
  if (process.platform === "win32") {
    expect(sqliteDisplayFilename(sqliteFilename("C:\\data\\store.sqlite"))).toBe("C:\\data\\store.sqlite");
    expect(sqliteDisplayFilename(sqliteFilename("\\\\host\\share\\store.sqlite"))).toBe("\\\\host\\share\\store.sqlite");
  }
});
