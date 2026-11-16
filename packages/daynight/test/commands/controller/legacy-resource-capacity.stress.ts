import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import { migratePendingContent } from "../../../src/commands/controller/pending-content.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";

test("v6 exports an extended resource above current limits and reopens its complete bytes", () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "legacy-resource-capacity-")), file = path.join(root, "journal.sqlite"), db = new Database(file);
  chmodSync(file, 0o600);
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true });
  try {
    const steps = loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url));
    for (const step of steps.filter(step => step.version <= 5)) db.exec(step.sql);
    db.pragma("user_version=5");
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0x5a), sessionId = randomUUID();
    const resource = { resourceId: randomUUID(), status: "available" as const, name: "x".repeat(1025), mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null, revision: "1", width: 16385, height: 2049, frameCount: 257 };
    db.prepare("INSERT INTO resources VALUES(?,?,?)").run(resource.resourceId, JSON.stringify(resource), bytes);
    db.transaction(() => migratePendingContent(db, sessionId, steps.find(step => step.version === 6)!.sql, permit)).immediate();
    const files = openResourceFiles(file, sessionId), lease = files.acquireResource(resource.resourceId);
    try {
      expect(lease.resource).toEqual(resource);
      const hash = createHash("sha256");
      for (let offset = 0; offset < bytes.length;) { const block = lease.read(String(offset), 524288); expect(block.length).toBeGreaterThan(0); hash.update(block); offset += block.length; }
      expect(hash.digest("hex")).toBe(resource.sha256);
    } finally { lease.close(); }
    expect(() => files.writeResource({ ...resource, resourceId: randomUUID(), name: "original.png", width: 1, height: 1, frameCount: 1 }, bytes)).toThrow();
  } finally {
    try { db.close(); }
    finally { try { permit.release(); } finally { rmSync(root, { recursive: true, force: true }); } }
  }
});
