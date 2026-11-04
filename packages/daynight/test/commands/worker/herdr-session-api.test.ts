import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdrSessionApi } from "../../../src/commands/worker/herdr/session-api.js";
import type { SessionV2Message, SessionV2Run } from "../../../src/session/v2/types.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Registration = Extract<SessionV2Message, { type: "registration" }>;
const servers = new Set<Server>();
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler); servers.add(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test address.");
  return `http://127.0.0.1:${address.port}`;
};
const registration = (serverOrigin: string): Registration => ({
  protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: uuid(1), claimId: uuid(2), executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "registration",
  payload: { registrationId: uuid(3), mode: "register", connectionEpoch: null, owner: { projectId: uuid(4), taskId: uuid(5), workerId: uuid(6), worktreeId: uuid(7), ownerUserId: uuid(8), serverOrigin, provider: "codex" }, binding: { instanceId: "daemon-one", sessionId: "w", workspaceId: "workspace-one", paneId: "pane-one", terminalId: "terminal-one", nativeSessionId: null }, capabilities: { observe: false, control: false, archive: false } },
});
const run = (message: Registration): SessionV2Run => ({ executionGeneration: "1", owner: message.payload.owner, binding: message.payload.binding, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [] });
const ack = (message: Registration): SessionV2Message => ({ ...message, type: "registration_ack", payload: { registrationId: message.payload.registrationId, connectionEpoch: "1" } });
const state = (message: Registration) => ({ status: "registered", protocol: message.protocol, schemaVersion: 2, projectionVersion: 1, sessionId: message.sessionId, claimId: message.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", owner: message.payload.owner, binding: message.payload.binding, connectionEpoch: "1", connected: false, capabilities: message.payload.capabilities, control: null, snapshot: null, ledger: { runs: [run(message)], finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: [] });
const send = (response: ServerResponse, body: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
afterEach(async () => { await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); servers.clear(); });

describe("Herdr Session v2 client", () => {
  it("uses the Worker credential and explicit protocol, preserving the original registration", async () => {
    let captured: { url?: string; headers: IncomingMessage["headers"]; body: unknown } | undefined;
    const origin = await listen((req, res) => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as Registration; captured = { ...(req.url === undefined ? {} : { url: req.url }), headers: req.headers, body }; send(res, ack(body)); }); });
    const message = registration(origin), api = createHerdrSessionApi(origin, "worker-test-token");
    expect(await api.register(message)).toEqual(ack(message));
    expect(captured?.url).toBe(`/api/v1/projects/${uuid(4)}/tasks/${uuid(5)}/sessions`);
    expect(captured?.headers.authorization).toBe("Bearer worker-test-token");
    expect(captured?.headers["daynight-session-protocol"]).toBe("daynight.session.v2");
    expect(captured?.body).toEqual(message);
  });

  it("rejects an acknowledgement from another fence or registration", async () => {
    let response: unknown;
    const origin = await listen((_req, res) => send(res, response)), message = registration(origin), api = createHerdrSessionApi(origin, "token");
    response = { ...ack(message), claimId: uuid(99) };
    await expect(api.register(message)).rejects.toThrow();
    response = { ...ack(message), payload: { registrationId: uuid(99), connectionEpoch: "1" } };
    await expect(api.register(message)).rejects.toThrow();
  });

  it("reconnects the original run by changing only the connection epoch", async () => {
    const origin = await listen((req, res) => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as Registration; send(res, { ...ack(body), payload: { registrationId: body.payload.registrationId, connectionEpoch: "8" } }); }); });
    const original = registration(origin), message: Registration = { ...original, payload: { ...original.payload, mode: "reconnect", connectionEpoch: "7" } };
    const result = await createHerdrSessionApi(origin, "token").register(message);
    expect(result).toMatchObject({ sessionId: original.sessionId, claimId: original.claimId, executionGeneration: "1", payload: { connectionEpoch: "8" } });
  });

  it("does not repeat a dispatched request after response loss", async () => {
    let calls = 0;
    const origin = await listen((req) => { calls++; req.resume(); req.on("end", () => req.socket.destroy()); });
    await expect(createHerdrSessionApi(origin, "token").register(registration(origin))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("binds generation grants to the original connection and exact ledger acknowledgement", async () => {
    let epoch: string | string[] | undefined, replyChanged = false;
    const origin = await listen((req, res) => { epoch = req.headers["daynight-connection-epoch"]; const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as SessionV2Message; send(res, replyChanged ? { ...body, executionGeneration: "2" } : body); }); });
    const message = registration(origin), ledger: Extract<SessionV2Message, { type: "generation_ledger" }> = { ...message, type: "generation_ledger", payload: { runs: [run(message)], finalizationId: null } };
    const api = createHerdrSessionApi(origin, "token"); expect(await api.ledger(ledger, "1")).toEqual(ledger); expect(epoch).toBe("1");
    replyChanged = true; await expect(api.ledger(ledger, "1")).rejects.toThrow();
  });

  it("reads the registered state for reconciliation and rejects changed ownership", async () => {
    let response: unknown;
    const origin = await listen((_req, res) => send(res, response)), message = registration(origin), api = createHerdrSessionApi(origin, "token");
    response = state(message);
    const expected = { owner: message.payload.owner, sessionId: message.sessionId, claimId: message.claimId };
    expect(await api.state(expected)).toEqual(response);
    response = { ...state(message), owner: { ...message.payload.owner, workerId: uuid(99) } };
    await expect(api.state(expected)).rejects.toThrow();
    response = { ...state(message), ledger: { runs: [{ ...run(message), owner: { ...message.payload.owner, worktreeId: uuid(99) } }], finalizationId: null } };
    await expect(api.state(expected)).rejects.toThrow();
  });

  it("discovers a registered original claim before allowing local provenance creation", async () => {
    let response: unknown;
    const origin = await listen((_req, res) => send(res, response)), message = registration(origin), api = createHerdrSessionApi(origin, "token");
    const expected = { owner: message.payload.owner, claimId: message.claimId };
    response = state(message); expect(await api.current(expected)).toMatchObject({ status: "registered", sessionId: message.sessionId });
    response = { status: "not_registered", protocol: "daynight.session.v2", claimId: message.claimId, agentControlMode: "herdr" };
    expect(await api.current(expected)).toEqual(response);
    response = { ...response as object, claimId: uuid(99) }; await expect(api.current(expected)).rejects.toThrow();
  });

  it("rejects unsupported capabilities, malformed bytes and oversized responses", async () => {
    let raw = JSON.stringify({ protocol: "daynight.session.v1" });
    const origin = await listen((_req, res) => res.end(raw)); const api = createHerdrSessionApi(origin, "token", { maxResponseBytes: 1024 });
    await expect(api.verifySupport()).rejects.toThrow();
    raw = JSON.stringify({ protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, providers: ["codex", "claude", "copilot"], backends: ["herdr"], recordingResponsibilityVersion: 1, controlDispatchVersion: 1, workerCapabilitiesRequired: true });
    await expect(api.verifySupport()).resolves.toBeUndefined();
    raw = '{"protocol":"daynight.session.v2","protocol":"daynight.session.v1"}'; await expect(api.register(registration(origin))).rejects.toThrow();
    raw = "x".repeat(2048); await expect(api.register(registration(origin))).rejects.toThrow(/limit|large|size/i);
  });

  it("bounds unresponsive requests and rejects redirects without forwarding credentials", async () => {
    let redirect = false, calls = 0;
    const origin = await listen((_req, res) => { calls++; if (redirect) { res.statusCode = 307; res.setHeader("location", "/elsewhere"); res.end(); } });
    const api = createHerdrSessionApi(origin, "token", { timeoutMs: 30 });
    await expect(api.register(registration(origin))).rejects.toThrow(); expect(calls).toBe(1);
    redirect = true; await expect(api.register(registration(origin))).rejects.toThrow(); expect(calls).toBe(2);
  });

  it("preserves HTTP status for readback decisions without reporting response bodies", async () => {
    const origin = await listen((_req, res) => { res.statusCode = 404; res.end("private error details"); });
    const message = registration(origin);
    await expect(createHerdrSessionApi(origin, "token").state({ owner: message.payload.owner, claimId: message.claimId, sessionId: message.sessionId })).rejects.toMatchObject({ status: 404 });
  });
});
