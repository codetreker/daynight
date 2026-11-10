import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, stat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { controllerMetadataBudget, CONTROLLER_METADATA_BYTES, CONTROLLER_SETTLEMENT_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("real SQLite pages, WAL and pending timeline share the normal and settlement metadata limits", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-metadata-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "m-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file);
  try {
    db.pragma("journal_mode=WAL"); db.pragma("wal_autocheckpoint=0");
    db.exec("CREATE TABLE retained(value BLOB); INSERT INTO retained VALUES(zeroblob(1048576))");
    const content = openPendingContent(file, "session");
    content.saveEntry({ entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "text", text: "Retained history" }] });
    const budget = controllerMetadataBudget(file, db);
    const physical = (await Promise.all([file, `${file}-wal`, `${file}-shm`].map(filename => stat(filename)))).reduce((sum, item) => sum + item.size, 0);
    const pending = `${file}.pending-content`;
    const metadata = [...(await readdir(pending)).filter(name => name !== "blobs").map(name => path.join(pending, name))];
    let pendingBytes = 0;
    for (const entry of metadata) { const info = await stat(entry); pendingBytes += info.isFile() ? info.size : (await Promise.all((await readdir(entry)).map(name => stat(path.join(entry, name))))).reduce((sum, item) => sum + item.size, 0); }
    expect(budget.bytes()).toBe(physical + pendingBytes);
    expect(pendingBytes).toBeGreaterThan(content.metadataBytes());
    const remaining = CONTROLLER_METADATA_BYTES - budget.bytes();
    expect(() => budget.assert(remaining)).not.toThrow();
    expect(() => budget.assert(remaining + 1)).toThrow("metadata budget");
    expect(() => budget.assert(remaining + CONTROLLER_SETTLEMENT_BYTES, true)).not.toThrow();
    expect(() => budget.assert(remaining + CONTROLLER_SETTLEMENT_BYTES + 1, true)).toThrow("metadata budget");
    await mkdir(`${file}.history-sync`, { mode: 0o700 }); const frozen = await open(path.join(`${file}.history-sync`, `${randomUUID()}.json`), "wx", 0o400); try { await frozen.truncate(1048576); } finally { await frozen.close(); }
    expect(budget.bytes()).toBe(physical + pendingBytes + 1048576);
    await writeFile(path.join(pending, "resource-pins.json"), "x".repeat(1024));
    expect(budget.bytes()).toBe(physical + pendingBytes + 1048576 + 1024);
  } finally { db.close(); }
});
