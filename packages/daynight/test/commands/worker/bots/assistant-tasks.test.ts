import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTaskApiError, assistantTaskClaimFingerprint, type AssistantTask, type AssistantTaskClient, type AssistantTaskClaimInput, type AssistantTaskClaimKind, type AssistantTaskClaimResult, type AssistantTaskEvent } from "../../../../src/api/assistant-task.js";
import { withClaimStorage, type ClaimScope } from "../../../../src/commands/assistant-task/state.js";
import * as claimOperations from "../../../../src/commands/assistant-task/claims.js";
import { createAssistantTaskRuntime, type AssistantApplicationContext, type AssistantTaskClock, type AssistantTaskRuntime, type AssistantTaskRuntimeOptions } from "../../../../src/commands/worker/bots/assistant-tasks.js";
import { AssistantTaskSessionError } from "../../../../src/commands/worker/bots/assistant-task-session.js";
import type { BotRecord } from "../../../../src/commands/worker/bots/types.js";
import { parseSessionCommand, SESSION_PROTOCOL, type SessionCommand, type SessionOperation } from "../../../../src/session/protocol.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-11-13T00:00:00Z"), signal = () => new AbortController().signal;
const token = Buffer.alloc(32, 7).toString("base64url");
const roots: string[] = [], runtimes: AssistantTaskRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const expectClaimLocked = async (scope: ClaimScope): Promise<void> => {
  const entered = vi.fn(async () => undefined), competing = withClaimStorage(scope, entered);
  // Windows excludes competing handles at CreateFileW; POSIX rejects the nonblocking flock.
  if (process.platform === "win32") await expect(competing).rejects.toMatchObject({ stage: "open", win32Code: 32 });
  else await expect(competing).rejects.toThrow("Another process owns this operation submission. Query the original operation.");
  expect(entered).not.toHaveBeenCalled();
};
class Clock implements AssistantTaskClock {
  time = start;
  pending: { due: number; resolve(): void }[] = [];
  now = () => this.time;
  wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = () => { this.pending = this.pending.filter(value => value !== entry); signal.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(signal.reason); };
    const entry = { due: this.time + ms, resolve: () => { cleanup(); resolve(); } };
    if (signal.aborted) { reject(signal.reason); return; }
    this.pending.push(entry); signal.addEventListener("abort", cancel, { once: true });
  });
  advance(ms: number) { this.time += ms; vi.setSystemTime(this.time); for (const entry of [...this.pending]) if (entry.due <= this.time) entry.resolve(); }
}
const fixture = async (botNumber = 3) => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start);
  const root = path.resolve(import.meta.dirname, "../../../../../../.tmp/assistant-runtime-tests"); await mkdir(root, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(root, "case-")); roots.push(stateDirectory);
  const owner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2 + botNumber) }, botId = id(botNumber), clock = new Clock();
  const bot = { owner, botId, observed: { deletion: null }, intent: { sessionId: id(30 + botNumber), executionId: id(40 + botNumber), executionGeneration: "1" } } as BotRecord;
  let task: AssistantTask = { id: id(10), ownerUserId: id(1), application: "", name: "Watch", purpose: "Observe", scope: "Tasks", kind: "continuous", state: "active", takeover: "manual", trigger: null, version: "2", manualVersion: "1", createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(), holderBotId: botId, credentialOperationId: id(11), claimGeneration: "1", claimState: "active", claimedAt: new Date(start).toISOString(), renewedAt: new Date(start).toISOString(), leaseUntil: new Date(start + 300_000).toISOString(), observedAt: new Date(start).toISOString() };
  const scope = { ...owner, botId, stateDirectory, taskId: task.id };
  await withClaimStorage(scope, async storage => { storage.state.credential = { claimToken: token, claimGeneration: "1", credentialOperationId: id(11), requiresRenew: false }; await storage.save(); });
  let events: AssistantTaskEvent[] = [];
  const claimResult = (kind: AssistantTaskClaimKind, input: AssistantTaskClaimInput, current: AssistantTask = task): AssistantTaskClaimResult => ({ operation: { operationId: input.operationId, kind, taskId: current.id, actorBotId: botId, requestFingerprint: assistantTaskClaimFingerprint({ ...input, kind, ownerUserId: owner.ownerUserId, taskId: current.id, actorBotId: botId }), admittedAt: new Date(clock.now()).toISOString(), resultingVersion: current.version, resultingGeneration: current.claimGeneration, holderBotId: current.holderBotId, credentialOperationId: current.credentialOperationId, leaseUntil: current.leaseUntil }, currentClaim: { ...current } });
  const listTasks = vi.fn<AssistantTaskClient["listTasks"]>(async () => ({ items: [{ ...task }], nextCursor: null, observedAt: new Date(clock.now()).toISOString() }));
  const getTask = vi.fn(async () => ({ ...task }));
  const claim = vi.fn(async (_taskId: string, kind: AssistantTaskClaimKind, input: AssistantTaskClaimInput) => claimResult(kind, input));
  const getClaimOperation = vi.fn<AssistantTaskClient["getClaimOperation"]>(async () => { throw new Error("Unexpected receipt recovery"); });
  const listEvents = vi.fn<AssistantTaskClient["listEvents"]>(async (taskId, query) => {
    const after = query?.cursor === undefined ? -1 : events.findIndex(event => event.id === query.cursor);
    if (query?.cursor !== undefined && after < 0) throw new Error("Unexpected event cursor");
    const matching = events.slice(after + 1).filter(event => (taskId === undefined || event.taskId === taskId) && (query?.state === undefined || event.state === query.state) && (query?.targetBotId === undefined || event.targetBotId === query.targetBotId));
    const items = matching.slice(0, query?.limit ?? 200);
    return { items, nextCursor: matching.length > items.length ? items.at(-1)!.id : null, observedAt: new Date(clock.now()).toISOString() };
  });
  const ackEvent = vi.fn<AssistantTaskClient["ackEvent"]>(async (_taskId, eventId, input) => { const event = events.find(event => event.id === eventId)!; return { ...event, state: "delivered", ackOperationId: input.operationId }; });
  const addEvent = vi.fn<AssistantTaskClient["addEvent"]>(async (taskId, input) => ({ id: input.id, taskId, targetBotId: input.targetBotId, type: input.type, payload: input.payload ?? null, state: "pending", attention: false, createdAt: new Date(clock.now()).toISOString(), deliveredAt: null, seenAt: null, ackOperationId: null }));
  const api = { listTasks, getTask, claim, getClaimOperation, listEvents, ackEvent, addEvent } as unknown as AssistantTaskClient;
  const sessionResult = (command: SessionCommand): SessionOperation => ({ protocol: SESSION_PROTOCOL, sessionId: command.sessionId, testExecutionId: command.testExecutionId!, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: "send_message", state: "confirmed", providerResult: "started", error: null });
  const send = vi.fn(async (_bot: BotRecord, command: SessionCommand, _signal: AbortSignal) => sessionResult(command));
  const readOperation = vi.fn(async (_bot: BotRecord, command: SessionCommand, _signal: AbortSignal) => sessionResult(command));
  const healthy = vi.fn(async () => true), idle = vi.fn(async () => true), onError = vi.fn();
  const options: AssistantTaskRuntimeOptions = { owner, bots: () => [bot], stateDirectory: async () => stateDirectory, healthy, idle, withApi: async (_botId, _signal, action) => action(api), sessions: { send, readOperation }, onError, clock };
  const create = () => { const runtime = createAssistantTaskRuntime(options); runtimes.push(runtime); return runtime; };
  const event = (n: number): AssistantTaskEvent => ({ id: id(n), taskId: task.id, targetBotId: botId, type: "trigger", payload: { fact: `Event ${n}` }, state: "pending", attention: false, createdAt: new Date(start).toISOString(), deliveredAt: null, seenAt: null, ackOperationId: null });
  return { owner, bot, scope, clock, create, options, event, claimResult, api, listTasks, getTask, claim, getClaimOperation, listEvents, ackEvent, addEvent, send, readOperation, healthy, idle, onError, get task() { return task; }, set task(value) { task = value; }, get events() { return events; }, set events(value) { events = value; } };
};
const application = (runtime: AssistantTaskRuntime) => {
  const started = deferred<AssistantApplicationContext>(), stopped = deferred();
  runtime.registerApplication("watchdog", context => { started.resolve(context); return new Promise<void>(resolve => { context.signal.addEventListener("abort", () => { stopped.resolve(); resolve(); }, { once: true }); }); });
  return { started: started.promise, stopped: stopped.promise };
};

describe("assistant-task managed loops", () => {
  it("renews at 60-second boundaries and stops renewing when the Controller becomes unhealthy", async () => {
    const f = await fixture(), runtime = f.create(), abort = new AbortController();
    const running = runtime.run(abort.signal);
    await vi.waitFor(() => expect(f.clock.pending.filter(entry => entry.due === start + 60_000)).toHaveLength(4));
    expect(f.claim).toHaveBeenCalledTimes(1); expect(f.claim.mock.calls[0]![1]).toBe("renew");
    f.clock.advance(59_999); expect(f.claim).toHaveBeenCalledTimes(1);
    f.clock.advance(1);
    await vi.waitFor(() => expect(f.clock.pending.filter(entry => entry.due === start + 120_000)).toHaveLength(4));
    expect(f.claim).toHaveBeenCalledTimes(2);
    f.healthy.mockResolvedValue(false); f.clock.advance(60_000);
    await vi.waitFor(() => expect(f.clock.pending.filter(entry => entry.due === start + 180_000)).toHaveLength(4));
    expect(f.claim).toHaveBeenCalledTimes(2);
    abort.abort(); await running;
  });

  it.each(["renew", "takeover", "trigger"] as const)("reads each %s task page through a separate API operation", async lane => {
    const f = await fixture(), pageOperations: object[] = [];
    if (lane === "trigger") { f.task.trigger = { kind: "interval", minutes: 1 }; f.clock.advance(60_000); }
    if (lane === "takeover") {
      f.task = { ...f.task, takeover: "auto", holderBotId: null, credentialOperationId: null, claimGeneration: "0", claimState: "unowned", leaseUntil: null };
      await withClaimStorage(f.scope, async storage => { storage.state.credential = null; await storage.save(); });
      f.claim.mockImplementation(async (_taskId, kind, input) => f.claimResult(kind, input, { ...f.task, holderBotId: f.bot.botId, credentialOperationId: input.operationId, claimState: "active", claimGeneration: "1", leaseUntil: new Date(start + 300_000).toISOString() }));
    }
    const other = { ...f.task, id: id(90), holderBotId: id(91), takeover: "manual" as const, trigger: null };
    f.listTasks.mockImplementation(async query => ({ items: query?.cursor === undefined ? [{ ...f.task }] : [other], nextCursor: query?.cursor === undefined ? "second" : null, observedAt: new Date(f.clock.now()).toISOString() }));
    f.options.withApi = async (_botId, _signal, action) => {
      const operation = {};
      return action({ ...f.api, listTasks: async query => { pageOperations.push(operation); return f.listTasks(query); } });
    };
    await f.create().tick(lane, signal());
    expect(f.listTasks.mock.calls).toEqual([[{ limit: 1 }], [{ limit: 1, cursor: "second" }]]);
    expect(pageOperations).toHaveLength(2); expect(new Set(pageOperations).size).toBe(2);
    if (lane === "trigger") expect(f.addEvent).toHaveBeenCalledOnce();
    else { expect(f.claim).toHaveBeenCalledOnce(); expect(f.claim.mock.calls[0]![1]).toBe(lane === "renew" ? "renew" : "claim"); }
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps an unread application after a task page fails and stops it only after a complete listing proves absence", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const context = await app.started;
    const other = { ...f.task, id: id(90), holderBotId: id(91) };
    const firstPage = { items: [other], nextCursor: "later", observedAt: new Date(start).toISOString() };
    f.listTasks.mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error("Later task page unavailable"));
    await runtime.tick("renew", signal());
    expect(context.signal.aborted).toBe(false); expect(f.claim).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledWith("Later task page unavailable", f.bot.botId);

    const readingLastPage = deferred(), finishListing = deferred();
    f.listTasks.mockResolvedValueOnce(firstPage).mockImplementationOnce(async () => {
      readingLastPage.resolve(); await finishListing.promise;
      return { items: [], nextCursor: null, observedAt: new Date(start).toISOString() };
    });
    const renewal = runtime.tick("renew", signal()); await readingLastPage.promise;
    try { expect(context.signal.aborted).toBe(false); } finally { finishListing.resolve(); }
    await renewal; await app.stopped;
    expect(context.signal.aborted).toBe(true); expect(f.claim).toHaveBeenCalledOnce();
  });

  it("queues each minute's trigger credential read behind the renewal's real private claim lock", async () => {
    const f = await fixture(), runtime = f.create(); f.task.trigger = { kind: "interval", minutes: 1 };
    const readCredential = claimOperations.readClaimCredential;
    const reads = vi.spyOn(claimOperations, "readClaimCredential").mockImplementation(readCredential);
    for (let minute = 1; minute <= 3; minute++) {
      f.clock.advance(60_000);
      const renewing = deferred(), releaseRenewal = deferred(), listedEvents = deferred();
      f.claim.mockImplementationOnce(async (_taskId, kind, input) => { renewing.resolve(); await releaseRenewal.promise; return f.claimResult(kind, input); });
      f.listEvents.mockImplementationOnce(async () => { listedEvents.resolve(); return { items: [], nextCursor: null, observedAt: new Date(f.clock.now()).toISOString() }; });
      const renewal = runtime.tick("renew", signal()); await renewing.promise;
      let trigger: Promise<void> | undefined;
      const priorReads = reads.mock.calls.length;
      try {
        await expectClaimLocked(f.scope);
        trigger = runtime.tick("trigger", signal()); await listedEvents.promise;
        // Drain the ready pagination/scope microtasks. The spy observes entry before the credential reader performs filesystem I/O.
        await nextTurn();
        expect(reads).toHaveBeenCalledTimes(priorReads);
        expect(f.addEvent).toHaveBeenCalledTimes(minute - 1);
      } finally { releaseRenewal.resolve(); await Promise.all([renewal, ...(trigger ? [trigger] : [])]); }
      expect(f.addEvent).toHaveBeenCalledTimes(minute); expect(f.onError).not.toHaveBeenCalled();
      expect(reads).toHaveBeenCalledTimes(priorReads + 2);
    }
    expect(new Set(f.addEvent.mock.calls.map(call => call[1].id)).size).toBe(3);
  });

  it("releases renewal serialization before stopping an application waiting for a guarded credential read", async () => {
    const f = await fixture(), runtime = f.create(); f.task.application = "watchdog";
    const started = deferred(), beginGuard = deferred(), guardEntered = deferred(), appFinished = deferred(), action = vi.fn(async () => {});
    runtime.registerApplication("watchdog", async context => {
      started.resolve(); await beginGuard.promise; guardEntered.resolve();
      try { await context.withClaim(action); } catch (error) { if (!context.signal.aborted) throw error; } finally { appFinished.resolve(); }
    });
    await runtime.tick("renew", signal()); await started.promise;
    const renewing = deferred(), releaseRenewal = deferred();
    f.claim.mockImplementationOnce(async (_taskId, kind, input) => { renewing.resolve(); await releaseRenewal.promise; return f.claimResult(kind, input); });
    const renewal = runtime.tick("renew", signal()); await renewing.promise;
    try {
      beginGuard.resolve(); await guardEntered.promise; await nextTurn();
      f.task.state = "paused";
    } finally { beginGuard.resolve(); releaseRenewal.resolve(); }
    await renewal; await appFinished.promise;
    expect(action).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled();
  });

  it("rechecks task pause after an application guard waits behind trigger credential access", async () => {
    const f = await fixture(), runtime = f.create(); f.task.application = "watchdog"; f.task.trigger = { kind: "interval", minutes: 1 };
    const started = deferred(), beginGuard = deferred(), guardStarted = deferred(), appFinished = deferred(), action = vi.fn(async () => {}), refused = vi.fn();
    runtime.registerApplication("watchdog", async context => {
      started.resolve(); await beginGuard.promise; guardStarted.resolve();
      try { await context.withClaim(action); } catch (error) { refused(error); } finally { appFinished.resolve(); }
    });
    await runtime.tick("renew", signal()); await started.promise; f.clock.advance(60_000);
    const credentialReading = deferred(), releaseCredential = deferred();
    f.getTask.mockImplementationOnce(async () => { const observed = { ...f.task }; credentialReading.resolve(); await releaseCredential.promise; return observed; });
    const trigger = runtime.tick("trigger", signal()); await credentialReading.promise;
    try {
      await expectClaimLocked(f.scope);
      beginGuard.resolve(); await guardStarted.promise; await nextTurn();
      f.task.state = "paused";
    } finally { beginGuard.resolve(); releaseCredential.resolve(); }
    await trigger; await appFinished.promise;
    expect(action).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledOnce(); expect(f.addEvent).not.toHaveBeenCalled();
  });

  it("continues paused claim renewal while cancelling its application", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const context = await app.started;
    expect(context.signal.aborted).toBe(false);
    f.task.state = "paused"; await runtime.tick("renew", signal()); await app.stopped;
    expect(f.claim.mock.calls.map(call => call[1])).toEqual(["renew", "renew"]);
    expect(context.signal.aborted).toBe(true);
  });

  it("keeps the holder application running when another local Bot observes the same task", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const other = { ...f.bot, botId: id(90) }, started = deferred<AssistantApplicationContext>();
    f.options.bots = () => [f.bot, other];
    f.options.withApi = async (botId, _signal, action) => action(botId === other.botId ? { ...f.api, listTasks: async () => { await started.promise; return f.listTasks(); } } : f.api);
    const runtime = f.create();
    runtime.registerApplication("watchdog", context => { started.resolve(context); return new Promise<void>(resolve => { context.signal.addEventListener("abort", () => resolve(), { once: true }); }); });
    await runtime.tick("renew", signal());
    expect((await started.promise).signal.aborted).toBe(false);
  });

  it("stops the application after a confirmed claim_lost renewal refusal", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const context = await app.started;
    f.claim.mockRejectedValueOnce(new AssistantTaskApiError(false, "claim_lost", 409, true));
    await runtime.tick("renew", signal()); await app.stopped;
    expect(context.signal.aborted).toBe(true); expect(f.onError).toHaveBeenCalledWith(expect.stringContaining("claim_lost"), f.bot.botId);
  });

  it.each(["renewal", "health"] as const)("keeps the new holder application after the former holder's delayed %s failure", async failure => {
    const a = await fixture(), b = await fixture(4);
    a.task.application = "watchdog";
    b.task = { ...a.task, holderBotId: b.bot.botId, claimGeneration: "2", claimState: "pending", credentialOperationId: null };
    a.options.stateDirectory = async botId => botId === b.bot.botId ? b.scope.stateDirectory : a.scope.stateDirectory;
    a.options.withApi = async (botId, _signal, action) => action(botId === b.bot.botId ? b.api : a.api);
    const runtime = a.create(), contexts: AssistantApplicationContext[] = [], replacement = deferred<AssistantApplicationContext>();
    runtime.registerApplication("watchdog", context => {
      contexts.push(context); if (context.botId === b.bot.botId) replacement.resolve(context);
      return new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await runtime.tick("renew", signal());
    const original = contexts[0]!, entered = deferred(), release = deferred();
    if (failure === "renewal") a.claim.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new AssistantTaskApiError(false, "claim_lost", 409, true); });
    else a.healthy.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return false; });
    b.listTasks.mockImplementation(async () => { await entered.promise; return { items: [{ ...b.task }], nextCursor: null, observedAt: b.task.observedAt }; });
    b.claim.mockImplementation(async (_taskId, kind, input) => {
      if (kind === "bind") b.task = { ...b.task, claimState: "active", credentialOperationId: input.operationId };
      return b.claimResult(kind, input);
    });
    a.options.bots = () => [a.bot, b.bot];
    const renewal = runtime.tick("renew", signal());
    try {
      const current = await replacement.promise;
      expect(original.signal.aborted).toBe(true); expect(current.signal.aborted).toBe(false);
      release.resolve(); await renewal;
      expect(current.signal.aborted).toBe(false);
      expect(b.claim.mock.calls.map(call => call[1])).toEqual(["bind", "renew"]);
      const action = vi.fn(async () => {}); await current.withClaim(action); expect(action).toHaveBeenCalledOnce();
    } finally { release.resolve(); await renewal; }
  });

  it.each(["1", "9007199254740992"])("keeps the newer holder after generation %s completes its delayed successful credential check", async generation => {
    const a = await fixture(), b = await fixture(4), newer = String(BigInt(generation) + 1n);
    a.task = { ...a.task, application: "watchdog", claimGeneration: generation };
    await withClaimStorage(a.scope, async storage => { storage.state.credential!.claimGeneration = generation; await storage.save(); });
    b.task = { ...a.task, holderBotId: b.bot.botId, claimGeneration: newer, claimState: "pending", credentialOperationId: null };
    a.options.stateDirectory = async botId => botId === b.bot.botId ? b.scope.stateDirectory : a.scope.stateDirectory;
    a.options.withApi = async (botId, _signal, action) => action(botId === b.bot.botId ? b.api : a.api);
    const runtime = a.create(), contexts: AssistantApplicationContext[] = [], replacement = deferred<AssistantApplicationContext>();
    runtime.registerApplication("watchdog", context => {
      contexts.push(context); if (context.botId === b.bot.botId) replacement.resolve(context);
      return new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await runtime.tick("renew", signal());
    const original = contexts[0]!, credentialCheck = deferred(), release = deferred();
    a.getTask.mockResolvedValueOnce({ ...a.task }).mockResolvedValueOnce({ ...a.task }).mockResolvedValueOnce({ ...a.task })
      .mockImplementationOnce(async () => { const captured = { ...a.task }; credentialCheck.resolve(); await release.promise; return captured; });
    b.listTasks.mockImplementation(async () => { await credentialCheck.promise; return { items: [{ ...b.task }], nextCursor: null, observedAt: b.task.observedAt }; });
    b.claim.mockImplementation(async (_taskId, kind, input) => {
      if (kind === "bind") b.task = { ...b.task, claimState: "active", credentialOperationId: input.operationId };
      return b.claimResult(kind, input);
    });
    a.options.bots = () => [a.bot, b.bot];
    const renewal = runtime.tick("renew", signal());
    try {
      const current = await replacement.promise;
      expect(original.signal.aborted).toBe(true); expect(current.signal.aborted).toBe(false);
      release.resolve(); await renewal;
      expect(contexts).toHaveLength(2); expect(current.signal.aborted).toBe(false);
      expect(current.task.claimGeneration).toBe(newer); expect(a.onError).not.toHaveBeenCalled();
      const action = vi.fn(async () => {}); await current.withClaim(action); expect(action).toHaveBeenCalledOnce();
    } finally { release.resolve(); await renewal; }
  });

  it.each(["health", "bind"] as const)("stops its older application when a later same-Bot claim fails %s", async failure => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const original = await app.started;
    f.task = { ...f.task, claimGeneration: "3", claimState: "pending", credentialOperationId: null };
    if (failure === "health") f.healthy.mockResolvedValue(false);
    else f.claim.mockRejectedValueOnce(new AssistantTaskApiError(false, "claim_lost", 409, true));
    await runtime.tick("renew", signal());
    expect(original.signal.aborted).toBe(true); await app.stopped;
    if (failure === "bind") expect(f.claim.mock.calls.at(-1)![1]).toBe("bind");
  });

  it("keeps a newer same-Bot application when an older listing fails its health check", async () => {
    const f = await fixture(); f.task = { ...f.task, application: "watchdog", claimGeneration: "3" };
    await withClaimStorage(f.scope, async storage => { storage.state.credential!.claimGeneration = "3"; await storage.save(); });
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const current = await app.started;
    f.listTasks.mockResolvedValueOnce({ items: [{ ...f.task, claimGeneration: "1" }], nextCursor: null, observedAt: f.task.observedAt });
    f.healthy.mockResolvedValueOnce(false);
    await runtime.tick("renew", signal());
    expect(current.signal.aborted).toBe(false);
  });

  it.each(["health", "claim"] as const)("does not cancel the replacement when an old application guard discovers changed %s", async failure => {
    const a = await fixture(), b = await fixture(4);
    a.task.application = "watchdog";
    b.task = { ...a.task, holderBotId: b.bot.botId, claimGeneration: "2" };
    await withClaimStorage(b.scope, async storage => { storage.state.credential!.claimGeneration = "2"; await storage.save(); });
    a.options.stateDirectory = async botId => botId === b.bot.botId ? b.scope.stateDirectory : a.scope.stateDirectory;
    a.options.withApi = async (botId, _signal, action) => action(botId === b.bot.botId ? b.api : a.api);
    const runtime = a.create(), contexts: AssistantApplicationContext[] = [];
    // The guard remains in flight after its original application factory has returned.
    runtime.registerApplication("watchdog", async context => { contexts.push(context); });
    await runtime.tick("renew", signal());
    const original = contexts[0]!, entered = deferred(), release = deferred(), action = vi.fn(async () => {});
    if (failure === "health") a.healthy.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return false; });
    else a.getTask.mockResolvedValueOnce({ ...a.task }).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ...b.task }; });
    const guarded = original.withClaim(action).then(() => null, error => error);
    await entered.promise;
    try {
      a.options.bots = () => [b.bot]; await runtime.tick("renew", signal());
      const current = contexts[1]!;
      expect(original.signal.aborted).toBe(true); expect(current.signal.aborted).toBe(false);
      release.resolve(); expect(await guarded).toBeInstanceOf(Error);
      expect(action).not.toHaveBeenCalled(); expect(current.signal.aborted).toBe(false);
      await current.withClaim(action); expect(action).toHaveBeenCalledOnce();
    } finally { release.resolve(); await guarded; }
  });

  it("joins the original in-flight Bot work and stops its application before permitting deletion cleanup", async () => {
    const f = await fixture(); f.task.application = "watchdog"; f.events = [f.event(51)];
    const runtime = f.create(), app = application(runtime), entered = deferred<AbortSignal>(), finished = deferred();
    await runtime.tick("renew", signal()); const context = await app.started;
    f.send.mockImplementation(async (_bot, _command, signal) => { entered.resolve(signal); await finished.promise; throw new AssistantTaskSessionError(true, "request_cancelled"); });
    const delivery = runtime.tick("delivery", signal()), requestSignal = await entered.promise;
    let stopped = false; const stop = runtime.stopBot(f.bot.botId).then(() => { stopped = true; });
    await app.stopped; expect(context.signal.aborted).toBe(true); expect(requestSignal.aborted).toBe(true); expect(stopped).toBe(false);
    finished.resolve(); await delivery; await stop; expect(stopped).toBe(true);
    const calls = f.listTasks.mock.calls.length;
    await Promise.all((["renew", "takeover", "delivery", "trigger"] as const).map(lane => runtime.tick(lane, signal())));
    expect(f.listTasks).toHaveBeenCalledTimes(calls); expect(f.send).toHaveBeenCalledOnce(); expect(f.claim).toHaveBeenCalledOnce(); expect(f.ackEvent).not.toHaveBeenCalled();
  });

  it("does not mount an application from a renewal receipt that arrives after Bot stopping began", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), entered = deferred(), receipt = deferred(), factory = vi.fn(async (_context: AssistantApplicationContext) => {});
    runtime.registerApplication("watchdog", factory);
    f.claim.mockImplementation(async (_taskId, kind, input) => { entered.resolve(); await receipt.promise; return f.claimResult(kind, input); });
    const renewal = runtime.tick("renew", signal()); await entered.promise;
    let stopped = false; const stop = runtime.stopBot(f.bot.botId).then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(factory).not.toHaveBeenCalled();
    receipt.resolve(); await renewal; await stop;
    expect(stopped).toBe(true); expect(factory).not.toHaveBeenCalled();
    await runtime.tick("renew", signal()); expect(f.claim).toHaveBeenCalledOnce();
  });

  it("expires application work at the existing five-minute lease when Controller health is lost", async () => {
    const f = await fixture(); f.task.application = "watchdog";
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); const context = await app.started;
    f.healthy.mockResolvedValue(false); f.clock.advance(299_999); expect(context.signal.aborted).toBe(false);
    f.clock.advance(1); await app.stopped; expect(context.signal.aborted).toBe(true);
    await runtime.tick("renew", signal()); expect(f.claim).toHaveBeenCalledTimes(1);
  });

  it("binds a pending transfer then renews its exact generated token before starting an application", async () => {
    const f = await fixture(); f.task = { ...f.task, application: "watchdog", claimState: "pending", credentialOperationId: null };
    await withClaimStorage(f.scope, async storage => { storage.state.credential = null; await storage.save(); });
    f.claim.mockImplementation(async (_taskId, kind, input) => {
      if (kind === "bind") f.task = { ...f.task, claimState: "active", credentialOperationId: input.operationId };
      return f.claimResult(kind, input);
    });
    const runtime = f.create(), app = application(runtime);
    await runtime.tick("renew", signal()); await app.started;
    expect(f.claim.mock.calls.map(call => call[1])).toEqual(["bind", "renew"]);
    expect(f.claim.mock.calls[1]![2]).toMatchObject({ claimToken: f.claim.mock.calls[0]![2].claimToken, claimGeneration: "1" });
    await withClaimStorage(f.scope, async storage => expect(storage.state.credential).toMatchObject({ requiresRenew: false }));
  });

  it("recovers an unknown renewal using its original receipt before any later renewal", async () => {
    const f = await fixture(), runtime = f.create(), actions: string[] = [];
    f.claim.mockImplementationOnce(async (_taskId, _kind, input) => { actions.push(`write:${input.operationId}`); throw new Error("connection lost after renewal"); });
    await runtime.tick("renew", signal());
    const original = f.claim.mock.calls[0]![2];
    f.getClaimOperation.mockImplementation(async (taskId, operationId) => { expect(taskId).toBe(f.task.id); expect(operationId).toBe(original.operationId); actions.push(`read:${operationId}`); return f.claimResult("renew", original); });
    f.claim.mockImplementation(async (_taskId, kind, input) => { actions.push(`write:${input.operationId}`); return f.claimResult(kind, input); });
    await runtime.tick("renew", signal());
    expect(f.getClaimOperation).toHaveBeenCalledOnce(); expect(f.claim).toHaveBeenCalledTimes(2);
    expect(f.claim.mock.calls[1]![2].operationId).not.toBe(original.operationId);
    expect(actions).toEqual([`write:${original.operationId}`, `read:${original.operationId}`, `write:${f.claim.mock.calls[1]![2].operationId}`]);
  });

  it("binds a later transferred generation after an old unknown renewal receipt returns 404", async () => {
    const f = await fixture(), runtime = f.create(), factory = vi.fn(async (_context: AssistantApplicationContext) => {});
    f.task.application = "watchdog"; runtime.registerApplication("watchdog", factory);
    f.claim.mockRejectedValueOnce(new Error("renewal response unavailable"));
    await runtime.tick("renew", signal());
    const original = f.claim.mock.calls[0]![2];
    expect(factory).not.toHaveBeenCalled();
    await withClaimStorage(f.scope, async storage => expect(storage.state.pending).toBe(original.operationId));

    f.task = { ...f.task, version: "4", claimGeneration: "3", claimState: "pending", credentialOperationId: null };
    f.getClaimOperation.mockRejectedValue(new AssistantTaskApiError(false, "claim_operation_not_found", 404, true));
    f.claim.mockImplementation(async (_taskId, kind, input) => {
      if (kind === "bind") f.task = { ...f.task, claimState: "active", credentialOperationId: input.operationId };
      return f.claimResult(kind, input);
    });
    f.onError.mockClear();
    await runtime.tick("renew", signal());

    expect(f.getClaimOperation).toHaveBeenCalledOnce();
    expect(f.getClaimOperation).toHaveBeenCalledWith(f.task.id, original.operationId, expect.objectContaining({ kind: "renew", actorBotId: f.bot.botId }));
    expect(f.claim.mock.calls.map(call => call[1])).toEqual(["renew", "bind", "renew"]);
    const bound = f.claim.mock.calls[1]![2], renewed = f.claim.mock.calls[2]![2];
    expect(bound).toMatchObject({ expectedGeneration: "3" });
    expect(bound.operationId).not.toBe(original.operationId); expect(bound.claimToken).not.toBe(original.claimToken);
    expect(renewed).toMatchObject({ claimGeneration: "3", claimToken: bound.claimToken });
    expect(new Set(f.claim.mock.calls.map(call => call[2].operationId)).size).toBe(3);
    await withClaimStorage(f.scope, async storage => {
      expect(storage.state.pending).toBeNull();
      expect(storage.state.credential).toMatchObject({ claimGeneration: "3", credentialOperationId: bound.operationId, requiresRenew: false });
      expect((await storage.readOperation(original.operationId))?.input).toEqual(original);
    });
    expect(factory).toHaveBeenCalledOnce(); expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(["active", "pending"] as const)("retains a same-generation unknown %s claim after receipt 404 without resubmitting", async claimState => {
    const f = await fixture(), runtime = f.create(), factory = vi.fn(async (_context: AssistantApplicationContext) => {});
    f.task = { ...f.task, application: "watchdog", claimState, ...(claimState === "pending" ? { credentialOperationId: null } : {}) };
    if (claimState === "pending") await withClaimStorage(f.scope, async storage => { storage.state.credential = null; await storage.save(); });
    runtime.registerApplication("watchdog", factory);
    f.claim.mockRejectedValueOnce(new Error("claim response unavailable"));
    await runtime.tick("renew", signal());
    const original = f.claim.mock.calls[0]![2];
    f.getClaimOperation.mockRejectedValue(new AssistantTaskApiError(false, "claim_operation_not_found", 404, true));
    f.onError.mockClear();
    await runtime.tick("renew", signal());

    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.claim.mock.calls[0]![1]).toBe(claimState === "pending" ? "bind" : "renew");
    expect(f.getClaimOperation).toHaveBeenCalledOnce();
    expect(f.getClaimOperation.mock.calls[0]!.slice(0, 2)).toEqual([f.task.id, original.operationId]);
    await withClaimStorage(f.scope, async storage => {
      expect(storage.state.pending).toBe(original.operationId);
      expect(await storage.readOperation(original.operationId)).toMatchObject({ input: original, phase: "prepared" });
    });
    expect(factory).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledWith(expect.stringContaining(`Claim operation ${original.operationId} is unconfirmed`), f.bot.botId);
  });

  it("lets the service refusal settle simultaneous automatic takeover without retrying the loser", async () => {
    const a = await fixture(3), b = await fixture(4), arrived = deferred(); let calls = 0;
    for (const f of [a, b]) {
      f.task = { ...f.task, takeover: "auto", holderBotId: null, credentialOperationId: null, claimGeneration: "0", claimState: "unowned", leaseUntil: null };
      await withClaimStorage(f.scope, async storage => { storage.state.credential = null; await storage.save(); });
    }
    a.claim.mockImplementation(async (_taskId, kind, input) => { if (++calls === 2) arrived.resolve(); await arrived.promise; return a.claimResult(kind, input, { ...a.task, holderBotId: a.bot.botId, credentialOperationId: input.operationId, claimState: "active", claimGeneration: "1", leaseUntil: new Date(start + 300_000).toISOString() }); });
    b.claim.mockImplementation(async () => { if (++calls === 2) arrived.resolve(); await arrived.promise; throw new AssistantTaskApiError(false, "claim_held", 409, true); });
    await Promise.all([a.create().tick("takeover", signal()), b.create().tick("takeover", signal())]);
    expect(a.claim).toHaveBeenCalledOnce(); expect(b.claim).toHaveBeenCalledOnce();
    await withClaimStorage(a.scope, async storage => expect(storage.state.credential?.credentialOperationId).toBe(a.claim.mock.calls[0]![2].operationId));
    await withClaimStorage(b.scope, async storage => { expect(storage.state.credential).toBeNull(); expect((await storage.readOperation(b.claim.mock.calls[0]![2].operationId))?.phase).toBe("refused"); });
    expect(b.onError).not.toHaveBeenCalled();
  });

  it("merges all pending events once the Session becomes idle, without acknowledging the rejected busy attempt", async () => {
    const f = await fixture(), runtime = f.create(); f.events = [f.event(51), f.event(52)];
    f.idle.mockResolvedValue(false);
    await runtime.tick("delivery", signal()); expect(f.send).not.toHaveBeenCalled(); expect(f.ackEvent).not.toHaveBeenCalled();
    f.events.push(f.event(53)); f.idle.mockResolvedValue(true); await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ackEvent).toHaveBeenCalledTimes(3);
    const input = f.send.mock.calls[0]![1];
    expect(input.kind).toBe("send_message");
    if (input.kind !== "send_message") throw new Error("Wrong notification kind");
    expect(input.payload.origin).toBe("daynight"); expect(input.payload.expectedTurnId).toBeNull();
    const text = JSON.stringify(input.payload.content); for (const event of f.events) expect(text).toContain(event.id);
  });

  it("delivers takeover timestamps and gap guidance from the historical event without substituting the current claim", async () => {
    const f = await fixture(), runtime = f.create();
    const previousLeaseUntil = "2026-11-12T23:59:01.123456Z", createdAt = "2026-11-13T00:01:01.654321Z";
    f.events = [{ ...f.event(51), type: "takeover", createdAt, payload: { generation: "2", previousLeaseUntil } }];
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ackEvent).toHaveBeenCalledOnce(); expect(f.getTask).not.toHaveBeenCalled();
    const input = f.send.mock.calls[0]![1];
    if (input.kind !== "send_message") throw new Error("Wrong notification kind");
    const text = input.payload.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    expect(text).toContain(previousLeaseUntil); expect(text).toContain(createdAt); expect(text).not.toContain(f.task.leaseUntil!);
    expect(text).toContain("previousLeaseUntil 早于本事件时间时，两者之间是租约空档");
    expect(text).toContain("否则没有过期租约空档");
    expect(text).toContain("不能证明助手实际停止工作的时间");
    expect(text).toContain("不用当前认领时间替代历史事件时间");
  });

  it("only queries a durable unknown Session submission after runtime reconstruction", async () => {
    const f = await fixture(); f.events = [f.event(51), f.event(52)];
    f.send.mockRejectedValueOnce(new AssistantTaskSessionError(true, "request_failed"));
    const first = f.create(); await first.tick("delivery", signal()); await first.shutdown();
    expect(f.ackEvent).not.toHaveBeenCalled();
    const original = f.send.mock.calls[0]![1]; await f.create().tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.readOperation).toHaveBeenCalledWith(f.bot, original, expect.any(AbortSignal));
    expect(f.ackEvent).toHaveBeenCalledTimes(2);
    expect(f.ackEvent.mock.calls.every(call => call[2].operationId === original.operationId)).toBe(true);
  });

  it("delivers an event with a legal large payload without blocking later notifications", async () => {
    const f = await fixture(), runtime = f.create(); f.events = [{ ...f.event(51), payload: { fact: "x".repeat(600 * 1024) } }, f.event(52)];
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ackEvent).toHaveBeenCalledTimes(2);
    const input = JSON.stringify(f.send.mock.calls[0]![1]);
    expect(input).toContain(id(51)); expect(input).toContain(id(52));
    expect(Buffer.byteLength(input)).toBeLessThan(2 * 1024 * 1024);
  });

  it("continues delivery and acknowledgment across batches whose event payloads exceed 32 MiB in total", async () => {
    const f = await fixture(), runtime = f.create(), payload = { fact: "x".repeat(450 * 1024) };
    f.events = Array.from({ length: 80 }, (_, index) => ({ ...f.event(100 + index), payload }));
    expect(Buffer.byteLength(JSON.stringify(payload)) * f.events.length).toBeGreaterThan(32 * 1024 * 1024);
    f.ackEvent.mockImplementation(async (_taskId, eventId, input) => {
      const index = f.events.findIndex(event => event.id === eventId);
      const delivered: AssistantTaskEvent = { ...f.events[index]!, state: "delivered", ackOperationId: input.operationId };
      f.events[index] = delivered; return delivered;
    });
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.ackEvent.mock.calls.length).toBeGreaterThan(0); expect(f.ackEvent.mock.calls.length).toBeLessThan(80);
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.ackEvent).toHaveBeenCalledTimes(80);
    expect(new Set(f.ackEvent.mock.calls.map(call => call[1])).size).toBe(80);
    expect(f.events.every(event => event.state === "delivered")).toBe(true);
    expect(f.listEvents.mock.calls.every(([, query]) => query?.limit === 1 && query.state === "pending" && query.targetBotId === f.bot.botId)).toBe(true);
    for (const [, command] of f.send.mock.calls) {
      if (command.kind !== "send_message") throw new Error("Wrong notification kind");
      expect(Buffer.byteLength(command.payload.content.filter(part => part.type === "text").map(part => part.text).join(""))).toBeLessThanOrEqual(512 * 1024);
    }
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("queries and acknowledges only pending events for the local Bot", async () => {
    const f = await fixture(), runtime = f.create();
    f.events = [f.event(51), { ...f.event(52), targetBotId: id(90) }, { ...f.event(53), state: "delivered" }];
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ackEvent).toHaveBeenCalledOnce();
    expect(f.ackEvent.mock.calls[0]![1]).toBe(id(51));
    expect(f.listEvents.mock.calls.every(([, query]) => query?.state === "pending" && query.targetBotId === f.bot.botId)).toBe(true);
    const text = JSON.stringify(f.send.mock.calls[0]![1]);
    expect(text).toContain(id(51)); expect(text).not.toContain(id(52)); expect(text).not.toContain(id(53));
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps Unicode valid when the payload summary boundary intersects an emoji", async () => {
    const f = await fixture(), runtime = f.create(); f.events = [{ ...f.event(51), payload: { fact: `${"x".repeat(7990)}😀` } }];
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (bot, command, signal) => { parseSessionCommand(command); return send(bot, command, signal); });
    await runtime.tick("delivery", signal());
    expect(f.ackEvent).toHaveBeenCalledOnce(); expect(f.onError).not.toHaveBeenCalled();
  });

  it.each([["state-changed", "direct"], ["expired", "direct"], ["state-changed", "recovery"], ["expired", "recovery"]])("allows a new delivery after a service-confirmed %s refusal from %s", async (reason, source) => {
    const f = await fixture(), runtime = f.create(); f.events = [f.event(51)];
    const refused = (command: SessionCommand): SessionOperation => ({ protocol: SESSION_PROTOCOL, sessionId: command.sessionId, testExecutionId: command.testExecutionId!, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: "send_message", state: reason === "expired" ? "expired" : "rejected", providerResult: null, error: reason === "expired" ? null : { code: "permission_or_state_changed", message: "Operation no longer has current permission or state." } });
    if (source === "direct") f.send.mockImplementationOnce(async (_bot, command) => refused(command));
    else { f.send.mockRejectedValueOnce(new AssistantTaskSessionError(true, "request_failed")); f.readOperation.mockImplementation(async (_bot, command) => refused(command)); }
    await runtime.tick("delivery", signal()); expect(f.ackEvent).not.toHaveBeenCalled();
    if (source === "recovery") { await runtime.tick("delivery", signal()); expect(f.send).toHaveBeenCalledOnce(); expect(f.ackEvent).not.toHaveBeenCalled(); }
    await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.ackEvent).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[1]![1].operationId).not.toBe(f.send.mock.calls[0]![1].operationId);
  });

  it("does not reinterpret a provider rejection without nonacceptance proof as permission to resend", async () => {
    const f = await fixture(), runtime = f.create(); f.events = [f.event(51)];
    let original!: SessionOperation;
    f.send.mockImplementationOnce(async (_bot, command) => original = { protocol: SESSION_PROTOCOL, sessionId: command.sessionId, testExecutionId: command.testExecutionId!, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: "send_message", state: "rejected", providerResult: null, error: { code: "provider_error", message: "Provider response did not establish nonacceptance" } });
    f.readOperation.mockImplementation(async () => original);
    await runtime.tick("delivery", signal()); await runtime.tick("delivery", signal()); await runtime.tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.readOperation).toHaveBeenCalledTimes(2); expect(f.ackEvent).not.toHaveBeenCalled();
    expect(f.readOperation.mock.calls.every(call => call[1].operationId === original.operationId)).toBe(true);
  });

  it("recovers a lost ACK response by reading event state without sending or acknowledging it twice", async () => {
    const f = await fixture(); f.events = [f.event(51), f.event(52)];
    f.ackEvent.mockImplementationOnce(async (_taskId, eventId, input) => {
      f.events = f.events.map(event => event.id === eventId ? { ...event, state: "delivered", ackOperationId: input.operationId } : event);
      throw new AssistantTaskApiError(true, "request_failed");
    });
    const first = f.create(); await first.tick("delivery", signal()); await first.shutdown();
    await f.create().tick("delivery", signal());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.readOperation).not.toHaveBeenCalled();
    expect(f.ackEvent.mock.calls.map(call => call[1])).toEqual([id(51), id(52)]);
    expect(f.ackEvent.mock.calls[0]![2].operationId).toBe(f.ackEvent.mock.calls[1]![2].operationId);
  });

  it.each(["interval", "daily"])("does not duplicate a due %s event after runtime reconstruction", async kind => {
    const f = await fixture(); f.task.trigger = kind === "interval" ? { kind, minutes: 1 } : { kind, time: "00:01", timeZone: "UTC" }; f.clock.advance(60_000);
    const first = f.create(); await first.tick("trigger", signal()); await first.shutdown();
    expect(f.addEvent).toHaveBeenCalledOnce();
    f.listEvents.mockClear(); f.listEvents.mockRejectedValue(new Error("Confirmed trigger must not scan event history"));
    const second = f.create(); await second.tick("trigger", signal()); expect(f.addEvent).toHaveBeenCalledOnce();
    expect(f.listEvents).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled();
    f.task.state = "paused"; f.clock.advance(60_000); await second.tick("trigger", signal()); expect(f.addEvent).toHaveBeenCalledOnce();
  });
});
