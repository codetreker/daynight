import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as durableJson from "../../../src/platform/durable-json.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotRecoveryStore, type BotRecoveryOperation } from "../../../src/commands/worker/bots/recovery-store.js";
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
});
