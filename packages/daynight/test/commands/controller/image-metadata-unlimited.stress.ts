import { openControllerTestDatabase, closeControllerTestDatabase } from "../../helpers/controller-sqlite.js";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { createNativeImageState } from "../../../src/commands/controller/media/native-state.js";
import { createMarkdownSourceStore } from "../../../src/commands/controller/markdown/store.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("valid retained metadata beyond the former limit permits native, Markdown and timeline writes after reopening", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-metadata-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "m-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), sessionId = randomUUID();
  let db = openControllerTestDatabase({ file, allowCreate: true, onMigration: () => {} });
  const transactions = () => ({ read: <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(action).deferred(), write: <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(action).immediate() });
  try {
    const native = createNativeImageState(db, transactions()), value = "x".repeat(1_048_000);
    db.transaction(() => { for (let i = 0; i < 130; i++) native.writeNativeImageState(`retained-${i}`, value); }).immediate();
    db.pragma("wal_checkpoint(TRUNCATE)");
    expect((await stat(file)).size).toBeGreaterThan(128 * 1048576);
    closeControllerTestDatabase(db);
    db = openControllerTestDatabase({ file, allowCreate: false, onMigration: () => {} });
    const tx = transactions(), reopened = createNativeImageState(db, tx), markdown = createMarkdownSourceStore(db, tx);
    expect(reopened.readNativeImageState("retained-129")).toBe(value);
    reopened.writeNativeImageState("new", { outcome: "retained" });
    markdown.put("projection", "entry", { revision: "1" });
    const content = openSessionContent(file, sessionId, db, { read: tx.read, assertWrite: () => { if (!db.inTransaction) throw new Error("Publication requires the original write transaction."); } });
    const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "assistant_message" as const, content: [{ type: "text" as const, text: "Retained history" }] };
    tx.write(() => content.timeline.save(entry));
    expect(content.timeline.get(entry.entryId)).toEqual(entry);
    expect(markdown.get("projection", "entry")).toEqual({ revision: "1" });
    expect(reopened.readNativeImageState("new")).toEqual({ outcome: "retained" });
    expect(() => reopened.writeNativeImageState("oversized", "x".repeat(1_048_576))).toThrow("bound");
  } finally { closeControllerTestDatabase(db); }
}, 30000);
