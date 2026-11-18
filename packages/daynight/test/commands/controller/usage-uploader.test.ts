import { afterEach, expect, test, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openUsageStore } from "../../../src/commands/controller/usage/store.js";
import { createUsageUploader } from "../../../src/commands/controller/usage/uploader.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const capability = { profileId: "copilot-event-1.0.11-v1", qualification: "verified", measurementPlane: "native_event", revisionAuthority: "immutable", metrics: { inputTokens: "unknown", outputTokens: "supported", cacheReadTokens: "unknown", cacheWriteTokens: "unknown", reasoningTokens: "optional", totalTokens: "unknown" }, subagents: "included_per_event", recovery: "durable_after_ingress_only", completion: "partial_only" };
const setup = async (configuration: { exactVersion?: string; capabilityStatus?: number } = {}) => {
  const db = new Database(":memory:"); cleanups.push(() => { db.close(); });
  db.exec(readFileSync(new URL("../../../src/commands/controller/sqlite/journal/014-usage.sql", import.meta.url), "utf8"));
  const store = openUsageStore(db, { read: action => action(), write: action => db.transaction(action).immediate() });
  const state = store.ensureState("1", randomUUID(), "1.0.11/1.0.105");
  const identity = { sessionId: randomUUID(), executionGeneration: "1", controllerInstanceId: randomUUID() };
  const remote = () => ({ id: state.stateId, sessionId: identity.sessionId, executionGeneration: "1", nativeSessionId: state.nativeSessionId, registrationId: state.registrationId, providerVersion: state.providerVersion, profileId: capability.profileId, provider: "copilot", rowVersion: "1" });
  const calls: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  let handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void = () => { throw new Error("Unconfigured usage request."); };
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      calls.push({ path: request.url!, auth: request.headers.authorization, body });
      if (request.url === "/api/usage/v1/capabilities") { response.statusCode = configuration.capabilityStatus ?? 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: capability.profileId, provider: "copilot", capability, qualifiedVersions: [{ providerVersion: configuration.exactVersion ?? state.providerVersion, capability }] }] })); return; }
      handler(request, response, body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No HTTP fixture address.");
  let connected = true;
  const uploader = createUsageUploader({ serverOrigin: `http://127.0.0.1:${address.port}`, store, identity, connection: () => connected ? { connectionEpoch: "3", nativeSessionId: state.nativeSessionId } : null, readParentToken: async () => "parent-token" });
  cleanups.push(() => uploader.close());
  const enqueue = () => store.enqueueMeasurement(state.stateId, { sourceKey: `copilot-event-v1:${randomUUID()}`, profileId: capability.profileId, revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted", includedInSourceKey: null, nativeTurnId: null, nativeCallId: null, model: "model", metrics: { inputTokens: null, outputTokens: "17", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null, providerTotalTokens: null }, nativeMetrics: { outputTokens: "17" }, reasonCodes: [], observedAt: new Date().toISOString() });
  const grant = () => store.saveGrant(state.stateId, { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, "1");
  const success = (body: Record<string, unknown>, mutate: (rows: Record<string, unknown>[]) => void = () => {}) => {
    const pending = store.pending(state.stateId);
    const results = pending.map(item => ({ eventId: item.eventId, sourceKey: item.payload.sourceKey ?? null, sourceRevision: item.payload.sourceRevision ?? null, stateSequence: item.payload.stateSequence ?? null, finality: item.payload.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: item.bodyHash }));
    mutate(results); return { protocol: "daynight.usage.v1", batchId: body.batchId, results, observedAt: new Date().toISOString() };
  };
  const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  return { store, state, identity, remote, calls, uploader, enqueue, grant, success, json, disconnect: () => { connected = false; }, handler: (value: typeof handler) => { handler = value; } };
};

test("registers the original connection and uploads with a separate grant and exact acknowledgement", async () => {
  const f = await setup(); f.enqueue();
  f.handler((request, response, body) => {
    if (request.method === "GET") f.json(response, { error: { code: "resource_unavailable" } }, 404);
    else if (request.url?.endsWith("registrations")) f.json(response, { state: f.remote(), grant: { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, 201);
    else f.json(response, f.success(body));
  });
  await Promise.all([f.uploader.tick(), f.uploader.tick()]);
  expect(f.store.pending(f.state.stateId)).toHaveLength(0);
  expect(f.calls.filter(call => call.path.endsWith("registrations"))).toHaveLength(1);
  expect(f.calls.find(call => call.path.endsWith("registrations"))).toMatchObject({ auth: "Bearer parent-token", body: { ...f.identity, connectionEpoch: "3", registrationId: f.state.registrationId, nativeSessionId: f.state.nativeSessionId } });
  expect(f.calls.at(-1)?.auth).toBe(`Bearer ${"g".repeat(43)}`);
  expect(f.uploader.qualified(f.state)).toBe(true);
});

test.each(["missing", "wrong-hash", "wrong-batch", "wrong-source"])("keeps every pending event after a %s success response", async flaw => {
  const f = await setup(); f.enqueue(); f.enqueue(); f.grant();
  f.handler((_request, response, body) => {
    const reply = f.success(body, rows => {
      if (flaw === "missing") rows.pop();
      if (flaw === "wrong-hash") rows[0]!.bodyHash = "f".repeat(64);
      if (flaw === "wrong-source") rows[0]!.sourceKey = "another-source";
    });
    if (flaw === "wrong-batch") reply.batchId = randomUUID();
    f.json(response, reply);
  });
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId)).toHaveLength(2);
});

test("retains durable identities through unknown upload and resends those identities", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue(); f.grant(); const original = f.store.pending(f.state.stateId)[0]!;
  let attempts = 0;
  f.handler((_request, response, body) => { if (++attempts === 1) response.destroy(); else f.json(response, f.success(body)); });
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId)[0]).toEqual(original);
  vi.setSystemTime(Date.now() + 2000); await f.uploader.tick();
  const sent = f.calls.filter(call => call.path.endsWith("batches"));
  expect(sent.map(call => call.body.events)).toEqual([[original.payload], [original.payload]]);
  expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test("observes an unknown registration without replaying its write", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue();
  f.handler((request, response) => { if (request.method === "GET") f.json(response, {}, 404); else response.destroy(); });
  await f.uploader.tick(); vi.setSystemTime(Date.now() + 2000); await f.uploader.tick();
  expect(f.calls.filter(call => call.path.endsWith("registrations"))).toHaveLength(1);
  expect(f.store.getState(f.state.stateId).reasons).toContain("registration_missing");
  expect(f.store.pending(f.state.stateId)).toHaveLength(1);
});

test.each([409, 429])("retries a proven no-write registration refusal (%i) with the original identity", async status => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue(); let registrations = 0;
  f.handler((request, response, body) => {
    if (request.method === "GET") f.json(response, {}, 404);
    else if (request.url?.endsWith("registrations")) {
      if (++registrations === 1) { response.setHeader("retry-after", "1"); f.json(response, { error: { code: "registration_unavailable" } }, status); }
      else f.json(response, { state: f.remote(), grant: { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, 201);
    } else f.json(response, f.success(body));
  });
  await f.uploader.tick(); expect(f.store.getState(f.state.stateId).registrationAttempted).toBe(false);
  vi.setSystemTime(Date.now() + 2000); await f.uploader.tick();
  expect(registrations).toBe(2); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
  const attempts = f.calls.filter(call => call.path.endsWith("registrations"));
  expect(attempts[0]?.body).toEqual(attempts[1]?.body);
});

test("retries an explicitly rate-limited grant rotation without treating it as unknown", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue(); let rotations = 0;
  f.handler((request, response, body) => {
    if (request.method === "GET") f.json(response, f.remote());
    else if (request.url?.endsWith("grant")) {
      if (++rotations === 1) { response.setHeader("retry-after", "1"); f.json(response, {}, 429); }
      else f.json(response, { state: { ...f.remote(), rowVersion: "2" }, grant: { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    } else f.json(response, f.success(body));
  });
  await f.uploader.tick(); expect(f.store.getState(f.state.stateId).grantRequestAttempted).toBe(false);
  vi.setSystemTime(Date.now() + 2000); await f.uploader.tick();
  expect(rotations).toBe(2); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test("recovers a lost registration token with one observed-version grant rotation", async () => {
  const f = await setup(); f.enqueue(); f.store.markRegistrationAttempted(f.state.stateId);
  f.handler((request, response, body) => {
    if (request.method === "GET") f.json(response, f.remote());
    else if (request.url?.endsWith("grant")) {
      expect(body).toEqual({ expectedRowVersion: "1", ...f.identity, connectionEpoch: "3" });
      f.json(response, { state: { ...f.remote(), rowVersion: "2" }, grant: { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    } else f.json(response, f.success(body));
  });
  await f.uploader.tick();
  expect(f.calls.some(call => call.path.endsWith("registrations"))).toBe(false);
  expect(f.store.getState(f.state.stateId).rowVersion).toBe("2");
  expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test("does not repeat a grant rotation whose response was lost", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue();
  f.handler((request, response) => { if (request.method === "GET") f.json(response, f.remote()); else response.destroy(); });
  await f.uploader.tick(); vi.setSystemTime(Date.now() + 2000); await f.uploader.tick();
  expect(f.calls.filter(call => call.path.endsWith("grant"))).toHaveLength(1);
  expect(f.store.getState(f.state.stateId).grantRequestAttempted).toBe(true);
  expect(f.store.pending(f.state.stateId)).toHaveLength(1);
});

test("quarantines only a proven poison event and continues unrelated sources", async () => {
  const f = await setup(); f.enqueue(); f.enqueue(); f.grant(); const poison = f.store.pending(f.state.stateId)[0]!;
  let first = true;
  f.handler((_request, response, body) => {
    if (first) { first = false; f.json(response, { error: { code: "source_conflict", eventId: poison.eventId, sourceKey: poison.payload.sourceKey } }, 409); }
    else f.json(response, f.success(body));
  });
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId).some(item => item.eventId === poison.eventId)).toBe(false);
  expect(f.store.getState(f.state.stateId).reasons).toContain("source_conflict");
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test("uploads an existing grant after its original connection has ended", async () => {
  const f = await setup(); f.enqueue(); f.grant(); f.disconnect();
  f.handler((_request, response, body) => f.json(response, f.success(body)));
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
  expect(f.calls.some(call => call.path.endsWith("registrations") || call.path.endsWith("grant"))).toBe(false);
});

test("stops after revoked upload authority without replacing it with parent authentication", async () => {
  const f = await setup(); f.enqueue(); f.grant();
  f.handler((_request, response) => f.json(response, { error: { code: "permission_revoked" } }, 403));
  await f.uploader.tick(); await f.uploader.tick();
  expect(f.calls.filter(call => call.path.endsWith("batches"))).toHaveLength(1);
  expect(f.store.getState(f.state.stateId).reasons).toContain("permission_revoked");
  expect(f.store.pending(f.state.stateId)).toHaveLength(1);
});

test("does not infer exact qualification and sends state beyond one hundred blocked measurements", async () => {
  const f = await setup({ exactVersion: "1.0.11/other-runtime" });
  for (let count = 0; count < 101; count++) f.enqueue();
  f.grant();
  const stateEvent = f.store.enqueueState(f.state.stateId, { collectionState: "unavailable", capability: { ...capability, qualification: "unverified" }, reasonCodes: ["profile_unverified"], nativeStartedAt: null, nativeEndedAt: null, observedAt: new Date().toISOString(), seal: false });
  f.handler((_request, response, body) => {
    expect(body.events).toEqual([stateEvent.payload]);
    f.json(response, { protocol: "daynight.usage.v1", batchId: body.batchId, results: [{ eventId: stateEvent.eventId, sourceKey: null, sourceRevision: null, stateSequence: "1", finality: null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: stateEvent.bodyHash }] });
  });
  await f.uploader.tick();
  expect(f.uploader.qualified(f.state)).toBe(false);
  expect(f.uploader.capability(f.state)?.qualification).toBe("unverified");
  expect(f.store.pending(f.state.stateId, 100, "execution_state")).toHaveLength(0);
  expect(f.store.pending(f.state.stateId)).toHaveLength(100);
});

test("acknowledges stale state only after reading its current revision and hash", async () => {
  const f = await setup(); f.grant();
  const body = { collectionState: "partial", capability, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: null, observedAt: new Date().toISOString(), seal: false };
  const first = f.store.enqueueState(f.state.stateId, body), last = f.store.enqueueState(f.state.stateId, body);
  f.handler((request, response, input) => {
    if (request.method === "GET") {
      expect(new URL(request.url!, "http://fixture").searchParams.getAll("key")).toHaveLength(1);
      f.json(response, { items: [], missingKeys: ["usage-state-probe-v1"], stateSequence: "2", bodyHash: last.bodyHash });
    } else f.json(response, f.success(input, rows => {
      rows.find(row => row.eventId === first.eventId)!.outcome = "stale";
      rows.find(row => row.eventId === first.eventId)!.stateSequence = "2";
      rows.find(row => row.eventId === first.eventId)!.bodyHash = last.bodyHash;
    }));
  });
  await f.uploader.tick(); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test("honors bounded Retry-After before resending durable records", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await setup(); f.enqueue(); f.grant();
  let attempts = 0;
  f.handler((_request, response, body) => {
    if (++attempts === 1) { response.writeHead(429, { "retry-after": "999999" }); response.end("{}"); }
    else f.json(response, f.success(body));
  });
  await f.uploader.tick(); vi.setSystemTime(Date.now() + 299_000); await f.uploader.tick(); expect(attempts).toBe(1);
  vi.setSystemTime(Date.now() + 1000); await f.uploader.tick(); expect(attempts).toBe(2); expect(f.store.pending(f.state.stateId)).toHaveLength(0);
});

test.each([404, 501])("disables reporting against an old service returning %i", async status => {
  const f = await setup({ capabilityStatus: status }); f.enqueue();
  await f.uploader.tick(); await f.uploader.tick();
  expect(f.calls).toHaveLength(1); expect(f.store.pending(f.state.stateId)).toHaveLength(1);
});
