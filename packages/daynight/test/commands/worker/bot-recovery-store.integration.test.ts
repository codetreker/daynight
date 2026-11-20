import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as durableJson from "../../../src/platform/durable-json.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotRecoveryStore, type BotRecoveryOperation, type BotRecoveryRejectedOperation, type BotRecoveryRejection } from "../../../src/commands/worker/bots/recovery-store.js";
import type { BotRecoveryGrant, BotRecoveryRegistration, BotRecoveryResult } from "../../../src/commands/worker/bots/recovery-protocol.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { definition, id, owner } from "./bot-execution-store.fixtures.js";

const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-recovery-store-tests");
const directories: string[] = [], handles: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, "case-")); directories.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const stateDirectory = resolveConfigurationPaths(home).stateDirectory;
  const open = (identity = owner) => {
    const local = openLocalBotStores({ owner: identity, stateDirectory, legacyDatabaseFile: path.join(stateDirectory, "worker", "state.sqlite"), onMigration: () => {} });
    handles.push(local);
    return { local, store: openBotRecoveryStore({ stateDirectory, owner: identity, assertLocked: local.assertLocked }) };
  };
  const opened = open();
  opened.local.store.observe(owner, definition(), 1);
  opened.local.store.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 2 });
  const intent = opened.local.store.get(owner, id(3))!.intent!;
  const record = opened.local.store.observe(owner, { ...definition(), version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
  return { home, stateDirectory, open, record, file: path.join(resolveBotPaths(stateDirectory, id(3)).directory, "recovery.json"), ...opened };
};
const registration = (f: ReturnType<typeof fixture>): Omit<BotRecoveryOperation, "result"> => {
  const state = f.store.ensureIdentity(f.record);
  return { kind: "register", workerId: owner.workerId, body: {
    botRecoveryVersion: 1, serviceOrigin: owner.serverOrigin, recoveryIdentity: state.recoveryIdentity,
    operationId: id(30), botVersion: f.record.observed.version, sessionId: f.record.intent!.sessionId!,
    testExecutionId: f.record.intent!.executionId, nativeSessionId: null,
  } };
};
const result = (f: ReturnType<typeof fixture>, operation: Omit<BotRecoveryOperation, "result">): BotRecoveryResult => ({
  current: true, receipt: {
    botRecoveryVersion: 1, operationId: operation.body.operationId, kind: operation.kind, workerId: operation.workerId,
    hostingGeneration: operation.kind === "takeover" ? "2" : "1", botVersion: operation.kind === "takeover" ? "4" : "3",
    sessionId: operation.body.sessionId, testExecutionId: operation.body.testExecutionId, nativeSessionId: operation.body.nativeSessionId,
    executionGeneration: "1", controllerId: f.record.intent!.registration.controllerId, controllerInstanceId: f.record.intent!.controllerInstanceId,
    grantExpiresAt: operation.kind === "register" ? null : "2026-11-20T00:30:00Z",
    controllerTokenHash: operation.kind === "register" ? null : createHash("sha256").update((operation.body as BotRecoveryGrant).controllerToken).digest("hex"),
  },
});
const registered = (f: ReturnType<typeof fixture>) => {
  const operation = registration(f);
  f.store.prepare(f.record, operation); f.store.recordResult(f.record, operation.body.operationId, result(f, operation));
  f.store.finishOperation(f.record, operation.body.operationId);
  return operation;
};
const rejection: BotRecoveryRejection = { status: 409, code: "resource_conflict", requestId: "bot-recovery-conflict-1" };

describe("durable Bot recovery operations", () => {
  it("retains the exact pending registration and protected identity after Worker replacement", () => {
    const f = fixture(), operation = registration(f);
    const pending = f.store.prepare(f.record, operation);
    f.local.close();
    const rebuilt = { ...owner, workerId: id(90) }, reopened = f.open(rebuilt);
    const record = reopened.local.scan().records[0]!;
    expect(reopened.store.read(record)).toEqual(pending);
    expect(reopened.store.ensureIdentity(record)).toEqual(pending);
    expect(record.owner).toEqual(owner);
    expect(() => reopened.store.prepare(record, operation)).toThrow(/original identity or operation/);
    expect(() => reopened.store.prepare(record, { ...operation, body: { ...operation.body, operationId: id(31) } })).toThrow(/original identity or operation/);
    expect(() => reopened.store.finishOperation(record, operation.body.operationId)).toThrow(/original identity or operation/);
    expect(reopened.store.read(record)?.pending?.body).toEqual(operation.body);
  });

  it("keeps the submitted operation when durable publication succeeds but the caller loses its result", () => {
    const f = fixture(), operation = registration(f), original = durableJson.writeDurableJson;
    vi.spyOn(durableJson, "writeDurableJson").mockImplementationOnce((file, value) => { original(file, value); throw new Error("publication result lost"); });
    expect(() => f.store.prepare(f.record, operation)).toThrow("publication result lost");
    f.local.close();
    const reopened = f.open();
    expect(reopened.store.read(f.record)?.pending).toEqual({ ...operation, result: null });
    expect(() => reopened.store.prepare(f.record, { ...operation, body: { ...operation.body, operationId: id(31) } })).toThrow();
  });

  it("retains a confirmed noncurrent receipt and its original grant token after completing local reconciliation", () => {
    const f = fixture(); registered(f);
    const identity = f.store.read(f.record)!;
    const body: BotRecoveryGrant = {
      botRecoveryVersion: 1, serviceOrigin: owner.serverOrigin, recoveryIdentity: identity.recoveryIdentity,
      operationId: id(31), expectedHostingGeneration: "1", sessionId: f.record.intent!.sessionId!, testExecutionId: f.record.intent!.executionId,
      nativeSessionId: null, controllerToken: `dncontroller_${Buffer.alloc(32, 1).toString("base64url")}`,
      grant: { protocol: "daynight.session.v1", testExecutionId: f.record.intent!.executionId, controllerId: f.record.intent!.registration.controllerId,
        controllerInstanceId: f.record.intent!.controllerInstanceId, executionGeneration: "1", kind: "reconnect", previousGeneration: null, stopProof: null },
    };
    const operation = { kind: "takeover" as const, workerId: id(90), body };
    f.store.prepare(f.record, operation);
    const historical = { ...result(f, operation), current: false };
    f.store.recordResult(f.record, body.operationId, historical);
    const complete = f.store.finishOperation(f.record, body.operationId);
    expect(complete).toMatchObject({ current: historical, currentOperation: { ...operation, result: historical }, pending: null });
    f.local.close(); const reopened = f.open({ ...owner, workerId: id(90) });
    expect(reopened.store.read(f.record)).toEqual(complete);
    expect((reopened.store.read(f.record)!.currentOperation!.body as BotRecoveryGrant).controllerToken).toBe(body.controllerToken);
  });

  it.each(["worker", "operation", "session", "native", "hosting", "version"])("rejects a mismatched %s registration receipt without losing pending evidence", field => {
    const f = fixture(), operation = registration(f);
    f.store.prepare(f.record, operation);
    const response = result(f, operation);
    if (field === "worker") response.receipt.workerId = id(90);
    if (field === "operation") response.receipt.operationId = id(90);
    if (field === "session") response.receipt.sessionId = id(90);
    if (field === "native") response.receipt.nativeSessionId = id(90);
    if (field === "hosting") response.receipt.hostingGeneration = "2";
    if (field === "version") response.receipt.botVersion = "2";
    expect(() => f.store.recordResult(f.record, operation.body.operationId, response)).toThrow();
    expect(f.store.read(f.record)?.pending).toEqual({ ...operation, result: null });
  });

  it("requires the original account and a currently held Bot lock for every access", () => {
    const f = fixture(); registration(f);
    const content = readFileSync(f.file, "utf8");
    expect(() => f.store.read({ ...f.record, owner: { ...owner, ownerUserId: id(90) } })).toThrow();
    expect(() => f.store.read({ ...f.record, owner: { ...owner, serverOrigin: "https://other.example" } })).toThrow();
    f.local.close();
    expect(() => f.store.read(f.record)).toThrow(/closed|closing/);
    expect(readFileSync(f.file, "utf8")).toBe(content);
  });

  it("preserves corrupted recovery evidence and refuses a redirected secret file", () => {
    const f = fixture();
    writeFileSync(f.file, "original corrupt bytes", { mode: 0o600 });
    expect(() => f.store.ensureIdentity(f.record)).toThrow(/unreadable/);
    expect(readFileSync(f.file, "utf8")).toBe("original corrupt bytes");
    rmSync(f.file);
    const target = path.join(f.home, "unrelated"); writeFileSync(target, "untouched", { mode: 0o600 });
    if (process.platform !== "win32") {
      symlinkSync(target, f.file);
      expect(() => f.store.ensureIdentity(f.record)).toThrow(/private physical/);
      expect(readFileSync(target, "utf8")).toBe("untouched");
    } else {
      mkdirSync(f.file);
      expect(() => f.store.ensureIdentity(f.record)).toThrow(/private physical/);
      expect(existsSync(f.file)).toBe(true);
    }
  });

  it("rejects a changed body under the original operation ID and prevents reusing a finished registration", () => {
    const f = fixture(), operation = registration(f);
    f.store.prepare(f.record, operation);
    expect(() => f.store.prepare(f.record, { ...operation, body: { ...(operation.body as BotRecoveryRegistration), botVersion: "3" } })).toThrow();
    f.store.recordResult(f.record, operation.body.operationId, result(f, operation));
    f.store.finishOperation(f.record, operation.body.operationId);
    expect(() => f.store.prepare(f.record, operation)).toThrow();
  });

  it.each(["resource_conflict", "session_conflict", "version_conflict", "archive_conflict"] as const)("retains an exact %s rejection across Worker replacement without rewriting native execution evidence", code => {
    const f = fixture(), operation = registration(f);
    const terminal = { ...rejection, code };
    f.local.executions.prepare(f.record); f.local.executions.update(f.record, { launchSubmission: "unknown" });
    const execution = f.local.executions.get(f.record);
    f.store.prepare(f.record, operation);
    const rejected = f.store.rejectOperation(f.record, operation.body.operationId, terminal);
    expect(rejected).toMatchObject({ pending: null, registration: null, current: null,
      rejections: [{ operation: { ...operation, result: null }, rejection: terminal }] });
    f.local.close();
    const reopened = f.open({ ...owner, workerId: id(90) });
    const original = reopened.local.scan().records[0]!;
    expect(original).toEqual(f.record);
    expect(reopened.local.executions.get(original)).toEqual(execution);
    expect(reopened.store.read(original)).toEqual(rejected);
    expect(() => reopened.store.prepare(original, operation)).toThrow();
    const next = { ...operation, body: { ...operation.body, operationId: id(31) } };
    reopened.store.prepare(original, next);
    reopened.store.rejectOperation(original, next.body.operationId, { ...terminal, requestId: "bot-recovery-conflict-2" });
    expect(reopened.store.read(original)?.rejections.map(item => item.operation.body.operationId)).toEqual([operation.body.operationId, next.body.operationId]);
    expect(reopened.store.read(original)?.rejections.map(item => item.rejection.code)).toEqual([code, code]);
    expect(() => reopened.store.prepare(original, operation)).toThrow();
    expect(() => reopened.store.prepare(original, next)).toThrow();
  });

  it.each(["before publication", "after publication"])("observes the original rejection operation after a failure %s without repeating its write", point => {
    const f = fixture(), operation = registration(f), original = durableJson.writeDurableJson;
    const pending = f.store.prepare(f.record, operation);
    const writes = vi.spyOn(durableJson, "writeDurableJson").mockImplementationOnce((file, value) => {
      if (point === "after publication") original(file, value);
      throw new Error("rejection publication result unavailable");
    });
    expect(() => f.store.rejectOperation(f.record, operation.body.operationId, rejection)).toThrow("rejection publication result unavailable");
    expect(writes).toHaveBeenCalledTimes(1);
    f.local.close();
    const reopened = f.open(), observed = reopened.store.read(f.record)!;
    expect(writes).toHaveBeenCalledTimes(1);
    if (point === "before publication") {
      expect(observed).toEqual(pending);
      expect(() => reopened.store.prepare(f.record, { ...operation, body: { ...operation.body, operationId: id(31) } })).toThrow();
      expect(() => reopened.store.finishOperation(f.record, operation.body.operationId)).toThrow();
      expect(reopened.store.read(f.record)?.pending?.body).toEqual(operation.body);
    } else {
      expect(observed.pending).toBeNull();
      expect(observed.rejections).toEqual([{ operation: { ...operation, result: null }, rejection }]);
      expect(() => reopened.store.rejectOperation(f.record, operation.body.operationId, rejection)).toThrow();
      expect(() => reopened.store.prepare(f.record, operation)).toThrow();
      expect(writes).toHaveBeenCalledTimes(1);
      const next = { ...operation, body: { ...operation.body, operationId: id(31) } };
      reopened.store.prepare(f.record, next);
      expect(reopened.store.read(f.record)?.rejections).toEqual(observed.rejections);
      expect(reopened.store.read(f.record)?.pending?.body).toEqual(next.body);
    }
  });

  it("reads schema 1 evidence without rejection history and normalizes it on the next authorized write", () => {
    const f = fixture(), operation = registration(f);
    const state = f.store.prepare(f.record, operation), { rejections: _rejections, ...legacy } = state;
    writeFileSync(f.file, JSON.stringify(legacy), { mode: 0o600 });
    expect(f.store.read(f.record)).toEqual({ ...legacy, rejections: [] });
    f.store.rejectOperation(f.record, operation.body.operationId, rejection);
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    expect(saved.rejections).toEqual([{ operation: { ...operation, result: null }, rejection }]);
    expect(saved.pending).toBeNull();
  });

  it("preserves readable pending evidence when retaining its rejection would exceed the publication budget", () => {
    const f = fixture(), operation = registration(f), limit = 256 * 1024;
    const state = f.store.prepare(f.record, operation);
    const historical: BotRecoveryRejectedOperation = {
      operation: { ...operation, body: { ...operation.body, operationId: id(100), nativeSessionId: "x" }, result: null }, rejection,
    };
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
    // Populate one bounded file in memory; no repeated persistence or stress loop.
    const count = Math.floor((limit - bytes(state)) / (bytes(historical) + 1)) - 1;
    state.rejections = Array.from({ length: count }, (_, index) => ({ ...historical,
      operation: { ...historical.operation, body: { ...historical.operation.body, operationId: id(100 + index) } },
    }));
    state.rejections[count - 1]!.operation.body.nativeSessionId = "x".repeat(limit - 8 - bytes(state) + 1);
    const before = Buffer.from(JSON.stringify(state), "utf8");
    expect(before.byteLength).toBe(limit - 8);
    expect(bytes({ ...state, pending: null, rejections: [...state.rejections, { operation: { ...operation, result: null }, rejection }] })).toBeGreaterThan(limit);
    writeFileSync(f.file, before, { mode: 0o600 });
    expect(f.store.read(f.record)).toEqual(state);
    const writes = vi.spyOn(durableJson, "writeDurableJson");
    expect(() => f.store.rejectOperation(f.record, operation.body.operationId, rejection)).toThrow(/exceeds its byte limit/);
    expect(writes).not.toHaveBeenCalled();
    expect(readFileSync(f.file)).toEqual(before);
    expect(f.store.read(f.record)).toEqual(state);
    expect(f.store.read(f.record)?.pending?.body).toEqual(operation.body);
  });

  it.each([
    { ...rejection, status: 503 },
    { ...rejection, code: "forbidden" },
    { ...rejection, code: "unknown_conflict" },
    { ...rejection, requestId: "" },
    { ...rejection, requestId: "a".repeat(65) },
    { ...rejection, requestId: "request\nsecret" },
    { ...rejection, message: "server reflected secret" },
  ])("refuses unrecognized terminal rejection evidence %# without clearing pending", input => {
    const f = fixture(), operation = registration(f);
    f.store.prepare(f.record, operation);
    const before = readFileSync(f.file, "utf8");
    expect(() => f.store.rejectOperation(f.record, operation.body.operationId, input as BotRecoveryRejection)).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(before).not.toContain("server reflected secret");
  });

  it("does not reject another operation or replace an already confirmed receipt with rejection", () => {
    const f = fixture(), operation = registration(f);
    f.store.prepare(f.record, operation);
    expect(() => f.store.rejectOperation(f.record, id(90), rejection)).toThrow();
    f.store.recordResult(f.record, operation.body.operationId, result(f, operation));
    const before = readFileSync(f.file, "utf8");
    expect(() => f.store.rejectOperation(f.record, operation.body.operationId, rejection)).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(before);
  });

  it("rejects duplicate or foreign-session terminal history when reopening its original evidence", () => {
    const f = fixture(), operation = registration(f);
    f.store.prepare(f.record, operation);
    const state = f.store.rejectOperation(f.record, operation.body.operationId, rejection);
    writeFileSync(f.file, JSON.stringify({ ...state, rejections: [...state.rejections, ...state.rejections] }), { mode: 0o600 });
    expect(() => f.store.read(f.record)).toThrow();
    const foreign = { ...state, rejections: [{ operation: { ...operation, body: { ...operation.body, sessionId: id(90) }, result: null }, rejection }] };
    writeFileSync(f.file, JSON.stringify(foreign), { mode: 0o600 });
    expect(() => f.store.read(f.record)).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(JSON.stringify(foreign));
  });
});
