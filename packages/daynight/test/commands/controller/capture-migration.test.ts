import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { migrateDirectCaptureState } from "../../../src/commands/controller/media/capture-migration.js";
import type { ImageCaptureRequest } from "../../../src/session/image-values.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = () => {
  const db = createMemoryDatabase(); databases.push(db);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 11)) db.exec(step.sql);
  const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence: { imageId: randomUUID(), entryId: randomUUID(), container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" }, nativeSource: { provider: "codex", nativeSessionId: "native", nativeMessageId: "message", nativePartId: "part" }, locator: { kind: "native", provider: "codex", nativeSessionId: "native", nativeMessageId: "message", nativePartId: "part" } };
  const part = { type: "image_unavailable", imageId: request.occurrence.imageId, label: "Image", error: { code: "capture_pending", message: "Pending" } };
  const validated = { mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
  const write = (key: string, value: unknown) => db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, JSON.stringify(value));
  const read = (key: string) => JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value);
  const migrate = () => db.transaction(() => migrateDirectCaptureState(db, "SELECT 1", () => {}))();
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

test("a corrupt retained capture rolls back every earlier migration rewrite", () => {
  const f = fixture(); f.write("native_provider:image-slot:a", f.old); f.write("native_provider:image-slot:b", { ...f.old, request: { ...f.request, captureId: "invalid" } });
  expect(f.migrate).toThrow(); expect(f.read("native_provider:image-slot:a")).toEqual(f.old);
});
