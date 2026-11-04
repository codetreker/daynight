import { afterEach, expect, test, vi } from "vitest";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import registrationFixture from "../../session/fixtures/v2/valid-registration.json" with { type: "json" };
import dispatchFixture from "../../session/fixtures/v2/valid-control-dispatch.json" with { type: "json" };
import operationFixture from "../../session/fixtures/v2/valid-keys.json" with { type: "json" };
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { createHerdrInputBridge } from "../../../src/commands/worker/herdr/input-bridge.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const setup = async (overrides: Partial<Parameters<typeof createHerdrInputBridge>[0]> = {}, beforeBridge?: () => void) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (typeof address === "string" || address === null) throw new Error("Expected a TCP server.");
  const registration = structuredClone(registrationFixture) as Message<"registration">;
  registration.payload.owner.serverOrigin = `http://127.0.0.1:${address.port}`;
  registration.payload.capabilities = { observe: false, control: false, archive: false };
  const incoming: SessionV2Message[] = [], messages: SessionV2Message[] = [], receipts: SessionV2Message[] = [], disconnects: Error[] = [];
  let inputSignal: AbortSignal | undefined;
  const connected = once(server, "connection");
  beforeBridge?.();
  const bridge = createHerdrInputBridge({ registration, serverToken: "isolated-test-token", onMessage: async (message, signal) => { messages.push(message); inputSignal = signal; }, onDisconnect: error => { disconnects.push(error); }, onReceipt: message => { receipts.push(message); }, ...overrides });
  cleanups.push(bridge.close);
  // Rejections are asserted after the test's server event; install the handler immediately.
  void bridge.ready.catch(() => {});
  const [socket, request] = await connected as [WebSocket, { url?: string; headers: Record<string, string> }];
  socket.on("message", data => { incoming.push(JSON.parse(data.toString()) as SessionV2Message); });
  await vi.waitFor(() => expect(incoming).toHaveLength(1));
  const ack = { ...registration, type: "registration_ack", payload: { registrationId: registration.payload.registrationId, connectionEpoch: "1" } } as Message<"registration_ack">;
  const dispatch = structuredClone(dispatchFixture) as Message<"control_dispatch">;
  const operation = structuredClone(operationFixture) as Message<"operation">;
  const frame = (message: unknown) => socket.send(JSON.stringify(message));
  const accept = async () => { frame(ack); await bridge.ready; };
  return { server, bridge, registration, incoming, messages, receipts, disconnects, signal: () => inputSignal, socket, request, ack, dispatch, operation, frame, accept };
};

test("binds a private v2 channel with the original registration before dispatch", async () => {
  const f = await setup();
  expect(f.request.url).toBe(`/api/v1/projects/${f.registration.payload.owner.projectId}/tasks/${f.registration.payload.owner.taskId}/sessions/${f.registration.sessionId}/worker-channel`);
  expect(f.request.headers.authorization).toBe("Bearer isolated-test-token");
  expect(f.request.headers["sec-websocket-protocol"]).toBe("daynight.session.v2");
  expect(f.incoming[0]).toEqual(f.registration);
  expect(f.bridge.connected()).toBe(false);
  await f.accept(); f.frame(f.dispatch);
  await vi.waitFor(() => expect(f.messages).toEqual([f.dispatch]));
  expect(f.bridge.connected()).toBe(true);
});

test("holds offered input until registration acknowledgement is durably recorded", async () => {
  const recorded = deferred();
  const f = await setup({ onRegistered: () => recorded.promise });
  f.frame(f.ack); f.frame(f.dispatch);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.messages).toHaveLength(0); expect(f.bridge.connected()).toBe(false);
  recorded.resolve(); await f.bridge.ready;
  await vi.waitFor(() => expect(f.messages).toEqual([f.dispatch]));
});

test.each(["sessionId", "claimId", "executionGeneration"] as const)("refuses a mismatched registration %s before invoking input", async field => {
  const f = await setup(); f.frame({ ...f.ack, [field]: field === "executionGeneration" ? "2" : "11111111-1111-4111-8111-111111111111" });
  await expect(f.bridge.ready).rejects.toThrow();
  expect(f.messages).toHaveLength(0); expect(f.disconnects).toHaveLength(1);
});

test("refuses a registration epoch other than the exact successor", async () => {
  const f = await setup(); f.frame({ ...f.ack, payload: { ...f.ack.payload, connectionEpoch: "2" } });
  await expect(f.bridge.ready).rejects.toThrow(); expect(f.messages).toHaveLength(0);
});

test("rejects input before the registration ack and never reconnects or replays it", async () => {
  const f = await setup(); f.frame(f.dispatch);
  await expect(f.bridge.ready).rejects.toThrow();
  expect(f.messages).toHaveLength(0); expect(f.incoming).toHaveLength(1);
});

test("checks each input fence and connection epoch", async () => {
  const f = await setup(); await f.accept();
  f.frame({ ...f.operation, payload: { ...f.operation.payload, connectionEpoch: "2" } });
  await vi.waitFor(() => expect(f.disconnects).toHaveLength(1));
  expect(f.messages).toHaveLength(0);
});

test("keeps control dispatch independent from a pending native input handler", async () => {
  const blocked = deferred(), calls: string[] = [];
  const f = await setup({ onMessage: async message => { calls.push(message.type); if (message.type === "operation") await blocked.promise; } });
  await f.accept(); f.frame(f.operation); f.frame(f.dispatch);
  await vi.waitFor(() => expect(calls).toEqual(["operation", "control_dispatch"]));
  blocked.resolve();
});

test("disconnect cancels the handed-off input and refuses delayed results", async () => {
  const f = await setup(); await f.accept(); f.frame(f.operation);
  await vi.waitFor(() => expect(f.signal()).toBeDefined());
  f.socket.terminate(); await vi.waitFor(() => expect(f.disconnects).toHaveLength(1));
  expect(f.signal()!.aborted).toBe(true); expect(f.bridge.connected()).toBe(false);
  await expect(f.bridge.send({ ...f.operation, type: "operation_result", payload: { operationId: f.operation.payload.operationId, state: "unknown", errorCode: "input_unknown" } })).rejects.toThrow();
});

test("separates transport writes from durable server receipts without replaying commands", async () => {
  const f = await setup(); await f.accept();
  const result: Message<"operation_result"> = { ...f.operation, type: "operation_result", payload: { operationId: f.operation.payload.operationId, state: "transport_completed", errorCode: null } };
  await f.bridge.send(result);
  await vi.waitFor(() => expect(f.incoming).toEqual([f.registration, result]));
  expect(f.receipts).toHaveLength(0);
  f.frame(result); await vi.waitFor(() => expect(f.receipts).toEqual([result]));
  expect(f.messages).toHaveLength(0);
});

test("rejects malformed text, duplicate keys and binary frames", async () => {
  for (const frame of ["{bad", '{"protocol":"daynight.session.v2","protocol":"daynight.session.v2"}', Buffer.from("binary")]) {
    const f = await setup(); await f.accept();
    f.socket.send(frame);
    await vi.waitFor(() => expect(f.disconnects).toHaveLength(1));
    expect(f.messages).toHaveLength(0);
  }
});

test("close during durable registration prevents delayed input and is idempotent", async () => {
  const recorded = deferred();
  const f = await setup({ onRegistered: () => recorded.promise });
  f.frame(f.ack); f.frame(f.dispatch);
  f.bridge.close(); f.bridge.close(); recorded.resolve();
  await expect(f.bridge.ready).rejects.toThrow();
  expect(f.messages).toHaveLength(0); expect(f.disconnects).toHaveLength(1);
});

test("a failed durable registration callback closes admission", async () => {
  const f = await setup({ onRegistered: async () => { throw new Error("journal unavailable"); } });
  f.frame(f.ack); f.frame(f.dispatch);
  await expect(f.bridge.ready).rejects.toThrow("journal unavailable");
  expect(f.messages).toHaveLength(0); expect(f.bridge.connected()).toBe(false);
});

test("registration and pending offered frames have bounded lifetimes and capacity", async () => {
  const recorded = deferred();
  const f = await setup({ onRegistered: () => recorded.promise });
  f.frame(f.ack);
  for (let i = 0; i < 33; i++) f.frame(f.dispatch);
  await expect(f.bridge.ready).rejects.toThrow("incoming limit");
  expect(f.messages).toHaveLength(0); recorded.resolve();
});

test("a registration timeout does not create another connection", async () => {
  const f = await setup({}, () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(f.bridge.ready).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.incoming).toHaveLength(1); expect(f.messages).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

test("refuses publishing to a different fence without writing it", async () => {
  const f = await setup(); await f.accept();
  const result: Message<"operation_result"> = { ...f.operation, claimId: "11111111-1111-4111-8111-111111111111", type: "operation_result", payload: { operationId: f.operation.payload.operationId, state: "unknown", errorCode: "input_unknown" } };
  await expect(f.bridge.send(result)).rejects.toThrow("fence");
  expect(f.incoming).toHaveLength(1); expect(f.bridge.connected()).toBe(true);
});
