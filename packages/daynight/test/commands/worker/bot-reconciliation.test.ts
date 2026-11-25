import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotRecoveryStore } from "../../../src/commands/worker/bots/recovery-store.js";
import { createBotRecoveryApi } from "../../../src/commands/worker/bots/recovery-api.js";
import { createBotReconciliation } from "../../../src/commands/worker/bots/reconciliation.js";
import { createBotSessionApi } from "../../../src/commands/worker/bots/session-api.js";
import type { BotRecoveryGrant, BotRecoveryReceipt, BotRecoveryRegistration } from "../../../src/commands/worker/bots/recovery-protocol.js";
import type { SessionSnapshot } from "../../../src/session/protocol.js";
import { definition, id } from "./bot-execution-store.fixtures.js";

const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-reconciliation-tests");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const signal = () => new AbortController().signal;
type Request = { action: string; workerId: string; body: BotRecoveryRegistration | BotRecoveryGrant; auth: string };
const fixture = async () => {
  const requests: Request[] = [], operations = new Map<string, { receipt: BotRecoveryReceipt; auth: string }>();
  let hostingWorker = id(2), hostingGeneration = "1", botVersion = "2", selected: string | null = null;
  const fault: { drop: string | null; refuse: string | null; missingQueries: boolean; expired: boolean; parentRevoked: boolean; canSubmit: boolean; advanceNative: boolean; advanceVersion: boolean; archiveBusy: boolean; conflictResponse: "normal" | "drop" | "malformed"; queryConflict: boolean } = { drop: null, refuse: null, missingQueries: false, expired: false, parentRevoked: false, canSubmit: true, advanceNative: false, advanceVersion: false, archiveBusy: false, conflictResponse: "normal", queryConflict: false };
  const ordinaryReads: string[] = [];
  const observations: string[] = [];
  let record!: ReturnType<ReturnType<typeof openLocalBotStores>["store"]["get"]>;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Daynight-User-ID", id(1));
    let raw = ""; req.setEncoding("utf8"); req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "GET") {
        if (req.url!.endsWith("/observation")) {
          observations.push(req.url!);
          res.end(JSON.stringify({ schemaVersion: 1, botId: id(3), botVersion, workerId: hostingWorker, machine: null, provider: "codex",
            sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId, nativeSessionId: snapshot.identity.nativeSessionId,
            hostingGeneration: operations.size === 0 ? null : hostingGeneration, executionGeneration: snapshot.executionGeneration, connectionEpoch: snapshot.connectionEpoch,
            state: "recovering", reason: "startup_pending", observedAt: "2026-11-20T00:00:00Z", workerLastSeenAt: null, sessionLastSeenAt: null, freshUntil: null, currentTurnId: null }));
          if (fault.advanceNative) { fault.advanceNative = false; snapshot = { ...snapshot, identity: { ...snapshot.identity, nativeSessionId: id(11) } }; }
          if (fault.advanceVersion) { fault.advanceVersion = false; botVersion = (BigInt(botVersion) + 1n).toString(); }
          return;
        }
        ordinaryReads.push(req.url!);
        if (fault.parentRevoked) { res.statusCode = 403; res.end(JSON.stringify({ error: { code: "forbidden", message: "Original parent PAT was revoked", requestId: id(90) } })); return; }
        res.end(JSON.stringify({ session: snapshot })); return;
      }
      const route = req.url!.split("/"), workerId = route[5]!, action = route[10]!;
      const body = JSON.parse(raw) as BotRecoveryRegistration | BotRecoveryGrant;
      const auth = req.headers.authorization!; requests.push({ action, workerId, body, auth });
      if (fault.refuse === action) { res.statusCode = 403; res.end(JSON.stringify({ error: { code: "forbidden", message: "Current credential denied", requestId: id(90) } })); return; }
      if (action === "operations") {
        if (fault.queryConflict) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "resource_conflict", message: "Query conflict", requestId: id(90) } })); return; }
        const operation = operations.get(route[11]!);
        if (operation === undefined || fault.missingQueries) { res.statusCode = 404; res.end(JSON.stringify({ error: { code: "not_found", message: "Unknown operation", requestId: id(90) } })); return; }
        const receipt = operation.receipt;
        const current = receipt.kind === "register" ? receipt.workerId === hostingWorker : selected === receipt.operationId && operation.auth === auth && !fault.expired;
        res.end(JSON.stringify({ receipt, current })); return;
      }
      if (action === "report") {
        const report = body as unknown as { report: { result: { state: string; code: string | null } } };
        botVersion = (BigInt(botVersion) + 1n).toString();
        res.end(JSON.stringify({ ...record!.definition!, version: botVersion, startupResult: report.report.result })); return;
      }
      if (action !== "register" && action !== "grant" && action !== "takeover") { res.statusCode = 404; res.end("{}"); return; }
      if (body.nativeSessionId !== snapshot.identity.nativeSessionId) {
        if (fault.conflictResponse === "drop") { req.socket.destroy(); return; }
        res.statusCode = 409;
        res.end(fault.conflictResponse === "malformed" ? "{invalid" : JSON.stringify({ error: { code: "session_conflict", message: "Native binding changed before transaction", requestId: id(90) } }));
        return;
      }
      if (action === "register" && (body as BotRecoveryRegistration).botVersion !== botVersion) {
        res.statusCode = 409; res.end(JSON.stringify({ error: { code: "version_conflict", message: "Bot version changed", requestId: id(90) } })); return;
      }
      if (action !== "register" && fault.archiveBusy) {
        fault.archiveBusy = false;
        res.statusCode = 409; res.end(JSON.stringify({ error: { code: "archive_conflict", message: "Active history has an IO lease", requestId: id(90) } })); return;
      }
      if (action === "register") botVersion = (BigInt(botVersion) + 1n).toString();
      if (action === "takeover") { hostingGeneration = (BigInt(hostingGeneration) + 1n).toString(); hostingWorker = workerId; botVersion = (BigInt(botVersion) + 1n).toString(); }
      const grant = action === "register" ? null : (body as BotRecoveryGrant).grant;
      if (grant !== null) {
        fault.parentRevoked = false;
        snapshot = { ...snapshot, executionGeneration: grant.executionGeneration, identity: { ...snapshot.identity, controllerInstanceId: grant.controllerInstanceId } };
      }
      const receipt: BotRecoveryReceipt = { botRecoveryVersion: 1, operationId: body.operationId, kind: action, workerId,
        hostingGeneration, botVersion, sessionId: body.sessionId, testExecutionId: body.testExecutionId, nativeSessionId: body.nativeSessionId,
        executionGeneration: snapshot.executionGeneration,
        controllerId: snapshot.identity.controllerId,
        controllerInstanceId: snapshot.identity.controllerInstanceId,
        grantExpiresAt: grant === null ? null : "2099-01-01T00:00:00Z", controllerTokenHash: grant === null ? null : createHash("sha256").update((body as BotRecoveryGrant).controllerToken).digest("hex") };
      operations.set(body.operationId, { receipt, auth }); if (grant !== null) selected = body.operationId;
      if (fault.drop === action) { fault.drop = null; req.socket.destroy(); return; }
      res.end(JSON.stringify({ receipt, current: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
  mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "case-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const stateDirectory = resolveConfigurationPaths(home).stateDirectory;
  const owner = { serverOrigin: `http://127.0.0.1:${address.port}`, ownerUserId: id(1), workerId: id(2) };
  const open = (workerId: string, token: string) => {
    const current = { ...owner, workerId };
    const local = openLocalBotStores({ owner: current, stateDirectory, legacyDatabaseFile: path.join(stateDirectory, "worker", "state.sqlite"), onMigration: () => {} });
    cleanups.push(local.close);
    const store = openBotRecoveryStore({ owner: current, stateDirectory, assertLocked: local.assertLocked });
    const api = createBotRecoveryApi({ owner: current, serverToken: token });
    const reconciliation = createBotReconciliation({ owner: current, store, api, canSubmit: () => fault.canSubmit });
    return { local, store, api, reconciliation, sessionApi: createBotSessionApi({ owner: current, serverToken: token, recovery: reconciliation }) };
  };
  let active = open(owner.workerId, "first-current-token");
  active.local.store.observe(owner, definition(), 1);
  active.local.store.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 3 });
  const intent = active.local.store.get(owner, id(3))!.intent!;
  record = active.local.store.observe(owner, { ...definition(), version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
  let snapshot: SessionSnapshot = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: id(4), testExecutionId: intent.executionId,
    executionGeneration: "1", connectionEpoch: "1", identity: { ownerUserId: id(1), controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: id(11) },
    sessionRevision: "1", historyEpoch: id(12), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false,
    lifecycle: "active", connectionState: "disconnected", activity: "unknown", currentTurnId: null,
    capabilities: { send: true, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
  record = { ...record!, intent: { ...record!.intent!, nativeSessionId: id(11) } };
  const binding = { sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId, nativeSessionId: snapshot.identity.nativeSessionId };
  return { requests, operations, observations, fault, get snapshot() { return snapshot; }, setSnapshot: (value: SessionSnapshot) => { snapshot = value; }, binding, ordinaryReads, owner, record: record!,
    get active() { return active; },
    restart: (workerId = owner.workerId, token = "first-current-token") => { active.local.close(); active = open(workerId, token); expect(active.local.scan().records[0]!.owner).toEqual(owner); return active; },
  };
};

describe("Bot hosting reconciliation with durable storage and HTTP", () => {
  it.each([false, true])("initialization deletion checks the original grant ledger even when a later renewal is refused (earlier commit %s)", async committed => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    const original = { ...f.record, intent: { ...f.record.intent!, nativeSessionId: null } };
    await f.active.sessionApi.grant(original, signal());
    const previous = { generation: "1", instanceId: original.intent.controllerInstanceId, recordId: id(75), stoppedAt: "2026-01-01T00:00:00Z",
      initializationEvidence: { version: 1 as const, state: "not_dispatched" as const } };
    const retry = { ...original, intent: { ...original.intent, executionGeneration: "2", controllerInstanceId: id(76) } };
    if (committed) {
      f.fault.drop = "grant";
      await expect(f.active.sessionApi.grant(retry, signal(), previous)).rejects.toThrow();
      expect(f.active.sessionApi.initializationGrantUncommitted(retry)).toBe(false);
      f.fault.expired = true;
    }
    f.fault.archiveBusy = true;
    await expect(f.active.sessionApi.grant(retry, signal(), previous)).rejects.toMatchObject({ writeOutcome: "not_committed" });
    const restarted = f.restart();
    expect(restarted.sessionApi.initializationGrantUncommitted(retry)).toBe(!committed);
    expect(restarted.sessionApi.initializationGrantAcknowledged(retry)).toBe(committed);
    expect(restarted.store.read(retry)!.pending).toBeNull();
  });
  it("retains the exact initialization retry operation after a lost grant and resumes the same generation after restart", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    const original = { ...f.record, intent: { ...f.record.intent!, nativeSessionId: null } };
    await f.active.sessionApi.grant(original, signal());
    const previous = { generation: "1", instanceId: original.intent.controllerInstanceId, recordId: id(75), stoppedAt: "2026-01-01T00:00:00Z",
      initializationEvidence: { version: 1 as const, state: "not_dispatched" as const } };
    const retry = { ...original, intent: { ...original.intent, executionGeneration: "2", controllerInstanceId: id(76) } };
    f.fault.drop = "grant";
    await expect(f.active.sessionApi.grant(retry, signal(), previous)).rejects.toThrow();
    const pending = f.active.store.read(retry)!.pending!;
    expect(pending.body).toMatchObject({ initializationEvidence: previous.initializationEvidence, nativeSessionId: null });
    const requests = f.requests.filter(request => request.action === "grant").length;
    await f.restart().sessionApi.grant(retry, signal(), previous);
    expect(f.requests.filter(request => request.action === "grant")).toHaveLength(requests);
    expect(f.active.store.read(retry)!.pending).toBeNull();
    expect(f.snapshot.executionGeneration).toBe("2");
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: id(11) } });
    const ready = { ...retry, intent: { ...retry.intent, nativeSessionId: id(11) } };
    await f.restart(id(2), "renewed-current-token").sessionApi.grant(ready, signal());
    const renewed = f.requests.at(-1)!.body as BotRecoveryGrant;
    expect(renewed.initializationEvidence).toBeUndefined();
    expect(renewed.grant.previousGeneration).toBeNull();
    expect(renewed.nativeSessionId).toBe(id(11));
  });
  it("reconfirms stopped initialization hosting after restart before reporting the original failure", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    const original = { ...f.record, intent: { ...f.record.intent!, nativeSessionId: null } };
    await f.active.sessionApi.grant(original, signal());
    const active = f.restart();
    expect(active.reconciliation.ready(original)).toBe(false);
    await expect(active.sessionApi.report(original, { state: "failed", code: "initialization_evidence_missing" }, signal())).resolves.toMatchObject({ startupResult: { state: "failed", code: "initialization_evidence_missing" } });
    expect(active.reconciliation.ready(original)).toBe(true);
    expect(f.requests.at(-1)!.action).toBe("report");
  });
  it("waits for current local evidence when the service native identity is ahead of the cache", async () => {
    const f = await fixture();
    const cached = { ...f.record, intent: { ...f.record.intent!, nativeSessionId: null } };
    await expect(f.active.sessionApi.grant(cached, signal())).rejects.toThrow("matching current service");
    expect(f.requests).toEqual([]); expect(f.active.store.read(cached)!.pending).toBeNull();
    await expect(f.active.sessionApi.grant(f.record, signal())).resolves.toMatchObject({ sessionId: f.binding.sessionId });
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant"]);
  });

  it("restores a revoked parent using service null without replacing the Controller's known native identity", async () => {
    const f = await fixture(); f.fault.parentRevoked = true;
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    const originalIntent = { ...f.record.intent! };
    await f.active.sessionApi.grant(f.record, signal());
    expect(f.requests.map(request => request.body.nativeSessionId)).toEqual([null, null]);
    expect(f.record.intent).toEqual(originalIntent);
    expect(f.ordinaryReads).toEqual([]); expect(f.fault.parentRevoked).toBe(false);
    // The same Controller can publish the identity it already owns after renewal.
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: id(11) }, synchronized: true, connectionState: "connected", activity: "idle" });
    await expect(f.active.sessionApi.report(f.record, { state: "ready", nativeSessionId: id(11) }, signal())).resolves.toMatchObject({ startupResult: { state: "ready" } });
  });

  it("grants and renews a lazy native Session while both committed and local identities remain null", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    const lazy = { ...f.record, intent: { ...f.record.intent!, nativeSessionId: null } };
    const first = await f.active.sessionApi.grant(lazy, signal());
    const renewed = f.restart(id(2), "replacement-current-token");
    const second = await renewed.sessionApi.grant(lazy, signal());
    expect(second.token).not.toBe(first.token);
    expect(f.requests.filter(request => request.action === "grant").map(request => request.body.nativeSessionId)).toEqual([null, null]);
    expect(lazy.intent.nativeSessionId).toBeNull();
  });

  it("retains a definite precommit conflict and observes again before a new operation after restart", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    f.fault.advanceNative = true;
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toMatchObject({ status: 409, code: "session_conflict", writeOutcome: "not_committed" });
    const state = f.active.store.read(f.record)!;
    expect(state.pending).toBeNull(); expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]!.rejection.code).toBe("session_conflict");
    const rejected = state.rejections[0]!.operation;
    expect(rejected.body.nativeSessionId).toBeNull(); expect(f.requests).toHaveLength(1);
    const before = f.observations.length;
    await f.restart().sessionApi.grant(f.record, signal());
    expect(f.observations.length).toBeGreaterThan(before);
    expect(f.requests.map(request => request.action)).toEqual(["register", "register", "grant"]);
    expect(f.requests[1]!.body.operationId).not.toBe(rejected.body.operationId);
    expect(f.active.store.read(f.record)!.rejections).toEqual(state.rejections);
  });

  it("retains the actual registration version conflict and observes a fresh version after restart", async () => {
    const f = await fixture(); f.fault.advanceVersion = true;
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toMatchObject({ status: 409, code: "version_conflict", writeOutcome: "not_committed" });
    const rejected = f.active.store.read(f.record)!.rejections[0]!;
    expect(rejected.rejection.code).toBe("version_conflict");
    expect(f.active.store.read(f.record)!.pending).toBeNull();
    await f.restart().sessionApi.grant(f.record, signal());
    expect(f.requests.map(request => request.action)).toEqual(["register", "register", "grant"]);
    expect(f.requests[1]!.body).toMatchObject({ botVersion: "3" });
    expect(f.requests[1]!.body.operationId).not.toBe(rejected.operation.body.operationId);
    expect(f.active.store.read(f.record)!.rejections).toEqual([rejected]);
  });

  it("retries generation recovery with a new operation after a confirmed archive lease conflict", async () => {
    const f = await fixture(); await f.active.sessionApi.grant(f.record, signal());
    const previous = { generation: "1", instanceId: f.record.intent!.controllerInstanceId, recordId: id(50), stoppedAt: "2026-01-01T00:00:00Z" };
    const next = { ...f.record, intent: { ...f.record.intent!, executionGeneration: "2", controllerInstanceId: id(51) } };
    f.fault.archiveBusy = true;
    await expect(f.active.sessionApi.grant(next, signal(), previous)).rejects.toMatchObject({ status: 409, code: "archive_conflict", writeOutcome: "not_committed" });
    const rejected = f.active.store.read(next)!.rejections[0]!;
    expect(rejected.rejection.code).toBe("archive_conflict");
    expect(f.active.store.read(next)!.pending).toBeNull();
    expect(f.snapshot.executionGeneration).toBe("1");
    await expect(f.restart().sessionApi.grant(next, signal(), previous)).resolves.toMatchObject({ executionGeneration: "2" });
    expect(f.requests.at(-1)!.body.operationId).not.toBe(rejected.operation.body.operationId);
    expect(f.requests.at(-1)!.body).toMatchObject({ grant: { previousGeneration: "1", stopProof: { recordId: previous.recordId } } });
    expect(f.active.store.read(next)!.rejections).toEqual([rejected]);
  });

  it("registers the stopped predecessor before granting an unregistered dedicated Bot's next generation", async () => {
    const f = await fixture();
    const previous = { generation: "1", instanceId: f.record.intent!.controllerInstanceId, recordId: id(50), stoppedAt: "2026-01-01T00:00:00Z" };
    const next = { ...f.record, intent: { ...f.record.intent!, executionGeneration: "2", controllerInstanceId: id(51) } };
    await expect(f.active.sessionApi.grant(next, signal())).rejects.toThrow("matching current service");
    expect(f.requests).toEqual([]);
    await expect(f.active.sessionApi.grant(next, signal(), previous)).resolves.toMatchObject({ executionGeneration: "2", controllerInstanceId: id(51) });
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant"]);
    expect(f.active.store.read(next)!.registration!.receipt).toMatchObject({ executionGeneration: "1", controllerInstanceId: previous.instanceId });
    expect(f.requests[0]!.body).not.toHaveProperty("grant");
    expect(f.requests[1]!.body).toMatchObject({ grant: { previousGeneration: "1", stopProof: { recordId: previous.recordId } } });
    expect(f.record.intent!.nativeSessionId).toBe(next.intent.nativeSessionId);
  });

  it("rejects an unregistered predecessor whose service generation differs from the verified stop proof", async () => {
    const f = await fixture();
    const previous = { generation: "2", instanceId: id(52), recordId: id(50), stoppedAt: "2026-01-01T00:00:00Z" };
    const next = { ...f.record, intent: { ...f.record.intent!, executionGeneration: "3", controllerInstanceId: id(51) } };
    await expect(f.active.sessionApi.grant(next, signal(), previous)).rejects.toThrow("matching current service");
    expect(f.requests).toEqual([]); expect(f.active.store.read(next)!.pending).toBeNull();
  });

  it.each(["drop", "malformed"] as const)("keeps a raced binding with a %s response query-only", async conflictResponse => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    f.fault.advanceNative = true; f.fault.conflictResponse = conflictResponse;
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!;
    const before = f.observations.length;
    const rebuilt = f.restart();
    await expect(rebuilt.sessionApi.grant(f.record, signal())).rejects.toMatchObject({ code: "not_found" });
    expect(f.observations).toHaveLength(before);
    expect(rebuilt.store.read(f.record)).toMatchObject({ pending, rejections: [] });
    f.fault.queryConflict = true;
    await expect(rebuilt.sessionApi.grant(f.record, signal())).rejects.toMatchObject({ status: 409, code: "resource_conflict" });
    expect(rebuilt.store.read(f.record)).toMatchObject({ pending, rejections: [] });
    expect(f.requests.map(request => request.action)).toEqual(["register", "operations", "operations"]);
  });

  it("preserves pending when the definite rejection cannot be published durably", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    f.fault.advanceNative = true;
    const persist = vi.spyOn(f.active.store, "rejectOperation").mockImplementation(() => { throw new Error("Rejection publication failed"); });
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toThrow("Rejection publication failed");
    const pending = f.active.store.read(f.record)!.pending!; persist.mockRestore();
    await expect(f.restart().sessionApi.grant(f.record, signal())).rejects.toMatchObject({ code: "not_found" });
    expect(f.active.store.read(f.record)).toMatchObject({ pending, rejections: [] });
    expect(f.requests.map(request => request.action)).toEqual(["register", "operations"]);
  });

  it("does not prepare a new generation before the service retains the predecessor native identity", async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, nativeSessionId: null } });
    await f.active.sessionApi.grant(f.record, signal());
    const previous = { generation: "1", instanceId: f.record.intent!.controllerInstanceId, recordId: id(50), stoppedAt: "2026-01-01T00:00:00Z" };
    const next = { ...f.record, intent: { ...f.record.intent!, executionGeneration: "2", controllerInstanceId: id(51) } };
    await expect(f.active.sessionApi.grant(next, signal(), previous)).rejects.toThrow("service to retain its original native");
    expect(f.active.store.read(next)!.pending).toBeNull();
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
  });

  it("registers and restores a revoked parent through the production Session API before ordinary reads", async () => {
    const f = await fixture(); f.fault.parentRevoked = true;
    await expect(f.active.sessionApi.readSession(f.record, signal())).rejects.toMatchObject({ code: "forbidden" });
    f.ordinaryReads.length = 0;
    await f.active.sessionApi.registerRecovery(f.record, signal());
    expect(f.fault.parentRevoked).toBe(true);
    const grant = await f.active.sessionApi.grant(f.record, signal());
    expect(f.ordinaryReads).toEqual([]);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant"]);
    expect(f.requests.every(request => request.body.sessionId === f.binding.sessionId && request.body.nativeSessionId === f.binding.nativeSessionId)).toBe(true);
    expect(grant).toMatchObject({ sessionId: f.binding.sessionId, testExecutionId: f.binding.testExecutionId });
    await expect(f.active.sessionApi.readSession(f.record, signal())).resolves.toEqual(f.snapshot);
    await expect(f.active.sessionApi.report(f.record, { state: "ready" }, signal())).rejects.toThrow("synchronized active Session");
    f.setSnapshot({ ...f.snapshot, synchronized: true, connectionState: "connected", activity: "idle" });
    await expect(f.active.sessionApi.report(f.record, { state: "ready" }, signal())).resolves.toMatchObject({ startupResult: { state: "ready" } });
  });

  it("renews through the production Session API with a replacement PAT while ordinary access is denied", async () => {
    const f = await fixture(); const initial = await f.active.sessionApi.grant(f.record, signal());
    f.fault.parentRevoked = true;
    const renewed = f.restart(id(2), "replacement-current-token");
    const grant = await renewed.sessionApi.grant(f.record, signal());
    expect(f.ordinaryReads).toEqual([]);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "grant"]);
    expect(grant.token).not.toBe(initial.token);
    expect(f.requests.at(-1)!.auth).toBe("Bearer replacement-current-token");
    await expect(renewed.sessionApi.readSession(f.record, signal())).resolves.toEqual(f.snapshot);
  });

  it("queries a lost generation grant before renewing with its exact predecessor proof under a replacement PAT", async () => {
    const f = await fixture(); await f.active.sessionApi.grant(f.record, signal());
    const previous = { generation: "1", instanceId: f.record.intent!.controllerInstanceId, recordId: id(50), stoppedAt: "2026-01-01T00:00:00Z" };
    const next = { ...f.record, intent: { ...f.record.intent!, executionGeneration: "2", controllerInstanceId: id(51) } };
    f.fault.drop = "grant";
    await expect(f.active.sessionApi.grant(next, signal(), previous)).rejects.toThrow();
    const pending = f.active.store.read(next)!.pending!;
    f.fault.parentRevoked = true;
    const renewed = f.restart(id(2), "replacement-current-token");
    const start = f.requests.length;
    const grant = await renewed.sessionApi.grant(next, signal(), previous);
    expect(f.ordinaryReads).toEqual([]);
    expect(f.requests.slice(start).map(request => request.action)).toEqual(["operations", "operations", "grant"]);
    expect(f.requests.at(-1)!.body).toMatchObject({ grant: { previousGeneration: "1", executionGeneration: "2", stopProof: { recordId: previous.recordId, previousControllerInstanceId: previous.instanceId, stoppedAt: previous.stoppedAt } } });
    expect(f.requests.filter(request => request.action === "grant" && request.body.operationId === pending.body.operationId)).toHaveLength(1);
    expect(grant.executionGeneration).toBe("2");
  });

  it.each(["register", "grant", "takeover"] as const)("does not prepare %s until the Worker machine report is confirmed", async action => {
    const f = await fixture();
    if (action === "grant") await f.active.reconciliation.register(f.record, f.binding, signal());
    if (action === "takeover") { await f.active.reconciliation.grant(f.record, f.binding, signal()); f.restart(id(20)); }
    f.fault.canSubmit = false;
    const before = f.requests.length;
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toThrow("confirmed Worker machine identity report");
    expect(f.active.store.read(f.record)!.pending).toBeNull();
    expect(f.requests.slice(before).every(request => request.action === "operations")).toBe(true);
    f.fault.canSubmit = true;
    await expect(f.active.sessionApi.grant(f.record, signal())).resolves.toMatchObject({ sessionId: f.binding.sessionId });
    expect(f.requests.at(-1)!.action).toBe(action === "register" ? "grant" : action);
  });

  it("queries an unknown operation with the report gate closed without preparing a replacement", async () => {
    const f = await fixture(); f.fault.drop = "grant";
    await expect(f.active.sessionApi.grant(f.record, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!;
    f.fault.canSubmit = false; f.fault.missingQueries = true;
    const rebuilt = f.restart();
    await expect(rebuilt.sessionApi.grant(f.record, signal())).rejects.toMatchObject({ code: "not_found" });
    expect(rebuilt.store.read(f.record)!.pending).toEqual(pending);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
    f.fault.missingQueries = false;
    await expect(rebuilt.sessionApi.grant(f.record, signal())).resolves.toMatchObject({ token: (pending.body as BotRecoveryGrant).controllerToken });
    expect(rebuilt.store.read(f.record)!.pending).toBeNull();
    expect(f.requests.filter(request => request.action === "grant")).toHaveLength(1);
  });

  it("registers before granting, then reuses only a queried current grant", async () => {
    const f = await fixture();
    const granted = await f.active.reconciliation.grant(f.record, f.binding, signal());
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant"]);
    expect(f.active.store.read(f.record)).toMatchObject({ pending: null, current: { receipt: { workerId: id(2), hostingGeneration: "1" } } });
    const second = await f.restart().reconciliation.grant(f.record, f.binding, signal());
    expect(second).toEqual(granted); expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
  });

  it.each(["register", "grant"])("queries a committed %s after response loss and restart without another POST of its intent", async action => {
    const f = await fixture(); f.fault.drop = action;
    await expect(f.active.reconciliation.grant(f.record, f.binding, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!;
    const restored = f.restart();
    const grant = await restored.reconciliation.grant(f.record, f.binding, signal());
    expect(grant.sessionId).toBe(f.snapshot.sessionId);
    expect(f.requests.filter(request => request.action === action)).toHaveLength(1);
    expect(f.requests.filter(request => request.action === "operations").length).toBeGreaterThan(0);
    expect(restored.store.read(f.record)!.pending).toBeNull();
    if (action === "grant") expect(grant.token).toBe((pending.body as BotRecoveryGrant).controllerToken);
  });

  it("keeps a missing original receipt pending without a replacement registration", async () => {
    const f = await fixture(); f.fault.drop = "register";
    await expect(f.active.reconciliation.grant(f.record, f.binding, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!; f.fault.missingQueries = true;
    const restored = f.restart();
    await expect(restored.reconciliation.grant(f.record, f.binding, signal())).rejects.toMatchObject({ code: "not_found" });
    expect(restored.store.read(f.record)!.pending).toEqual(pending);
    expect(restored.reconciliation.ready(f.record)).toBe(false);
    expect(f.requests.map(request => request.action)).toEqual(["register", "operations"]);
  });

  it("takes over a Bot using only its dedicated data when the Worker identity changes", async () => {
    const f = await fixture(); const initial = await f.active.reconciliation.grant(f.record, f.binding, signal());
    const rebuilt = f.restart(id(20));
    const grant = await rebuilt.reconciliation.grant(f.record, f.binding, signal());
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "takeover"]);
    const takeover = f.requests.at(-1)!;
    expect(takeover.workerId).toBe(id(20)); expect((takeover.body as BotRecoveryGrant).expectedHostingGeneration).toBe("1");
    expect(grant).toMatchObject({ sessionId: initial.sessionId, testExecutionId: initial.testExecutionId, executionGeneration: initial.executionGeneration, controllerInstanceId: initial.controllerInstanceId });
    expect(grant.token).not.toBe(initial.token);
    expect(rebuilt.store.read(f.record)!.current!.receipt.hostingGeneration).toBe("2");
    expect(f.record.owner.workerId).toBe(id(2)); expect(f.record.definition!.resolvedConfiguration.workerId).toBe(id(2));
  });

  it("uses a new operation and token under a new PAT without reviving the old grant", async () => {
    const f = await fixture(); const initial = await f.active.reconciliation.grant(f.record, f.binding, signal());
    const oldOperation = f.active.store.read(f.record)!.currentOperation!;
    const renewed = f.restart(id(2), "replacement-current-token");
    const grant = await renewed.reconciliation.grant(f.record, f.binding, signal());
    expect(grant.token).not.toBe(initial.token);
    expect(renewed.store.read(f.record)!.currentOperation!.body.operationId).not.toBe(oldOperation.body.operationId);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "grant"]);
    expect(f.requests.at(-1)!.auth).toBe("Bearer replacement-current-token");
    expect(renewed.store.read(f.record)!.current!.receipt.hostingGeneration).toBe("1");
  });

  it("retains a rejected takeover as pending and does not report ready", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.binding, signal());
    const rebuilt = f.restart(id(20)); f.fault.refuse = "takeover";
    await expect(rebuilt.reconciliation.grant(f.record, f.binding, signal())).rejects.toMatchObject({ code: "forbidden" });
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    expect(rebuilt.store.read(f.record)!.pending!.kind).toBe("takeover");
    expect(f.requests.filter(request => request.action === "takeover")).toHaveLength(1);
  });

  it("reports startup through the confirmed current hosting while preserving original DTO identity", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.binding, signal());
    const rebuilt = f.restart(id(20)); await rebuilt.reconciliation.grant(f.record, f.binding, signal());
    const report = { botVersion: "4", fence: { sessionId: f.snapshot.sessionId, testExecutionId: f.binding.testExecutionId, executionGeneration: "1", connectionEpoch: "2" },
      controllerId: f.snapshot.identity.controllerId, controllerInstanceId: f.snapshot.identity.controllerInstanceId, nativeSessionId: id(11), result: { state: "ready" as const, code: null } };
    const bot = await rebuilt.reconciliation.report(f.record, report, signal());
    expect(bot.startupResult.state).toBe("ready"); expect(bot.workerId).toBe(id(2));
    expect(f.requests.at(-1)).toMatchObject({ action: "report", workerId: id(20), body: { hostingGeneration: "2", report } });
  });

  it("withdraws local eligibility when a retained grant expires", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.binding, signal());
    let now = Date.parse("2098-12-31T00:00:00Z");
    const expired = createBotReconciliation({ owner: f.owner, store: f.active.store, api: f.active.api, now: () => now, canSubmit: () => true });
    await expired.grant(f.record, f.binding, signal());
    expect(expired.ready(f.record)).toBe(true);
    now = Date.parse("2099-01-01T00:00:00Z");
    expect(expired.ready(f.record)).toBe(false);
    await expect(expired.report(f.record, { botVersion: "3", fence: null, controllerId: "", controllerInstanceId: "", nativeSessionId: id(11), result: { state: "failed", code: "expired" } }, signal())).rejects.toThrow();
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
  });

  it("requires a fresh receipt query after restart and withdraws eligibility after a query refusal", async () => {
    const f = await fixture();
    await f.active.reconciliation.grant(f.record, f.binding, signal());
    const durable = f.active.store.read(f.record)!;
    expect(durable.current).toMatchObject({ current: true, receipt: { grantExpiresAt: "2099-01-01T00:00:00Z" } });
    expect(f.active.reconciliation.ready(f.record)).toBe(true);
    const rebuilt = f.restart();
    expect(rebuilt.store.read(f.record)).toEqual(durable);
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    await rebuilt.reconciliation.grant(f.record, f.binding, signal());
    expect(rebuilt.reconciliation.ready(f.record)).toBe(true);
    f.fault.refuse = "operations";
    await expect(rebuilt.reconciliation.grant(f.record, f.binding, signal())).rejects.toMatchObject({ code: "forbidden" });
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    expect(rebuilt.store.read(f.record)).toEqual(durable);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "operations"]);
  });
});
