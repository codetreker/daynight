import { createHash } from "node:crypto";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(async () => { vi.useRealTimers(); await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); servers.clear(); });

describe("Herdr Session v2 client", () => {
  it("keeps cleanup HTTP pending past the ordinary timeout and aborts at five minutes", async () => {
    vi.useFakeTimers();
    const pendingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    let ordinaryError: unknown, cleanupError: unknown;
    const ordinary = createHerdrSessionApi("https://daynight.example", "token", { fetch: pendingFetch }).verifySupport().catch(error => { ordinaryError = error; });
    const cleanup = createHerdrSessionApi("https://daynight.example", "token", { fetch: pendingFetch, timeoutMs: 300_000 }).verifySupport().catch(error => { cleanupError = error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ordinaryError).toBeInstanceOf(Error); expect(cleanupError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(269_999); expect(cleanupError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await Promise.all([ordinary, cleanup]);
    expect(cleanupError).toBeInstanceOf(Error); expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the enclosing operation cancel cleanup HTTP before its request deadline", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const pendingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const result = createHerdrSessionApi("https://daynight.example", "token", { fetch: pendingFetch, timeoutMs: 300_000 }).verifySupport(controller.signal).catch(error => error as unknown);
    await vi.advanceTimersByTimeAsync(45_000); const cancelled = new Error("Operation cancelled"); controller.abort(cancelled);
    expect(await result).toBe(cancelled); expect(vi.getTimerCount()).toBe(0);
  });

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

  it("aborts an unresponsive registration at its deadline without replaying it", async () => {
    vi.useFakeTimers();
    const requests: RequestInit[] = [];
    const pendingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      requests.push(init!);
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    // We control the deadline after dispatch; a wall-clock deadline cannot guarantee server arrival.
    let settled = false;
    const origin = "https://daynight.example";
    const result = createHerdrSessionApi(origin, "token", { fetch: pendingFetch, timeoutMs: 30 }).register(registration(origin)).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body as string)).toEqual(registration(origin));
    await vi.advanceTimersByTimeAsync(29);
    expect(settled).toBe(false); expect(requests[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(requests[0]!.signal!.reason);
    expect(requests[0]!.signal!.reason).toMatchObject({ message: "The Herdr Session request deadline elapsed; its result must be reconciled." });
    expect(requests).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects redirects without sending the Worker credential to the destination", async () => {
    const destinationRequests: (string | undefined)[] = [], originRequests: (string | undefined)[] = [];
    const destination = await listen((req, res) => { destinationRequests.push(req.headers.authorization); req.resume(); res.end(); });
    const origin = await listen((req, res) => { originRequests.push(req.headers.authorization); req.resume(); res.statusCode = 307; res.setHeader("location", `${destination}/elsewhere`); res.end(); });
    await expect(createHerdrSessionApi(origin, "worker-redirect-token").register(registration(origin))).rejects.toThrow();
    expect(originRequests).toEqual(["Bearer worker-redirect-token"]);
    expect(destinationRequests).toEqual([]);
  });

  it("preserves HTTP status for readback decisions without reporting response bodies", async () => {
    const origin = await listen((_req, res) => { res.statusCode = 404; res.end("private error details"); });
    const message = registration(origin);
    await expect(createHerdrSessionApi(origin, "token").state({ owner: message.payload.owner, claimId: message.claimId, sessionId: message.sessionId })).rejects.toMatchObject({ status: 404 });
  });
});

const prepareRecovery = (message: Registration) => ({ ...message, type: "automation_recovery_prepare" as const, payload: { recoveryId: uuid(30), connectionEpoch: "1", controlEpoch: "1", closingControlEpoch: "2", stopOperationId: uuid(31), binding: { ...message.payload.binding, nativeSessionId: uuid(32) }, initialAssignment: "transport_completed" as const } });
const recoveryState = (message: ReturnType<typeof prepareRecovery>) => ({ ...message, type: "automation_recovery_state" as const, payload: { recoveryId: message.payload.recoveryId, prepareDigest: createHash("sha256").update(canonicalSessionJson(message)).digest("hex"), sourceGeneration: "1", sourceConnectionEpoch: "1", sourceControlEpoch: "1", closingControlEpoch: "2", stopOperationId: uuid(31), nativeSessionId: uuid(32), consumed: null } });
const recoveryIdentity = (message: Registration) => ({ owner: message.payload.owner, sessionId: message.sessionId, claimId: message.claimId });

describe("original automation recovery decisions", () => {
  it("posts one exact prepare intent on the original epoch and verifies its digest", async () => {
    const received: { url: string | undefined; epoch: string | string[] | undefined; body: unknown }[] = [];
    let corrupt = false;
    const origin = await listen((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(Buffer.from(c))); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as ReturnType<typeof prepareRecovery>; received.push({ url: req.url, epoch: req.headers["daynight-connection-epoch"], body }); const reply = recoveryState(body); if (corrupt) reply.payload.prepareDigest = "f".repeat(64); send(res, reply); }); });
    const base = registration(origin), intent = prepareRecovery(base), api = createHerdrSessionApi(origin, "token");
    expect(await api.prepareRecovery(recoveryIdentity(base), intent)).toEqual(recoveryState(intent));
    expect(received).toEqual([{ url: `/api/v1/projects/${uuid(4)}/tasks/${uuid(5)}/sessions/${uuid(1)}/worker-messages`, epoch: "1", body: intent }]);
    corrupt = true; await expect(api.prepareRecovery(recoveryIdentity(base), intent)).rejects.toThrow();
  });
  it("reads an original consumed receipt without treating it as current automation authority", async () => {
    let response: unknown, lastPath: string | undefined;
    const origin = await listen((req, res) => { lastPath = req.url; send(res, response); });
    const base = registration(origin), api = createHerdrSessionApi(origin, "token");
    response = { ...recoveryState(prepareRecovery(base)), executionGeneration: "2", payload: { ...recoveryState(prepareRecovery(base)).payload, consumed: { executionGeneration: "2", connectionEpoch: "4", controlEpoch: "8", requestDigest: "a".repeat(64) } } };
    expect(await api.readRecovery(recoveryIdentity(base), uuid(30))).toEqual(response);
    expect(lastPath).toBe(`/api/v1/projects/${uuid(4)}/tasks/${uuid(5)}/sessions/${uuid(1)}/automation-recovery/${uuid(30)}`);
    const valid = response;
    response = { ...response as object, claimId: uuid(99) }; await expect(api.readRecovery(recoveryIdentity(base), uuid(30))).rejects.toThrow();
    response = { ...valid as object, payload: { ...(valid as ReturnType<typeof recoveryState>).payload, recoveryId: uuid(99) } }; await expect(api.readRecovery(recoveryIdentity(base), uuid(30))).rejects.toThrow();
  });
  it("binds consume acknowledgement to the new generation, epoch, and exact request", async () => {
    let reply: unknown;
    const origin = await listen((_req, res) => send(res, reply)), base = registration(origin), prepared = prepareRecovery(base);
    const message = { ...base, executionGeneration: "2", type: "automation_recovery" as const, payload: { recoveryId: uuid(30), connectionEpoch: "3", controlEpoch: "5", previousGeneration: "1", stopOperationId: uuid(31), binding: { ...prepared.payload.binding, instanceId: "second-daemon", terminalId: "second-terminal" } } };
    const consumed = { executionGeneration: "2", connectionEpoch: "3", controlEpoch: "5", requestDigest: createHash("sha256").update(canonicalSessionJson(message)).digest("hex") };
    reply = { ...recoveryState(prepared), executionGeneration: "2", payload: { ...recoveryState(prepared).payload, consumed } };
    const api = createHerdrSessionApi(origin, "token"); expect(await api.recoverAutomation(recoveryIdentity(base), message)).toEqual(reply);
    reply = { ...reply as object, payload: { ...recoveryState(prepared).payload, consumed: { ...consumed, connectionEpoch: "2" } } };
    await expect(api.recoverAutomation(recoveryIdentity(base), message)).rejects.toThrow();
  });
  it("never replays prepare after a lost HTTP response", async () => {
    let requests = 0;
    const origin = await listen(req => { requests++; req.resume(); req.on("end", () => req.socket.destroy()); });
    const base = registration(origin), api = createHerdrSessionApi(origin, "token");
    await expect(api.prepareRecovery(recoveryIdentity(base), prepareRecovery(base))).rejects.toThrow();
    expect(requests).toBe(1);
  });
});

it("publishes an original control snapshot only with an exact acknowledgement", async () => {
  let changed = false;
  const origin = await listen((req, res) => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()); if (changed) body.payload.controlEpoch = "9"; send(res, body); }); });
  const base = registration(origin), api = createHerdrSessionApi(origin, "token");
  const message = { ...base, type: "control_state" as const, payload: { connectionEpoch: "1", controlEpoch: "1", state: "automation" as const, lease: null, initialAssignment: "transport_completed" as const, availableActions: ["acquire_control" as const], unavailableReason: null } };
  expect(await api.publishControl(recoveryIdentity(base), message)).toEqual(message);
  changed = true; await expect(api.publishControl(recoveryIdentity(base), message)).rejects.toThrow();
});

it("does not replay an unconfirmed consume or infer a missing permit", async () => {
  let calls = 0, missing = false;
  const origin = await listen((req, res) => { calls++; if (missing) { res.statusCode = 404; res.end(); } else { req.resume(); req.on("end", () => req.socket.destroy()); } });
  const base = registration(origin), prepared = prepareRecovery(base), api = createHerdrSessionApi(origin, "token");
  const message = { ...base, executionGeneration: "2", type: "automation_recovery" as const, payload: { recoveryId: uuid(30), connectionEpoch: "3", controlEpoch: "5", previousGeneration: "1", stopOperationId: uuid(31), binding: { ...prepared.payload.binding, instanceId: "second", terminalId: "second" } } };
  await expect(api.recoverAutomation(recoveryIdentity(base), message)).rejects.toThrow(); expect(calls).toBe(1);
  missing = true; await expect(api.readRecovery(recoveryIdentity(base), uuid(30))).rejects.toMatchObject({ status: 404 }); expect(calls).toBe(2);
});
