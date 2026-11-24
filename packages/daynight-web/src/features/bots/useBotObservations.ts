import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, subscribeAuthPause, waitForAuthRequests } from '../../api/client';
import { getBotObservation, type BotObservation } from '../../api/bot-observation';
import type { BotDefinition } from '../../api/bots';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

export type BotObservationRead = {
  readonly value: BotObservation | null; readonly stale: boolean; readonly busy: boolean;
  readonly error: unknown; readonly refresh: () => void;
  readonly refreshing: boolean; readonly refreshExplicit: () => void;
};
type Entry = Omit<BotObservationRead, 'refresh' | 'refreshExplicit'> & { readonly deadline: number };
export type BotObservationLoader = (id: string, scope: TaskCacheScope, signal: AbortSignal) => Promise<BotObservation>;
const loadObservation: BotObservationLoader = (id, scope, signal) => getBotObservation(id, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
const empty = (): Entry => ({ value: null, stale: true, busy: false, refreshing: false, error: null, deadline: 0 });
const instant = (value: string) => BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1_000_000n + BigInt(value.slice(19, -1).replace('.', '').padEnd(9, '0'));
const older = (incoming: BotObservation, previous: BotObservation): boolean => {
  for (const field of ['botVersion', 'hostingGeneration'] as const) {
    const left = BigInt(incoming[field] ?? '0'), right = BigInt(previous[field] ?? '0');
    if (left < right) return true;
  }
  if (incoming.sessionId === previous.sessionId && incoming.executionGeneration !== null && previous.executionGeneration !== null) {
    const left = BigInt(incoming.executionGeneration), right = BigInt(previous.executionGeneration);
    if (left < right) return true;
    if (left === right && incoming.connectionEpoch !== null && previous.connectionEpoch !== null && BigInt(incoming.connectionEpoch) < BigInt(previous.connectionEpoch)) return true;
  }
  return instant(incoming.observedAt) < instant(previous.observedAt);
};

/** One account-scoped owner supplies identical, independently expiring Bot facts to every view. */
export function useBotObservations(bots: readonly BotDefinition[], enabled: boolean, load: BotObservationLoader = loadObservation) {
  const scope = useTaskCacheScope();
  const key = JSON.stringify(bots.map(bot => [bot.id, bot.version]).sort(([a], [b]) => a!.localeCompare(b!)));
  const definitions = useMemo(() => new Map(JSON.parse(key) as [string, string][]), [key]);
  const [state, setState] = useState<{ scope: TaskCacheScope; entries: ReadonlyMap<string, Entry> }>(() => ({ scope, entries: new Map() }));
  const actions = useRef<(id?: string, explicit?: boolean) => void>(() => {});
  const refresh = useCallback(() => actions.current(), []);
  const refreshExplicit = useCallback(() => actions.current(undefined, true), []);
  useLayoutEffect(() => {
    let live = true, expiry: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    const entries = new Map<string, Entry>(state.scope === scope ? [...state.entries].filter(([id]) => definitions.has(id)).map(([id, entry]) => [id, { ...entry, busy: false, refreshing: false }]) : []);
    const pending = new Map<string, AbortController>(), queue = new Set<string>(), lifetime = new AbortController();
    const admitted = () => live && enabled && !scope.isInvalidated && !authRequestsPaused() && document.visibilityState !== 'hidden';
    const publish = () => { if (live) setState({ scope, entries: new Map(entries) }); };
    const schedule = () => {
      clearTimeout(expiry);
      const now = performance.now(), deadlines = [...entries.values()].filter(entry => !entry.stale && entry.deadline > now).map(entry => entry.deadline);
      if (deadlines.length) expiry = setTimeout(expire, Math.min(...deadlines) - now);
    };
    const expire = () => {
      const now = performance.now();
      for (const [id, entry] of entries) if (!entry.stale && entry.deadline <= now) {
        entries.set(id, { ...entry, stale: true });
        if (admitted()) queue.add(id);
      }
      publish(); schedule(); drain();
    };
    const run = async (id: string) => {
      const attempt = new AbortController(), signal = AbortSignal.any([attempt.signal, scope.signal]);
      pending.set(id, attempt);
      entries.set(id, { ...(entries.get(id) ?? empty()), busy: true }); publish();
      try {
        await scope.ready(signal);
        if (!admitted() || signal.aborted) return;
        const started = performance.now(), value = await load(id, scope, signal);
        await scope.ready(signal);
        if (!admitted() || signal.aborted || pending.get(id) !== attempt) return;
        const previous = entries.get(id);
        if (value.botId !== id || BigInt(value.botVersion) < BigInt(definitions.get(id)!) || previous?.value && older(value, previous.value)) throw new ApiError('protocol');
        // The entire request duration is charged against server-relative freshness.
        // A slow response cannot renew old evidence, even when the browser clock differs.
        const budget = value.freshUntil === null ? value.state === 'offline' ? 5_000 : 0 : Math.max(0, Number((instant(value.freshUntil) - instant(value.observedAt)) / 1_000_000n));
        const deadline = previous?.value && instant(previous.value.observedAt) === instant(value.observedAt) ? Math.min(previous.deadline, started + budget) : started + budget;
        entries.set(id, { value, stale: deadline <= performance.now(), busy: false, refreshing: false, error: null, deadline });
      } catch (error) {
        if (admitted() && !signal.aborted && pending.get(id) === attempt) {
          const denied = error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0);
          entries.set(id, { ...(denied ? empty() : entries.get(id) ?? empty()), stale: true, busy: false, refreshing: false, error });
        }
      } finally {
        if (pending.get(id) === attempt) {
          pending.delete(id);
          const entry = entries.get(id); if (entry && (entry.busy || entry.refreshing)) entries.set(id, { ...entry, busy: false, refreshing: false });
          publish(); schedule(); drain();
        }
      }
    };
    const drain = () => {
      if (!admitted()) return;
      for (const id of queue) {
        if (pending.size >= 4) return;
        queue.delete(id);
        if (!pending.has(id)) void run(id);
      }
    };
    const refreshOne = (id?: string, explicit = false) => {
      if (!admitted()) return;
      for (const target of id === undefined ? definitions.keys() : definitions.has(id) ? [id] : []) {
        if (explicit) entries.set(target, { ...(entries.get(target) ?? empty()), refreshing: true });
        if (!pending.has(target)) queue.add(target);
      }
      if (explicit) publish();
      drain();
    };
    const cancel = () => {
      queue.clear();
      for (const [id, attempt] of pending) {
        attempt.abort();
        const entry = entries.get(id); if (entry) entries.set(id, { ...entry, busy: false, refreshing: false });
      }
      for (const [id, entry] of entries) if (entry.refreshing) entries.set(id, { ...entry, refreshing: false });
      pending.clear(); publish();
    };
    const invalidate = () => { cancel(); lifetime.abort(); entries.clear(); publish(); clearTimeout(expiry); clearInterval(poll); };
    const visibility = () => { if (document.visibilityState === 'hidden') cancel(); else { expire(); refreshOne(); } };
    actions.current = refreshOne;
    for (const [id, entry] of entries) if (entry.value && BigInt(entry.value.botVersion) < BigInt(definitions.get(id)!)) entries.set(id, { ...entry, stale: true });
    publish(); schedule(); refreshOne();
    if (enabled && !scope.isInvalidated) poll = setInterval(() => { expire(); refreshOne(); }, 5_000);
    const pause = () => {
      cancel();
      void waitForAuthRequests(AbortSignal.any([lifetime.signal, scope.signal])).then(() => refreshOne(), () => {});
    };
    const unsubscribe = subscribeAuthPause(pause);
    if (authRequestsPaused()) pause();
    scope.signal.addEventListener('abort', invalidate, { once: true });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false; lifetime.abort(); cancel(); clearTimeout(expiry); clearInterval(poll); unsubscribe();
      scope.signal.removeEventListener('abort', invalidate); document.removeEventListener('visibilitychange', visibility); actions.current = () => {};
    };
    // Entries are retained by scope; only membership or definition versions restart admission.
  }, [scope, definitions, enabled, load]);
  const refreshing = state.scope === scope && !scope.isInvalidated && [...state.entries].some(([id, entry]) => definitions.has(id) && entry.refreshing);
  return { refresh, refreshExplicit, refreshing, get: (id: string): BotObservationRead => {
    const entry = state.scope === scope && !scope.isInvalidated && definitions.has(id) ? state.entries.get(id) ?? empty() : empty();
    return { ...entry, stale: !enabled || authRequestsPaused() || entry.stale || entry.deadline <= performance.now() || !!entry.value && BigInt(entry.value.botVersion) < BigInt(definitions.get(id)!), refresh: () => actions.current(id), refreshExplicit: () => actions.current(id, true) };
  } };
}
