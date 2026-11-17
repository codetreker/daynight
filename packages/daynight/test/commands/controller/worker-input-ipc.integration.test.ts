import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const native = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), opened: vi.fn(), openGate: null as Promise<void> | null, captureGate: null as Promise<void> | null }));
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
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "test", commandHash: "test" }), captureProcessProof: async () => { await native.captureGate; return { pid: 42, parentPid: 1, processGroupId: 1, startedAt: "test", commandHash: "test" }; } }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true, receipt: () => {} };
} }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: async (options: ProviderOptions) => {
  native.opened(options);
  options.onState({ nativeSessionId: "native-test", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
  if (native.captureGate) options.onSpawn!({ pid: 42 } as never);
  if (native.openGate) await native.openGate;
  return { nativeSessionId: "native-test", send: native.send, close: native.close, cancel: async () => {} };
} }));
import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController, type WorkerInputAction } from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

const roots: string[] = [];
afterEach(async () => { native.openGate = null; native.captureGate = null; vi.unstubAllEnvs(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async (options: { openGate?: Promise<void>; captureGate?: Promise<void> } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "worker-ipc-")); roots.push(home);
  const state = path.join(home, ".daynight"); vi.stubEnv("DN_CONFIG_DIR", state); await mkdir(state, { recursive: true });
  let paused = false, claimValid = true, reads = 0, wrongUser = false, failRead = false;
  let gate: Promise<void> | null = null;
  const http = createHttpServer(async (req, res) => {
    reads++;
    const pending = gate;
    if (pending) await pending;
    expect(req.method).toBe("GET"); expect(req.url).toBe(`/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}`);
    expect(req.headers.authorization).toBe("Bearer fixture-token");
    if (failRead) { res.writeHead(403, { "content-type": "application/json", "daynight-user-id": ticket.userId! }); res.end(JSON.stringify({ error: "denied" })); return; }
    const now = new Date().toISOString();
    const task = { id: ticket.taskId, projectId: ticket.projectId, type: "task", parentId: null, title: "Task", description: "", tags: [], status: "in_progress", allowAgents: true, requiredPlatform: null, assignedTo: ticket.userId, startedAt: now, completedAt: null, cancelledAt: null, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: now, updatedAt: now, version: 1, properties: { paused, worker: { claimId: claimValid ? ticket.claimId : randomUUID(), state: "active", userId: ticket.userId, workerId: ticket.workerId, machine: { id: randomUUID(), name: "test" }, platform: "linux", agent: "claude", agentControlMode: "web", worktreeId: ticket.worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: now } } };
    res.writeHead(200, { "content-type": "application/json", "daynight-user-id": wrongUser ? randomUUID() : ticket.userId! }); res.end(JSON.stringify(task));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: `http://127.0.0.1:${address.port}`, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "claude", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: { agent: "claude", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "initial assignment", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-worker-ipc-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(path.join(state, "config.yml"), `serverUrl: ${ticket.serverOrigin}\nserverToken: fixture-token\n`);
  await writeLaunchTicket(home, ticket);
  native.send.mockResolvedValue({ disposition: "started", turnId: "turn" }); native.close.mockResolvedValue(undefined);
  native.openGate = options.openGate ?? null; native.captureGate = options.captureGate ?? null;
  const running = runController({ homeDirectory: home, provider: "claude", launchId: ticket.launchId }); void running.catch(() => {});
  const pendingStartup = options.openGate !== undefined || options.captureGate !== undefined;
  await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot.lifecycle).toBe(pendingStartup ? "starting" : "ready"));
  if (pendingStartup) await vi.waitFor(() => expect(native.opened).toHaveBeenCalledOnce());
  const journal = path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite");
  return { ticket, running, journal, config: path.join(state, "config.yml"), setPaused: (value: boolean) => { paused = value; }, setClaimValid: (value: boolean) => { claimValid = value; }, setGate: (value: Promise<void> | null) => { gate = value; }, setWrongUser: (value: boolean) => { wrongUser = value; }, setFailRead: (value: boolean) => { failRead = value; }, reads: () => reads,
    state: (activity: "idle" | "working") => (native.opened.mock.calls[0]![0] as ProviderOptions).onState({ nativeSessionId: "native-test", activity, currentTurnId: activity === "working" ? "turn" : null, capabilities: { send: true, steer: activity === "working", cancel: true, respond: true } }),
    operation: (id: string) => { const db = new Database(journal, { readonly: true }); try { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(id) as { value: string } | undefined; return row && JSON.parse(row.value); } finally { db.close(); } },
    stop: async (failed = false) => { try { if (!failed) await requestController(ticket, { kind: "stop", deadline: Date.now() + 2000 }); await running; } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); } } };
};
const action = (operationId = randomUUID(), prompt = "continue"): WorkerInputAction => ({ kind: "submit_worker_input", operationId, prompt, deadline: Date.now() + 10_000 });

test("fatal startup after idle prevents Worker input before the provider handle arrives", async () => {
  const gate = Promise.withResolvers<void>();
  const v = await setup({ openGate: gate.promise });
  try {
    const provider = native.opened.mock.calls[0]![0] as ProviderOptions;
    provider.onFatalError!(new Error("native startup failed"));
    expect((await requestController(v.ticket, { kind: "observe" })).snapshot).toMatchObject({ lifecycle: "paused", activity: "idle", capabilities: { send: true } });
    const input = action(), before = v.reads();
    expect((await requestController(v.ticket, input)).inputResult).toEqual({ kind: "waiting", reason: "unavailable" });
    v.state("idle");
    expect((await requestController(v.ticket, { kind: "observe" })).snapshot).toMatchObject({ lifecycle: "starting", activity: "idle", capabilities: { send: true } });
    expect((await requestController(v.ticket, input)).inputResult).toEqual({ kind: "waiting", reason: "unavailable" });
    expect(v.reads()).toBe(before); expect(v.operation(input.operationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
  } finally { gate.resolve(); await expect(v.stop(true)).rejects.toThrow("native startup failed"); }
});

test("initial input waits for native process proof after the provider handle arrives", async () => {
  const gate = Promise.withResolvers<void>();
  const v = await setup({ captureGate: gate.promise });
  try {
    const before = v.reads();
    const result = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(result.snapshot).toMatchObject({ lifecycle: "starting", activity: "idle", initialInputState: "not_submitted" });
    expect(result.operation).toBeUndefined(); expect(v.reads()).toBe(before);
    expect(v.operation(v.ticket.initialOperationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(async () => expect((await requestController(v.ticket, { kind: "observe" })).snapshot.lifecycle).toBe("ready"));
    expect((await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId })).operation).toMatchObject({ state: "confirmed" });
    expect(native.send).toHaveBeenCalledOnce();
  } finally { gate.resolve(); await v.stop(); }
});

test("initial and later input reread the task and recheck idle after the GET", async () => {
  const v = await setup();
  try {
    v.setPaused(true);
    const paused = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(paused.operation).toBeUndefined(); expect(v.operation(v.ticket.initialOperationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    v.setPaused(false); v.setClaimValid(false);
    const invalid = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(invalid.operation).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    v.setClaimValid(true);
    const initial = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(initial.operation).toMatchObject({ kind: "initial", operationId: v.ticket.initialOperationId, state: "confirmed" });
    expect(native.send).toHaveBeenCalledTimes(1);
    const hold = Promise.withResolvers<void>(); v.setGate(hold.promise);
    const next = action(), before = v.reads();
    const waiting = requestController(v.ticket, next);
    await vi.waitFor(() => expect(v.reads()).toBe(before + 1));
    v.state("working"); hold.resolve(); v.setGate(null);
    expect((await waiting).inputResult).toEqual({ kind: "waiting", reason: "working" });
    expect(v.operation(next.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(1);
    v.state("idle");
    expect((await requestController(v.ticket, next)).inputResult).toMatchObject({ kind: "operation", operation: { kind: "worker_input", state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(2);
  } finally { await v.stop(); }
});

test("configuration, principal and GET failures never dispatch or register the input", async () => {
  const v = await setup();
  try {
    await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    const next = action(), initialReads = v.reads();
    await writeFile(v.config, "serverUrl: http://127.0.0.1:1\nserverToken: fixture-token\n");
    await expect(requestController(v.ticket, next)).rejects.toThrow(/configuration/);
    expect(v.reads()).toBe(initialReads);
    await writeFile(v.config, `serverUrl: ${v.ticket.serverOrigin}\n`);
    await expect(requestController(v.ticket, next)).rejects.toThrow(/configuration/);
    expect(v.reads()).toBe(initialReads);
    await writeFile(v.config, `serverUrl: ${v.ticket.serverOrigin}\nserverToken: fixture-token\n`);
    v.setWrongUser(true);
    await expect(requestController(v.ticket, next)).rejects.toThrow();
    expect(v.reads()).toBe(initialReads + 1);
    v.setWrongUser(false); v.setFailRead(true);
    await expect(requestController(v.ticket, next)).rejects.toThrow();
    expect(v.reads()).toBe(initialReads + 2);
    expect(v.operation(next.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(1);
    v.setFailRead(false);
    expect((await requestController(v.ticket, next)).inputResult).toMatchObject({ kind: "operation", operation: { operationId: next.operationId, state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(2);
  } finally { await v.stop(); }
});

test("queued Worker requests recheck the task, preserve IDs and expire without dispatch", async () => {
  const v = await setup();
  const release = Promise.withResolvers<{ disposition: "started"; turnId: string }>();
  try {
    await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    native.send.mockReturnValueOnce(release.promise);
    const first = action(), blocked = requestController(v.ticket, first);
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(2));
    const second = action(), queued = requestController(v.ticket, second);
    await expect(requestController(v.ticket, { ...second, prompt: "changed queued input" })).rejects.toThrow(/different content/);
    const duplicate = requestController(v.ticket, first);
    await expect(requestController(v.ticket, { ...first, prompt: "changed" })).rejects.toThrow(/different content/);
    const expired = { ...action(), deadline: Date.now() + 100 };
    const expiry = requestController(v.ticket, expired);
    await expect(requestController(v.ticket, { ...expired, prompt: "changed expiring input" })).rejects.toThrow(/different content/);
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(expired.deadline));
    v.setPaused(true); release.resolve({ disposition: "started", turnId: "turn" });
    expect((await blocked).inputResult).toMatchObject({ kind: "operation", operation: { operationId: first.operationId, state: "confirmed" } });
    expect((await duplicate).inputResult).toMatchObject({ kind: "operation", operation: { operationId: first.operationId, state: "confirmed" } });
    expect((await queued).inputResult).toEqual({ kind: "waiting", reason: "task_paused" });
    expect((await expiry).inputResult).toEqual({ kind: "waiting", reason: "expired" });
    expect(v.operation(second.operationId)).toBeUndefined(); expect(v.operation(expired.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(2);
    v.setPaused(false); v.setClaimValid(false);
    expect((await requestController(v.ticket, second)).inputResult).toEqual({ kind: "waiting", reason: "claim_invalid" });
    v.setClaimValid(true);
    expect((await requestController(v.ticket, second)).inputResult).toMatchObject({ kind: "operation", operation: { operationId: second.operationId, state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(3);
  } finally { release.resolve({ disposition: "started", turnId: "turn" }); await v.stop(); }
});
