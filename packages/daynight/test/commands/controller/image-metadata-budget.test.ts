import { openControllerTestDatabase, closeControllerTestDatabase } from "../../helpers/controller-sqlite.js";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, stat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { controllerMetadataBudget, CONTROLLER_SETTLEMENT_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("real SQLite pages, WAL and resource metadata share the normal and settlement metadata limits", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-metadata-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "m-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = openControllerTestDatabase({ file, allowCreate: true, onMigration: () => {} });
  try {
    db.pragma("journal_mode=WAL"); db.pragma("wal_autocheckpoint=0");
    db.exec("CREATE TABLE retained(value BLOB); INSERT INTO retained VALUES(zeroblob(1048576))");
    const content = openSessionContent(file, "session", db, { read: action => db.inTransaction ? action() : db.transaction(action).deferred(), assertWrite: additional => { if (!db.inTransaction) throw new Error("Publication requires the original write transaction."); controllerMetadataBudget(file, db).assert(additional); } });
    db.transaction(() => content.timeline.save({ entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "text", text: "Retained history" }] })).immediate();
    const budget = controllerMetadataBudget(file, db);
    const physical = (await Promise.all([file, `${file}-wal`, `${file}-shm`].map(filename => stat(filename)))).reduce((sum, item) => sum + item.size, 0);
    const pending = `${file}.pending-content`;
    const metadata = [...(await readdir(pending)).filter(name => name !== "blobs").map(name => path.join(pending, name))];
    let pendingBytes = 0;
    for (const entry of metadata) { const info = await stat(entry); pendingBytes += info.isFile() ? info.size : (await Promise.all((await readdir(entry)).map(name => stat(path.join(entry, name))))).reduce((sum, item) => sum + item.size, 0); }
    expect(budget.bytes()).toBe(physical + pendingBytes);
    expect(content.timeline.totals()).toMatchObject({ entryCount: 1 });
    expect(pendingBytes).toBeGreaterThan(0);
    expect(await readdir(pending)).not.toContain("timeline");
    const remaining = budget.ceiling() - CONTROLLER_SETTLEMENT_BYTES - budget.bytes();
    expect(() => budget.assert(remaining)).not.toThrow();
    expect(() => budget.assert(remaining + 1)).toThrow("metadata budget");
    expect(() => budget.assert(remaining + CONTROLLER_SETTLEMENT_BYTES, true)).not.toThrow();
    expect(() => budget.assert(remaining + CONTROLLER_SETTLEMENT_BYTES + 1, true)).toThrow("metadata budget");
    await mkdir(`${file}.history-sync`, { mode: 0o700 }); const syncId = randomUUID(), filename = path.join(`${file}.history-sync`, `${syncId}.json`), frozen = await open(filename, "wx", 0o400); try { await frozen.truncate(1048576); } finally { await frozen.close(); }
    expect(budget.bytes()).toBe(physical + pendingBytes + 1048576);
    const before = budget.ceiling();
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run("active_history_sync", JSON.stringify({ syncId, filename, byteLength: "1048576" }));
    expect(budget.ceiling()).toBe(before + 1048576);
    db.prepare("DELETE FROM image_runtime_state WHERE key=?").run("active_history_sync");
    expect(budget.ceiling()).toBe(before);
    const beforePin = budget.bytes();
    await writeFile(path.join(pending, "resource-pins.json"), "x".repeat(1024));
    expect(budget.bytes()).toBe(beforePin + 1024);
  } finally { closeControllerTestDatabase(db); }
});
