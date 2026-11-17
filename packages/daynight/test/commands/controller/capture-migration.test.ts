import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { migrateDirectCaptureState } from "../../../src/commands/controller/media/capture-migration.js";
import { parseImageCaptureRequest, parseImagePart, parseValidatedImage, type ImageCaptureRequest } from "../../../src/session/image-values.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { upgradeControllerJournal } from "../../../src/commands/controller/storage-preparation.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { createImageCaptureSource } from "../../../src/commands/controller/media/capture-source.js";

const databases: Database.Database[] = [], roots: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const db = createMemoryDatabase(); databases.push(db);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 11)) db.exec(step.sql);
  const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence: { imageId: randomUUID(), entryId: randomUUID(), container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" }, nativeSource: { provider: "codex", nativeSessionId: "native", nativeMessageId: "message", nativePartId: "part" }, locator: { kind: "native", provider: "codex", nativeSessionId: "native", nativeMessageId: "message", nativePartId: "part" } };
  const part = { type: "image_unavailable", imageId: request.occurrence.imageId, label: "Image", error: { code: "capture_pending", message: "Pending" } };
  const validated = { mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
  const write = (key: string, value: unknown) => db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, JSON.stringify(value));
  const read = (key: string) => JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value);
  const migrate = () => db.transaction(() => migrateDirectCaptureState(db, "SELECT 1"))();
  const old = { request, index: 0, waitingForSource: false, phase: "new", unknownAction: null, part, validated: null };
  return { db, request, part, validated, write, read, migrate, old };
};

test.each(["commit", "failure"] as const)("migration freezes legacy native %s and its publication seed without changing original identity", action => {
  const f = fixture(), key = "native_provider:image-slot:original";
  const old = { ...f.old, phase: "query", unknownAction: action, validated: action === "commit" ? f.validated : null, part: action === "failure" ? { ...f.part, error: { code: "decode_failed", message: "Decoder failed." } } : f.part };
  f.write(key, old);
  f.db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run(randomUUID(), "codex", "native", "message", "b".repeat(64), JSON.stringify({ receipt: { original: true }, slots: [{ key: "image-slot:original", label: "Image", state: old }] }));
  f.migrate();
  const state = f.read(key);
  expect(state).toMatchObject({ request: f.request, attemptId: f.request.attemptId, phase: "query", submission: { request: f.request, attemptId: f.request.attemptId, outcome: { kind: action === "commit" ? "validated" : "failed" } } });
  expect(state).not.toHaveProperty("unknownAction"); expect(state).not.toHaveProperty("validated");
  const publication = JSON.parse((f.db.prepare("SELECT value FROM native_input_publications").get() as { value: string }).value);
  expect(publication.slots[0].state).toEqual(state); expect(publication.receipt).toEqual({ original: true });
});

test.each(["new", "reserved", "query"] as const)("migration preserves the native %s source boundary without inventing sealed bytes", phase => {
  const f = fixture(), key = "native_provider:image-slot:original";
  f.write(key, { ...f.old, phase, unknownAction: phase === "query" ? "register" : null }); f.migrate();
  expect(f.read(key)).toMatchObject({ request: f.request, submission: null, phase: phase === "reserved" ? "preparing" : phase });
});

test("migration recovers a sealed native stage from its actual persisted attempt without source IO", () => {
  const f = fixture(), key = "native_provider:image-slot:original";
  f.write(key, { ...f.old, phase: "reserved" });
  f.db.prepare("INSERT INTO image_captures VALUES(?,?,?,?)").run(`${f.request.captureId}:${f.request.attemptId}`, f.request.occurrence.imageId, `${randomUUID()}.part`, JSON.stringify(f.validated));
  f.migrate(); expect(f.read(key)).toMatchObject({ phase: "submit", submission: { outcome: { kind: "validated", validated: f.validated } } });
});

test("migration adopts current service attempt without assigning old sealed bytes to it", () => {
  const f = fixture(), key = "native_provider:image-slot:original", currentAttempt = randomUUID();
  f.write(`capture:${f.request.captureId}`, { request: f.request, attemptId: currentAttempt, attempts: [f.request.attemptId, currentAttempt], receipt: null });
  f.write(key, { ...f.old, phase: "commit", validated: f.validated }); f.migrate();
  expect(f.read(key)).toMatchObject({ request: f.request, attemptId: currentAttempt, phase: "query", submission: null });
});

test.each(["commit", "failure"] as const)("migration retains exact Markdown %s retry and independent cleanup", action => {
  const f = fixture(), key = `markdown:source:${f.request.occurrence.imageId}`;
  const cleanup = { captureId: f.request.captureId, attemptId: f.request.attemptId, pending: true, error: { code: "EACCES", message: "Unlink failed." } };
  const retryControl = { action, attemptId: f.request.attemptId, after: 5000, ...(action === "commit" ? { validated: f.validated } : { error: { code: "decode_failed", message: "Decoder failed." } }) };
  f.write(key, { request: f.request, phase: "unknown", cooldownUntil: 1000, sourceCleanup: cleanup, retryControl, observeOnly: false }); f.migrate();
  expect(f.read(key)).toMatchObject({ phase: "unknown", dispatchPending: true, cooldownUntil: 5000, sourceCleanup: cleanup, submission: { request: f.request, attemptId: f.request.attemptId, outcome: { kind: action === "commit" ? "validated" : "failed" } } });
  expect(f.read(key)).not.toHaveProperty("retryControl"); expect(f.read(key)).not.toHaveProperty("observeOnly");
});

test("migration keeps unknown Markdown registration observation-only without reopening its source", () => {
  const f = fixture(), key = `markdown:source:${f.request.occurrence.imageId}`;
  f.write(key, { request: f.request, phase: "unknown", observeOnly: false, started: false, awaitingRetry: false }); f.migrate();
  expect(f.read(key)).toMatchObject({ request: f.request, phase: "unknown", awaitingRetry: true, started: false });
  expect(f.read(key)).not.toHaveProperty("submission");
});

test("v12 maps independent states without auditing receipts, identities or image associations", () => {
  const f = fixture();
  const good = { ...f.old, phase: "query", unknownAction: "failure", part: { type: "unexpected", error: { malformed: true } }, unrelated: { arbitrary: true } };
  const bad = { ...f.old, request: null };
  const ownerRequest = { ...f.request, captureId: "different", arbitrary: true };
  f.write(`capture:${f.request.captureId}`, { request: ownerRequest, attemptId: f.request.attemptId, receipt: "bad" });
  f.write("native_provider:image-slot:a", good);
  f.write("native_provider:image-slot:b", bad);
  f.write("native_provider:image-slot:c", good);
  const operation = randomUUID();
  const receipt = { invalid: "receipt", imageId: "unrelated" };
  f.db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run(operation, "codex", "native", "message", "bad-hash", JSON.stringify({ receipt, slots: [{ state: good }, { state: bad }, { state: good }] }));
  f.db.prepare("INSERT INTO native_input_publication_images VALUES(?,?,?,?)").run(operation, "unrelated-image", "unrelated-resource", 99);
  f.migrate();
  const a = f.read("native_provider:image-slot:a"), c = f.read("native_provider:image-slot:c");
  expect(a).toEqual(c);
  expect(a).toMatchObject({ request: ownerRequest, phase: "query", part: good.part, unrelated: good.unrelated, submission: { outcome: { kind: "failed", error: good.part.error } } });
  expect(f.read("native_provider:image-slot:b")).toEqual(bad);
  const publication = JSON.parse((f.db.prepare("SELECT value FROM native_input_publications").get() as { value: string }).value);
  expect(publication.receipt).toEqual(receipt);
  expect(publication.slots.map((slot: { state: unknown }) => slot.state)).toEqual([a, bad, c]);
  expect(f.db.prepare("SELECT * FROM native_input_publication_images").all()).toEqual([{ operation_id: operation, image_id: "unrelated-image", resource_id: "unrelated-resource", part_index: 99 }]);
});

test("v12 preserves unparseable companions and unchanged raw containers without updating them", () => {
  const f = fixture(), badOwner = { ...f.request, captureId: randomUUID() }, badSealed = { ...f.request, captureId: randomUUID() };
  const good = { ...f.old, phase: "query", unknownAction: "register" };
  f.write("native_provider:image-slot:a", good);
  f.write("native_provider:image-slot:b", { ...f.old, request: badOwner });
  f.write("native_provider:image-slot:c", { ...f.old, request: badSealed, phase: "commit" });
  f.write("native_provider:image-slot:d", good);
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(`capture:${badOwner.captureId}`, "{broken");
  f.db.prepare("INSERT INTO image_captures VALUES(?,?,?,?)").run(`${badSealed.captureId}:${badSealed.attemptId}`, "bad-image", "bad-file", "{broken");
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run("markdown:source:bad", "  {broken");
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run("markdown:source:unchanged", ' { "request": null, "extra": true } ');
  f.db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run(randomUUID(), "codex", "native", "message", "hash", ' { "receipt": "bad", "slots": 7 } ');
  f.db.exec(`CREATE TRIGGER forbid_unchanged BEFORE UPDATE ON image_runtime_state WHEN OLD.key IN ('markdown:source:bad', 'markdown:source:unchanged', 'native_provider:image-slot:b', 'native_provider:image-slot:c') BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END`);
  f.db.exec(`CREATE TRIGGER forbid_publication BEFORE UPDATE ON native_input_publications BEGIN SELECT RAISE(ABORT, 'unexpected publication rewrite'); END`);
  f.migrate();
  expect(f.read("native_provider:image-slot:a")).toMatchObject({ phase: "query", resumeReserved: "source" });
  expect(f.read("native_provider:image-slot:d")).toEqual(f.read("native_provider:image-slot:a"));
  expect(f.read("native_provider:image-slot:b")).toEqual({ ...f.old, request: badOwner });
  expect(f.read("native_provider:image-slot:c")).toEqual({ ...f.old, request: badSealed, phase: "commit" });
  expect((f.db.prepare("SELECT value FROM image_runtime_state WHERE key='markdown:source:bad'").get() as { value: string }).value).toBe("  {broken");
  expect((f.db.prepare("SELECT value FROM image_runtime_state WHERE key='markdown:source:unchanged'").get() as { value: string }).value).toBe(' { "request": null, "extra": true } ');
  expect((f.db.prepare("SELECT value FROM native_input_publications").get() as { value: string }).value).toBe(' { "receipt": "bad", "slots": 7 } ');
});

test("v12 keeps an observation-only Markdown state without sealed data in query", () => {
  const f = fixture(), key = "markdown:source:observation";
  f.write(key, { request: f.request, phase: "unknown", observeOnly: true, started: false, awaitingRetry: false });
  f.migrate();
  expect(f.read(key)).toMatchObject({ request: f.request, phase: "unknown", awaitingRetry: true, started: false });
  expect(f.read(key)).not.toHaveProperty("submission");
  expect(f.read(key)).not.toHaveProperty("resumeReserved");
  expect(f.read(key)).not.toHaveProperty("observeOnly");
});

test("v12 preserves states when a required sealed companion is absent", () => {
  const f = fixture();
  const native = { ...f.old, phase: "query", unknownAction: "commit", validated: null };
  const markdown = { request: f.request, phase: "validated", observeOnly: true, sourceAdmission: null };
  f.write("native_provider:image-slot:missing", native);
  f.write("markdown:source:missing", markdown);
  f.migrate();
  expect(f.read("native_provider:image-slot:missing")).toEqual(native);
  expect(f.read("markdown:source:missing")).toEqual(markdown);
});

test.each([undefined, "unrecognized"])("v12 preserves native state when its needed action is unavailable", unknownAction => {
  const f = fixture(), key = "native_provider:image-slot:action";
  const old = { ...f.old, phase: "query", unknownAction };
  const raw = ` ${JSON.stringify(old)} `;
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, raw);
  f.db.exec(`CREATE TRIGGER forbid_action_update BEFORE UPDATE ON image_runtime_state WHEN OLD.key='${key}' BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END`);
  f.migrate();
  expect((f.db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value).toBe(raw);
});

test.each(["commit", "failure"] as const)("v12 preserves native %s when its required outcome is unavailable", action => {
  const f = fixture(), key = "native_provider:image-slot:outcome";
  const old = action === "commit"
    ? { ...f.old, phase: "query", unknownAction: action, validated: undefined }
    : { ...f.old, phase: "query", unknownAction: action, part: { type: "image_unavailable" } };
  const raw = ` ${JSON.stringify(old)} `;
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, raw);
  f.migrate();
  expect((f.db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value).toBe(raw);
});

test.each([{}, { action: "unrecognized" }])("v12 preserves Markdown state when retry action is unavailable", retryControl => {
  const f = fixture(), key = "markdown:source:retry";
  const old = { request: f.request, phase: "unknown", started: false, awaitingRetry: false, observeOnly: false, retryControl, receipt: "bad" };
  const raw = ` ${JSON.stringify(old)} `;
  f.db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, raw);
  f.db.exec(`CREATE TRIGGER forbid_retry_update BEFORE UPDATE ON image_runtime_state WHEN OLD.key='${key}' BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END`);
  f.migrate();
  expect((f.db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value).toBe(raw);
});

test("v12 carries sealed Markdown data without checking source admission and rolls back actual SQL failures", () => {
  const f = fixture(), nativeKey = "native_provider:image-slot:a", markdownKey = "markdown:source:b";
  f.write(nativeKey, f.old);
  const markdown = { request: f.request, phase: "validated", sourceAdmission: { validated: "different", attemptId: "different" }, receipt: "bad" };
  f.write(markdownKey, markdown);
  f.db.prepare("INSERT INTO image_captures VALUES(?,?,?,?)").run(`${f.request.captureId}:${f.request.attemptId}`, "unrelated", "unrelated", JSON.stringify(f.validated));
  f.db.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON image_runtime_state WHEN OLD.key='${nativeKey}' BEGIN SELECT RAISE(ABORT, 'real write failure'); END`);
  expect(f.migrate).toThrow("real write failure");
  expect(f.read(markdownKey)).toEqual(markdown);
  expect(f.read(nativeKey)).toEqual(f.old);
  f.db.exec("DROP TRIGGER fail_update");
  f.migrate();
  expect(f.read(markdownKey)).toMatchObject({ receipt: "bad", sourceAdmission: { validated: "different", attemptId: "different" }, phase: "unknown", submission: { outcome: { kind: "validated", validated: f.validated } } });
  const once = f.db.prepare("SELECT key,value FROM image_runtime_state ORDER BY key").all();
  f.migrate();
  expect(f.db.prepare("SELECT key,value FROM image_runtime_state ORDER BY key").all()).toEqual(once);
});


test("journal upgrade commits independent v12 state mappings for a file-backed v11 database", () => {
  const f = fixture();
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/capture-migration-upgrade");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file);
  const good = { ...f.old, phase: "query", unknownAction: "register" }, bad = { ...f.old, request: null };
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 11)) db.exec(step.sql);
    for (const [key, state] of [["a", good], ["b", bad], ["c", good]] as const) db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(`native_provider:image-slot:${key}`, JSON.stringify(state));
    db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run("operation", "codex", "native", "message", "bad", JSON.stringify({ receipt: "bad", slots: [{ state: good }, { state: bad }, { state: good }] }));
    db.prepare("INSERT INTO native_input_publication_images VALUES(?,?,?,?)").run("operation", "unrelated", "resource", 3);
    db.pragma("user_version=11");
  } finally { db.close(); }
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true });
  try { upgradeControllerJournal(file, permit, { onMigration: () => {} }); }
  finally { permit.release(); }
  const read = new Database(file, { readonly: true });
  try {
    expect(read.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
    const states = (read.prepare("SELECT value FROM image_runtime_state ORDER BY key").all() as { value: string }[]).map(row => JSON.parse(row.value));
    expect(states[0]).toMatchObject({ phase: "query", resumeReserved: "source" });
    expect(states[1]).toEqual(bad); expect(states[2]).toEqual(states[0]);
    const publication = JSON.parse((read.prepare("SELECT value FROM native_input_publications").get() as { value: string }).value);
    expect(publication.receipt).toBe("bad");
    expect(publication.slots.map((slot: { state: unknown }) => slot.state)).toEqual(states);
    expect(read.prepare("SELECT * FROM native_input_publication_images").all()).toEqual([{ operation_id: "operation", image_id: "unrelated", resource_id: "resource", part_index: 3 }]);
  } finally { read.close(); }
});

test("v11 capture migration preserves over-limit stored values while new input remains bounded", () => {
  const f = fixture();
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/capture-migration-capacity");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file);
  const request = { ...f.request, occurrence: { ...f.request.occurrence, sourceKey: "s".repeat(1025) }, nativeSource: { ...f.request.nativeSource!, nativeSessionId: "n".repeat(257) }, locator: { ...f.request.locator, nativeSessionId: "n".repeat(257) } };
  const part = { ...f.part, label: "l".repeat(1025) };
  const validated = { ...f.validated, byteLength: "10485761", width: 16385, frameCount: 257 };
  const old = { ...f.old, request, part, validated, phase: "query", unknownAction: "commit" };
  const key = "native_provider:image-slot:oversized", operation = randomUUID();
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 11)) db.exec(step.sql);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, JSON.stringify(old));
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(`capture:${request.captureId}`, JSON.stringify({ request, attemptId: request.attemptId, attempts: [request.attemptId], receipt: null }));
    db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run(operation, "codex", "native", "message", "b".repeat(64), JSON.stringify({ receipt: { original: true }, slots: [{ key: "image-slot:oversized", label: "Image", state: old }] }));
    db.pragma("user_version=11");
  } finally { db.close(); }
  expect(() => parseImageCaptureRequest(request)).toThrow();
  expect(() => parseImagePart(part)).toThrow();
  expect(() => parseValidatedImage(validated)).toThrow();
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true });
  try { expect(upgradeControllerJournal(file, permit, { onMigration: () => {} })).toEqual({ version: currentSqliteVersion(controllerJournalFormat), legacyTimelineCleanupPending: false }); }
  finally { permit.release(); }
  const read = new Database(file, { readonly: true });
  try {
    const state = JSON.parse((read.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value);
    expect(state).toMatchObject({ request, part, phase: "query", submission: { request, attemptId: request.attemptId, outcome: { kind: "validated", validated } } });
    const publication = JSON.parse((read.prepare("SELECT value FROM native_input_publications WHERE operation_id=?").get(operation) as { value: string }).value);
    expect(publication.slots[0].state).toEqual(state);
    expect(publication.receipt).toEqual({ original: true });
    const source = createImageCaptureSource(read, { read: action => action(), write: action => action() }, () => ({} as never));
    expect(source.getImageCaptureRequest(request.captureId)).toEqual(request);
    expect(() => source.registerImageCaptureRequest(request as ImageCaptureRequest)).toThrow("Invalid Daynight image protocol value");
  } finally { read.close(); }
});
