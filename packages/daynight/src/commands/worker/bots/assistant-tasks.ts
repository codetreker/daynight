import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantTaskApiError, type AssistantTask, type AssistantTaskClient } from "../../../api/assistant-task.js";
import type { AssistantTaskEvent, AssistantTaskEventQuery } from "../../../api/assistant-task.js";
import { parseSessionCommand, SESSION_PROTOCOL, type SessionCommand, type SessionOperation } from "../../../session/protocol.js";
import { readClaimCredential, recoverClaimOperation, runClaimOperation } from "../../assistant-task/claims.js";
import { withClaimStorage } from "../../assistant-task/state.js";
import { AssistantTaskSessionError } from "./assistant-task-session.js";
import { withAssistantRuntimeState } from "./assistant-task-state.js";
import { assistantTaskPages } from "./assistant-task-pages.js";
import { INBOUND_EVENT_TYPE } from "./assistant-task-inbound.js";
import { relatedExperience } from "./assistant-task-experience.js";
import { createNotificationBatch } from "./assistant-task-notification.js";
import { assistantTriggerId, assistantTriggerOccurrence } from "./assistant-task-trigger.js";
import type { BotOwner, BotRecord } from "./types.js";

export const ASSISTANT_TASK_INTERVAL_MS = 60_000;
export type AssistantTaskClock = { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
export type AssistantApplicationContext = {
  task: AssistantTask; botId: string; signal: AbortSignal;
  /** Revalidate health, state and the original claim immediately before every externally visible action. */
  withClaim<T>(action: (api: AssistantTaskClient, task: AssistantTask, credential: { claimToken: string; claimGeneration: string }) => Promise<T>): Promise<T>;
};
export type AssistantApplicationFactory = (context: AssistantApplicationContext) => Promise<void>;
type Delivery = { command: SessionCommand; events: { taskId: string; id: string }[]; confirmed: boolean };
type EventTypeFilter = { type?: string; excludeType?: string };
type TriggerState = { id: string; occurrence: string; confirmed: boolean };
type Application = { botId: string; generation: string; cancellation: AbortController; expiry: AbortController; work: Promise<void> };
export type AssistantTaskRuntimeOptions = {
  owner: BotOwner; bots(): readonly BotRecord[];
  stateDirectory(botId: string): Promise<string>;
  healthy(record: BotRecord, signal: AbortSignal): Promise<boolean>;
  idle(record: BotRecord, signal: AbortSignal): Promise<boolean>;
  withApi<T>(botId: string | undefined, signal: AbortSignal, action: (api: AssistantTaskClient) => Promise<T>): Promise<T>;
  sessions: { send(record: BotRecord, command: SessionCommand, signal: AbortSignal): Promise<SessionOperation>; readOperation(record: BotRecord, command: SessionCommand, signal: AbortSignal): Promise<SessionOperation> };
  onError(message: string, botId: string | null): void;
  clock?: AssistantTaskClock;
};
const held = (task: AssistantTask, botId: string, now: number): boolean => task.holderBotId === botId && task.claimState === "active" && task.leaseUntil !== null && Date.parse(task.leaseUntil) > Math.max(now, Date.parse(task.observedAt));
// The service expires only before dispatch and gives stale offers this specific refusal code. Native failures use native_operation_error.
const notDispatched = (operation: SessionOperation): boolean => operation.providerResult === null
  && (operation.state === "expired" && operation.error === null || operation.state === "rejected" && operation.error?.code === "permission_or_state_changed");
/** Four independent minute loops; lifecycle cancellation joins applications before the Bot host stops Controllers. */
export const createAssistantTaskRuntime = (options: AssistantTaskRuntimeOptions) => {
  const clock = options.clock ?? { now: Date.now, wait: (ms, signal) => delay(ms, undefined, { signal }) };
  const factories = new Map<string, AssistantApplicationFactory>(), applications = new Map<string, Application>();
  const cancellation = new AbortController(), inFlight = new Set<Promise<void>>();
  const lanes = new Map<string, Promise<void>>();
  const claimWork = new Map<string, Promise<unknown>>();
  const stoppedBots = new Set<string>(), botCancellation = new Map<string, AbortController>(), botWork = new Map<string, Set<Promise<void>>>();
  let running: Promise<void> | null = null, closed = false;
  const report = (error: unknown, botId: string | null) => options.onError(error instanceof Error ? error.message : "Assistant task maintenance failed.", botId);
  const stopApplication = async (taskId: string, current: Application | null = applications.get(taskId) ?? null): Promise<void> => {
    if (!current) return;
    current.cancellation.abort(); current.expiry.abort();
    await current.work;
    if (applications.get(taskId) === current) applications.delete(taskId);
  };
  const localBots = () => options.bots().filter(bot => !stoppedBots.has(bot.botId) && bot.observed.deletion === null && bot.intent?.sessionId !== null && bot.intent !== null);
  const withBot = async (bot: BotRecord, signal: AbortSignal, action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (stoppedBots.has(bot.botId)) return;
    let cancel = botCancellation.get(bot.botId);
    if (!cancel) { cancel = new AbortController(); botCancellation.set(bot.botId, cancel); }
    const jobs = botWork.get(bot.botId) ?? new Set<Promise<void>>(); botWork.set(bot.botId, jobs);
    const work = Promise.resolve().then(() => action(AbortSignal.any([signal, cancellation.signal, cancel.signal]))).finally(() => jobs.delete(work));
    jobs.add(work); await work;
  };
  const scope = async (bot: BotRecord, taskId: string, api: AssistantTaskClient) => ({ serverOrigin: options.owner.serverOrigin, ownerUserId: options.owner.ownerUserId, botId: bot.botId, stateDirectory: await options.stateDirectory(bot.botId), taskId, api });
  const withLocalClaim = async <T>(botId: string, taskId: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    const key = `${botId}/${taskId}`, previous = claimWork.get(key);
    const work = (async () => { await previous?.catch(() => undefined); signal.throwIfAborted(); return action(); })();
    claimWork.set(key, work);
    try { return await work; } finally { if (claimWork.get(key) === work) claimWork.delete(key); }
  };
  const healthy = async (bot: BotRecord, signal: AbortSignal): Promise<boolean> => {
    const current = localBots().find(value => value.botId === bot.botId);
    return current !== undefined && await options.healthy(current, signal);
  };
  const guard = async <T>(bot: BotRecord, taskId: string, application: Application, signal: AbortSignal, action: (api: AssistantTaskClient, task: AssistantTask, credential: { claimToken: string; claimGeneration: string }) => Promise<T>): Promise<T> => options.withApi(bot.botId, signal, async api => {
    signal.throwIfAborted();
    const credential = await withLocalClaim(bot.botId, taskId, signal, async () => readClaimCredential(await scope(bot, taskId, api)));
    if (!await healthy(bot, signal)) { application.cancellation.abort(); throw new Error("Assistant Controller is unhealthy; application work is stopped."); }
    const task = await api.getTask(taskId);
    if (task.state !== "active" || !held(task, bot.botId, clock.now()) || task.claimGeneration !== application.generation) { application.cancellation.abort(); throw new Error("Assistant task is paused or its original claim is no longer active."); }
    signal.throwIfAborted();
    return action(api, task, credential);
  });
  const syncApplication = async (bot: BotRecord, task: AssistantTask, signal: AbortSignal): Promise<void> => {
    const factory = factories.get(task.application);
    for (;;) {
      signal.throwIfAborted();
      if (stoppedBots.has(bot.botId)) return;
      const previous = applications.get(task.id);
      // Generations are canonical int64 decimal strings. A delayed successful
      // renewal cannot replace a newer claim, including while joining an old app.
      if (previous && BigInt(task.claimGeneration) < BigInt(previous.generation)) return;
      if (!previous || !(previous.botId !== bot.botId || previous.cancellation.signal.aborted || previous.generation !== task.claimGeneration || task.state !== "active" || !held(task, bot.botId, clock.now()) || !factory)) break;
      await stopApplication(task.id, previous);
    }
    if (!factory || task.state !== "active" || !held(task, bot.botId, clock.now())) return;
    let app = applications.get(task.id);
    if (!app) {
      const cancel = new AbortController();
      const appSignal = AbortSignal.any([cancel.signal, cancellation.signal, signal]);
      app = { botId: bot.botId, generation: task.claimGeneration, cancellation: cancel, expiry: new AbortController(), work: Promise.resolve() };
      applications.set(task.id, app);
      const current = app;
      app.work = Promise.resolve().then(() => factory({ task, botId: bot.botId, signal: appSignal,
        withClaim: action => guard(bot, task.id, current, appSignal, action),
      })).catch(error => { if (!appSignal.aborted) { cancel.abort(); report(error, bot.botId); } });
    }
    app.expiry.abort(); app.expiry = new AbortController();
    const target = app;
    void clock.wait(Math.max(0, Date.parse(task.leaseUntil!) - clock.now()), AbortSignal.any([app.expiry.signal, cancellation.signal])).then(() => target.cancellation.abort(), () => undefined);
  };
  const recover = async (bot: BotRecord, task: AssistantTask, api: AssistantTaskClient): Promise<void> => {
    const context = await scope(bot, task.id, api);
    const pending = await withClaimStorage(context, async storage => storage.state.pending);
    if (pending) await recoverClaimOperation({ ...context, operationId: pending });
  };
  const tasksFor = (botId: string | undefined, signal: AbortSignal) => assistantTaskPages(
    query => options.withApi(botId, signal, api => api.listTasks(query)),
  );
  const renewBot = async (bot: BotRecord, signal: AbortSignal): Promise<void> => {
    const seenOwnedIds = new Set<string>();
    for await (const task of tasksFor(bot.botId, signal)) {
      if (task.holderBotId !== bot.botId) continue;
      seenOwnedIds.add(task.id);
      const current = applications.get(task.id);
      // A late renewal or health result can cancel only the application it observed.
      const original = current?.botId === bot.botId && BigInt(current.generation) <= BigInt(task.claimGeneration) ? current : null;
      try {
        if (!await healthy(bot, signal)) { await stopApplication(task.id, original); continue; }
        const renewed = await withLocalClaim(bot.botId, task.id, signal, () => options.withApi(bot.botId, signal, async api => {
          // A missing old receipt is not a replay permission. The shared claim state machine
          // re-reads the generation before retiring an obsolete operation or binding a transfer.
          try { await recover(bot, task, api); } catch (error) { if (!(error instanceof AssistantTaskApiError && error.status === 404)) throw error; }
          const current = await api.getTask(task.id), context = await scope(bot, task.id, api);
          if (current.claimState === "pending" && current.holderBotId === bot.botId) await runClaimOperation({ ...context, kind: "bind", operationId: randomUUID(), expectedGeneration: current.claimGeneration });
          await runClaimOperation({ ...context, kind: "renew", operationId: randomUUID() });
          const currentTask = await api.getTask(task.id);
          await readClaimCredential(context);
          return currentTask;
        }));
        await syncApplication(bot, renewed, signal);
      } catch (error) { await stopApplication(task.id, original); if (!signal.aborted) report(error, bot.botId); }
    }
    // Only a complete listing proves that an existing application is no longer owned.
    for (const [taskId, app] of applications) if (app.botId === bot.botId && !seenOwnedIds.has(taskId)) await stopApplication(taskId, app);
  };
  const takeover = async (signal: AbortSignal): Promise<void> => {
    const bots: BotRecord[] = [];
    for (const bot of localBots()) { try { if (await healthy(bot, signal)) bots.push(bot); } catch (error) { report(error, bot.botId); } }
    if (!bots.length) return;
    for await (const task of tasksFor(undefined, signal)) {
      if (task.state !== "active" || task.takeover !== "auto" || !["unowned", "expired"].includes(task.claimState)) continue;
      const bot = bots.find(candidate => candidate.botId !== task.holderBotId) ?? bots[0]!;
      await withBot(bot, signal, botSignal => withLocalClaim(bot.botId, task.id, botSignal, () => options.withApi(bot.botId, botSignal, async api => {
        try {
          const current = await api.getTask(task.id);
          if (current.state !== "active" || current.takeover !== "auto" || !["unowned", "expired"].includes(current.claimState) || !await healthy(bot, botSignal)) return;
          const context = await scope(bot, task.id, api);
          // A pending operation is recovered before making a new claim decision. An expired possible claim may be retired by the shared CLI state machine.
          try { await recover(bot, current, api); } catch (error) { if (!(error instanceof AssistantTaskApiError && error.status === 404)) throw error; }
          await runClaimOperation({ ...context, kind: "claim", operationId: randomUUID(), ifVersion: current.version, expectedGeneration: current.claimGeneration });
        } catch (error) { if (!signal.aborted && !(error instanceof AssistantTaskApiError && ["claim_held", "version_conflict"].includes(error.code ?? ""))) report(error, bot.botId); }
      })));
    }
  };
  const eventsFor = (bot: BotRecord, signal: AbortSignal, taskId?: string, pending = false, filter: EventTypeFilter = {}) => assistantTaskPages<AssistantTaskEvent, AssistantTaskEventQuery>(
    query => options.withApi(bot.botId, signal, api => api.listEvents(taskId, query)),
    pending ? { state: "pending", targetBotId: bot.botId, ...filter } : {},
  );
  /** Pending events for this Bot in page order; every item must match the requested filters. */
  async function* pendingEvents(bot: BotRecord, signal: AbortSignal, filter: EventTypeFilter = {}): AsyncGenerator<AssistantTaskEvent> {
    for await (const event of eventsFor(bot, signal, undefined, true, filter)) {
      if (event.targetBotId !== bot.botId || event.state !== "pending"
        || (filter.type !== undefined && event.type !== filter.type) || (filter.excludeType !== undefined && event.type === filter.excludeType)) {
        throw new Error("Assistant event page conflicts with its target, state or type filter.");
      }
      yield event;
    }
  }
  const deliveryBot = async (bot: BotRecord, signal: AbortSignal): Promise<void> => {
    await withAssistantRuntimeState({ owner: options.owner, stateDirectory: await options.stateDirectory(bot.botId), key: "delivery" }, async (read, save) => {
      const saved = await read();
      let delivery: Delivery | null = null;
      if (saved !== null) {
        const value = saved as Delivery;
        const command = parseSessionCommand(value.command);
        if (!Array.isArray(value.events) || !value.events.length || value.events.some(event => typeof event.taskId !== "string" || typeof event.id !== "string") || typeof value.confirmed !== "boolean") throw new Error("Invalid assistant delivery journal.");
        delivery = { ...value, command };
      }
      if (!delivery) {
        if (!await healthy(bot, signal) || !await options.idle(bot, signal)) return;
        const notification = createNotificationBatch(), batch = notification.events, admitted: AssistantTaskEvent[] = [];
        // Non-inbound events are selected first, so an inbound backlog never
        // blocks other assistant task notifications. Inbound events are then
        // paged separately until the inbound budget or the batch limit; the
        // server omits paused tasks, and unselected events stay pending without
        // any per-event skip request.
        let full = false;
        for await (const event of pendingEvents(bot, signal, { excludeType: INBOUND_EVENT_TYPE })) {
          if (notification.add(event) === "added") { admitted.push(event); continue; }
          if (!batch.length) throw new Error("Assistant notification exceeds its bounded Session input size.");
          full = true; break;
        }
        if (!full) {
          for await (const event of pendingEvents(bot, signal, { type: INBOUND_EVENT_TYPE })) {
            const admission = notification.add(event);
            if (admission === "added") { admitted.push(event); continue; }
            if (admission === "full" && !batch.length) throw new Error("Assistant notification exceeds its bounded Session input size.");
            break;
          }
        }
        if (!batch.length) return;
        // Experience reads finish before the journal is saved, so a replayed
        // Session command carries the same summaries.
        const experience = await relatedExperience(admitted, {
          itemCategory: (taskId, itemId) => options.withApi(bot.botId, signal, async api => (await api.getItem(taskId, itemId)).category),
          related: (taskId, query) => options.withApi(bot.botId, signal, async api => (await api.relatedAppendix(taskId, query)).items),
        }, notification.remaining(), signal);
        const intent = bot.intent!;
        const command: SessionCommand = { protocol: SESSION_PROTOCOL, sessionId: intent.sessionId!, testExecutionId: intent.executionId, executionGeneration: intent.executionGeneration,
          requestId: randomUUID(), operationId: randomUUID(), kind: "send_message", payload: { content: [{ type: "text", text: notification.text(experience) }], expectedTurnId: null, origin: "daynight" } };
        delivery = { command, events: batch, confirmed: false };
        await save(delivery);
        try {
          const result = await options.sessions.send(bot, command, signal);
          if (notDispatched(result)) { await save(null); return; }
          delivery.confirmed = ["provider_accepted", "confirmed"].includes(result.state);
          await save(delivery);
        } catch (error) {
          if (error instanceof AssistantTaskSessionError && !error.outcomeUnconfirmed) await save(null);
          throw error;
        }
      } else if (!delivery.confirmed) {
        const result = await options.sessions.readOperation(bot, delivery.command, signal);
        if (notDispatched(result)) { await save(null); return; }
        delivery.confirmed = ["provider_accepted", "confirmed"].includes(result.state);
        await save(delivery);
      }
      if (!delivery.confirmed) return;
      // Pending-only reads exclude delivered history. Each page and ACK has its own
      // bounded API operation; a lost ACK response never creates a new Session command.
      // The journal does not record event types. Non-inbound events are acknowledged
      // first without reading the inbound backlog. Delivered inbound events were the
      // earliest pending inbound events of non-paused tasks, so the server-filtered
      // inbound read reaches them before any later backlog and never reads a paused
      // task's backlog. Only an event still unacknowledged after both passes, such
      // as one whose task was paused after the notification was sent, needs the
      // unfiltered read.
      const remaining = new Set(delivery.events.map(event => `${event.taskId}/${event.id}`));
      for (const filter of [{ excludeType: INBOUND_EVENT_TYPE }, { type: INBOUND_EVENT_TYPE }, {}] satisfies EventTypeFilter[]) {
        if (!remaining.size) break;
        for await (const event of pendingEvents(bot, signal, filter)) {
          const key = `${event.taskId}/${event.id}`;
          if (!remaining.has(key)) continue;
          await options.withApi(bot.botId, signal, api => api.ackEvent(event.taskId, event.id, { operationId: delivery!.command.operationId }));
          remaining.delete(key);
          if (!remaining.size) break;
        }
      }
      await save(null);
    });
  };
  const triggerBot = async (bot: BotRecord, signal: AbortSignal): Promise<void> => {
    if (!await healthy(bot, signal)) return;
    for await (const task of tasksFor(bot.botId, signal)) {
      if (task.state !== "active" || !held(task, bot.botId, clock.now()) || task.trigger === null) continue;
      const occurrence = assistantTriggerOccurrence(task, clock.now());
      if (!occurrence) continue;
      const id = assistantTriggerId(task.id, task.trigger, occurrence);
      await withAssistantRuntimeState({ owner: options.owner, stateDirectory: await options.stateDirectory(bot.botId), key: `trigger-${task.id}` }, async (read, save) => {
        const saved = await read() as TriggerState | null;
        if (saved?.id === id && saved.confirmed) return;
        for await (const event of eventsFor(bot, signal, task.id)) {
          if (event.id === id) { await save({ id, occurrence, confirmed: true }); return; }
        }
        if (saved?.id === id) return;
        // A scheduled occurrence has one stable event ID across restart and takeover.
        await options.withApi(bot.botId, signal, async api => {
          const credential = await withLocalClaim(bot.botId, task.id, signal, async () => readClaimCredential(await scope(bot, task.id, api)));
          const current = await api.getTask(task.id);
          if (current.state !== "active" || !held(current, bot.botId, clock.now()) || JSON.stringify(current.trigger) !== JSON.stringify(task.trigger) || !await healthy(bot, signal)) return;
          await save({ id, occurrence, confirmed: false });
          try { await api.addEvent(task.id, { ...credential, id, type: "trigger", targetBotId: bot.botId, payload: { occurrence, trigger: task.trigger } }); await save({ id, occurrence, confirmed: true }); }
          catch (error) { if (error instanceof AssistantTaskApiError && !error.outcomeUnconfirmed) await save(null); throw error; }
        });
      });
    }
  };
  const tick = (lane: "renew" | "takeover" | "delivery" | "trigger", signal: AbortSignal): Promise<void> => {
    if (closed) return Promise.resolve();
    const previous = lanes.get(lane); if (previous) return previous;
    const combined = AbortSignal.any([signal, cancellation.signal]);
    const work = (async () => {
      if (lane === "takeover") { await takeover(combined); return; }
      await Promise.all(localBots().map(async bot => {
        try { await withBot(bot, combined, botSignal => ({ renew: renewBot, delivery: deliveryBot, trigger: triggerBot })[lane](bot, botSignal)); }
        catch (error) { if (!combined.aborted) report(error, bot.botId); }
      }));
    })().finally(() => { inFlight.delete(work); lanes.delete(lane); });
    inFlight.add(work); lanes.set(lane, work); return work;
  };
  return {
    registerApplication: (name: string, factory: AssistantApplicationFactory): void => {
      if (!name || factories.has(name) || running || closed) throw new Error("Assistant application must be registered once before runtime start.");
      factories.set(name, factory);
    },
    tick,
    stopBot: async (botId: string): Promise<void> => {
      stoppedBots.add(botId); botCancellation.get(botId)?.abort();
      for (const app of applications.values()) if (app.botId === botId) app.cancellation.abort();
      await Promise.allSettled([...(botWork.get(botId) ?? [])]);
      for (const [taskId, app] of applications) if (app.botId === botId) await stopApplication(taskId, app);
    },
    run: (signal: AbortSignal): Promise<void> => {
      if (running || closed) throw new Error("Assistant task runtime cannot be started again.");
      const combined = AbortSignal.any([signal, cancellation.signal]);
      running = Promise.all((["renew", "takeover", "delivery", "trigger"] as const).map(async lane => {
        while (!combined.aborted) {
          const started = clock.now();
          try { await tick(lane, combined); } catch (error) { if (!combined.aborted) report(error, null); }
          try { await clock.wait(Math.max(1, ASSISTANT_TASK_INTERVAL_MS - (clock.now() - started)), combined); } catch (error) { if (!combined.aborted) throw error; }
        }
      })).then(() => undefined);
      return running;
    },
    shutdown: async (): Promise<void> => {
      closed = true; cancellation.abort();
      await Promise.allSettled([...inFlight, ...(running ? [running] : [])]);
      await Promise.all([...applications.keys()].map(taskId => stopApplication(taskId)));
    },
  };
};
export type AssistantTaskRuntime = ReturnType<typeof createAssistantTaskRuntime>;
