import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBotSessionApi } from "../../../src/commands/worker/bots/session-api.js";
import type { BotDefinition, BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { SessionSnapshot } from "../../../src/session/protocol.js";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const role = { instructions: "Frozen role", revision: "first", digest: createHash("sha256").update("Frozen role").digest("hex") };
const owner = { serverOrigin: "http://127.0.0.1:1", ownerUserId: id(1), workerId: id(2) };
const definition = (): BotDefinition => ({ id: id(3), ownerUserId: id(1), workerId: id(2), version: "9007199254740993", deletion: null, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: id(2), cwd: "/ordinary", provider: "codex", model: null, args: [] }, roleConfiguration: role, sessionId: id(4), testExecutionId: id(5), startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
const record = (): BotRecord => ({ owner, botId: id(3), observed: definition(), definition: definition(), observedAt: 1, intent: { botVersion: "1", registration: { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, registrationId: id(6), testExecutionId: id(5), controllerId: id(7), controllerInstanceId: id(8), provider: "codex", initialInput: "none" }, launchId: id(9), executionId: id(5), initialOperationId: id(10), sessionId: id(4), executionGeneration: "1", nativeSessionId: null, ticketPath: "/private/ticket.json", journalPath: "/private/journal.sqlite", credentialFile: "/private/credential.json", recoveryLimit: 3, roleConfiguration: role } });
const snapshot = (): SessionSnapshot => ({ protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", connectionEpoch: "2", identity: { ownerUserId: id(1), controllerId: id(7), controllerInstanceId: id(8), agentControlMode: "web", provider: "codex", nativeSessionId: id(11) }, sessionRevision: "3", historyEpoch: id(12), lastEventSeq: "1", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: true, lifecycle: "active", connectionState: "connected", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: true }, operations: { canSend: true, canCancel: false, canRespond: true } });
const credential = () => ({ sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", controllerId: id(7), controllerInstanceId: id(8), token: "relay-secret", expiresAt: "2099-01-01T00:00:00Z" });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = async (handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void) => {
  const server = createServer((request, response) => {
    response.setHeader("Daynight-User-ID", id(1)); response.setHeader("Content-Type", "application/json");
    let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
    request.on("end", () => handler(request, response, body ? JSON.parse(body) : undefined));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
  const binding = { ...owner, serverOrigin: `http://127.0.0.1:${address.port}` };
  return { api: createBotSessionApi({ owner: binding, serverToken: "fixture-token" }), record: { ...record(), owner: binding } };
};
const signal = () => new AbortController().signal;

describe("Bot lifecycle HTTP client", () => {
  it("replays the exact original registration version and frozen role even after the Bot version advanced", async () => {
    let payload: unknown;
    const fixture = await listen((request, response, body) => {
      expect(request.url).toBe(`/api/v1/me/workers/${id(2)}/bots/${id(3)}/register`);
      expect(request.headers.authorization).toBe("Bearer fixture-token"); payload = body;
      response.end(JSON.stringify({ bot: definition(), session: snapshot() }));
    });
    const result = await fixture.api.register(fixture.record, signal());
    expect(payload).toEqual({ botVersion: "1", registration: fixture.record.intent!.registration, configuration: definition().resolvedConfiguration, roleConfiguration: role });
    expect(result.bot.version).toBe("9007199254740993"); expect(result.snapshot.sessionId).toBe(id(4));
  });

  it.each(["owner", "execution", "generation", "role", "configuration", "bot"])("rejects registration with conflicting %s", async mismatch => {
    const bot = definition(), session = { ...snapshot() };
    if (mismatch === "owner") session.identity = { ownerUserId: id(90), controllerId: id(7), controllerInstanceId: id(8), agentControlMode: "web", provider: "codex", nativeSessionId: id(11) };
    if (mismatch === "execution") session.testExecutionId = id(90);
    if (mismatch === "generation") session.executionGeneration = "2";
    if (mismatch === "role") bot.roleConfiguration = { ...role, revision: "upgrade" };
    if (mismatch === "configuration") bot.resolvedConfiguration.cwd = "/another";
    if (mismatch === "bot") bot.id = id(90);
    const fixture = await listen((_request, response) => response.end(JSON.stringify({ bot, session })));
    await expect(fixture.api.register(fixture.record, signal())).rejects.toThrow();
  });

  it("uses current Bot version and observed native identity for a reconnect grant", async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    const fixture = await listen((request, response, body) => {
      requests.push({ method: request.method!, url: request.url!, body });
      response.end(JSON.stringify(request.method === "GET" ? snapshot() : credential()));
    });
    expect(await fixture.api.grant(fixture.record, signal())).toEqual(credential());
    expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
    expect(requests[0]!.url).toBe(`/api/v1/test-sessions/${id(4)}`);
    expect(requests[1]!.body).toEqual({ botVersion: "9007199254740993", nativeSessionId: id(11), grant: { protocol: "daynight.session.v1", testExecutionId: id(5), controllerId: id(7), controllerInstanceId: id(8), executionGeneration: "1", kind: "reconnect", previousGeneration: null, stopProof: null } });
  });

  it.each(["expired", "execution", "controller"])("rejects a %s grant", async mismatch => {
    const grant = credential();
    if (mismatch === "expired") grant.expiresAt = "2000-01-01T00:00:00Z";
    if (mismatch === "execution") grant.testExecutionId = id(90);
    if (mismatch === "controller") grant.controllerId = id(90);
    const fixture = await listen((request, response) => response.end(JSON.stringify(request.method === "GET" ? snapshot() : grant)));
    await expect(fixture.api.grant(fixture.record, signal())).rejects.toThrow();
  });

  it("reports ready only with the current synchronized Session fence and exact native identity", async () => {
    let payload: unknown;
    const fixture = await listen((request, response, body) => {
      payload = body; response.end(JSON.stringify(request.method === "GET" ? snapshot() : { ...definition(), version: "9007199254740994", startupResult: { state: "ready", code: null } }));
    });
    const result = await fixture.api.report(fixture.record, { state: "ready", nativeSessionId: id(11) }, signal());
    expect(payload).toEqual({ botVersion: "9007199254740993", fence: { sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", connectionEpoch: "2" }, controllerId: id(7), controllerInstanceId: id(8), nativeSessionId: id(11), result: { state: "ready", code: null } });
    expect(result.deletion === null && result.startupResult.state).toBe("ready");
  });

  it.each(["unsynchronized", "native"])("does not report ready from %s evidence", async mismatch => {
    let posts = 0;
    const session = { ...snapshot() };
    if (mismatch === "unsynchronized") { session.synchronized = false; session.operations = { canSend: false, canCancel: false, canRespond: false }; }
    const fixture = await listen((request, response) => { if (request.method === "POST") posts++; response.end(JSON.stringify(session)); });
    await expect(fixture.api.report(fixture.record, { state: "ready", nativeSessionId: mismatch === "native" ? id(99) : id(11) }, signal())).rejects.toThrow();
    expect(posts).toBe(0);
  });

  it("reports a pre-registration configuration failure without inventing a Session", async () => {
    let payload: unknown;
    const unbound = { ...definition(), sessionId: null, testExecutionId: null, roleConfiguration: null };
    const fixture = await listen((_request, response, body) => { payload = body; response.end(JSON.stringify({ ...unbound, version: "9007199254740994", startupResult: { state: "failed", code: "invalid_configuration" } })); });
    fixture.record.observed = unbound; fixture.record.definition = unbound; fixture.record.intent = null;
    await fixture.api.report(fixture.record, { state: "failed", code: "invalid_configuration" }, signal());
    expect(payload).toEqual({ botVersion: "9007199254740993", fence: null, controllerId: "", controllerInstanceId: "", nativeSessionId: null, result: { state: "failed", code: "invalid_configuration" } });
  });

  it("does not repeat registration after its response is lost", async () => {
    let requests = 0;
    const fixture = await listen((request) => { requests++; request.socket.destroy(); });
    await expect(fixture.api.register(fixture.record, signal())).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it.each(["principal", "oversize", "json", "utf8", "redirect", "status"])("refuses %s HTTP responses without retrying", async mismatch => {
    let requests = 0;
    const fixture = await listen((_request, response) => {
      requests++;
      if (mismatch === "principal") response.setHeader("Daynight-User-ID", id(99));
      if (mismatch === "redirect") { response.statusCode = 302; response.setHeader("Location", "/other"); }
      if (mismatch === "status") response.statusCode = 503;
      response.end(mismatch === "oversize" ? JSON.stringify("x".repeat(2 * 1024 * 1024)) : mismatch === "json" ? "broken" : mismatch === "utf8" ? Buffer.from([0xff]) : JSON.stringify(snapshot()));
    });
    await expect(fixture.api.readSession(fixture.record, signal())).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("rejects canceled calls and mismatched local ownership before HTTP", async () => {
    let requests = 0;
    const fixture = await listen((_request, response) => { requests++; response.end(JSON.stringify(snapshot())); });
    await expect(fixture.api.readSession(fixture.record, AbortSignal.abort())).rejects.toThrow();
    fixture.record.owner = { ...fixture.record.owner, ownerUserId: id(99) };
    await expect(fixture.api.register(fixture.record, signal())).rejects.toThrow();
    expect(requests).toBe(0);
  });
});
