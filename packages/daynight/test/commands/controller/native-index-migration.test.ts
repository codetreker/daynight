import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { upgradeControllerJournal } from "../../../src/commands/controller/storage-preparation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.each([
  ["object", '{ "id": "original", "owner": { "pid": 1 }, "maximumBytes": 123, "other": true }', { id: "original", owner: { pid: 1 }, other: true }],
  ["malformed", '{bad', '{bad'],
  ["array", '[1,2]', '[1,2]'],
  ["scalar", 'null', 'null'],
  ["unmapped object", '{ "id": "original" }', '{ "id": "original" }'],
  ["absent", null, null],
])("v12 upgrade preserves %s lease evidence and removes only its byte field", (_name, original, expected) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/native-index-migration");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file);
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 12)) db.exec(step.sql);
    if (original !== null) db.prepare("INSERT INTO image_runtime_state VALUES('native_index_reservation',?)").run(original);
    db.prepare("INSERT INTO image_runtime_state VALUES('other',?)").run(JSON.stringify({ maximumBytes: 7, id: randomUUID() }));
    db.pragma("user_version=12");
  } finally { db.close(); }
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true });
  try { upgradeControllerJournal(file, permit, { onMigration: () => {} }); }
  finally { permit.release(); }
  for (let i = 0; i < 2; i++) {
    const reopened = new Database(file, { readonly: true });
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(13);
      const row = reopened.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get() as { value: string } | undefined;
      if (expected === null) expect(row).toBeUndefined();
      else if (typeof expected === "string") expect(row?.value).toBe(expected);
      else expect(JSON.parse(row!.value)).toEqual(expected);
      expect(JSON.parse((reopened.prepare("SELECT value FROM image_runtime_state WHERE key='other'").get() as { value: string }).value)).toMatchObject({ maximumBytes: 7 });
    } finally { reopened.close(); }
  }
});
