import { retainDispatchedOutcome } from "../../../src/commands/controller/providers/native-rpc.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { SessionCommand } from "../../../src/session/protocol.js";
const fixture = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), cancel: vi.fn(), opened: vi.fn(), authorize: vi.fn(), receipt: vi.fn(), relay: vi.fn() }));
vi.mock("node:net", async original => {
  const net = await original<typeof import("node:net")>();
  const { relative } = await import("node:path");
  const endpoint = (value: string) => process.platform === "win32" ? value : relative(process.cwd(), value);
  return { ...net, createServer: (...args: Parameters<typeof net.createServer>) => {
    const server = net.createServer(...args), listen = server.listen;
    server.listen = ((value: string, callback: () => void) => listen.call(server, endpoint(value), callback)) as typeof server.listen;
    return server;
  }, createConnection: (value: string) => net.createConnection(endpoint(value)) };
});
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 123, parentPid: 122, processGroupId: 123, startedAt: "fixture", commandHash: "fixture" }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(value: boolean): void; onCommand(command: SessionCommand): Promise<void> }) => {
  fixture.relay(callbacks); queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, stop: () => {}, connected: () => true, authorize: fixture.authorize, receipt: fixture.receipt };
} }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: async (options: ProviderOptions) => {
  fixture.opened(options);
  options.onState({ nativeSessionId: "11111111-1111-4111-8111-111111111111", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
  return { nativeSessionId: "11111111-1111-4111-8111-111111111111", send: fixture.send, close: fixture.close, cancel: fixture.cancel, waitForTurn: async () => {} };
} }));
import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openLifecycleStore, type LifecycleBinding, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const roots: string[] = [], stores: LifecycleStore[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs(); vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const setup = async (initialInput: "none" | "prompt" = "prompt") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "lifecycle-ipc-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "state"));
  const workerDirectory = resolveWorkerPaths(home).workerDirectory; await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const store = openLifecycleStore({ file: path.join(workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true }); stores.push(store);
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), intentVersion: "1", localEpoch: "1", scopeGeneration: "1" };
  store.bindInstance({ ...binding, desired: "enabled" });
  store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision });
  const activation = { binding, operationId: randomUUID(), action: "bootstrap" as const };
  store.prepareActivation(activation);
  store.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "bootstrap", workerId: identity.workerId, operationId: activation.operationId, instanceId: binding.instanceId, intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
  const ticket: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: identity.serverOrigin, testExecutionId: randomUUID(), ownerUserId: identity.userId, provider: "claude", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: { agent: "claude", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput, initialOperationId: randomUUID(), initialPrompt: initialInput === "none" ? "" : "accepted once", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: process.platform === "win32" ? `\\\\.\\pipe\\daynight-lifecycle-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket);
  const running = runController({ homeDirectory: home, provider: "claude", launchId: ticket.launchId });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  const stop = async (): Promise<void> => {
    if (!settled) await requestController(ticket, { kind: "stop", deadline: Date.now() + 2000 }, { timeoutMs: 2000 });
    await running;
  };
  cleanup.push(async () => { if (!settled) await stop(); });
  await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot.lifecycle).toBe("ready"));
  return { ticket, store, closeAdmission: () => store.closeAdmission({ operationId: randomUUID(), local: true }),
    stop };
};

test("the real IPC dispatcher rejects initial and cleanup input after a second connection closes admission, while observe and stop remain usable", async () => {
  const value = await setup();
  try {
    fixture.close.mockImplementation(async () => { (fixture.opened.mock.calls[0]![0] as ProviderOptions).assertNativeDispatch!(); });
    value.closeAdmission();
    const initial = await requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
    expect(initial.operation?.state).toBe("rejected");
    const cleanup = await requestController(value.ticket, { kind: "cleanup", operationId: randomUUID(), prompt: "save work", deadline: Date.now() + 2000 });
    expect(cleanup.operation?.state).toBe("rejected");
    expect(fixture.send).not.toHaveBeenCalled();
    expect((await requestController(value.ticket, { kind: "observe" })).snapshot.sessionId).toBe(value.ticket.sessionId);
  } finally { await value.stop(); }
  expect(fixture.close).toHaveBeenCalledOnce();
});

test("relay authorization completing after durable closure cannot reach the Provider", async () => {
  const value = await setup("none"), authorized = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  fixture.authorize.mockImplementation(async () => { entered.resolve(); await authorized.promise; });
  const callbacks = fixture.relay.mock.calls[0]![0] as { onCommand(command: SessionCommand): Promise<void> };
  const command: SessionCommand = { protocol: "daynight.session.v1", requestId: randomUUID(), sessionId: value.ticket.sessionId, testExecutionId: value.ticket.testExecutionId!, executionGeneration: "1", operationId: randomUUID(), kind: "send_message", payload: { content: [{ type: "text", text: "late input" }], origin: "user", expectedTurnId: null } };
  const sending = callbacks.onCommand(command);
  try {
    await entered.promise; value.closeAdmission(); authorized.resolve(); await sending;
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: command.operationId, state: "rejected" }));
    expect(value.store.getResource(command.operationId)?.stage).toBe("not_dispatched");
  } finally { authorized.resolve(); await sending; await value.stop(); }
});

test("a reserved input rechecks the persistent fence at the native boundary after an await", async () => {
  const value = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let nativeCalls = 0;
  fixture.send.mockImplementation(async () => {
    entered.resolve(); await release.promise;
    (fixture.opened.mock.calls[0]![0] as ProviderOptions).assertNativeDispatch!();
    nativeCalls++; return { disposition: "started", turnId: "turn" };
  });
  const sending = requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
  try {
    await entered.promise;
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("reserved");
    value.closeAdmission(); release.resolve();
    expect((await sending).operation?.state).toBe("rejected");
    expect(nativeCalls).toBe(0);
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("not_dispatched");
  } finally { release.resolve(); await sending; await value.stop(); }
});

test("input admitted before closure saves its exact late receipt without reopening admission", async () => {
  const value = await setup(), entered = Promise.withResolvers<void>(), receipt = Promise.withResolvers<unknown>();
  fixture.send.mockImplementation(async () => { entered.resolve(); return receipt.promise; });
  const sending = requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
  try {
    await entered.promise; value.closeAdmission(); receipt.resolve({ disposition: "started", turnId: "original-turn" });
    expect((await sending).operation?.state).toBe("confirmed");
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("confirmed");
    expect(value.store.readState()).toMatchObject({ admission: "closed", localVeto: true });
  } finally { receipt.resolve({ disposition: "started", turnId: "original-turn" }); await sending; await value.stop(); }
});

test("all relay business operations use the closed fence while cancellation keeps its management authority", async () => {
  const value = await setup("none"), provider = fixture.opened.mock.calls[0]![0] as ProviderOptions;
  const callbacks = fixture.relay.mock.calls[0]![0] as { onCommand(command: SessionCommand): Promise<void> };
  provider.onState({ nativeSessionId: "11111111-1111-4111-8111-111111111111", activity: "idle", currentTurnId: null,
    capabilities: { send: true, steer: false, cancel: true, respond: true },
    controls: { revision: "1", settings: [{ id: "model", category: "model", label: "Model", description: null, value: "default", options: [{ value: "default", label: "Default" }], mutable: true, scope: "session" }], commands: [{ id: "compact", name: "compact", description: "Compact", argumentHint: null, available: true }], settingsError: null, commandsError: null } });
  const bodies: Pick<SessionCommand, "kind" | "payload">[] = [
    { kind: "send_message", payload: { content: [{ type: "text", text: "blocked" }], origin: "user", expectedTurnId: null } },
    { kind: "update_setting", payload: { settingId: "model", value: "default", expectedControlsRevision: "1" } },
    { kind: "execute_command", payload: { commandId: "compact", arguments: "", expectedControlsRevision: "1", expectedTurnId: null } },
    { kind: "interaction_response", payload: { interactionId: randomUUID(), interactionRevision: "1", submissionId: randomUUID(), response: { kind: "dismiss" } } },
    { kind: "refresh_controls", payload: {} },
  ];
  const command = (body: Pick<SessionCommand, "kind" | "payload">): SessionCommand => ({ protocol: "daynight.session.v1", requestId: randomUUID(), sessionId: value.ticket.sessionId, testExecutionId: value.ticket.testExecutionId!, executionGeneration: "1", operationId: randomUUID(), ...body } as SessionCommand);
  try {
    value.closeAdmission();
    for (const body of bodies) {
      const input = command(body); await callbacks.onCommand(input);
      expect(fixture.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: input.operationId, state: "rejected" }));
      expect(value.store.getResource(input.operationId)).toBeNull();
    }
    fixture.cancel.mockImplementation(async () => { provider.assertNativeDispatch!(); return { disposition: "handled" }; });
    const cancel = command({ kind: "cancel", payload: { expectedTurnId: randomUUID() } });
    await callbacks.onCommand(cancel);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: cancel.operationId, state: "confirmed" }));
    expect(fixture.send).not.toHaveBeenCalled();
  } finally { await value.stop(); }
});

test("a late native receipt settles the original unknown reservation while admission stays closed", async () => {
  const value = await setup();
  fixture.send.mockRejectedValue(new Error("Native response was lost."));
  try {
    const response = await requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
    expect(response.operation?.state).toBe("unknown");
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("unknown");
    value.closeAdmission();
    expect((fixture.opened.mock.calls[0]![0] as ProviderOptions).onInputObserved!(value.ticket.initialOperationId)).toBe(true);
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("confirmed");
    expect(value.store.readState().admission).toBe("closed");
    expect(fixture.send).toHaveBeenCalledOnce();
  } finally { await value.stop(); }
});


test("cleanup rejected after its cancellation await closes only the unsent cleanup input", async () => {
  const value = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = fixture.opened.mock.calls[0]![0] as ProviderOptions;
  provider.onState({ nativeSessionId: "11111111-1111-4111-8111-111111111111", activity: "working", currentTurnId: "original-turn", capabilities: { send: true, steer: false, cancel: true, respond: true } });
  fixture.cancel.mockImplementation(async () => { entered.resolve(); await release.promise; return { disposition: "handled" }; });
  const operationId = randomUUID(), sending = requestController(value.ticket, { kind: "cleanup", operationId, prompt: "must not run", deadline: Date.now() + 5000 });
  try {
    await entered.promise; value.closeAdmission(); release.resolve();
    expect((await sending).operation?.state).toBe("rejected");
    expect(value.store.getResource(operationId)?.stage).toBe("not_dispatched");
    expect(fixture.send).not.toHaveBeenCalled(); expect(fixture.cancel).toHaveBeenCalledOnce();
  } finally { release.resolve(); await sending; await value.stop(); }
});

test("a failure after the original native call remains unknown when admission later closes", async () => {
  const value = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let nativeCalls = 0;
  fixture.send.mockImplementation(async () => {
    (fixture.opened.mock.calls[0]![0] as ProviderOptions).assertNativeDispatch!();
    nativeCalls++; entered.resolve(); await release.promise; throw new Error("Native response was lost.");
  });
  const sending = requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
  try {
    await entered.promise; value.closeAdmission(); release.resolve();
    expect((await sending).operation?.state).toBe("unknown");
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe("unknown"); expect(nativeCalls).toBe(1);
  } finally { release.resolve(); await sending; await value.stop(); }
});


test.each([false, true])("Controller stopping settles pending input according to actual native dispatch (dispatched=%s)", async dispatched => {
  const value = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const stoppingEntered = Promise.withResolvers<void>(), finishClose = Promise.withResolvers<void>();
  const provider = fixture.opened.mock.calls[0]![0] as ProviderOptions;
  let nativeCalls = 0;
  fixture.close.mockImplementation(async () => { stoppingEntered.resolve(); await finishClose.promise; });
  fixture.send.mockImplementation(async () => {
    const perform = async () => {
      if (dispatched) nativeCalls++;
      entered.resolve(); await release.promise;
      provider.assertNativeDispatch!();
      if (!dispatched) nativeCalls++;
      return { disposition: "started", turnId: "original-turn" };
    };
    return dispatched ? retainDispatchedOutcome(perform) : perform();
  });
  const sending = requestController(value.ticket, { kind: "submit_initial", operationId: value.ticket.initialOperationId });
  let stopping: Promise<void> | undefined;
  try {
    await entered.promise;
    stopping = value.stop();
    await stoppingEntered.promise;
    // Persistent admission stays open: only Controller stopping can reject this input.
    expect(value.store.readState().admission).toBe("open");
    release.resolve();
    const result = await sending;
    expect(result.operation?.state).toBe(dispatched ? "unknown" : "rejected");
    expect(value.store.getResource(value.ticket.initialOperationId)?.stage).toBe(dispatched ? "unknown" : "not_dispatched");
    expect(nativeCalls).toBe(dispatched ? 1 : 0);
    if (!dispatched) expect(result.operation?.error).toBe("Controller stopped before native dispatch.");
  } finally {
    release.resolve(); finishClose.resolve();
    await sending; await (stopping ?? value.stop());
  }
});
