import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BotRecoveryRejectedError, createBotRecoveryApi } from "../../../src/commands/worker/bots/recovery-api.js";
import { ApiError } from "../../../src/api/client.js";
import type { BotRecoveryGrant, BotRecoveryIdentity, BotRecoveryReceipt, BotRecoveryRegistration } from "../../../src/commands/worker/bots/recovery-protocol.js";
import type { BotDefinition, BotRecord } from "../../../src/commands/worker/bots/types.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition = (): BotDefinition => ({ id: id(3), workerId: id(2), version: "9007199254740993", deletion: null,
  ownerUserId: id(1), name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: id(2), cwd: "/ordinary", provider: "codex", model: null, args: [] },
  roleConfiguration: null, sessionId: id(4), testExecutionId: id(5), startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
const signal = () => new AbortController().signal;
const controllerToken = `dncontroller_${Buffer.alloc(32, 2).toString("base64url")}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = async (handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void, limits?: Parameters<typeof createBotRecoveryApi>[0]["limits"]) => {
  const requests: { url: string; body: unknown; method: string }[] = [];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Daynight-User-ID", id(1));
    let raw = ""; req.setEncoding("utf8"); req.on("data", chunk => { raw += chunk; });
    req.on("end", () => { const body: unknown = raw === "" ? undefined : JSON.parse(raw); requests.push({ url: req.url!, body, method: req.method! }); handler(req, res, body); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
  const owner = { serverOrigin: `http://127.0.0.1:${address.port}`, ownerUserId: id(1), workerId: id(20) };
  const bot = definition();
  const record: BotRecord = { owner: { ...owner, workerId: id(2) }, botId: bot.id, observed: bot, definition: bot, observedAt: 1, intent: null };
  const identity: BotRecoveryIdentity = { botRecoveryVersion: 1, serviceOrigin: owner.serverOrigin, recoveryIdentity: Buffer.alloc(32, 1).toString("base64url") };
  const registration: BotRecoveryRegistration = { ...identity, operationId: id(6), botVersion: bot.version, sessionId: id(4), testExecutionId: id(5), nativeSessionId: id(11) };
  const grant: BotRecoveryGrant = { ...identity, operationId: id(6), sessionId: id(4), testExecutionId: id(5), nativeSessionId: id(11), expectedHostingGeneration: "9007199254740993", controllerToken,
    grant: { protocol: "daynight.session.v1", testExecutionId: id(5), controllerId: id(7), controllerInstanceId: id(8), executionGeneration: "1", kind: "reconnect", previousGeneration: null, stopProof: null } };
  return { owner, record, identity, registration, grant, requests, api: createBotRecoveryApi({ owner, serverToken: "fixture-current-token", ...(limits === undefined ? {} : { limits }) }) };
};
const receipt = (kind: "register" | "takeover" | "grant" = "register"): BotRecoveryReceipt => ({ botRecoveryVersion: 1, operationId: id(6), kind, workerId: kind === "register" ? id(2) : id(20),
  hostingGeneration: kind === "register" ? "1" : kind === "takeover" ? "9007199254740994" : "9007199254740993", botVersion: "9007199254740994",
  sessionId: id(4), testExecutionId: id(5), nativeSessionId: id(11), executionGeneration: "1", controllerId: id(7), controllerInstanceId: id(8),
  grantExpiresAt: kind === "register" ? null : "2099-01-01T00:00:00Z", controllerTokenHash: kind === "register" ? null : createHash("sha256").update(controllerToken).digest("hex") });
const observation = () => ({ schemaVersion: 1, botId: id(3), botVersion: "9007199254740993", workerId: id(2), machine: { id: id(15), name: "Original machine" }, provider: "codex",
  sessionId: id(4), testExecutionId: id(5), nativeSessionId: id(11), hostingGeneration: null, executionGeneration: "1", connectionEpoch: "1",
  state: "recovering", reason: "connection_expired", observedAt: "2026-11-20T00:00:00Z", workerLastSeenAt: "2026-11-20T00:00:00Z", sessionLastSeenAt: null, freshUntil: null, currentTurnId: null });
const attachNative = (record: BotRecord, nativeSessionId: string): void => {
  record.intent = { botVersion: record.observed.version,
    registration: { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, registrationId: id(16), testExecutionId: id(5), controllerId: id(7), controllerInstanceId: id(8), provider: "codex", initialInput: "none" },
    launchId: id(9), executionId: id(5), initialOperationId: id(10), controllerInstanceId: id(8), sessionId: id(4), executionGeneration: "1", nativeSessionId,
    ticketPath: "/private/ticket.json", journalPath: "/private/journal.sqlite", credentialFile: "/private/credential.json", recoveryLimit: 3, roleConfiguration: null };
};

describe("Bot recovery HTTP boundary", () => {
  it("registers the original Worker with current authentication and exact version", async () => {
    const f = await listen((req, res) => { expect(req.headers.authorization).toBe("Bearer fixture-current-token"); res.end(JSON.stringify({ receipt: receipt(), current: true })); });
    expect(await f.api.register(f.record, f.registration, signal())).toEqual({ receipt: receipt(), current: true });
    expect(f.requests).toEqual([{ method: "POST", url: `/api/v1/me/workers/${id(2)}/bots/${id(3)}/recovery/v1/register`, body: f.registration }]);
    expect(f.record.owner.workerId).toBe(id(2)); expect(f.record.definition!.resolvedConfiguration.workerId).toBe(id(2));
  });

  it.each(["takeover", "grant"] as const)("sends %s to the new Worker without changing original identities", async kind => {
    const f = await listen((_req, res) => res.end(JSON.stringify({ receipt: receipt(kind), current: true })));
    expect((await f.api[kind](f.record, f.grant, signal())).receipt.hostingGeneration).toBe(receipt(kind).hostingGeneration);
    expect(f.requests).toEqual([{ method: "POST", url: `/api/v1/me/workers/${id(20)}/bots/${id(3)}/recovery/v1/${kind}`, body: f.grant }]);
  });

  it("queries a historical operation with its original Worker and returns current=false unchanged", async () => {
    const f = await listen((_req, res) => res.end(JSON.stringify({ receipt: receipt(), current: false })));
    expect((await f.api.operation(f.record, id(2), id(6), f.identity, signal())).current).toBe(false);
    expect(f.requests).toEqual([{ method: "POST", url: `/api/v1/me/workers/${id(2)}/bots/${id(3)}/recovery/v1/operations/${id(6)}`, body: f.identity }]);
    expect(JSON.stringify(f.requests[0]!.url)).not.toContain(f.identity.recoveryIdentity);
  });

  it("reads a recovery report as the immutable original Bot DTO", async () => {
    const reported: BotDefinition = { ...definition(), version: "9007199254740994", startupResult: { state: "ready", code: null } };
    const f = await listen((_req, res) => res.end(JSON.stringify(reported)));
    const input = { ...f.identity, hostingGeneration: "9007199254740994", report: { botVersion: definition().version,
      fence: { sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", connectionEpoch: "2" }, controllerId: id(7), controllerInstanceId: id(8), nativeSessionId: id(11), result: { state: "ready" as const, code: null } } };
    expect(await f.api.report(f.record, input, signal())).toEqual(reported);
    expect(f.requests[0]!.url).toBe(`/api/v1/me/workers/${id(20)}/bots/${id(3)}/recovery/v1/report`);
  });

  it.each(["service", "account", "bot", "session", "execution"])("rejects conflicting %s before sending a recovery request", async mismatch => {
    const f = await listen((_req, res) => res.end(JSON.stringify({ receipt: receipt(), current: true })));
    if (mismatch === "service") f.registration.serviceOrigin = "https://other.example";
    if (mismatch === "account") f.record.owner.ownerUserId = id(90);
    if (mismatch === "bot") f.record.botId = id(90);
    if (mismatch === "session") f.registration.sessionId = id(90);
    if (mismatch === "execution") f.registration.testExecutionId = id(90);
    await expect(f.api.register(f.record, f.registration, signal())).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it.each(["operation", "worker", "session", "native", "controller", "instance", "generation", "hosting", "token", "kind"])("rejects a mismatched %s grant receipt", async mismatch => {
    const value = receipt("takeover");
    if (mismatch === "operation") value.operationId = id(90);
    if (mismatch === "worker") value.workerId = id(90);
    if (mismatch === "session") value.sessionId = id(90);
    if (mismatch === "native") value.nativeSessionId = id(90);
    if (mismatch === "controller") value.controllerId = id(90);
    if (mismatch === "instance") value.controllerInstanceId = id(90);
    if (mismatch === "generation") value.executionGeneration = "2";
    if (mismatch === "hosting") value.hostingGeneration = "9007199254740995";
    if (mismatch === "token") value.controllerTokenHash = "a".repeat(64);
    if (mismatch === "kind") value.kind = "grant";
    const f = await listen((_req, res) => res.end(JSON.stringify({ receipt: value, current: true })));
    await expect(f.api.takeover(f.record, f.grant, signal())).rejects.toThrow(/conflicts/);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["principal", "content-type", "json", "utf8", "extra", "bytes"])("rejects %s response failures without retrying", async failure => {
    const f = await listen((_req, res) => {
      if (failure === "principal") res.setHeader("Daynight-User-ID", id(90));
      if (failure === "content-type") res.setHeader("Content-Type", "text/html");
      if (failure === "json") { res.end("not-json"); return; }
      if (failure === "utf8") { res.end(Buffer.from([0xff])); return; }
      if (failure === "bytes") { res.end(" ".repeat(1025)); return; }
      res.end(JSON.stringify({ receipt: receipt(), current: true, ...(failure === "extra" ? { extra: true } : {}) }));
    }, failure === "bytes" ? { responseBytes: 1024 } : undefined);
    await expect(f.api.register(f.record, f.registration, signal())).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });

  it.each([[403, "forbidden"], [409, "resource_conflict"], [503, "outcome_unknown"], [404, "not_found"]] as const)("preserves %i %s without echoing secret response text or replaying", async (status, code) => {
    const reflected = `private-${controllerToken}`;
    const f = await listen((_req, res) => { res.statusCode = status; res.end(JSON.stringify({ error: { code, message: reflected, requestId: id(40) } })); });
    const action = status === 404 ? f.api.operation(f.record, id(2), id(6), f.identity, signal()) : f.api.register(f.record, f.registration, signal());
    const error = await action.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status, code }); expect(String(error)).not.toContain(reflected);
    expect(f.requests).toHaveLength(1);
  });

  it("retains a timeout as an unknown transport outcome and never repeats the POST", async () => {
    const f = await listen((_req, res) => { res.flushHeaders(); res.write("{"); }, { requestMs: 300 });
    await expect(f.api.register(f.record, f.registration, signal())).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });

  it("cancels an observed in-flight request without a second submission", async () => {
    let observed!: () => void; const started = new Promise<void>(resolve => { observed = resolve; });
    const f = await listen((_req, res) => { res.flushHeaders(); observed(); });
    const cancellation = new AbortController();
    const result = f.api.register(f.record, f.registration, cancellation.signal);
    await started; cancellation.abort();
    await expect(result).rejects.toThrow(); expect(f.requests).toHaveLength(1);
  });

  it("rejects an oversized request before sending recovery credentials", async () => {
    const f = await listen((_req, res) => res.end(JSON.stringify({ receipt: receipt(), current: true })));
    f.registration.nativeSessionId = "x".repeat(1024 * 1024);
    await expect(f.api.register(f.record, f.registration, signal())).rejects.toMatchObject({ kind: "request_limit" });
    expect(f.requests).toEqual([]);
  });

  it("does not follow a redirect or repeat a request whose connection closes", async () => {
    const f = await listen((_req, res) => { res.statusCode = 307; res.setHeader("Location", "/unexpected-target"); res.end(); });
    await expect(f.api.register(f.record, f.registration, signal())).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    const closed = await listen((req, _res) => { req.socket.destroy(); });
    await expect(closed.api.register(closed.record, closed.registration, signal())).rejects.toThrow();
    expect(closed.requests).toHaveLength(1);
  });

  it("reads the Bot observation with the current PAT without accessing the old parent-protected Session", async () => {
    const f = await listen((req, res) => { expect(req.headers.authorization).toBe("Bearer fixture-current-token"); res.end(JSON.stringify(observation())); });
    expect(await f.api.observation(f.record, signal())).toEqual({ sessionId: id(4), testExecutionId: id(5), nativeSessionId: id(11), executionGeneration: "1",
      botVersion: "9007199254740993", workerId: id(2), provider: "codex", hostingGeneration: null });
    expect(f.requests).toEqual([{ url: `/api/v1/me/bots/${id(3)}/observation`, method: "GET", body: undefined }]);
  });

  it.each(["bot", "session", "execution", "provider", "generation", "version"])("rejects an observation with conflicting %s", async mismatch => {
    const value: Record<string, unknown> = observation();
    if (mismatch === "bot") value.botId = id(90);
    if (mismatch === "session") value.sessionId = id(90);
    if (mismatch === "execution") value.testExecutionId = id(90);
    if (mismatch === "provider") value.provider = "claude";
    if (mismatch === "generation") value.executionGeneration = null;
    if (mismatch === "version") value.botVersion = "1";
    const f = await listen((_req, res) => res.end(JSON.stringify(value)));
    await expect(f.api.observation(f.record, signal())).rejects.toThrow(/conflicts/);
    expect(f.requests).toHaveLength(1);
  });

  it("keeps a locally protected native identity while using the service's still-null binding", async () => {
    const f = await listen((req, res) => res.end(JSON.stringify(req.method === "GET" ? { ...observation(), nativeSessionId: null } : { receipt: { ...receipt(), nativeSessionId: null }, current: true })));
    attachNative(f.record, id(11));
    expect((await f.api.observation(f.record, signal())).nativeSessionId).toBeNull();
    await f.api.register(f.record, { ...f.registration, nativeSessionId: null }, signal());
    expect(f.record.intent!.nativeSessionId).toBe(id(11));
    expect(f.requests.map(request => request.method)).toEqual(["GET", "POST"]);
  });

  it("rejects conflicting known native identities without submitting recovery", async () => {
    const f = await listen((_req, res) => res.end(JSON.stringify({ ...observation(), nativeSessionId: id(90) })));
    attachNative(f.record, id(11));
    await expect(f.api.observation(f.record, signal())).rejects.toThrow(/conflicts/);
    await expect(f.api.register(f.record, { ...f.registration, nativeSessionId: id(90) }, signal())).rejects.toThrow(/original Session binding/);
    expect(f.requests.map(request => request.method)).toEqual(["GET"]);
  });

  it.each(["register", "grant", "takeover"] as const)("classifies only a complete original %s conflict response as proven noncommit", async action => {
    const f = await listen((_req, res) => { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "resource_conflict", requestId: id(40), message: "Changed binding" } })); });
    const pending = action === "register" ? f.api.register(f.record, f.registration, signal()) : f.api[action](f.record, f.grant, signal());
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BotRecoveryRejectedError);
    expect(error).toMatchObject({ status: 409, code: "resource_conflict", requestId: id(40), writeOutcome: "not_committed", confirmedRefusal: true });
    expect(f.requests).toHaveLength(1);
  });

  it.each(["operation", "report", "observation"] as const)("does not classify a %s conflict as the original mutation's noncommit", async action => {
    const f = await listen((_req, res) => { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "resource_conflict", requestId: id(40), message: "Changed" } })); });
    const pending = action === "operation" ? f.api.operation(f.record, id(2), id(6), f.identity, signal())
      : action === "observation" ? f.api.observation(f.record, signal())
      : f.api.report(f.record, { ...f.identity, hostingGeneration: "1", report: { botVersion: f.record.observed.version, fence: null, controllerId: "", controllerInstanceId: "", nativeSessionId: null, result: { state: "failed", code: "unavailable" } } }, signal());
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError); expect(error).not.toBeInstanceOf(BotRecoveryRejectedError);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["principal", "content-type", "json", "additional-field", "unknown-details"])("does not infer noncommit from a conflicting response with invalid %s", async defect => {
    const f = await listen((_req, res) => {
      res.statusCode = 409;
      if (defect === "principal") res.setHeader("Daynight-User-ID", id(90));
      if (defect === "content-type") res.setHeader("Content-Type", "text/plain");
      if (defect === "json") { res.end("broken"); return; }
      res.end(JSON.stringify({ error: { code: "resource_conflict", requestId: id(40), message: "Changed", ...(defect === "unknown-details" ? { details: { unexpected: true } } : {}) }, ...(defect === "additional-field" ? { unexpected: true } : {}) }));
    });
    const error = await f.api.register(f.record, f.registration, signal()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(BotRecoveryRejectedError);
    expect(f.requests).toHaveLength(1);
  });
});
