import { test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import snapshot from "../../session/fixtures/snapshot.json" with { type: "json" };
import type { ControllerLifecycleStore, ControllerOperation } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const files = vi.hoisted(() => ({ readFile: vi.fn(), lstat: vi.fn() }));
vi.mock("node:fs/promises", () => files);
const transport = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }));
vi.mock("ws", () => ({ default: class extends EventEmitter {
  static OPEN = 1; readyState = 1; sent: unknown[] = [];
  constructor() { super(); transport.sockets.push(this); queueMicrotask(() => this.emit("open")); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
} }));
import { createControllerRelay, publicOperation } from "../../../src/commands/controller/relay.js";
import { RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
import { ImageReleaseStorageError } from "../../../src/commands/controller/media/release-error.js";
import { ImageCaptureNotDispatchedError } from "../../../src/commands/controller/media/capture-error.js";
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); transport.sockets.length = 0; vi.clearAllMocks(); });
const setup = async (operations: ControllerOperation[] = [], live = false, images = false) => {
  const historyEpoch = live ? randomUUID() : snapshot.historyEpoch;
  const ticket = { ...snapshot.identity, ...snapshot, provider: "codex", controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, executionId: randomUUID(), credentialFile: "/private/grant", serverOrigin: "http://127.0.0.1:19000" } as unknown as ControllerLaunchTicket;
  files.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 100, mode: 0o600 });
  files.readFile.mockResolvedValue(JSON.stringify({ token: "private-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }));
  const journal = { acknowledgeEvents: vi.fn(), drainProjectionGap: vi.fn(), getLastAcknowledgedSequence: () => "8", pendingEvents: () => [], markOperationAcknowledged: vi.fn(), listUnacknowledgedOperations: (limit: number, after?: string) => operations.slice(after ? operations.findIndex(o => o.operationId === after) + 1 : 0, (after ? operations.findIndex(o => o.operationId === after) + 1 : 0) + limit) } as unknown as ControllerLifecycleStore;
  let activeMediaBlocks = 0;
  const tryAcquireMediaBlock = () => {
    if (activeMediaBlocks === 2) return null;
    activeMediaBlocks++;
    let closed = false;
    return { close: () => { if (!closed) { closed = true; activeMediaBlocks--; } } };
  };
  const setMedia = (source: Record<string, unknown> | (() => Record<string, unknown>)) => {
    Object.assign(journal, { media: () => ({ ...(typeof source === "function" ? source() : source), tryAcquireMediaBlock }) });
  };
  setMedia({});
  const callbacks = { onConnection: vi.fn(), onCommand: vi.fn().mockResolvedValue(undefined), onError: vi.fn(), onRetryCapture: vi.fn<({ captureId, attemptId }: { captureId: string; attemptId: string }, signal: AbortSignal) => Promise<import("../../../src/session/image-values.js").ValidatedImage>>() };
  const relay = createControllerRelay(ticket, journal, callbacks); cleanup.push(relay.close);
  await vi.waitFor(() => expect(transport.sockets.length).toBe(1));
  const socket = transport.sockets[0]! as EventEmitter & { sent: Record<string, unknown>[]; close(): void };
  const frame = (type: string, extra = {}) => ({ protocol: snapshot.protocol, sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, connectionEpoch: "3", type, ...extra });
  const emit = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)));
  emit({ type: "welcome", protocol: snapshot.protocol, connectionEpoch: "3", session: { ...snapshot, historyEpoch, ...(images ? { contentRevision: 2, imageBudget: { revision: "1", maxBytes: "0", committedBytes: "0", reservedBytes: "0", maxResources: 0, committedResources: 0, reservedResources: 0 }, capabilities: { ...snapshot.capabilities, images: { revision: "1", providerRevision: "1", expectedNativeSessionId: null, modelId: null, controlsRevision: null, send: "unsupported", steer: "unsupported", reasonCode: "profile_disabled", inputMediaTypes: [], maxImageBytes: "0", maxMessageImageBytes: "0", maxImagesPerMessage: 0, geometry: { version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 } } } } : {}) }, lastAckedSourceSeq: "8", limits: RELAY_LIMITS, ...(live ? { requiresLiveSync: true } : {}) });
  return { relay, journal, callbacks, ticket, socket, emit, frame, historyEpoch, setMedia };
};

test("reconciliation waits for all bounded pages and retains unknown without native dispatch", async () => {
  const operations = Array.from({ length: 205 }, (_, i) => ({ operationId: randomUUID(), kind: "send_message", state: i === 0 ? "unknown" : "confirmed", result: null, error: null } as ControllerOperation));
  const { relay, socket, emit, frame, callbacks } = await setup(operations);
  const pages = () => socket.sent.filter(m => m.type === "reconcile");
  expect(pages()[0]).toMatchObject({ final: false, operations: expect.arrayContaining([expect.objectContaining({ state: "unknown" })]) });
  expect((pages()[0]!.operations as unknown[])).toHaveLength(100); expect(relay.connected()).toBe(false);
  emit(frame("reconcile_result", { operations: [] })); expect((pages()[1]!.operations as unknown[])).toHaveLength(100); expect(relay.connected()).toBe(false);
  emit(frame("reconcile_result", { operations: [] })); expect(pages()[2]).toMatchObject({ final: true }); expect((pages()[2]!.operations as unknown[])).toHaveLength(5);
  emit(frame("reconcile_result", { operations: [] })); expect(relay.connected()).toBe(true); expect(callbacks.onCommand).not.toHaveBeenCalled();
});

test("disconnect rejects an outstanding authorization and never treats begin as permission to invoke native", async () => {
  const { relay, socket, emit, frame } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const pending = relay.authorize(randomUUID()); const assertion = expect(pending).rejects.toThrow("disconnected");
  socket.close(); await assertion; expect(relay.connected()).toBe(false);
});

test("authorization retains effective image limits and the independent provider revision", async () => {
  const { relay, emit, frame } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const operationId = randomUUID();
  const imageAuthorization = { revision: "7", providerRevision: "2", expectedNativeSessionId: "native", modelId: "model", controlsRevision: "3", send: "supported", steer: "unsupported", reasonCode: null, inputMediaTypes: ["image/png"], maxImageBytes: "100", maxMessageImageBytes: "200", maxImagesPerMessage: 2, geometry: { version: 1, known: true, maxWidth: 32, maxHeight: 32, maxPixels: 512, maxFrames: 1 } };
  const pending = relay.authorize(operationId);
  emit(frame("operation_authorized", { operationId, imageAuthorization }));
  expect(await pending).toEqual(imageAuthorization);
});

test("old generation receipts retain their identity and only reconcile, while explicit rejected states survive", async () => {
  const operation = { operationId: randomUUID(), executionGeneration: "1", kind: "cancel", state: "rejected", result: null, error: "Native turn changed" } as ControllerOperation;
  const { relay, socket, emit, frame, ticket } = await setup([operation]);
  expect(socket.sent.find(m => m.type === "reconcile")).toMatchObject({ operations: [{ operationId: operation.operationId, state: "rejected", providerResult: null, error: { code: "native_operation_error", message: "Native turn changed" } }] });
  expect(publicOperation(ticket, operation).executionGeneration).toBe("1");
  emit(frame("reconcile_result", { operations: [] })); relay.receipt(operation);
  expect(socket.sent.some(m => m.type === "operation_receipt")).toBe(false);
});

test("closing while the credential read is pending cannot create a socket or access the released journal", async () => {
  const ticket = { ...snapshot, controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, credentialFile: "/private/grant", serverOrigin: "http://127.0.0.1:19000" } as unknown as ControllerLaunchTicket;
  files.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 100, mode: 0o600 });
  let finish!: (value: string) => void;
  files.readFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const getLastAcknowledgedSequence = vi.fn(() => "0");
  const relay = createControllerRelay(ticket, { getLastAcknowledgedSequence } as unknown as ControllerLifecycleStore, { onConnection: () => {}, onCommand: async () => {}, onError: () => {} });
  cleanup.push(relay.close);
  await vi.waitFor(() => expect(files.readFile).toHaveBeenCalledOnce()); relay.close();
  finish(JSON.stringify({ token: "token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }));
  await new Promise(resolve => setImmediate(resolve));
  expect(transport.sockets).toHaveLength(0); expect(getLastAcknowledgedSequence).not.toHaveBeenCalled();
});

test.each(["rejected", "expired"] as const)("%s authorization receipt persists refusal without closing the channel", async state => {
  const { relay, journal, emit, frame, ticket, callbacks } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const operation = { operationId: randomUUID(), executionGeneration: ticket.executionGeneration, kind: "send_message", state: "accepted", result: null, error: null } as ControllerOperation;
  Object.assign(journal, { getOperation: vi.fn(() => operation), recordOperation: vi.fn() });
  const pending = relay.authorize(operation.operationId);
  const assertion = expect(pending).rejects.toThrow("Permission or state changed");
  emit(frame("receipt_ack", { operation: { ...publicOperation(ticket, operation), state, error: { code: "permission_or_state_changed", message: "Permission or state changed" } } }));
  await assertion;
  expect(journal.recordOperation).toHaveBeenCalledWith(operation.operationId, state, null, "Permission or state changed");
  expect(journal.markOperationAcknowledged).toHaveBeenCalledWith(operation.operationId);
  expect(relay.connected()).toBe(true);
  const next = randomUUID(), allowed = relay.authorize(next);
  emit(frame("operation_authorized", { operationId: next }));
  await allowed;
  expect(callbacks.onError).not.toHaveBeenCalled();
});

test("authorization refusal with mismatching operation identity cannot settle the journal", async () => {
  const { relay, journal, emit, frame, ticket } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const operation = { operationId: randomUUID(), executionGeneration: ticket.executionGeneration, kind: "send_message", state: "accepted", result: null, error: null } as ControllerOperation;
  Object.assign(journal, { getOperation: vi.fn(() => operation), recordOperation: vi.fn() });
  const pending = relay.authorize(operation.operationId);
  const assertion = expect(pending).rejects.toThrow("disconnected");
  emit(frame("receipt_ack", { operation: { ...publicOperation(ticket, operation), kind: "cancel", state: "rejected", error: null } }));
  await assertion;
  expect(journal.recordOperation).not.toHaveBeenCalled();
  expect(journal.markOperationAcknowledged).not.toHaveBeenCalled();
});

test("a refusal arriving after its authorization waiter is gone still settles undispatched intent", async () => {
  const { relay, journal, emit, frame, ticket } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const operation = { operationId: randomUUID(), executionGeneration: ticket.executionGeneration, kind: "send_message", state: "accepted", result: null, error: null } as ControllerOperation;
  Object.assign(journal, { getOperation: vi.fn(() => operation), recordOperation: vi.fn() });
  emit(frame("receipt_ack", { operation: { ...publicOperation(ticket, operation), state: "rejected", error: null } }));
  expect(journal.recordOperation).toHaveBeenCalledWith(operation.operationId, "rejected", null, "Operation no longer has current permission or state.");
  expect(journal.markOperationAcknowledged).toHaveBeenCalledWith(operation.operationId);
  expect(relay.connected()).toBe(true);
});

test.each(["rejected", "expired"] as const)("reconciliation settles %s intent after its receipt ACK was lost", async state => {
  const operation = { operationId: randomUUID(), kind: "send_message", state: "accepted", result: null, error: null } as ControllerOperation;
  const { relay, journal, emit, frame, ticket, socket, callbacks } = await setup([operation]);
  const pendingOperations = [operation];
  Object.assign(journal, {
    getOperation: vi.fn(() => operation),
    recordOperation: vi.fn((_id, nextState, _result, error) => { operation.state = nextState; operation.error = error; }),
    markOperationAcknowledged: vi.fn(() => { if (["rejected", "expired"].includes(operation.state)) pendingOperations.splice(0); }),
    listUnacknowledgedOperations: vi.fn(() => pendingOperations),
  });
  expect(socket.sent.find(m => m.type === "reconcile")).toMatchObject({ operations: [{ operationId: operation.operationId, state: "not_submitted" }] });
  emit(frame("reconcile_result", { operations: [{ ...publicOperation(ticket, operation), state, error: { code: "permission_or_state_changed", message: "Refused before native dispatch" } }] }));
  expect(journal.recordOperation).toHaveBeenCalledWith(operation.operationId, state, null, "Refused before native dispatch");
  expect(pendingOperations).toEqual([]);
  expect(callbacks.onCommand).not.toHaveBeenCalled();
  expect(relay.connected()).toBe(true);
});


test("requires fresh local state after reconciliation before exposing remote controls", async () => {
  const { relay, journal, socket, emit, frame } = await setup([], true);
  Object.assign(journal, {
    getSnapshot: () => ({ ...snapshot, nativeSessionId: snapshot.identity.nativeSessionId }),
    pendingInteractions: () => [], getSourceFloor: () => "0", getLastSourceSequence: () => "8",
  });
  emit(frame("reconcile_result", { operations: [] }));
  expect(relay.connected()).toBe(false);
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === "sync_state")).toBe(true));
  expect(relay.connected()).toBe(false);
  emit(frame("sync_ack"));
  expect(relay.connected()).toBe(true);
});

test('serializes large concurrent pages and rejects only excess requests without closing the controller', async () => {
  const { relay, journal, socket, emit, frame, callbacks, historyEpoch } = await setup([], true);
  Object.assign(journal, {
    getSnapshot: () => ({ ...snapshot, nativeSessionId: snapshot.identity.nativeSessionId }),
    pendingInteractions: () => [], getSourceFloor: () => '0', getLastSourceSequence: () => '8',
    readTimeline: () => ({ kind: 'timeline', historyEpoch, items: [1, 2].map(i => ({ kind: 'reasoning', entryId: randomUUID(), entrySeq: String(i), revision: '1', text: 'x'.repeat(600000) })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false }),
  });
  emit(frame('reconcile_result', { operations: [] }));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === 'sync_state')).toBe(true));
  emit(frame('sync_ack'));
  for (let i = 0; i < 5; i++) emit(frame('content_request', { requestId: randomUUID(), kind: 'timeline', historyEpoch, direction: 'tail', cursor: null, limit: 100 }));
  await vi.waitFor(() => expect(socket.sent.filter(message => message.type === 'content_response')).toHaveLength(5));
  const responses = socket.sent.filter(message => message.type === 'content_response');
  expect(responses.filter(message => message.result !== null)).toHaveLength(4);
  expect(responses.filter(message => message.result === null)).toEqual([expect.objectContaining({ error: { code: 'rate_limited', message: 'Local content request capacity is unavailable.' } })]);
  expect(callbacks.onError).not.toHaveBeenCalled();
  expect(relay.connected()).toBe(true);
});

test("recovers an old oversized display outbox without changing source identity or replaying operations", async () => {
  const { relay, journal, socket, emit, frame, callbacks } = await setup([], true);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "2", kind: "tool_call", callId: "tool", name: "shell", input: "\u2028".repeat(200_000), output: [{ type: "text", text: "\u2029".repeat(200_000) }], status: "completed", truncated: false };
  let acknowledged = "8";
  Object.assign(journal, {
    getSnapshot: () => ({ ...snapshot, nativeSessionId: snapshot.identity.nativeSessionId }),
    pendingInteractions: () => [], getSourceFloor: () => "0", getLastSourceSequence: () => "9", getLastAcknowledgedSequence: () => acknowledged,
    pendingEvents: () => acknowledged === "8" ? [{ sequence: "9", payload: { kind: "timeline_upsert", payload: entry } }] : [],
    acknowledgeEvents: (seq: string) => { acknowledged = seq; },
  });
  emit(frame("reconcile_result", { operations: [] }));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === "events")).toBe(true));
  const batch = socket.sent.find(message => message.type === "events")!;
  expect(batch.events).toEqual([{ sourceSeq: "9", kind: "timeline_upsert", payload: expect.objectContaining({ entryId: entry.entryId, entrySeq: "1", revision: "2", kind: "error", code: "display_budget_exceeded" }) }]);
  expect(entry.input).toHaveLength(200_000);
  emit(frame("events_ack", { batchId: batch.batchId, sourceEpoch: batch.sourceEpoch, lastAckedSourceSeq: "9", lastEventSeq: "20" }));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === "sync_state")).toBe(true));
  emit(frame("sync_ack"));
  expect(relay.connected()).toBe(true);
  expect(callbacks.onCommand).not.toHaveBeenCalled();
  expect(callbacks.onError).not.toHaveBeenCalled();
});

test("does not HTML-expand or replace pending approval content in live sync", async () => {
  const { relay, journal, socket, emit, frame, callbacks } = await setup([], true);
  const pending = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", state: "pending", kind: "approval", title: "Approve tool", detail: "<>".repeat(200_000), actions: ["allow_once", "reject"] } };
  Object.assign(journal, { getSnapshot: () => ({ ...snapshot, nativeSessionId: snapshot.identity.nativeSessionId }), pendingInteractions: () => [pending], getSourceFloor: () => "0", getLastSourceSequence: () => "8" });
  emit(frame("reconcile_result", { operations: [] }));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === "sync_state")).toBe(true));
  expect(socket.sent.find(message => message.type === "sync_state")!.pendingInteractions).toEqual([pending]);
  emit(frame("sync_ack"));
  expect(relay.connected()).toBe(true);
  expect(callbacks.onError).not.toHaveBeenCalled();
});

test("media capacity is bounded independently while authorization remains responsive", async () => {
  const { relay, socket, emit, frame, setMedia } = await setup(); emit(frame("reconcile_result", { operations: [] }));
  const pending: (() => void)[] = [];
  const status = vi.fn(() => new Promise<null>(resolve => { pending.push(() => resolve(null)); }));
  setMedia({ status });
  for (let i = 0; i < 3; i++) emit(frame("image_request", { requestId: randomUUID(), action: "status", body: { uploadId: randomUUID() } }));
  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  expect(socket.sent.filter(value => value.type === "image_response")).toEqual([expect.objectContaining({ action: "status", result: null, error: expect.objectContaining({ code: "rate_limited" }) })]);
  const operationId = randomUUID(), authorized = relay.authorize(operationId);
  emit(frame("operation_authorized", { operationId })); await authorized;
  socket.close(); const count = socket.sent.length;
  for (const complete of pending) complete(); await new Promise(resolve => setImmediate(resolve));
  expect(socket.sent).toHaveLength(count);
  expect(socket.sent[0]).toMatchObject({ type: "hello", contentRevision: 2 });
});

test.each([
  ["release", new ImageReleaseStorageError(Object.assign(new Error("Disk unavailable"), { code: "EIO" })), "release_storage_unavailable"],
  ["status", new ImageReleaseStorageError(new Error("Storage unavailable")), "image_unavailable"],
  ["release", new Error("Image preparation upload_conflict."), "upload_conflict"],
  ["release", new Error("Image preparation upload_in_use."), "upload_in_use"],
  ["release", new Error("Image preparation is unavailable."), "image_unavailable"],
  ["release", new Error("Image preparation target_changed."), "target_changed"],
] as const)("%s preserves the release error classification %s as %s", async (action, error, code) => {
  const { relay, socket, emit, frame, callbacks, setMedia } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  setMedia({ [action]: async () => { throw error; } });
  const requestId = randomUUID(), body = { uploadId: randomUUID() };
  emit(frame("image_request", { requestId, action, body }));
  await vi.waitFor(() => expect(socket.sent.filter(value => value.type === "image_response")).toEqual([
    expect.objectContaining({ requestId, action, result: null, error: { code, message: "The Controller could not complete this image request." } }),
  ]));
  expect(callbacks.onError).not.toHaveBeenCalled();
  await relay.close();
});

test.each([
  ["EIO", Object.assign(new Error("Private media initialization failed."), { code: "EIO" })],
  ["SQLITE_BUSY", Object.assign(new Error("Private media initialization failed."), { code: "SQLITE_BUSY" })],
  ["storage-only AggregateError", new AggregateError([Object.assign(new Error("Directory sync failed."), { code: "EIO" }), Object.assign(new Error("Media ledger is locked."), { code: "SQLITE_BUSY" })], "Private media initialization failed.")],
] as const)("reoffers the original release after %s prevents lazy media initialization", async (_name, error) => {
  const { relay, socket, emit, frame, callbacks, ticket, setMedia } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const spec = { uploadId: randomUUID(), imageId: randomUUID(), target: { serverOrigin: ticket.serverOrigin, actorUserId: randomUUID(), fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: ticket.executionGeneration }, expectedNativeSessionId: null }, name: "original.png", mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64) };
  const released = { uploadId: spec.uploadId, imageId: spec.imageId, target: spec.target, state: "released", acceptedOffset: "0", validated: null, error: null };
  let storageAvailable = false;
  const release = vi.fn(async () => released);
  setMedia(() => {
    if (!storageAvailable) throw error;
    return { release };
  });
  const prepareId = randomUUID(), releaseId = randomUUID();
  const responses = () => socket.sent.filter(value => value.type === "image_response");
  emit(frame("image_request", { requestId: prepareId, action: "prepare", body: spec }));
  await vi.waitFor(() => expect(responses()).toHaveLength(1));
  expect(responses()[0]).toMatchObject({ requestId: prepareId, action: "prepare", result: null, error: { code: "image_unavailable" } });
  const request = frame("image_request", { requestId: releaseId, action: "release", body: { uploadId: spec.uploadId, spec } });
  emit(request);
  await vi.waitFor(() => expect(responses()).toHaveLength(2));
  expect.soft(responses()[1]).toMatchObject({ requestId: releaseId, action: "release", result: null, error: { code: "release_storage_unavailable" } });
  expect(release).not.toHaveBeenCalled();
  storageAvailable = true;
  emit(request);
  await vi.waitFor(() => expect(responses()).toHaveLength(3));
  expect(responses()[2]).toMatchObject({ requestId: releaseId, action: "release", result: released, error: null });
  expect(release).toHaveBeenCalledExactlyOnceWith({ uploadId: spec.uploadId, spec });
  expect(relay.connected()).toBe(true);
  expect(callbacks.onError).not.toHaveBeenCalled();
  await relay.close();
});

test.each([
  ["owner mismatch", "release", new Error("Media preparation owner identity differs.")],
  ["private symbolic link", "release", new Error("Media directory contains an untrusted symbolic link.")],
  ["corrupt SQLite", "release", Object.assign(new Error("Media ledger is corrupt."), { code: "SQLITE_CORRUPT" })],
  ["invalid SQLite", "release", Object.assign(new Error("Media ledger is not a database."), { code: "SQLITE_NOTADB" })],
  ["symbolic link loop", "release", Object.assign(new Error("Too many symbolic links."), { code: "ELOOP" })],
  ["mixed storage and safety AggregateError", "release", new AggregateError([Object.assign(new Error("Directory sync failed."), { code: "EIO" }), new Error("Media preparation owner identity differs.")], "Private media initialization failed.")],
  ["non-release storage failure", "status", Object.assign(new Error("Private media initialization failed."), { code: "EIO" })],
] as const)("lazy media initialization preserves the terminal response for %s", async (_name, action, error) => {
  const { relay, journal, socket, emit, frame, callbacks } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  Object.assign(journal, { media: () => { throw error; } });
  const requestId = randomUUID();
  emit(frame("image_request", { requestId, action, body: { uploadId: randomUUID() } }));
  await vi.waitFor(() => expect(socket.sent.filter(value => value.type === "image_response")).toEqual([
    expect.objectContaining({ requestId, action, result: null, error: { code: "image_unavailable", message: "The Controller could not complete this image request." } }),
  ]));
  expect(relay.connected()).toBe(true);
  expect(callbacks.onError).not.toHaveBeenCalled();
  await relay.close();
});

test("concurrent completions retain their original identities while one decoder drains a bounded queue", async () => {
  const { relay, socket, emit, frame, setMedia } = await setup(); emit(frame("reconcile_result", { operations: [] }));
  const pending: (() => void)[] = [];
  const complete = vi.fn(() => new Promise<null>(resolve => { pending.push(() => resolve(null)); }));
  setMedia({ complete });
  const bodies = Array.from({ length: 34 }, () => ({ uploadId: randomUUID(), sha256: "a".repeat(64), byteLength: "1" })), ids = bodies.map(() => randomUUID());
  bodies.forEach((body, index) => emit(frame("image_request", { requestId: ids[index], action: "complete", body })));
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  expect(socket.sent.filter(value => value.type === "image_response")).toEqual([expect.objectContaining({ requestId: ids[33], error: expect.objectContaining({ code: "rate_limited" }) })]);
  emit(frame("image_request", { requestId: ids[1], action: "complete", body: bodies[1] }));
  const operationId = randomUUID(), authorization = relay.authorize(operationId);
  emit(frame("operation_authorized", { operationId })); await authorization;
  pending.shift()!();
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  expect(complete.mock.calls[0]).toEqual([bodies[0]]); expect(complete.mock.calls[1]).toEqual([bodies[1]]);
  socket.close(); pending.shift()!(); await relay.close();
  expect(complete).toHaveBeenCalledTimes(2);
});

test("disconnect removes queued decoders before their preparation can be read", async () => {
  const { relay, socket, emit, frame, setMedia } = await setup(); emit(frame("reconcile_result", { operations: [] }));
  let release!: () => void;
  const complete = vi.fn(() => new Promise<null>(resolve => { release = () => resolve(null); }));
  setMedia({ complete });
  for (let i = 0; i < 2; i++) emit(frame("image_request", { requestId: randomUUID(), action: "complete", body: { uploadId: randomUUID(), sha256: "a".repeat(64), byteLength: "1" } }));
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  socket.close(); release(); await relay.close();
  expect(complete).toHaveBeenCalledTimes(1);
});


test("capture RPC binds request, action, attempt and current connection while disconnect remains unknown", async () => {
  const { relay, journal, socket, emit, frame, callbacks } = await setup([], false, true);
  emit(frame("reconcile_result", { operations: [] }));
  const captureId = randomUUID(), attemptId = randomUUID(), occurrence = { imageId: randomUUID(), entryId: randomUUID(), container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-part" };
  const request = { captureId, attemptId, occurrence, nativeSource: null, locator: { kind: "external", url: "https://example.test/original.png" } } as const;
  const registered = relay.capture("register", request);
  const wire = socket.sent.find(m => m.type === "image_capture")!;
  expect(wire).toMatchObject({ action: "register", body: request });
  const receipt = { captureId, attemptId, revision: "1", occurrence, state: "reserved", resourceId: randomUUID(), resource: null, error: null };
  emit(frame("image_capture_result", { requestId: wire.requestId, action: "register", result: receipt, error: null }));
  expect(await registered).toEqual(receipt);
  const unknown = relay.capture("query", { captureId }), assertion = expect(unknown).rejects.toThrow("unknown");
  socket.close(); await assertion;
  expect(callbacks.onCommand).not.toHaveBeenCalled(); expect(journal.markOperationAcknowledged).not.toHaveBeenCalled();
});

test("capture refusal rejects only its request and a following query consumes the failed original", async () => {
  const { relay, socket, emit, frame, callbacks } = await setup([], false, true);
  emit(frame("reconcile_result", { operations: [] }));
  const captureId = randomUUID(), attemptId = randomUUID(), occurrence = { imageId: randomUUID(), entryId: randomUUID(), container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-part" };
  const request = { captureId, attemptId, occurrence, nativeSource: null, locator: { kind: "external", url: "https://example.test/original.png" } } as const;
  const refused = relay.capture("register", request);
  const failure = expect(refused).rejects.toMatchObject({ code: "quota_exceeded", message: "Capture capacity is exhausted." });
  const wire = socket.sent.find(m => m.type === "image_capture")!;
  emit(frame("image_capture_result", { requestId: wire.requestId, action: "register", result: null, error: { code: "quota_exceeded", message: "Capture capacity is exhausted." } }));
  await failure;
  expect(relay.connected()).toBe(true); expect(callbacks.onError).not.toHaveBeenCalled();
  const query = relay.capture("query", { captureId });
  const queryWire = socket.sent.filter(m => m.type === "image_capture").at(-1)!;
  const receipt = { captureId, attemptId, revision: "1", occurrence, state: "failed", resourceId: null, resource: null, error: { code: "quota_exceeded", message: "Capture capacity is exhausted." } };
  emit(frame("image_capture_result", { requestId: queryWire.requestId, action: "query", result: receipt, error: null }));
  expect(await query).toEqual(receipt); expect(relay.connected()).toBe(true);
  await relay.close();
});

test("full capture slots refuse before dispatch and permit the same control after a slot frees", async () => {
  const { relay, socket, emit, frame } = await setup([], false, true);
  await expect(relay.capture("query", { captureId: randomUUID() })).rejects.toBeInstanceOf(ImageCaptureNotDispatchedError);
  expect(socket.sent.some(message => message.type === "image_capture")).toBe(false);
  emit(frame("reconcile_result", { operations: [] }));
  const captureId = randomUUID(), attemptId = randomUUID(), occurrence = { imageId: randomUUID(), entryId: randomUUID(), container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-part" };
  const receipt = { captureId, attemptId, revision: "1", occurrence, state: "reserved", resourceId: randomUUID(), resource: null, error: null };
  const first = relay.capture("query", { captureId });
  const second = relay.capture("query", { captureId });
  const body = { captureId, attemptId, error: { code: "source_unavailable", message: "Source unavailable." } };
  await expect(relay.capture("failed", body)).rejects.toBeInstanceOf(ImageCaptureNotDispatchedError);
  expect(socket.sent.filter(message => message.type === "image_capture")).toHaveLength(2);
  const queries = socket.sent.filter(message => message.type === "image_capture");
  emit(frame("image_capture_result", { requestId: queries[0]!.requestId, action: "query", result: receipt, error: null }));
  await first;
  const retry = relay.capture("failed", body);
  const wire = socket.sent.filter(message => message.type === "image_capture").at(-1)!;
  expect(wire).toMatchObject({ action: "failed", body });
  emit(frame("image_capture_result", { requestId: queries[1]!.requestId, action: "query", result: receipt, error: null }));
  emit(frame("image_capture_result", { requestId: wire.requestId, action: "failed", result: { ...receipt, revision: "2", state: "failed", resourceId: null, error: body.error }, error: null }));
  await second;
  expect(await retry).toMatchObject({ captureId, attemptId, state: "failed", error: body.error });
  await relay.close();
});

test("retry_capture consumes the source hook separately from native commands and aborts on connection loss", async () => {
  const { relay, journal, socket, emit, frame, callbacks } = await setup([], false, true);
  Object.assign(journal, { media: () => ({}) }); emit(frame("reconcile_result", { operations: [] }));
  let finish!: () => void, signal!: AbortSignal;
  const validated = { mediaType: "image/png" as const, byteLength: "1", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
  callbacks.onRetryCapture.mockImplementation(async (_body, currentSignal) => { signal = currentSignal; await new Promise<void>(resolve => { finish = resolve; }); return validated; });
  const body = { captureId: randomUUID(), attemptId: randomUUID() };
  emit(frame("image_request", { requestId: randomUUID(), action: "retry_capture", body }));
  await vi.waitFor(() => expect(callbacks.onRetryCapture).toHaveBeenCalledOnce());
  expect(callbacks.onRetryCapture).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  socket.close(); expect(signal.aborted).toBe(true); const count = socket.sent.length;
  finish(); await relay.close(); expect(socket.sent).toHaveLength(count); expect(callbacks.onCommand).not.toHaveBeenCalled();
});

test("retry source admission refusal leaves the original request available for reoffer", async () => {
  const { relay, socket, emit, frame, callbacks } = await setup([], false, true);
  emit(frame("reconcile_result", { operations: [] }));
  const validated = { mediaType: "image/png" as const, byteLength: "1", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
  callbacks.onRetryCapture.mockRejectedValueOnce(Object.assign(new Error("Controller source capture capacity is unavailable."), { code: "rate_limited" })).mockResolvedValueOnce(validated);
  const requestId = randomUUID(), body = { captureId: randomUUID(), attemptId: randomUUID() };
  const request = frame("image_request", { requestId, action: "retry_capture", body });
  emit(request);
  await vi.waitFor(() => expect(socket.sent.filter(message => message.type === "image_response")).toHaveLength(1));
  expect(socket.sent.filter(message => message.type === "image_response").at(-1)).toMatchObject({ requestId, action: "retry_capture", result: null, error: { code: "rate_limited" } });
  emit(request);
  await vi.waitFor(() => expect(socket.sent.filter(message => message.type === "image_response")).toHaveLength(2));
  expect(socket.sent.filter(message => message.type === "image_response").at(-1)).toMatchObject({ requestId, action: "retry_capture", result: validated, error: null });
  expect(callbacks.onRetryCapture.mock.calls.map(([value]) => value)).toEqual([body, body]);
  await relay.close();
});
