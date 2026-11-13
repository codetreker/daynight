import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import { controllerJournalFormat, controllerJournalFormatForMigration, assertJournalMigrationAllowed, type JournalMigrationContext } from "../../../src/commands/controller/journal-format.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";
import { acquireControllerStoragePermit, type ControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { currentSqliteVersion, inspectSqlite, upgradeSqlite } from "../../../src/platform/sqlite-format.js";
import { runSqliteImmediate, sqliteTransactionOutcome } from "../../../src/platform/sqlite-access.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import { controllerMetadataBudget } from "../../../src/commands/controller/media/metadata-budget.js";

const roots: string[] = [], connections: Database.Database[] = [], permits: ControllerStoragePermit[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const permit of permits.splice(0)) permit.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fixture = async (version: number, withExecution = true) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/timeline-migration");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db);
  await chmod(file, 0o600);
  const steps = loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url));
  for (const step of steps.filter(step => step.version <= version)) db.exec(step.sql);
  db.pragma(`user_version=${version}`);
  const sessionId = randomUUID(), executionId = randomUUID();
  const snapshot = JSON.stringify({ executionId, sessionId, claimId: randomUUID(), nativeSessionId: "original-native", executionGeneration: "17", lifecycle: "stopping", nativeStopped: false, stoppedAt: null, archiveReceipt: null, controllerProcess: { pid: 12345 }, nativeProcesses: [{ pid: 45678 }] });
  if (withExecution && version !== 0) {
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,last_sequence) VALUES(1,'original-ticket',NULL,?,71)").run(snapshot);
    db.prepare("INSERT INTO operations(id,value) VALUES('original',?)").run('{ "state": "unknown", "initial": true }');
    db.prepare("INSERT INTO outbox VALUES(71,?)").run('{ "unacknowledged": true }');
  }
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "3", kind: "reasoning" as const, text: "original 🧪 中文" };
  const body = JSON.stringify(entry), pending = `${file}.pending-content`;
  let bodyFile: string | undefined;
  if (version >= 2 && version <= 5 && withExecution) db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,3,?)").run(entry.entryId, controllerPayloadHash(entry), body);
  if (version >= 6 && withExecution) {
    await mkdir(path.join(pending, version < 8 ? "timeline" : "entries"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(pending, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId }), { mode: 0o600 });
    bodyFile = path.join(pending, version < 8 ? "timeline" : "entries", version < 8 ? `${hash(entry.entryId)}.json` : `${randomUUID()}.json`);
    await writeFile(bodyFile, body, { mode: 0o600 });
    if (version < 8) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
    else db.prepare("INSERT INTO content_index VALUES(?,?,?,?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, path.basename(bodyFile), hash(body), Buffer.byteLength(body));
  }
  if (version === 9 && withExecution) {
    db.prepare("INSERT INTO input_message_origins VALUES('user-entry','user-operation','user'),('daynight-entry','daynight-operation','daynight')").run();
    db.prepare("INSERT INTO native_input_publication_images VALUES('original','image','resource',0)").run();
  }
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true }); permits.push(permit);
  const assertReservedWrite = vi.fn<(additional: number) => void>(), assertPendingWrite = vi.fn<(additional: number) => void>();
  const context: JournalMigrationContext = { storagePermit: permit, assertReservedWrite, assertPendingWrite };
  const format = controllerJournalFormatForMigration(() => context);
  const migrate = () => runSqliteImmediate(db, () => { const source = inspectSqlite(db, format); assertJournalMigrationAllowed(db, source); return upgradeSqlite(db, format); });
  return { root, file, db, sessionId, snapshot, entry, body, bodyFile, pending, permit, context, format, migrate, assertReservedWrite, assertPendingWrite };
};

test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("imports actual v%s through the canonical chain without changing original execution evidence", async version => {
  const f = await fixture(version), before = f.db.prepare("SELECT snapshot,ticket_hash,owner_pid,last_sequence FROM execution").get();
  expect(f.migrate()).toMatchObject({ fromVersion: version, toVersion: 11 });
  expect(inspectSqlite(f.db, controllerJournalFormat)).toEqual({ kind: "current", version: 11 });
  expect(f.db.prepare("SELECT snapshot,ticket_hash,owner_pid,last_sequence FROM execution").get()).toEqual(before);
  expect(f.db.prepare("SELECT legacy_timeline_cleanup_pending FROM execution").get()).toEqual({ legacy_timeline_cleanup_pending: 1 });
  expect(f.db.prepare("SELECT value FROM operations").get()).toEqual({ value: '{ "state": "unknown", "initial": true }' });
  expect(f.db.prepare("SELECT value FROM outbox").get()).toEqual({ value: '{ "unacknowledged": true }' });
  const store = openTimelineStore(f.db, { assertWrite: () => { throw new Error("reader"); } });
  expect(store.get(f.entry.entryId)).toEqual(version === 1 ? undefined : f.entry);
  expect(store.totals()).toMatchObject({ entryCount: version === 1 ? 0 : 1, byteLength: version === 1 ? 0 : Buffer.byteLength(f.body) });
  expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='content_index'").get()).toBeUndefined();
  if (version === 1) expect(f.db.prepare("SELECT archive_incomplete FROM execution").get()).toEqual({ archive_incomplete: 1 });
  if (f.bodyFile !== undefined) expect(await readFile(f.bodyFile, "utf8")).toBe(f.body);
  if (version === 9) {
    expect(f.db.prepare("SELECT * FROM input_message_origins ORDER BY entry_id").all()).toEqual([{ entry_id: "daynight-entry", operation_id: "daynight-operation", origin: "daynight" }, { entry_id: "user-entry", operation_id: "user-operation", origin: "user" }]);
    expect(f.db.prepare("SELECT * FROM native_input_publication_images").all()).toEqual([{ operation_id: "original", image_id: "image", resource_id: "resource", part_index: 0 }]);
  }
});

test("canonical discovery adopts the unchanged complete v10 DDL after the published origins migration", async () => {
  expect(currentSqliteVersion(controllerJournalFormat)).toBe(11);
  const steps = loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url));
  expect(steps.map(step => step.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const repository = path.resolve(import.meta.dirname, "../../../../..");
  const accounting = await readFile(path.join(repository, "packages/daynight/src/commands/controller/sqlite/journal/011-outbox-accounting.sql"));
  expect(hash(Buffer.from(accounting.toString("utf8").replaceAll("\r\n", "\n"), "utf8"))).toBe("8ccff911653736b9af8c346ce75d127291deba9d0082ee8e96521942ff61a462");
  for (const [version, name, expectedHash] of [
    [9, "009-message-origins.sql", "f3c16ac2b559f1ed684566a6ede5bf82c7fc84b3870a84bee7d6ff3bdc158d76"],
    [10, "010-timeline-content.sql", "537649e624dbe080aff7657a08b05eb837b1579e5558481cb7c63d3f01703bcc"],
  ] as const) {
    const resource = `packages/daynight/src/commands/controller/sqlite/journal/${name}`;
    const canonical = execFileSync("git", ["show", `HEAD:${resource}`], { cwd: repository, timeout: 10000 });
    const checkout = await readFile(path.join(repository, resource));
    // Published bytes belong to Git; checkout EOL conversion must preserve both
    // their canonical content and the exact bytes consumed by resource loading.
    expect(hash(canonical)).toBe(expectedHash);
    expect(canonical.includes(13)).toBe(false);
    expect(Buffer.from(steps.find(step => step.version === version)!.sql, "utf8")).toEqual(checkout);
    expect(Buffer.from(checkout.toString("utf8").replaceAll("\r\n", "\n"), "utf8")).toEqual(canonical);
  }
});

test("imports only the committed v9 pointer while retaining an orphan newer candidate", async () => {
  const f = await fixture(9), orphan = path.join(f.pending, "entries", `${randomUUID()}.json`);
  await writeFile(orphan, JSON.stringify({ ...f.entry, revision: "4", text: "uncommitted" }), { mode: 0o600 });
  f.migrate();
  expect(openTimelineStore(f.db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
  expect(await readdir(path.dirname(orphan))).toHaveLength(2);
});

test.each(process.platform === "win32" ? ["missing", "sha", "length", "identity", "sequence", "revision", "hash"] as const : ["missing", "sha", "length", "identity", "sequence", "revision", "hash", "nonprivate", "symlink"] as const)("invalid committed v9 %s fails with original SQL and source intact", async variant => {
  const f = await fixture(9), original = f.bodyFile!;
  if (variant === "missing") await rm(original);
  if (variant === "sha") f.db.prepare("UPDATE content_index SET content_sha256=?").run("a".repeat(64));
  if (variant === "length") f.db.prepare("UPDATE content_index SET content_bytes=content_bytes+1").run();
  if (variant === "identity") f.db.prepare("UPDATE content_index SET id=?").run(randomUUID());
  if (variant === "sequence") f.db.prepare("UPDATE content_index SET entry_seq='2'").run();
  if (variant === "revision") f.db.prepare("UPDATE content_index SET revision='4'").run();
  if (variant === "hash") f.db.prepare("UPDATE content_index SET content_hash=?").run("b".repeat(64));
  if (variant === "nonprivate") await chmod(original, 0o644);
  if (variant === "symlink") { const target = `${original}.source`; await writeFile(target, f.body, { mode: 0o600 }); await rm(original); await symlink(target, original); }
  const pointers = f.db.prepare("SELECT * FROM content_index").all();
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(9);
  expect(f.db.prepare("SELECT * FROM content_index").all()).toEqual(pointers);
  expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='timeline_entries'").get()).toBeUndefined();
  expect(f.db.prepare("SELECT snapshot FROM execution").get()).toEqual({ snapshot: f.snapshot });
  if (variant !== "missing") expect(await readFile(original, "utf8")).toBe(f.body);
});

test.each([6, 7])("v%s requires exact old index/source agreement before importing", async version => {
  const f = await fixture(version);
  await writeFile(f.bodyFile!, JSON.stringify({ ...f.entry, revision: "4", text: "ahead" }), { mode: 0o600 });
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(version);
  expect(f.db.prepare("SELECT revision FROM content_index").get()).toEqual({ revision: "3" });
});

test.each([0, 9])("v%s without an original execution rejects retained pending sources", async version => {
  const f = await fixture(version, false);
  await mkdir(path.join(f.pending, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(f.pending, "entries", `${randomUUID()}.json`), f.body, { mode: 0o600 });
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(version);
  expect(await readdir(path.join(f.pending, "entries"))).toHaveLength(1);
});

test.each([5, 7])("v%s exports within the supplied peak reservation despite old physical metadata above128MiB", async version => {
  const f = await fixture(version), directory = path.join(f.pending, "entries");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(directory, `${randomUUID()}.json`), "wx", 0o600);
  try { await handle.truncate(129 * 1048576); } finally { await handle.close(); }
  expect(() => controllerMetadataBudget(f.file, f.db).assert()).toThrow("metadata budget");
  f.migrate();
  expect(f.assertPendingWrite).toHaveBeenCalled();
  expect(openTimelineStore(f.db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
});

test("live owner admission refuses conversion before touching the committed source", async () => {
  const f = await fixture(9); f.db.prepare("UPDATE execution SET owner_pid=?").run(process.pid);
  expect(f.migrate).toThrow("upgrade-blocked");
  expect(f.db.pragma("user_version", { simple: true })).toBe(9);
  expect(await readFile(f.bodyFile!, "utf8")).toBe(f.body);
});

test.each(["import", "before-commit", "after-commit"] as const)("%s failure exposes the real atomic migration outcome and retains body files", async phase => {
  const f = await fixture(9), execute = Database.prototype.exec, prepare = Database.prototype.prepare;
  if (phase === "import") vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
    if (this === f.db && sql.includes("INSERT INTO timeline_entries")) throw new Error("import fault");
    return prepare.call(this, sql);
  });
  else vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (this === f.db && sql === "COMMIT" && phase === "before-commit") throw new Error("commit fault");
    const result = execute.call(this, sql);
    if (this === f.db && sql === "COMMIT" && phase === "after-commit") throw new Error("commit result lost");
    return result;
  });
  let failure: unknown;
  try { f.migrate(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(sqliteTransactionOutcome(failure)).toBe(phase === "after-commit" ? "unknown" : "rolled-back");
  vi.restoreAllMocks();
  expect(f.db.pragma("user_version", { simple: true })).toBe(phase === "after-commit" ? 11 : 9);
  expect(await readFile(f.bodyFile!, "utf8")).toBe(f.body);
  if (phase !== "after-commit") { expect(f.db.prepare("SELECT COUNT(*) AS count FROM content_index").get()).toEqual({ count: 1 }); f.migrate(); }
  expect(openTimelineStore(f.db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
});


test("legacy SQL resource export keeps its exact backup and resource identity through v10", async () => {
  const f = await fixture(5), content = Buffer.from("original-resource"), resource = { resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(content.byteLength), sha256: hash(content), error: null };
  const descriptor = JSON.stringify(resource);
  f.db.prepare("INSERT INTO resources VALUES(?,?,?)").run(resource.resourceId, descriptor, content);
  f.migrate();
  const files = openResourceFiles(f.file, f.sessionId), lease = files.acquireResource(resource.resourceId);
  try { expect(lease.resource).toEqual(resource); expect(lease.read("0", content.byteLength)).toEqual(content); }
  finally { lease.close(); }
  expect(JSON.parse(await readFile(path.join(f.pending, "legacy-sql", `${resource.resourceId}.resource.json`), "utf8"))).toEqual({ descriptor, content: content.toString("base64") });
});

test("invalid UTF8 with a valid byte hash is rejected before adopting a body", async () => {
  const f = await fixture(9), invalid = Buffer.concat([Buffer.from(f.body.slice(0, -2)), Buffer.from([0xff]), Buffer.from('"}')]);
  await writeFile(f.bodyFile!, invalid, { mode: 0o600 });
  f.db.prepare("UPDATE content_index SET content_sha256=?,content_bytes=?").run(hash(invalid), invalid.length);
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(9);
  expect(await readFile(f.bodyFile!)).toEqual(invalid);
});

test("a capacity refusal during export retains original SQL and retries the same source", async () => {
  const f = await fixture(5);
  f.assertPendingWrite.mockImplementationOnce(() => { throw new Error("reserved peak exhausted"); });
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(5);
  expect(f.db.prepare("SELECT value FROM projection").get()).toEqual({ value: f.body });
  f.migrate();
  expect(openTimelineStore(f.db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
});

test("v9 import keeps decimal sequence and revision beyond JavaScript safe integers", async () => {
  const f = await fixture(9), entry = { ...f.entry, entrySeq: "9007199254740993", revision: "9223372036854775807" }, body = JSON.stringify(entry);
  await writeFile(f.bodyFile!, body, { mode: 0o600 });
  f.db.prepare("UPDATE content_index SET entry_seq=?,revision=?,content_hash=?,content_sha256=?,content_bytes=?").run(entry.entrySeq, entry.revision, controllerPayloadHash(entry), hash(body), Buffer.byteLength(body));
  f.migrate();
  expect(openTimelineStore(f.db, { assertWrite: () => {} }).get(entry.entryId)).toEqual(entry);
  expect(f.db.prepare("SELECT CAST(entry_seq AS TEXT) AS sequence,CAST(revision AS TEXT) AS revision FROM timeline_entries").get()).toEqual({ sequence: entry.entrySeq, revision: entry.revision });
});

test.each(["entrySeq", "revision"] as const)("v9 %s outside signed64 is rejected without changing the source", async field => {
  const f = await fixture(9), entry = { ...f.entry, [field]: "9223372036854775808" }, body = JSON.stringify(entry);
  await writeFile(f.bodyFile!, body, { mode: 0o600 });
  f.db.prepare("UPDATE content_index SET entry_seq=?,revision=?,content_hash=?,content_sha256=?,content_bytes=?").run(entry.entrySeq, entry.revision, controllerPayloadHash(entry), hash(body), Buffer.byteLength(body));
  expect(f.migrate).toThrow();
  expect(f.db.pragma("user_version", { simple: true })).toBe(9);
  expect(await readFile(f.bodyFile!, "utf8")).toBe(body);
});
