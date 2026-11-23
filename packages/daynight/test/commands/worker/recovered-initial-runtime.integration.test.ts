import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const native = vi.hoisted(() => ({ send: vi.fn(async () => ({ disposition: "started" as const, turnId: "original-turn" })), close: vi.fn(async () => {}) }));
vi.mock("node:net", async importOriginal => {
  const net = await importOriginal<typeof import("node:net")>();
  const { relative } = await import("node:path");
  const endpoint = (value: string) => process.platform === "win32" ? value : relative(process.cwd(), value);
  return { ...net,
    createServer: (...args: Parameters<typeof net.createServer>) => {
      const server = net.createServer(...args), listen = server.listen;
      server.listen = ((value: string, callback: () => void) => listen.call(server, endpoint(value), callback)) as typeof server.listen;
      return server;
    },
    createConnection: (value: string) => net.createConnection(endpoint(value)),
  };
});
vi.mock("../../../src/commands/controller/worker-task.js", () => ({ checkWorkerTask: vi.fn(async () => null) }));
vi.mock("../../../src/commands/controller/launch-tool-selection.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/commands/controller/launch-tool-selection.js")>(), readLaunchToolSelection: async () => undefined,
}));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true };
} }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: async (options: ProviderOptions) => {
  options.onNativeProcessProof!({ pid: 990, parentPid: 989, processGroupId: 989, startedAt: "native-recovered", commandHash: "b".repeat(64) });
  options.onState({ nativeSessionId: options.resumeNativeSessionId, activity: "idle", currentTurnId: null,
    capabilities: { send: true, steer: false, cancel: false, respond: false } });
  return { nativeSessionId: options.resumeNativeSessionId!, send: native.send, close: native.close };
} }));

import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { controllerExecutionDirectory, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { runController } from "../../../src/commands/controller/runtime.js";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";

const { fixture, cleanupSource } = createWebBackendFixtures("file");

it.each([false, true])("Worker delivers recovered original initial input once through Controller and Provider (prepared=%s)", async prepared => {
  native.send.mockClear(); native.close.mockClear();
  const f = await fixture();
  const binding = { repositoryPath: f.home, commonDirectory: path.join(f.home, ".git"), worktreePath: process.cwd(), branch: `daynight/${f.identity.taskId}` };
  vi.mocked(f.git.prepareWorktree).mockResolvedValue(binding);
  let task = f.store.bindWorktree(f.identity, binding, 2);
  task = f.store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 3);
  const source = await cleanupSource(f, task);
  vi.stubEnv("DN_CONFIG_DIR", path.join(f.home, "state"));
  const workerDirectory = resolveWorkerPaths(f.home).workerDirectory;
  await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: source.ticket.serverOrigin, userId: source.ticket.userId!, workerId: source.ticket.workerId! };
  const workerLifecycle = openLifecycleStore({ file: path.join(workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true });
  try {
  const lifecycleBinding: LifecycleBinding = { ...identity, instanceId: randomUUID(), instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" };
  workerLifecycle.bindInstance({ ...lifecycleBinding, desired: "enabled" });
  workerLifecycle.markStopped({ localEpoch: "1", inventoryRevision: workerLifecycle.readState().inventoryRevision });
  const activation = { binding: lifecycleBinding, operationId: randomUUID(), action: "bootstrap" as const };
  workerLifecycle.prepareActivation(activation);
  workerLifecycle.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "bootstrap", workerId: identity.workerId,
    operationId: activation.operationId, instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
  const firstTicket = { ...source.ticket, schemaVersion: 2 as const, lifecycleBinding };
  await writeLaunchTicket(f.home, firstTicket);
  source.saved.mockRestore();
  vi.mocked(lifecycle.readCompatibleControllerSnapshot).mockRestore();
  const file = path.join(controllerExecutionDirectory(f.home, firstTicket.executionId), "journal.sqlite");
  await mkdir(path.dirname(file), { recursive: true });
  const first = { ...source.snapshot, initialInputState: "not_submitted" as const, error: null };
  let journal = lifecycle.openControllerLifecycleStore(file, firstTicket);
  journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeSessionId: first.nativeSessionId,
    initialInputState: "not_submitted", nativeStopped: true, stoppedAt: first.stoppedAt,
    controllerProcess: first.controllerProcess, nativeProcesses: [], error: null });
  if (prepared) journal.prepareOperation({ operationId: firstTicket.initialOperationId, kind: "initial", payload: { text: firstTicket.initialPrompt } });
  journal.close();
  task = f.store.updateWebExecution(source.task, { initialInputState: "not_submitted" }, 4);
  task = f.store.beginWebGeneration(task, first, 5);
  const execution = task.webExecution!;
  const ticket = { ...firstTicket, launchId: execution.launchId, executionGeneration: execution.executionGeneration,
    controllerInstanceId: execution.controllerInstanceId, resumeNativeSessionId: task.resources.nativeSession!.sessionId };
  const ticketPath = await writeLaunchTicket(f.home, ticket);
  const proof = { pid: 989, parentPid: 1, processGroupId: 989, startedAt: "recovered", commandHash: "a".repeat(64) };
  vi.spyOn(processProof, "captureControllerProcessProof").mockResolvedValue(proof);
  const running = runController({ homeDirectory: f.home, provider: "codex", launchId: ticket.launchId });
  void running.catch(() => {});
  try {
    await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot).toMatchObject({ lifecycle: "ready", activity: "idle" }), { timeout: 10_000 });
    const observation = await requestController(ticket, { kind: "observe" });
    task = f.store.updateWebExecution(task, { ticketPath, launchSubmission: "acknowledged", controllerProcess: proof,
      nativeProcesses: observation.snapshot.nativeProcesses }, 6);
    const launcher = { prepare: vi.fn(async () => ticket), launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}) };
    const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher,
      platform: "macos", buildPrompt: () => "replacement must not be used", emit: vi.fn(), now: Date.now, request: requestController });
    const before = f.store.getTask(task)!;
    const result = await backend.advanceResult(task, new AbortController().signal);
    expect(result.kind).toBe("observed");
    expect(native.send).toHaveBeenCalledOnce();
    expect(workerLifecycle.getResource(ticket.initialOperationId)?.stage).toBe("confirmed");
    expect(native.send).toHaveBeenCalledWith({ content: [{ type: "text", text: ticket.initialPrompt }] }, ticket.initialOperationId, null);
    const operation = lifecycle.readControllerOperation(file, ticket.initialOperationId);
    expect(operation).toMatchObject({ operationId: ticket.initialOperationId, executionGeneration: "2", kind: "initial", payload: { text: ticket.initialPrompt }, state: "confirmed" });
    expect((await requestController(ticket, { kind: "observe" })).snapshot).toMatchObject({ nativeSessionId: ticket.resumeNativeSessionId, initialInputState: "confirmed", executionGeneration: "2" });
    expect(result.task.claimId).toBe(before.claimId);
    expect(result.task.resources).toEqual(before.resources);
    expect(result.task.recovery).toEqual(before.recovery);
    expect(result.task.webExecution).toMatchObject({ executionGeneration: "2", controllerInstanceId: ticket.controllerInstanceId, initialOperationId: ticket.initialOperationId });
  } finally {
    await requestController(ticket, { kind: "stop", deadline: Date.now() + 2_000 }).catch(() => {});
    await running;
  }
  } finally { workerLifecycle.close(); }
});
