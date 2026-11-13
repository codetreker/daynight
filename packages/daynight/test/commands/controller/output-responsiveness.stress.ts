import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { ControllerLocalResponse } from "../../../src/commands/controller/local-client.js";

const f = vi.hoisted(() => ({
  open: vi.fn(), consumed: 0, readBytes: 0, measuring: false,
  requests: [] as { at: number; consumed: number; readBytes: number }[],
  responses: [] as { at: number; consumed: number; readBytes: number }[],
}));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: (options: ProviderOptions) => f.open(options) }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "controlled-stress", commandHash: "controlled-stress" }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true };
} }));
vi.mock("node:net", async importOriginal => {
  const net = await importOriginal<typeof import("node:net")>();
  const endpoint = (value: string) => process.platform === "win32" ? value : path.relative(process.cwd(), value);
  return { ...net,
    createServer: (listener: (socket: import("node:net").Socket) => void) => {
      const server = net.createServer(socket => {
        socket.on("data", bytes => {
          if (f.measuring && String(bytes).includes('"kind":"observe"')) f.requests.push({ at: performance.timeOrigin + performance.now(), consumed: f.consumed, readBytes: f.readBytes });
        });
        const end = socket.end;
        socket.end = function (this: import("node:net").Socket, ...args: Parameters<typeof end>) {
          if (f.measuring && String(args[0]).includes('"snapshot":')) f.responses.push({ at: performance.timeOrigin + performance.now(), consumed: f.consumed, readBytes: f.readBytes });
          return end.apply(this, args);
        } as typeof end;
        listener(socket);
      });
      const listen = server.listen;
      server.listen = ((value: string, callback: () => void) => listen.call(server, endpoint(value), callback)) as typeof server.listen;
      return server;
    },
    createConnection: (value: string) => net.createConnection(endpoint(value)),
  };
});
import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { CodexRpc } from "../../../src/commands/controller/providers/codex-rpc.js";
import { CodexProjection, nativeEntryId } from "../../../src/commands/controller/providers/projection.js";

type ClientResult = { kind: "response" | "failure"; requestedAt: number; respondedAt: number; response?: ControllerLocalResponse & { ok: true }; error?: string };
type ProducerResult = { produced: number; startedAt: number; finishedAt: number; frameBytes: number };
const now = () => performance.timeOrigin + performance.now();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/output-responsiveness-${name}.mjs`, import.meta.url));
const awaitMessage = <T>(child: ChildProcess, predicate: (value: T) => boolean): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error("Stress subprocess message deadline exceeded.")), 30_000);
  const message = (value: T) => { if (predicate(value)) finish(undefined, value); };
  const error = (cause: Error) => finish(cause);
  const exit = () => finish(new Error("Stress subprocess exited before its expected message."));
  const finish = (cause?: Error, value?: T) => {
    clearTimeout(timer); child.off("message", message); child.off("error", error); child.off("exit", exit);
    if (cause) reject(cause); else resolve(value!);
  };
  child.on("message", message); child.once("error", error); child.once("exit", exit);
});
const spawnFixture = async (name: string) => {
  const child = spawn(process.execPath, [fixture(name)], { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
  const errors: string[] = [];
  child.stderr!.on("data", bytes => errors.push(String(bytes)));
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(); await exited;
    expect(errors).toEqual([]);
  };
  let ready: { kind: string; frameBytes?: number };
  try { ready = await awaitMessage<typeof ready>(child, value => value.kind === "ready"); }
  catch (error) { await close(); throw error; }
  return { child, ready, errors, close };
};

const run = async (backlog: boolean, mode: "single" | "per-frame", sustained = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/output-responsiveness");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "s-"));
  const nativeSessionId = randomUUID(), activeId = nativeEntryId(nativeSessionId, "tool");
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(),
    provider: "codex", cwd: process.cwd(), nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"),
    ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-output-stress-${randomUUID()}` : path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  let producer: Awaited<ReturnType<typeof spawnFixture>> | undefined, client: Awaited<ReturnType<typeof spawnFixture>> | undefined;
  let rpc: CodexRpc | undefined, running: Promise<void> | undefined, ready = false;
  const completed = Promise.withResolvers<ProducerResult>();
  const received = Promise.withResolvers<ClientResult>();
  void completed.promise.catch(() => {}); void received.promise.catch(() => {});
  const deadline = setTimeout(() => { const error = new Error("Output responsiveness phase deadline exceeded."); completed.reject(error); received.reject(error); }, 90_000);
  const chunks: { at: number; bytes: number }[] = [], delivery: number[] = [];
  let timerAt: number | null = null, timerConsumed: number | null = null, timer: NodeJS.Timeout | undefined;
  let responseObservedAt: number | null = null;
  let db: Database.Database | undefined, initialRows = 0, initialBytes = 0;
  let failed = false, primary: unknown;
  f.consumed = 0; f.readBytes = 0; f.measuring = false; f.requests = []; f.responses = [];
  try {
    producer = await spawnFixture("producer"); client = await spawnFixture("client");
    expect(producer.ready.frameBytes).toBe(95);
    const native = producer.child;
    native.stdout!.on("data", bytes => { chunks.push({ at: now(), bytes: bytes.length }); f.readBytes += bytes.length; });
    client.child.on("message", (value: ClientResult) => {
      if (value.kind !== "response" && value.kind !== "failure") return;
      responseObservedAt = now();
      if (sustained) native.send!({ kind: "stop-output" });
      received.resolve(value);
    });
    f.open.mockImplementation(async (options: ProviderOptions) => {
      const projection = new CodexProjection(nativeSessionId, options.onTimeline);
      if (backlog) for (let index = 0; index < 2200; index++) projection.item({ id: `backlog-${index}`, type: "commandExecution", command: "synthetic backlog", aggregatedOutput: "b".repeat(24750) }, true);
      projection.item({ id: "tool", type: "commandExecution", command: "synthetic output", aggregatedOutput: "a".repeat(24750) }, false);
      options.onState({ nativeSessionId, activity: "working", currentTurnId: "stress-turn", capabilities: { send: true, steer: true, cancel: true, respond: true } });
      rpc = new CodexRpc(native as ConstructorParameters<typeof CodexRpc>[0], message => {
        if (message.method === "fixture/finished") { completed.resolve(message.params as ProducerResult); return; }
        expect(message.method).toBe("item/commandExecution/outputDelta");
        const params = message.params as { itemId: string; delta: string };
        expect(params).toEqual({ itemId: "tool", delta: "0123456789" });
        projection.toolDelta(params.itemId, params.delta);
        f.consumed++; delivery.push(now());
        // Fixture credits bound unread native output without acknowledging the
        // Controller outbox or letting the sustained producer finish on its own.
        if (sustained && f.consumed % 32 === 0) native.send!({ kind: "continue" });
        if (f.consumed === 1) {
          client!.child.send!({ kind: "observe", ticket });
          timer = setTimeout(() => { timerAt = now(); timerConsumed = f.consumed; }, 0);
        }
      }, { createSpool: () => { throw new Error("This output fixture carries no media."); }, onFatalError: error => completed.reject(error) });
      return { nativeSessionId, send: async () => { throw new Error("No native input belongs to this synthetic output execution."); }, cancel: async () => ({ disposition: "handled" }), respond: async () => ({ disposition: "handled" }), waitForTurn: async () => {}, close: async () => { rpc!.dispose(); await rpc!.stopped; await producer!.close(); } };
    });
    await writeLaunchTicket(root, ticket);
    running = runController({ homeDirectory: root, provider: "codex", launchId: ticket.launchId });
    void running.catch(error => { completed.reject(error); received.reject(error); });
    await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot.startup?.state).toBe("ready"), { timeout: 30_000 });
    ready = true;
    db = new Database(path.join(controllerExecutionDirectory(root, ticket.executionId), "journal.sqlite"), { readonly: true });
    const totals = () => {
      let bytes = 0, rows = 0;
      for (const row of db!.prepare("SELECT value FROM outbox ORDER BY sequence").iterate() as Iterable<{ value: string }>) { rows++; bytes += Buffer.byteLength(row.value, "utf8"); }
      const stored = (db!.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get() as { byte_length: number }).byte_length;
      expect(stored).toBe(bytes); return { rows, bytes };
    };
    ({ rows: initialRows, bytes: initialBytes } = totals());
    if (backlog) { expect(initialRows).toBeGreaterThanOrEqual(2201); expect(initialBytes).toBeGreaterThan(54_000_000); expect(initialBytes).toBeLessThan(56_000_000); }
    const started = now(); f.measuring = true;
    native.send!({ kind: "start", mode, sustained });
    const response = await received.promise;
    expect(response.kind, response.error).toBe("response");
    expect(response.respondedAt - response.requestedAt).toBeLessThan(2000);
    expect(response.response!.snapshot).toMatchObject({ executionId: ticket.executionId, testExecutionId: ticket.testExecutionId, sessionId: ticket.sessionId, controllerInstanceId: ticket.controllerInstanceId, executionGeneration: "1", nativeSessionId, error: null });
    const final = await completed.promise, finished = now();
    f.measuring = false;
    expect(final.frameBytes).toBe(95); expect(f.consumed).toBe(final.produced);
    if (!sustained) expect(final.produced).toBe(400);
    expect(f.requests).toHaveLength(1); expect(f.responses).toHaveLength(1);
    expect(f.requests[0]!.consumed).toBeGreaterThan(0);
    expect(f.responses[0]!.consumed).toBeLessThan(final.produced);
    const remainingReadAtResponse = Math.min(final.produced, Math.floor(f.responses[0]!.readBytes / 95)) - f.responses[0]!.consumed;
    expect(remainingReadAtResponse).toBeGreaterThan(0);
    expect(timerConsumed).toBeGreaterThan(0); expect(timerConsumed).toBeLessThan(final.produced);
    // Independent process time origins are not aligned precisely enough for
    // sub-millisecond ordering. The first-frame message triggers the client;
    // all ordering comparisons use observations on the Controller's clock.
    expect(delivery[0]).toBeLessThan(f.requests[0]!.at);
    expect(f.responses[0]!.at).toBeLessThan(delivery.at(-1)!);
    expect(responseObservedAt).not.toBeNull();
    expect(responseObservedAt!).toBeLessThan(delivery.at(-1)!);
    const entry = JSON.parse((db.prepare("SELECT value FROM timeline_entries WHERE id=?").get(activeId) as { value: string }).value) as { output: { type: string; text: string }[]; revision: string };
    const expected = "a".repeat(24750) + "0123456789".repeat(final.produced);
    expect(entry.output).toEqual([{ type: "text", text: expected }]);
    const finalTotals = totals();
    expect(finalTotals.rows).toBe(initialRows + final.produced);
    let index = 0;
    for (const row of db.prepare("SELECT value FROM outbox ORDER BY sequence").iterate() as Iterable<{ value: string }>) {
      const event = JSON.parse(row.value) as { kind: string; payload: { entryId?: string; output?: { text: string }[] } };
      if (event.kind !== "timeline_upsert" || event.payload.entryId !== activeId) continue;
      expect(event.payload.output).toEqual([{ type: "text", text: "a".repeat(24750) + "0123456789".repeat(index) }]); index++;
    }
    expect(index).toBe(final.produced + 1);
    const allChunks = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
    expect(allChunks).toBeGreaterThanOrEqual(final.produced * 95);
    process.stdout.write(JSON.stringify({ kind: "output-responsiveness", platform: process.platform, nodeVersion: process.version, mode, sustained, producerPid: native.pid, clientPid: client.child.pid, initialRows, initialBytes, notifications: final.produced, notificationBytes: final.produced * 95, chunks, outputStartedAt: final.startedAt, firstConsumedAt: delivery[0], requestReadyAt: response.requestedAt, requestHandled: f.requests[0], responseWritten: f.responses[0], responseReceivedAt: response.respondedAt, parentResponseObservedAt: responseObservedAt, crossProcessTimestamps: "Client absolute timestamps are approximate; ordering uses the first-frame message barrier and Controller-local observations.", lastConsumedAt: delivery.at(-1), remainingAtResponseWrite: final.produced - f.responses[0]!.consumed, timerAt, timerConsumed, responseMs: response.respondedAt - response.requestedAt, totalMs: finished - started, finalSha256: hash(expected), finalRows: finalTotals.rows, finalBytes: finalTotals.bytes, journalVersion: db.pragma("user_version", { simple: true }), acknowledgement: "none", sustainedNativeCreditWindow: sustained ? 64 : null, evidence: "synthetic native OS pipe -> CodexRpc -> CodexProjection -> full runtime timeline/journal; real authenticated runtime IPC; controlled provider and relay; no model" }) + "\n");
  } catch (error) {
    failed = true; primary = error; throw error;
  } finally {
    clearTimeout(deadline); f.measuring = false; if (timer) clearTimeout(timer);
    const failures: unknown[] = [];
    const cleanup = async (action: () => void | Promise<void>) => { try { await action(); } catch (error) { failures.push(error); } };
    await cleanup(() => { db?.close(); });
    await cleanup(async () => {
      if (ready) await requestController(ticket, { kind: "stop", deadline: Date.now() + 10_000 });
      else if (running) process.emit("SIGTERM", "SIGTERM");
    });
    await cleanup(async () => { rpc?.dispose(); await rpc?.stopped; });
    await cleanup(async () => { await producer?.close(); });
    await cleanup(async () => { await client?.close(); });
    await cleanup(async () => { await running; });
    await cleanup(() => rm(root, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, "Output responsiveness fixture cleanup failed.", failed ? { cause: primary } : undefined);
  }
};

test.each([[false, "single"], [false, "per-frame"], [true, "single"], [true, "per-frame"]] as const)("keeps authenticated IPC responsive with backlog=%s and %s native writes", (backlog, mode) => run(backlog, mode), 120_000);
test("responds before a sustained native producer is asked to stop", () => run(false, "per-frame", true), 120_000);
