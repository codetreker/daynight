import { setTimeout as delay } from "node:timers/promises";
import { maintainControllerGrants } from "../backends/grant-renewal.js";
import { ControllerStartupError } from "../../controller/startup.js";
import type { BotDeletionManager } from "./delete.js";
import { createBotInventory } from "./inventory.js";
import { BotAdmissionBlockedError, type BotProcess } from "./process.js";
import type { BotRemote } from "./remote.js";
import type { BotSessionApi, BotStartupResult } from "./session-api.js";
import type { BotStore } from "./store.js";
import { parseBotOwner, type BotOwner, type BotRecord } from "./types.js";
import type { AssistantTaskRuntime } from "./assistant-tasks.js";

/**
 * Owns discovery and credential maintenance alongside the Task coordinator.
 * The caller owns the Worker lock and stores. Cancellation joins management work
 * and stops each original writer; shutdown errors retain all recovery evidence.
 */
export const createManagedAssistantRuntime = (options: {
  owner: BotOwner; store: BotStore; remote: BotRemote; process: BotProcess; sessionApi: BotSessionApi;
  deletion: BotDeletionManager; pollIntervalMs: number | (() => number); now?: () => number; onError(message: string, botId: string | null): void;
  canAdmitNewExecution(): boolean;
  inventory?: Pick<ReturnType<typeof createBotInventory>, "reconcile">;
  assistantTasks?: AssistantTaskRuntime;
}) => {
  const owner = parseBotOwner(options.owner), now = options.now ?? Date.now;
  const interval = (): number => {
    const value = typeof options.pollIntervalMs === "function" ? options.pollIntervalMs() : options.pollIntervalMs;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Bot discovery interval must be a positive integer.");
    return Math.min(value, 5000);
  };
  interval();
  const inventory = options.inventory ?? createBotInventory({ owner, store: options.store, remote: options.remote, now });
  const jobs = new Map<string, Promise<void>>(), errors = new Map<string, string>();
  let running = false, closing = false;
  const shutdownCancellation = new AbortController();
  const ticks = new Set<Promise<void>>();
  let runWork: Promise<void> | null = null, stopping: Promise<void> | null = null;
  const stopAll = (): Promise<void> => stopping ??= (async () => {
    const failures: unknown[] = [];
    try { await options.assistantTasks?.shutdown(); } catch (cause) { failures.push(cause); }
    const results = await Promise.allSettled(options.store.list(owner).map(async record => {
      try { await options.process.shutdown(record, AbortSignal.timeout(30_000)); }
      catch (cause) { error(record.botId, cause); throw cause; }
    }));
    failures.push(...results.filter(result => result.status === "rejected").map(result => result.reason));
    if (failures.length) throw new AggregateError(failures, "Bot shutdown could not confirm every original writer stopped; evidence is retained.");
  })();
  const error = (botId: string | null, cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : "Bot execution is unavailable.";
    if (errors.get(botId ?? "inventory") !== message) options.onError(message, botId);
    errors.set(botId ?? "inventory", message);
  };
  const refresh = async (input: BotRecord, signal: AbortSignal): Promise<BotRecord | null> => {
    const bot = await options.remote.read(input.botId, signal);
    if (bot === null) throw new Error("Bot is missing from its authoritative service; original local execution is retained.");
    const record = options.store.observe(owner, bot, now());
    return record.observed.deletion === null ? record : null;
  };
  const report = async (input: BotRecord, result: BotStartupResult, signal: AbortSignal): Promise<void> => {
    // Observe before each write, including after an unknown report response.
    const record = await refresh(input, signal);
    if (record === null || record.observed.deletion !== null) return;
    if (record.observed.startupResult.state === result.state && record.observed.startupResult.code === (result.code ?? null)) return;
    const bot = await options.sessionApi.report(record, result, signal);
    options.store.observe(owner, bot, now());
  };
  const advance = async (input: BotRecord, signal: AbortSignal): Promise<void> => {
    let record: BotRecord | null = input;
    try {
      record = await refresh(input, signal);
      if (record === null) return;
      const snapshot = await options.process.advance(record, signal);
      if (snapshot.startup?.state === "ready" && ["ready", "working"].includes(snapshot.lifecycle) && snapshot.initialInputState === "not_required") {
        await report(record, { state: "ready", nativeSessionId: snapshot.nativeSessionId }, signal);
      } else if (snapshot.startup?.state === "failed" || snapshot.lifecycle === "failed") {
        await report(record, { state: "failed", code: snapshot.startup?.reasonCode ?? "controller_start_failed", nativeSessionId: snapshot.nativeSessionId }, signal);
      }
      errors.delete(input.botId);
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof BotAdmissionBlockedError) return;
      error(input.botId, cause);
      const latest = options.store.get(owner, input.botId);
      // Do not advance the registration's version after a possibly submitted
      // request, or turn a transport outage into a definitive startup failure.
      if (record !== null && latest !== null && latest.observed.deletion === null
        && (latest.intent === null || cause instanceof ControllerStartupError && cause.observation.state === "failed" && latest.intent.sessionId !== null)) {
        try { await report(latest, { state: "failed", code: cause instanceof ControllerStartupError ? cause.observation.reasonCode : "environment_unavailable" }, signal); }
        catch (failure) { if (!signal.aborted) error(input.botId, failure); }
      }
    }
  };
  const discover = async (signal: AbortSignal): Promise<Promise<void>[]> => {
    const result = await inventory.reconcile(signal);
    const scheduled: Promise<void>[] = [];
    for (const botId of result.observed) {
      signal.throwIfAborted();
      const record = options.store.get(owner, botId);
      if (record === null) continue;
      const previous = jobs.get(botId);
      if (previous !== undefined) { scheduled.push(previous); continue; }
      if (record.observed.deletion === null && record.intent === null && !options.canAdmitNewExecution()) continue;
      const work = record.observed.deletion === null ? advance(record, signal)
        : (async () => { await options.assistantTasks?.stopBot(botId); await options.deletion.advance(record, signal); })().then(() => { errors.delete(botId); }, cause => { if (!signal.aborted) error(botId, cause); });
      const job = work.finally(() => { if (jobs.get(botId) === job) jobs.delete(botId); });
      jobs.set(botId, job); scheduled.push(job);
    }
    return scheduled;
  };
  return {
    /** A bounded caller-controlled reconciliation, useful before entering steady state. */
    tick: async (signal: AbortSignal): Promise<void> => {
      if (closing) throw new Error("Bot runtime is closing.");
      const combined = AbortSignal.any([signal, shutdownCancellation.signal]);
      const work = (async () => { await Promise.all(await discover(combined)); })();
      ticks.add(work);
      try { await work; } finally { ticks.delete(work); }
    },
    /** Stop scheduling, join submitted work, then prove each writer stopped. */
    shutdown: async (): Promise<void> => {
      closing = true; shutdownCancellation.abort();
      if (runWork !== null) await runWork;
      else { await Promise.allSettled([...ticks, ...jobs.values()]); await stopAll(); }
    },
    run: async (signal: AbortSignal): Promise<void> => {
      if (closing) throw new Error("Bot runtime is closing.");
      if (running) throw new Error("This Bot runtime is already running.");
      running = true;
      const cancellation = new AbortController();
      const combined = AbortSignal.any([signal, cancellation.signal, shutdownCancellation.signal]);
      const discovery = async () => {
        while (!combined.aborted) {
          try { await discover(combined); errors.delete("inventory"); }
          catch (cause) { if (!combined.aborted) error(null, cause); }
          try { await delay(interval(), undefined, { signal: combined }); }
          catch (cause) { if (!combined.aborted) throw cause; }
        }
      };
      const grants = maintainControllerGrants({ list: () => options.store.list(owner).filter(record => record.observed.deletion === null), key: record => record.botId,
        refresh: async (record, grantSignal) => { const latest = await refresh(record, grantSignal); if (latest !== null) await options.process.refreshGrant(latest, grantSignal); },
        signal: combined, onError: (message, botId) => error(botId, new Error(message)) });
      const discoveryWork = discovery();
      const assistantWork = options.assistantTasks?.run(combined) ?? Promise.resolve();
      runWork = (async () => {
        const failures: unknown[] = [];
        try { await Promise.all([discoveryWork, grants, assistantWork]); } catch (cause) { failures.push(cause); }
        finally {
          closing = true; cancellation.abort(); shutdownCancellation.abort();
          await Promise.allSettled([discoveryWork, grants, assistantWork, ...ticks, ...jobs.values()]);
          try { await stopAll(); } catch (cause) { failures.push(cause); }
          running = false;
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Bot runtime and shutdown failed.");
      })();
      await runWork;
    },
  };
};
export type ManagedAssistantRuntime = ReturnType<typeof createManagedAssistantRuntime>;
