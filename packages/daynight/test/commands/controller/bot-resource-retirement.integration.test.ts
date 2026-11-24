import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { queueBotResourceRetirement, retireBotResources } from "../../../src/commands/controller/content/bot-resource-retirement.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { closeControllerTestDatabase, openControllerTestDatabase } from "../../helpers/controller-sqlite.js";

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) closeControllerTestDatabase(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "bot-resource-retirement-"));
  roots.push(root);
  const journal = path.join(root, "journal.sqlite"), sessionId = randomUUID();
  const open = () => {
    const db = openControllerTestDatabase({ file: journal, allowCreate: true, onMigration: () => {} });
    connections.push(db);
    const write = <T>(action: () => T): T => db.transaction(action).immediate();
    const content = openSessionContent(journal, sessionId, db, {
      read: action => db.transaction(action).deferred(),
      assertWrite: () => { if (!db.inTransaction) throw new Error("Expected the fixture journal transaction."); },
    });
    return {
      db, write, content,
      close: () => closeControllerTestDatabase(db),
      queued: () => (db.prepare("SELECT resource_id FROM bot_resource_retirement ORDER BY resource_id").all() as { resource_id: string }[]).map(row => row.resource_id),
      retire: (verifiedReferences?: ReadonlySet<string>) => retireBotResources(db, content, write, verifiedReferences),
    };
  };
  const { db, write, content, close, queued, retire } = open();
  const bytes = Buffer.from("saved display attachment");
  const resourceId = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
  content.resourceFiles.writeResource({ resourceId, sha256, status: "available", name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), error: null }, bytes);
  const lease = content.resourceFiles.acquireResource(resourceId);
  const blob = lease.path;
  lease.close();
  return { db, write, content, close, queued, retire, open, bytes, blob, resourceId };
};

test("retires an evicted resource only after commit and the last timeline reference and read lease end", () => {
  const f = fixture(), entryId = randomUUID();
  f.write(() => f.content.timeline.save({ entryId, kind: "assistant_message", entrySeq: "1", revision: "1", content: [{ type: "resource", resourceId: f.resourceId, label: "original" }] }));
  const remove = () => {
    f.content.timeline.save({ entryId, kind: "assistant_message", entrySeq: "1", revision: "2", content: [{ type: "text", text: "image removed" }] });
    queueBotResourceRetirement(f.db, [f.resourceId]);
  };
  expect(() => f.write(() => { remove(); f.retire(); })).toThrow("committed window transaction");
  expect(f.queued()).toEqual([]);
  expect(f.content.timeline.get(entryId)?.revision).toBe("1");
  expect(existsSync(f.blob)).toBe(true);

  f.write(() => queueBotResourceRetirement(f.db, [f.resourceId]));
  f.retire();
  expect(f.queued()).toEqual([f.resourceId]);
  expect(existsSync(f.blob)).toBe(true);
  const lease = f.content.resourceFiles.acquireResource(f.resourceId);
  try {
    f.write(remove);
    f.retire();
    expect(f.queued()).toEqual([f.resourceId]);
    expect(lease.read("0", 40)).toEqual(f.bytes);
  } finally { lease.close(); }
  f.close();

  const reopened = f.open();
  reopened.retire(new Set([f.resourceId]));
  expect(reopened.queued()).toEqual([f.resourceId]);
  expect(existsSync(f.blob)).toBe(true);
  reopened.retire();
  expect(reopened.queued()).toEqual([]);
  expect(reopened.content.resourceFiles.resources.has(f.resourceId)).toBe(false);
  expect(existsSync(f.blob)).toBe(false);
});

test("retains pending capture, input pins and native publication evidence after display references are gone", () => {
  const f = fixture(), capture = `capture:${randomUUID()}`, operationId = randomUUID(), pinId = randomUUID();
  f.write(() => {
    queueBotResourceRetirement(f.db, [f.resourceId]);
    f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(capture, JSON.stringify({ request: { locator: { kind: "resource", resourceId: f.resourceId } }, receipt: null }));
  });
  f.retire();
  expect(existsSync(f.blob)).toBe(true);
  f.write(() => {
    f.db.prepare("UPDATE image_runtime_state SET value=json_set(value, '$.receipt', json_object('state', 'failed')) WHERE key=?").run(capture);
    f.db.prepare("INSERT INTO image_pins VALUES(?,?,?,?,?,?,0)").run(pinId, operationId, f.resourceId, null, "operation", f.blob);
  });
  f.retire();
  expect(existsSync(f.blob)).toBe(true);
  f.write(() => {
    f.db.prepare("UPDATE image_pins SET released=1 WHERE pin_id=?").run(pinId);
    f.db.prepare("INSERT INTO native_input_publication_images VALUES(?,?,?,?)").run(operationId, randomUUID(), f.resourceId, 0);
  });
  f.retire();
  expect(f.queued()).toEqual([f.resourceId]);
  expect(existsSync(f.blob)).toBe(true);
});

test("settles committed filesystem retirement after a failed candidate acknowledgement and reopen", () => {
  const f = fixture();
  f.write(() => {
    queueBotResourceRetirement(f.db, [f.resourceId]);
    f.db.exec("CREATE TEMP TRIGGER defer_retirement BEFORE DELETE ON bot_resource_retirement BEGIN SELECT RAISE(ABORT, 'controlled acknowledgement failure'); END");
  });
  expect(() => f.retire()).toThrow("could not finish");
  expect(f.queued()).toEqual([f.resourceId]);
  expect(existsSync(f.blob)).toBe(false);
  f.close();

  const reopened = f.open();
  reopened.retire();
  expect(reopened.queued()).toEqual([]);
  expect(reopened.content.resourceFiles.resources.has(f.resourceId)).toBe(false);
});
