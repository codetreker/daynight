import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { openUsageStore } from "../../../src/commands/controller/usage/store.js";
import { createUsageRuntime } from "../../../src/commands/controller/usage/runtime.js";
import type { UsagePayload } from "../../../src/commands/controller/usage/types.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.useRealTimers(); } });
const capability = { profileId: "copilot-event-1.0.11-v1", qualification: "verified", measurementPlane: "native_event", revisionAuthority: "immutable", metrics: { inputTokens: "unknown", outputTokens: "supported", cacheReadTokens: "unknown", cacheWriteTokens: "unknown", reasoningTokens: "optional", totalTokens: "unknown" }, subagents: "included_per_event", recovery: "durable_after_ingress_only", completion: "partial_only" };

const fixture = async (verified = true, provider: "copilot" | "codex" | "claude" = "copilot", codexResponses = false, codexVersion = "0.169.0", baseQualified = false) => {
  const profile = provider === "copilot" ? capability : provider === "claude" ? { ...capability, profileId: "claude-message-input-0.3.247-v1", measurementPlane: "root_message_input", recovery: "native_history_partial", subagents: "unknown" } : codexResponses ? { ...capability, profileId: "codex-response-0.169.0-v1", recovery: "native_history_partial", subagents: "unknown" } : { ...capability, profileId: "codex-snapshot-unaccountable-v1", qualification: "unsupported", measurementPlane: "none", revisionAuthority: "none", completion: "unsupported", recovery: "unsupported" };
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const db = new Database(":memory:"); cleanups.push(() => { db.close(); });
  db.exec(readFileSync(new URL("../../../src/commands/controller/sqlite/journal/014-usage.sql", import.meta.url), "utf8"));
  const store = openUsageStore(db, { read: action => db.transaction(action).deferred(), write: action => db.transaction(action).immediate() });
  const identity = { sessionId: randomUUID(), executionGeneration: "1", controllerInstanceId: randomUUID() };
  const native = { nativeSessionId: randomUUID(), providerVersion: provider === "copilot" ? "1.0.11/1.0.105" : provider === "claude" ? "0.3.247/2.1.247/anthropic" : codexVersion };
  const calls: string[] = [], batches: UsagePayload[][] = [];
  let holdBatch = false, release: (() => void) | null = null;
  const json = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const server = createServer((request, response) => {
    let text = ""; request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      calls.push(request.url!);
      const body = text ? JSON.parse(text) as UsagePayload : {};
      if (request.url === "/api/usage/v1/capabilities") {
        const unsupported = provider === "codex" && !codexResponses;
        const cap = { ...profile, qualification: unsupported ? "unsupported" : verified ? "verified" : "unverified" };
        json(response, { protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: profile.profileId, provider, capability: { ...profile, qualification: unsupported ? "unsupported" : baseQualified ? "verified" : "unverified" }, qualifiedVersions: verified && !baseQualified ? [{ providerVersion: native.providerVersion, capability: cap }] : [] }] });
      } else if (request.method === "GET") json(response, {}, 404);
      else if (request.url === "/api/usage/v1/registrations") {
        const state = store.states()[0]!;
        json(response, { state: { id: state.stateId, sessionId: identity.sessionId, executionGeneration: "1", nativeSessionId: native.nativeSessionId, registrationId: state.registrationId, providerVersion: native.providerVersion, profileId: profile.profileId, provider, rowVersion: "1" }, grant: { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, 201);
      } else if (request.url?.endsWith("/batches")) {
        const events = body.events as UsagePayload[]; batches.push(events);
        const state = store.states()[0]!, pending = store.pending(state.stateId);
        const reply = () => json(response, { protocol: "daynight.usage.v1", batchId: body.batchId, results: events.map(event => {
          const item = pending.find(item => item.eventId === event.eventId)!;
          return { eventId: event.eventId, sourceKey: event.sourceKey ?? null, sourceRevision: event.sourceRevision ?? null, stateSequence: event.stateSequence ?? null, finality: event.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: item.bodyHash };
        }) });
        if (holdBatch) release = reply; else reply();
      } else json(response, {}, 500);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const runtime = createUsageRuntime({ provider, serverOrigin: `http://127.0.0.1:${address.port}`, store, identity, generation: "1", connection: () => ({ connectionEpoch: "3", nativeSessionId: native.nativeSessionId }), readParentToken: async () => "parent-token" });
  cleanups.push(async () => { holdBatch = false; release?.(); release = null; await runtime.close(); });
  const advance = async () => { await vi.advanceTimersByTimeAsync(1000); };
  const event = (outputTokens: number) => ({ id: randomUUID(), type: "assistant.usage", timestamp: new Date().toISOString(), data: { model: "model", outputTokens } });
  return { runtime, store, calls, batches, native, advance, event, hold: () => { holdBatch = true; }, release: () => { holdBatch = false; release?.(); release = null; } };
};

test("ready registers a verified native identity without waiting for a model usage event", async () => {
  const f = await fixture(); f.runtime.ready(f.native); await f.advance();
  await vi.waitFor(() => expect(f.calls).toContain("/api/usage/v1/registrations"));
  await vi.waitFor(() => expect(f.store.pending(f.store.states()[0]!.stateId)).toHaveLength(1));
  expect(f.store.pending(f.store.states()[0]!.stateId)[0]!.payload).toMatchObject({ kind: "execution_state", collectionState: "collecting", seal: false });
  expect(f.batches).toEqual([]);
});

test("unsafe native numbers create an explicit integer gap without manufacturing a measurement", async () => {
  const f = await fixture(); f.runtime.ready(f.native);
  expect(() => f.runtime.observe({ ...f.native, event: f.event(Number.MAX_SAFE_INTEGER + 1) })).not.toThrow();
  const state = f.store.states()[0]!;
  expect(state.reasons).toContain("native_integer_unrepresentable");
  expect(state.reasons).not.toContain("local_storage_failed");
  expect(f.store.pending(state.stateId)).toEqual([]);
});

test("unqualified runtime retains native measurements and reports unavailable coverage", async () => {
  const f = await fixture(false); f.runtime.ready(f.native); f.runtime.observe({ ...f.native, event: f.event(7) });
  await f.advance();
  await vi.waitFor(() => expect(f.store.pending(f.store.states()[0]!.stateId)).toHaveLength(2));
  await f.advance(); await vi.waitFor(() => expect(f.batches.length).toBe(1));
  expect(f.batches[0]).toHaveLength(1);
  expect(f.batches[0]![0]).toMatchObject({ kind: "execution_state", collectionState: "unavailable", capability: { qualification: "unverified" }, reasonCodes: expect.arrayContaining(["profile_unverified"]) });
  expect(f.store.pending(f.store.states()[0]!.stateId).filter(item => item.payload.kind === "measurement")).toHaveLength(1);
});

test("an upload tick finishing during close cannot append collecting after the final seal", async () => {
  const f = await fixture(); f.runtime.ready(f.native); await f.advance();
  await vi.waitFor(() => expect(f.store.pending(f.store.states()[0]!.stateId)).toHaveLength(1));
  f.hold(); await f.advance(); await vi.waitFor(() => expect(f.batches.length).toBe(1));
  const closing = f.runtime.close();
  expect(f.store.getState(f.store.states()[0]!.stateId).stopped).toBe(true);
  f.release(); await closing;
  const pending = f.store.pending(f.store.states()[0]!.stateId);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.payload).toMatchObject({ kind: "execution_state", stateSequence: "2", collectionState: "partial", seal: true });
  expect(f.store.getState(f.store.states()[0]!.stateId).stopped).toBe(true);
});

test("Codex reports unsupported coverage without converting snapshots to measurements", async () => {
  const f = await fixture(false, "codex");
  f.store.ensureState("1", f.native.nativeSessionId, f.native.providerVersion, "codex");
  f.runtime.ready(f.native);
  f.runtime.observe({ ...f.native, event: f.event(900) });
  await f.advance();
  await vi.waitFor(() => expect(f.store.pending(f.store.states()[0]!.stateId)).toHaveLength(1));
  expect(f.store.states()[0]!.provider).toBe("codex");
  expect(f.store.states()[0]!.profileId).toBeUndefined();
  expect(f.store.pending(f.store.states()[0]!.stateId)[0]!.payload).toMatchObject({ collectionState: "unsupported", reasonCodes: ["provider_unsupported"] });
  await f.runtime.close();
  const events = f.batches.flat();
  expect(events.some(event => event.seal === true && event.collectionState === "unsupported")).toBe(true);
  expect(events.every(event => event.kind === "execution_state")).toBe(true);
});

test.each(["0.169.0", "0.170.0", "1.2.3-beta.1+build.2"])("Codex %s uploads each response once using the base qualified contract", async version => {
  const f = await fixture(true, "codex", true, version, true); f.runtime.ready(f.native); f.runtime.bindTurn("turn");
  const event = { method: "rawResponse/completed", params: { threadId: f.native.nativeSessionId, turnId: "turn", responseId: "response", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } };
  f.runtime.observe({ ...f.native, event }); f.runtime.observe({ ...f.native, event });
  const original = f.store.pending(f.store.states()[0]!.stateId, 100, "measurement");
  expect(original).toHaveLength(1); expect(original[0]!.payload.metrics).toMatchObject({ totalTokens: "110" });
  await f.advance(); await f.advance();
  await vi.waitFor(() => expect(f.batches.flat().filter(item => item.kind === "measurement")).toHaveLength(1));
  expect(f.batches.flat().find(item => item.kind === "measurement")!.eventId).toBe(original[0]!.eventId);
  f.runtime.observe({ ...f.native, event });
  expect(f.store.pending(f.store.states()[0]!.stateId, 100, "measurement")).toHaveLength(0);
});

test("Codex leaves unbound historical turns unattributed instead of charging the recovered generation", async () => {
  const f = await fixture(true, "codex", true); f.runtime.ready(f.native);
  f.runtime.observe({ ...f.native, event: { method: "rawResponse/completed", params: { threadId: f.native.nativeSessionId, turnId: "historical", responseId: "old", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } } });
  const state = f.store.states()[0]!;
  expect(f.store.pending(state.stateId, 100, "measurement")).toEqual([]);
  expect(state.reasons).toContain("attribution_unknown");
});

test("Claude durable ingress keeps known cache facts when native input precision is unavailable", async () => {
  const f = await fixture(true, "claude");
  const event = { type: "assistant", parent_tool_use_id: null, message: { id: "msg_fixed", stop_reason: "end_turn", model: "claude-fixture", usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } };
  f.runtime.observe({ ...f.native, event }); f.runtime.observe({ ...f.native, event });
  const state = f.store.states()[0]!, measurements = f.store.pending(state.stateId).filter(item => item.payload.kind === "measurement");
  expect(state.provider).toBe("claude"); expect(measurements).toHaveLength(1);
  expect(measurements[0]!.payload).toMatchObject({ sourceKey: "claude-message-input-v1:msg_fixed", metrics: { inputTokens: null, outputTokens: null, cacheReadTokens: "20", cacheWriteTokens: "30", totalTokens: null }, reasonCodes: expect.arrayContaining(["native_integer_unrepresentable"]) });
  expect(f.store.getState(state.stateId).reasons).toContain("native_integer_unrepresentable");
  await f.advance(); await vi.waitFor(() => expect(f.store.pending(state.stateId).some(item => item.payload.kind === "execution_state")).toBe(true));
  await f.runtime.close();
  expect(f.batches.flat().filter(item => item.kind === "measurement")).toHaveLength(1);
  expect(f.batches.flat().find(item => item.seal === true)).toMatchObject({ collectionState: "partial", reasonCodes: expect.arrayContaining(["native_integer_unrepresentable", "subagent_scope_unknown"]) });
});


test("new Codex states retain measurements when an older server has not qualified their contract", async () => {
  const f = await fixture(false, "codex", true, "0.170.0");
  f.runtime.ready(f.native); f.runtime.bindTurn("turn");
  f.runtime.observe({ ...f.native, event: { method: "rawResponse/completed", params: { threadId: f.native.nativeSessionId, turnId: "turn", responseId: "response", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } } });
  await f.advance();
  await vi.waitFor(() => expect(f.store.pending(f.store.states()[0]!.stateId).some(item => item.payload.kind === "execution_state")).toBe(true));
  await f.advance();
  await vi.waitFor(() => expect(f.batches.flat().some(item => item.kind === "execution_state")).toBe(true));
  expect(f.store.states()[0]!.profileId).toBe("codex-response-0.169.0-v1");
  expect(f.batches.flat().some(item => item.kind === "measurement")).toBe(false);
  expect(f.store.pending(f.store.states()[0]!.stateId, 100, "measurement")).toHaveLength(1);
});
