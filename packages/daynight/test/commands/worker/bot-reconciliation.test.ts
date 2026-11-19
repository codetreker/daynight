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
  const fault: { drop: string | null; refuse: string | null; missingQueries: boolean; expired: boolean } = { drop: null, refuse: null, missingQueries: false, expired: false };
  let record!: ReturnType<ReturnType<typeof openLocalBotStores>["store"]["get"]>;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Daynight-User-ID", id(1));
    let raw = ""; req.setEncoding("utf8"); req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const route = req.url!.split("/"), workerId = route[5]!, action = route[10]!;
      const body = JSON.parse(raw) as BotRecoveryRegistration | BotRecoveryGrant;
      const auth = req.headers.authorization!; requests.push({ action, workerId, body, auth });
      if (fault.refuse === action) { res.statusCode = 403; res.end(JSON.stringify({ error: { code: "forbidden", message: "Current credential denied", requestId: id(90) } })); return; }
      if (action === "operations") {
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
      if (action === "register") botVersion = (BigInt(botVersion) + 1n).toString();
      if (action === "takeover") { hostingGeneration = (BigInt(hostingGeneration) + 1n).toString(); hostingWorker = workerId; botVersion = (BigInt(botVersion) + 1n).toString(); }
      const grant = action === "register" ? null : (body as BotRecoveryGrant).grant;
      const receipt: BotRecoveryReceipt = { botRecoveryVersion: 1, operationId: body.operationId, kind: action, workerId,
        hostingGeneration, botVersion, sessionId: body.sessionId, testExecutionId: body.testExecutionId, nativeSessionId: body.nativeSessionId,
        executionGeneration: grant?.executionGeneration ?? record!.intent!.executionGeneration,
        controllerId: grant?.controllerId ?? record!.intent!.registration.controllerId,
        controllerInstanceId: grant?.controllerInstanceId ?? record!.intent!.controllerInstanceId,
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
    return { local, store, api, reconciliation: createBotReconciliation({ owner: current, store, api }) };
  };
  let active = open(owner.workerId, "first-current-token");
  active.local.store.observe(owner, definition(), 1);
  active.local.store.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 3 });
  const intent = active.local.store.get(owner, id(3))!.intent!;
  record = active.local.store.observe(owner, { ...definition(), version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
  const snapshot: SessionSnapshot = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: id(4), testExecutionId: intent.executionId,
    executionGeneration: "1", connectionEpoch: "1", identity: { ownerUserId: id(1), controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: id(11) },
    sessionRevision: "1", historyEpoch: id(12), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false,
    lifecycle: "active", connectionState: "disconnected", activity: "unknown", currentTurnId: null,
    capabilities: { send: true, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
  return { requests, operations, fault, snapshot, owner, record: record!,
    get active() { return active; },
    restart: (workerId = owner.workerId, token = "first-current-token") => { active.local.close(); active = open(workerId, token); expect(active.local.scan().records[0]!.owner).toEqual(owner); return active; },
  };
};

describe("Bot hosting reconciliation with durable storage and HTTP", () => {
  it("registers before granting, then reuses only a queried current grant", async () => {
    const f = await fixture();
    const granted = await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant"]);
    expect(f.active.store.read(f.record)).toMatchObject({ pending: null, current: { receipt: { workerId: id(2), hostingGeneration: "1" } } });
    const second = await f.restart().reconciliation.grant(f.record, f.snapshot, signal());
    expect(second).toEqual(granted); expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
  });

  it.each(["register", "grant"])("queries a committed %s after response loss and restart without another POST of its intent", async action => {
    const f = await fixture(); f.fault.drop = action;
    await expect(f.active.reconciliation.grant(f.record, f.snapshot, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!;
    const restored = f.restart();
    const grant = await restored.reconciliation.grant(f.record, f.snapshot, signal());
    expect(grant.sessionId).toBe(f.snapshot.sessionId);
    expect(f.requests.filter(request => request.action === action)).toHaveLength(1);
    expect(f.requests.filter(request => request.action === "operations").length).toBeGreaterThan(0);
    expect(restored.store.read(f.record)!.pending).toBeNull();
    if (action === "grant") expect(grant.token).toBe((pending.body as BotRecoveryGrant).controllerToken);
  });

  it("keeps a missing original receipt pending without a replacement registration", async () => {
    const f = await fixture(); f.fault.drop = "register";
    await expect(f.active.reconciliation.grant(f.record, f.snapshot, signal())).rejects.toThrow();
    const pending = f.active.store.read(f.record)!.pending!; f.fault.missingQueries = true;
    const restored = f.restart();
    await expect(restored.reconciliation.grant(f.record, f.snapshot, signal())).rejects.toMatchObject({ code: "not_found" });
    expect(restored.store.read(f.record)!.pending).toEqual(pending);
    expect(restored.reconciliation.ready(f.record)).toBe(false);
    expect(f.requests.map(request => request.action)).toEqual(["register", "operations"]);
  });

  it("takes over a Bot using only its dedicated data when the Worker identity changes", async () => {
    const f = await fixture(); const initial = await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    const rebuilt = f.restart(id(20));
    const grant = await rebuilt.reconciliation.grant(f.record, f.snapshot, signal());
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "takeover"]);
    const takeover = f.requests.at(-1)!;
    expect(takeover.workerId).toBe(id(20)); expect((takeover.body as BotRecoveryGrant).expectedHostingGeneration).toBe("1");
    expect(grant).toMatchObject({ sessionId: initial.sessionId, testExecutionId: initial.testExecutionId, executionGeneration: initial.executionGeneration, controllerInstanceId: initial.controllerInstanceId });
    expect(grant.token).not.toBe(initial.token);
    expect(rebuilt.store.read(f.record)!.current!.receipt.hostingGeneration).toBe("2");
    expect(f.record.owner.workerId).toBe(id(2)); expect(f.record.definition!.resolvedConfiguration.workerId).toBe(id(2));
  });

  it("uses a new operation and token under a new PAT without reviving the old grant", async () => {
    const f = await fixture(); const initial = await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    const oldOperation = f.active.store.read(f.record)!.currentOperation!;
    const renewed = f.restart(id(2), "replacement-current-token");
    const grant = await renewed.reconciliation.grant(f.record, f.snapshot, signal());
    expect(grant.token).not.toBe(initial.token);
    expect(renewed.store.read(f.record)!.currentOperation!.body.operationId).not.toBe(oldOperation.body.operationId);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "grant"]);
    expect(f.requests.at(-1)!.auth).toBe("Bearer replacement-current-token");
    expect(renewed.store.read(f.record)!.current!.receipt.hostingGeneration).toBe("1");
  });

  it("retains a rejected takeover as pending and does not report ready", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    const rebuilt = f.restart(id(20)); f.fault.refuse = "takeover";
    await expect(rebuilt.reconciliation.grant(f.record, f.snapshot, signal())).rejects.toMatchObject({ code: "forbidden" });
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    expect(rebuilt.store.read(f.record)!.pending!.kind).toBe("takeover");
    expect(f.requests.filter(request => request.action === "takeover")).toHaveLength(1);
  });

  it("reports startup through the confirmed current hosting while preserving original DTO identity", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    const rebuilt = f.restart(id(20)); await rebuilt.reconciliation.grant(f.record, f.snapshot, signal());
    const report = { botVersion: "4", fence: { sessionId: f.snapshot.sessionId, testExecutionId: f.snapshot.testExecutionId, executionGeneration: "1", connectionEpoch: "2" },
      controllerId: f.snapshot.identity.controllerId, controllerInstanceId: f.snapshot.identity.controllerInstanceId, nativeSessionId: id(11), result: { state: "ready" as const, code: null } };
    const bot = await rebuilt.reconciliation.report(f.record, report, signal());
    expect(bot.startupResult.state).toBe("ready"); expect(bot.workerId).toBe(id(2));
    expect(f.requests.at(-1)).toMatchObject({ action: "report", workerId: id(20), body: { hostingGeneration: "2", report } });
  });

  it("withdraws local eligibility when a retained grant expires", async () => {
    const f = await fixture(); await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    let now = Date.parse("2098-12-31T00:00:00Z");
    const expired = createBotReconciliation({ owner: f.owner, store: f.active.store, api: f.active.api, now: () => now });
    await expired.grant(f.record, f.snapshot, signal());
    expect(expired.ready(f.record)).toBe(true);
    now = Date.parse("2099-01-01T00:00:00Z");
    expect(expired.ready(f.record)).toBe(false);
    await expect(expired.report(f.record, { botVersion: "3", fence: null, controllerId: "", controllerInstanceId: "", nativeSessionId: id(11), result: { state: "failed", code: "expired" } }, signal())).rejects.toThrow();
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations"]);
  });

  it("requires a fresh receipt query after restart and withdraws eligibility after a query refusal", async () => {
    const f = await fixture();
    await f.active.reconciliation.grant(f.record, f.snapshot, signal());
    const durable = f.active.store.read(f.record)!;
    expect(durable.current).toMatchObject({ current: true, receipt: { grantExpiresAt: "2099-01-01T00:00:00Z" } });
    expect(f.active.reconciliation.ready(f.record)).toBe(true);
    const rebuilt = f.restart();
    expect(rebuilt.store.read(f.record)).toEqual(durable);
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    await rebuilt.reconciliation.grant(f.record, f.snapshot, signal());
    expect(rebuilt.reconciliation.ready(f.record)).toBe(true);
    f.fault.refuse = "operations";
    await expect(rebuilt.reconciliation.grant(f.record, f.snapshot, signal())).rejects.toMatchObject({ code: "forbidden" });
    expect(rebuilt.reconciliation.ready(f.record)).toBe(false);
    expect(rebuilt.store.read(f.record)).toEqual(durable);
    expect(f.requests.map(request => request.action)).toEqual(["register", "grant", "operations", "operations"]);
  });
});
