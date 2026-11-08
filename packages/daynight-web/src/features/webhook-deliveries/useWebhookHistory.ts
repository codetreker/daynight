import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import type { WebhookHistoryPage } from "../../api/webhooks";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

export const webhookHistoryDenied = (error: unknown): boolean => error instanceof ApiError && error.kind === "server" && error.status === 403 && error.code === "forbidden";
export const webhookHistoryMissing = (error: unknown): boolean => error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
type Snapshot<T> = { readonly key: string; readonly queryKey: string; readonly page: WebhookHistoryPage<T> | null; readonly pages: number; readonly error: unknown; readonly refreshing: boolean };

export const useWebhookHistory = <T extends { readonly id: string }, Q extends { readonly cursor?: string }>(key: string, query: Q, admission: TaskCacheScope, active: boolean, read: (query: Q, signal: AbortSignal) => Promise<WebhookHistoryPage<T>>, denied: () => void, observe: (items: readonly T[], startedAt: number) => readonly T[] = items => items, beginRead: () => number = () => 0, project: (items: readonly T[]) => readonly T[] = items => items, onFailure: (error: unknown) => void = () => {}) => {
  const [state, setState] = useState<Snapshot<T>>({ key, queryKey: "", page: null, pages: 0, error: null, refreshing: false });
  const stored = useRef(state); stored.current = state;
  const current = useRef({ key, query, active, read, denied, observe, beginRead, project, onFailure }); current.current = { key, query, active, read, denied, observe, beginRead, project, onFailure };
  const request = useRef<AbortController | null>(null), sequence = useRef(0);
  const queryKey = JSON.stringify(query), snapshot = state.key === key ? state : { key, queryKey: "", page: null, pages: 0, error: null, refreshing: false };
  const update = useCallback((next: Snapshot<T>) => { stored.current = next; setState(next); }, []);
  useLayoutEffect(() => { if (stored.current.key !== key) { sequence.current++; request.current?.abort(); update({ key, queryKey: "", page: null, pages: 0, error: null, refreshing: false }); } }, [key, update]);
  const load = useCallback(async (append: boolean, visible: boolean): Promise<void> => {
    const scope = current.current;
    if (!scope.active || admission.isInvalidated) return;
    const generation = ++sequence.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([admission.signal, controller.signal]), live = () => !signal.aborted && !admission.isInvalidated && current.current.active && current.current.key === scope.key && sequence.current === generation;
    const previous = stored.current.key === scope.key ? stored.current : { key: scope.key, queryKey: "", page: null, pages: 0, error: null, refreshing: false };
    const { cursor: ignored, ...base } = scope.query; void ignored;
    const filterKey = JSON.stringify(base), targetPages = append ? 1 : previous.queryKey === filterKey ? Math.max(1, previous.pages) : 1;
    if (visible) update({ ...previous, refreshing: true });
    try {
      await admission.ready(signal);
      const items: T[] = [], cursors = new Set<string>(); let cursor = append ? previous.page?.nextCursor ?? undefined : undefined, page: WebhookHistoryPage<T> | null = null, pages = 0;
      do {
        if (cursor !== undefined) cursors.add(cursor);
        const startedAt = scope.beginRead();
        page = await scope.read({ ...base, ...(cursor === undefined ? {} : { cursor }) } as Q, signal);
        await admission.ready(signal); if (!live()) return;
        if (page.items.some(item => items.some(old => old.id === item.id) || append && previous.page?.items.some(old => old.id === item.id)) || page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError("protocol");
        const observed = scope.observe(page.items, startedAt); if (!live()) return;
        items.push(...observed); pages++;
        if (page.nextCursor === null || pages >= targetPages) break;
        cursor = page.nextCursor;
      } while (true);
      if (page !== null && live()) update({ key: scope.key, queryKey: filterKey, page: { ...page, items: scope.project(append ? [...(stored.current.key === scope.key && stored.current.queryKey === filterKey ? stored.current.page?.items ?? [] : []), ...items] : items) }, pages: append ? previous.pages + pages : pages, error: null, refreshing: false });
    } catch (error) {
      if (!live()) return;
      if (webhookHistoryDenied(error)) scope.denied();
      scope.onFailure(error);
      const retained = stored.current.key === scope.key ? stored.current : previous;
      update({ ...retained, ...(webhookHistoryMissing(error) || webhookHistoryDenied(error) ? { page: null, pages: 0 } : {}), error, refreshing: false });
    }
  }, [admission, update]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { if (active) void loadRef.current(false, false); }, [key, queryKey, active]);
  useEffect(() => {
    const check = () => { if (current.current.active) void loadRef.current(false, false); }, visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => () => { sequence.current++; request.current?.abort(); }, []);
  return { ...snapshot, pendingQuery: snapshot.queryKey !== queryKey, check: () => { void loadRef.current(false, false); }, refresh: () => { void loadRef.current(false, true); }, more: () => { if (!stored.current.refreshing && stored.current.page?.nextCursor !== null) void loadRef.current(true, true); }, mapItems: (map: (item: T) => T) => { const old = stored.current; if (old.page === null) return; const items = old.page.items.map(map); if (items.some((item, index) => item !== old.page!.items[index])) update({ ...old, page: { ...old.page, items } }); }, prune: (keep: (item: T) => boolean) => { const old = stored.current; if (old.page === null) return; const items = old.page.items.filter(keep); if (items.length !== old.page.items.length) update({ ...old, page: { ...old.page, items } }); }, withdraw: () => { sequence.current++; request.current?.abort(); update({ ...stored.current, page: null, pages: 0 }); } };
};
