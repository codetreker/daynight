import { restoreCanonicalInputIntent } from "../../../src/commands/controller/media/input-intent.js";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { SessionCommand } from "../../../src/session/protocol.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/input-intent-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "i-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const command = { protocol: "daynight.session.v1", contentRevision: 2, requestId: "request", operationId: randomUUID(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "1", kind: "send_message", payload: { content: [{ type: "image", imageId: randomUUID(), uploadId: randomUUID(), resourceId: randomUUID(), sha256: "a".repeat(64), byteLength: "12" }], expectedTurnId: null, target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "1" }, expectedNativeSessionId: null }, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" } } as unknown as SessionCommand;
  return { filename: path.join(home, "journal.sqlite"), ticket, command };
};
test("the complete original image intent survives unknown and restart, while request IDs are transport only", async () => {
  const { filename, ticket, command } = await fixture();
  let store = openControllerLifecycleStore(filename, ticket);
  const operation = store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command });
  expect(store.getInputIntent(command.operationId)).toMatchObject({ sha256: operation.payloadHash });
  store.markDispatching(command.operationId); store.recordOperation(command.operationId, "unknown"); store.close();
  store = openControllerLifecycleStore(filename, ticket);
  try {
    expect(store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: { ...command, requestId: "another" } }).state).toBe("unknown");
    expect(() => store.markDispatching(command.operationId)).toThrow("replay");
    const changed = { ...command, payload: { ...command.payload, draftRevision: "2" } } as SessionCommand;
    expect(() => store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: changed.payload, intent: changed })).toThrow("different content");
  } finally { store.close(); }
});
test("legacy text keeps its original operation hash and has no rewritten image intent", async () => {
  const { filename, ticket } = await fixture(); const store = openControllerLifecycleStore(filename, ticket);
  try {
    const payload = { content: [{ type: "text", text: " first\n" }], expectedTurnId: null };
    const operation = store.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload });
    expect(operation.payloadHash).toBe(controllerPayloadHash({ kind: "send_message", payload }));
    expect(store.getInputIntent(operation.operationId)).toBeNull();
  } finally { store.close(); }
});

test("image unknown requires an exact structured native observation, never a legacy operation ID", async () => {
  const { filename, ticket, command } = await fixture(); const store = openControllerLifecycleStore(filename, ticket);
  const { observeNativeInput } = await import("../../../src/commands/controller/recovery.js");
  try {
    const op = store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command });
    store.patchSnapshot({ nativeSessionId: "native" }); store.markDispatching(op.operationId); store.recordOperation(op.operationId, "unknown");
    expect(observeNativeInput(store, op.operationId)).toBe(false);
    const observation = { operationId: op.operationId, nativeSessionId: "native", intentSha256: op.payloadHash, nativeMessageId: "exact-message", provider: "codex" as const };
    expect(observeNativeInput(store, { ...observation, intentSha256: "b".repeat(64) })).toBe(false);
    expect(observeNativeInput(store, { ...observation, nativeSessionId: "another" })).toBe(false);
    expect(observeNativeInput(store, observation)).toBe(true);
    expect(store.getOperation(op.operationId)?.state).toBe("provider_accepted");
    expect(() => store.recordInputObservation({ ...observation, nativeMessageId: "different" })).toThrow("conflicts");
  } finally { store.close(); }
});

test.each(["provider_accepted", "confirmed"] as const)("reopened %s images revalidate the original observation without changing the operation", async state => {
  const { filename, ticket, command } = await fixture();
  const { observeNativeInput } = await import("../../../src/commands/controller/recovery.js");
  let store = openControllerLifecycleStore(filename, ticket);
  const op = store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command });
  store.patchSnapshot({ nativeSessionId: "native" }); store.markDispatching(op.operationId);
  const observation = { operationId: op.operationId, nativeSessionId: "native", intentSha256: op.payloadHash, nativeMessageId: "exact-message", provider: "codex" as const };
  expect(observeNativeInput(store, observation)).toBe(true);
  if (state === "confirmed") store.recordOperation(op.operationId, "confirmed", { disposition: "started", turnId: "original-turn" });
  const accepted = store.getOperation(op.operationId); store.close();
  store = openControllerLifecycleStore(filename, ticket);
  try {
    expect(observeNativeInput(store, observation)).toBe(true);
    expect(store.getOperation(op.operationId)).toEqual(accepted);
    expect(observeNativeInput(store, op.operationId)).toBe(false);
    expect(observeNativeInput(store, { ...observation, intentSha256: "b".repeat(64) })).toBe(false);
    expect(observeNativeInput(store, { ...observation, nativeSessionId: "other" })).toBe(false);
    expect(() => observeNativeInput(store, { ...observation, nativeMessageId: "other" })).toThrow("conflicts");
    expect(store.getOperation(op.operationId)).toEqual(accepted);
  } finally { store.close(); }
});

test("a terminal image operation cannot gain its first native receipt during recovery", async () => {
  const { filename, ticket, command } = await fixture();
  const { observeNativeInput } = await import("../../../src/commands/controller/recovery.js");
  const store = openControllerLifecycleStore(filename, ticket);
  try {
    const op = store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command });
    store.patchSnapshot({ nativeSessionId: "native" }); store.markDispatching(op.operationId);
    store.recordOperation(op.operationId, "confirmed", { disposition: "started", turnId: "original-turn" });
    const confirmed = store.getOperation(op.operationId);
    const observation = { operationId: op.operationId, nativeSessionId: "native", intentSha256: op.payloadHash, nativeMessageId: "new-message", provider: "codex" as const };
    expect(observeNativeInput(store, observation)).toBe(false);
    expect(store.recordInputObservation(observation)).toBe(false);
    expect(store.getOperation(op.operationId)).toEqual(confirmed);
  } finally { store.close(); }
});

test("final history evidence uses the exact durable epoch and acknowledged source cutoff", async () => {
  const { filename, ticket } = await fixture(); let store = openControllerLifecycleStore(filename, ticket); const historyEpoch = randomUUID();
  try {
    store.recordRelayHistory(historyEpoch);
    const event = store.appendEvent({ kind: "state", payload: {} });
    expect(store.getHistorySource()).toMatchObject({ historyEpoch, sourceThrough: event.sequence, acknowledgedThrough: "0", projectionGap: false });
    expect(() => store.recordHistoryCheckpoint({ historyEpoch, sourceThrough: event.sequence })).toThrow("complete acknowledged");
    store.acknowledgeEvents(event.sequence);
    expect(() => store.recordHistoryCheckpoint({ historyEpoch: randomUUID(), sourceThrough: event.sequence })).toThrow();
    store.recordHistoryCheckpoint({ historyEpoch, sourceThrough: event.sequence });
    store.close(); store = openControllerLifecycleStore(filename, ticket);
    expect(store.getHistoryCheckpoint()).toEqual({ historyEpoch, sourceThrough: event.sequence });
    store.markProjectionGap("Native projection is incomplete.");
    expect(() => store.recordHistoryCheckpoint({ historyEpoch, sourceThrough: event.sequence })).toThrow();
  } finally { store.close(); }
});


test("provider restoration reads the exact persisted image intent without a transport request ID", async () => {
  const { filename, ticket, command } = await fixture();
  let store = openControllerLifecycleStore(filename, ticket);
  store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload, intent: command });
  store.markDispatching(command.operationId); store.recordOperation(command.operationId, "unknown"); store.close();
  store = openControllerLifecycleStore(filename, ticket);
  try {
    const intent = store.getInputIntent(command.operationId)!;
    expect(JSON.parse(intent.canonical)).not.toHaveProperty("requestId");
    const restored = restoreCanonicalInputIntent(intent, command.operationId);
    expect(restored).toEqual({ ...command, requestId: command.operationId });
    expect(() => restoreCanonicalInputIntent(intent, randomUUID())).toThrow(/original operation/);
    expect(() => restoreCanonicalInputIntent({ ...intent, sha256: "b".repeat(64) }, command.operationId)).toThrow(/original operation/);
    expect(() => restoreCanonicalInputIntent({ ...intent, canonical: intent.canonical + " " }, command.operationId)).toThrow(/original operation/);
    expect(store.getInputIntent(command.operationId)).toEqual(intent);
    expect(store.getOperation(command.operationId)?.state).toBe("unknown");
  } finally { store.close(); }
});
