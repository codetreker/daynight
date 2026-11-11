import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createMarkdownSourceStore } from "../../../../src/commands/controller/markdown/store.js";
import { controllerMetadataBudget } from "../../../../src/commands/controller/media/metadata-budget.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/markdown-store-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "s-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file);
  db.exec("CREATE TABLE image_runtime_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const transactions = { read<T>(action: () => T): T { return action(); }, write<T>(action: () => T): T { return db.transaction(action).immediate(); } };
  const budget = controllerMetadataBudget(file, db);
  return { file, db, transactions, budget, store: createMarkdownSourceStore(db, transactions, budget) };
};

test("projection, source and context metadata persist in separate bounded pages", async () => {
  const f = await fixture();
  try {
    expect(f.store.get("source", "missing")).toBeNull();
    for (const id of ["c", "a", "b"]) f.store.put("projection", id, { text: id });
    f.store.put("source", "a", { path: "original.png" }); f.store.put("context", "a", { revision: "1" });
    f.store.put("projection", "a", { text: "revised" });
    expect(f.store.list("projection", { limit: 2 })).toEqual([{ id: "a", value: { text: "revised" } }, { id: "b", value: { text: "b" } }]);
    expect(f.store.list("projection", { after: "b", limit: 2 })).toEqual([{ id: "c", value: { text: "c" } }]);
    expect(f.store.listIds("projection", { limit: 2 })).toEqual(["a", "b"]);
    expect(f.store.listIds("projection", { after: "b", limit: 2 })).toEqual(["c"]);
    f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run("markdown:source:poison", "not JSON");
    expect(f.store.listIds("source", { limit: 32 })).toEqual(["a", "poison"]);
    expect(f.store.get("source", "a")).toEqual({ path: "original.png" });
    f.store.put("context", "json", { optional: undefined, elapsed: 0.5 });
    expect(f.store.get("context", "json")).toEqual({ elapsed: 0.5 });
    const special = "key_%:中文"; f.store.put("context", special, { retained: true });
    expect(f.store.get("context", special)).toEqual({ retained: true });
  } finally { f.db.close(); }
  const reopened = new Database(f.file);
  try {
    const store = createMarkdownSourceStore(reopened, { read: action => action(), write: action => reopened.transaction(action).immediate() }, controllerMetadataBudget(f.file, reopened));
    expect(store.get("projection", "a")).toEqual({ text: "revised" });
    expect(store.get("context", "a")).toEqual({ revision: "1" });
  } finally { reopened.close(); }
});

test("metadata writes enforce identity, page and shared metadata budgets before mutation", async () => {
  const f = await fixture();
  try {
    for (const id of ["", "x".repeat(513), "\u0000", "\ud800"]) expect(() => f.store.put("source", id, {})).toThrow("identity");
    for (const limit of [0, 33, 1.5, Infinity]) expect(() => f.store.list("source", { limit })).toThrow("page");
    const id = "🟢".repeat(128); f.store.put("source", id, { valid: true });
    expect(f.store.get("source", id)).toEqual({ valid: true });
    const assert = vi.fn(() => { throw new Error("metadata exhausted"); });
    const refused = createMarkdownSourceStore(f.db, f.transactions, { assert });
    expect(() => refused.put("source", id, { valid: false })).toThrow("metadata exhausted");
    expect(() => refused.rate("image.example", 100000)).toThrow("metadata exhausted");
    expect(f.store.get("source", id)).toEqual({ valid: true });
    expect(assert).toHaveBeenCalledTimes(2);
    expect(f.db.prepare("SELECT key FROM image_runtime_state WHERE key=?").get("markdown:rate")).toBeUndefined();
  } finally { f.db.close(); }
});

test("request limits survive reopen and clock rollback without an unbounded host table", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) expect(f.store.rate("image.example", 100000)).toBe(true);
  expect(f.store.rate("image.example", 100001)).toBe(false); f.db.close();
  const db = new Database(f.file);
  try {
    const store = createMarkdownSourceStore(db, { read: action => action(), write: action => db.transaction(action).immediate() }, controllerMetadataBudget(f.file, db));
    expect(store.rate("image.example", 90000)).toBe(false);
    for (let i = 0; i < 20; i++) expect(store.rate(`host${i}.example`, 100001)).toBe(true);
    expect(store.rate("new.example", 159999)).toBe(false);
    expect(store.rate("new.example", 160001)).toBe(true);
    for (const host of ["", ".", "bad host", "x".repeat(254)]) expect(() => store.rate(host, 160001)).toThrow("host");
    expect(() => store.rate("image.example", NaN)).toThrow("clock");
    const rows = db.prepare("SELECT value FROM image_runtime_state").all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(Buffer.byteLength(rows[0]!.value)).toBeLessThan(16384);
  } finally { db.close(); }
});
