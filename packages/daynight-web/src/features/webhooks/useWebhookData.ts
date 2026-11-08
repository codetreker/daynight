import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, listProjects } from "../../api/client";
import { listTeams, type Team } from "../../api/teams";
import type { Project } from "../../api/types";
import { getWebhook, listWebhooks, type WebhookEndpoint, type WebhookEndpointSummary, type WebhookListQuery, type WebhookOwner } from "../../api/webhooks";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

export type WebhookReadFence = { readonly ownerKey: string; readonly generation: number };

export type WebhookData = {
  readonly items: readonly WebhookEndpointSummary[] | null;
  readonly nextCursor: string | null;
  readonly endpoint: WebhookEndpoint | null;
  readonly endpointId: string | null;
  readonly error: unknown;
  readonly detailError: unknown;
  readonly refreshing: boolean;
  readonly queryKey: string | null;
  readonly pageCount: number;
};
const empty = (): WebhookData => ({ items: null, nextCursor: null, endpoint: null, endpointId: null, error: null, detailError: null, refreshing: false, queryKey: null, pageCount: 0 });
export const webhookOwnerKey = (owner: WebhookOwner): string => `${owner.kind}:${owner.id}`;

export const useWebhookData = (owner: WebhookOwner | null, endpointId: string | null, query: WebhookListQuery, admission: TaskCacheScope, active: boolean) => {
  const [states, setStates] = useState<ReadonlyMap<string, WebhookData>>(new Map());
  const stored = useRef(states); stored.current = states;
  const generations = useRef(new Map<string, number>()), requests = useRef(new Map<string, AbortController>());
  const current = useRef({ owner, endpointId, query, active }); current.current = { owner, endpointId, query, active };
  const key = owner === null ? null : webhookOwnerKey(owner);
  const snapshot = key === null ? empty() : states.get(key) ?? empty();
  const update = useCallback((scope: string, transform: (old: WebhookData) => WebhookData) => {
    const next = new Map(stored.current); next.set(scope, transform(next.get(scope) ?? empty())); stored.current = next; setStates(next);
  }, []);
  const load = useCallback(async (scope: WebhookOwner, selected: string | null, filters: WebhookListQuery, append: boolean, visible: boolean): Promise<void> => {
    if (!current.current.active || admission.isInvalidated) return;
    const scopeKey = webhookOwnerKey(scope), generation = (generations.current.get(scopeKey) ?? 0) + 1;
    generations.current.set(scopeKey, generation); requests.current.get(scopeKey)?.abort();
    const controller = new AbortController(); requests.current.set(scopeKey, controller);
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const live = () => !signal.aborted && !admission.isInvalidated && current.current.active && generations.current.get(scopeKey) === generation;
    if (visible) update(scopeKey, old => ({ ...old, refreshing: true }));
    const requestAdmission = { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch };
    try {
      await admission.ready(signal);
      const previous = stored.current.get(scopeKey) ?? empty();
      const { cursor: initialCursor, ...baseFilters } = filters;
      const queryKey = JSON.stringify(baseFilters);
      const targetPages = append ? 1 : previous.queryKey === queryKey ? Math.max(1, previous.pageCount) : 1;
      const items: WebhookEndpointSummary[] = [], cursors = new Set<string>();
      let cursor = initialCursor, nextCursor: string | null = null, pages = 0;
      do {
        if (cursor !== undefined) cursors.add(cursor);
        const page = await listWebhooks(scope, { ...baseFilters, ...(cursor === undefined ? {} : { cursor }) }, signal, requestAdmission);
        await admission.ready(signal); if (!live()) return;
        if (page.items.some(item => items.some(old => old.id === item.id) || append && previous.items?.some(old => old.id === item.id)) || page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError("protocol");
        items.push(...page.items); nextCursor = page.nextCursor; pages++;
        if (nextCursor === null || pages >= targetPages) break;
        cursor = nextCursor;
      } while (true);
      const chosen = selected ?? previous.endpointId ?? items[0]?.id ?? null;
      update(scopeKey, old => ({ ...old, items: append ? [...(old.items ?? []), ...items] : items, nextCursor, endpointId: chosen, error: null, refreshing: false, queryKey, pageCount: append ? previous.pageCount + pages : pages }));
      if (chosen !== null) {
        try {
          const endpoint = await getWebhook(scope, chosen, signal, requestAdmission);
          await admission.ready(signal); if (!live()) return;
          update(scopeKey, old => {
            if (old.endpoint?.id === endpoint.id && BigInt(endpoint.configVersion) < BigInt(old.endpoint.configVersion)) return old;
            return { ...old, endpoint, endpointId: chosen, detailError: null };
          });
        } catch (detailError) { if (live()) update(scopeKey, old => ({ ...old, endpointId: chosen, endpoint: detailError instanceof ApiError && (detailError.status === 403 || detailError.status === 404) ? null : old.endpoint?.id === chosen ? old.endpoint : null, detailError })); }
      } else update(scopeKey, old => ({ ...old, endpoint: null, endpointId: null, detailError: null }));
    } catch (error) { if (live()) update(scopeKey, old => ({ ...old, ...(error instanceof ApiError && (error.status === 403 || error.status === 404) ? { items: null, endpoint: null } : {}), error, refreshing: false })); }
  }, [admission, update]);
  const loadRef = useRef(load); loadRef.current = load;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    if (owner !== null && active) void loadRef.current(owner, endpointId, query, false, false);
  }, [key, endpointId, queryKey, active]);
  useEffect(() => {
    const check = () => { const scope = current.current; if (scope.owner !== null && scope.active) void loadRef.current(scope.owner, scope.endpointId, scope.query, false, false); };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => () => { for (const request of requests.current.values()) request.abort(); requests.current.clear(); generations.current.clear(); }, []);
  const fenceCurrent = (fence: WebhookReadFence): boolean => current.current.owner !== null && webhookOwnerKey(current.current.owner) === fence.ownerKey && current.current.active && !admission.isInvalidated && (generations.current.get(fence.ownerKey) ?? 0) === fence.generation;
  const captureFence = (): WebhookReadFence | null => owner === null ? null : { ownerKey: webhookOwnerKey(owner), generation: generations.current.get(webhookOwnerKey(owner)) ?? 0 };
  const accept = (endpoint: WebhookEndpoint, fence: WebhookReadFence | null): boolean => {
    if (fence === null || webhookOwnerKey(endpoint.owner) !== fence.ownerKey || !fenceCurrent(fence)) return false;
    const previous = stored.current.get(fence.ownerKey);
    if (previous?.endpoint?.id === endpoint.id && BigInt(previous.endpoint.configVersion) > BigInt(endpoint.configVersion)) return false;
    generations.current.set(fence.ownerKey, fence.generation + 1); requests.current.get(fence.ownerKey)?.abort();
    update(fence.ownerKey, old => ({ ...old, endpoint, endpointId: endpoint.id, detailError: null }));
    return true;
  };
  const readEndpoint = async (endpointId: string): Promise<{ readonly endpoint: WebhookEndpoint; readonly fence: WebhookReadFence } | null> => {
    if (owner === null || !current.current.active || admission.isInvalidated) return null;
    const ownerKey = webhookOwnerKey(owner), generation = (generations.current.get(ownerKey) ?? 0) + 1;
    generations.current.set(ownerKey, generation); requests.current.get(ownerKey)?.abort();
    const controller = new AbortController(); requests.current.set(ownerKey, controller);
    const signal = AbortSignal.any([controller.signal, admission.signal]), fence = { ownerKey, generation };
    try {
      await admission.ready(signal);
      const endpoint = await getWebhook(owner, endpointId, signal, { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch, ready: readySignal => admission.ready(readySignal) });
      await admission.ready(signal);
      return fenceCurrent(fence) ? { endpoint, fence } : null;
    } catch (error) {
      if (signal.aborted || !fenceCurrent(fence)) return null;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) update(ownerKey, old => ({ ...old, items: old.items === null ? null : old.items.filter(item => item.id !== endpointId), endpoint: old.endpoint?.id === endpointId ? null : old.endpoint, detailError: error }));
      throw error;
    }
  };
  return {
    ...snapshot,
    pendingQuery: snapshot.queryKey !== JSON.stringify(query),
    endpoint: snapshot.endpoint?.id === (endpointId ?? snapshot.endpointId) ? snapshot.endpoint : null,
    refresh: () => { if (owner !== null) void loadRef.current(owner, endpointId, query, false, true); },
    more: () => { if (owner !== null && snapshot.nextCursor !== null && !snapshot.refreshing) void loadRef.current(owner, endpointId, { ...query, cursor: snapshot.nextCursor }, true, true); },
    withdraw: (endpointId: string) => { if (owner !== null) update(webhookOwnerKey(owner), old => ({ ...old, items: old.items === null ? null : old.items.filter(item => item.id !== endpointId), endpoint: old.endpoint?.id === endpointId ? null : old.endpoint })); },
    captureFence, fenceCurrent, readEndpoint, accept,
  };
};

export const useWebhookDirectories = (owner: WebhookOwner | null, admission: TaskCacheScope, active: boolean) => {
  const [teams, setTeams] = useState<readonly Team[] | null>(null), [projects, setProjects] = useState<{ readonly key: string; readonly items: readonly Project[] } | null>(null), [error, setError] = useState<unknown>(null), [revision, setRevision] = useState(0);
  const key = owner === null ? "personal" : webhookOwnerKey(owner);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, admission.signal]);
    const read = async () => {
      try {
        await admission.ready(signal);
        const availableTeams: Team[] = [], teamCursors = new Set<string>(); let teamCursor: string | null = null;
        do {
          const page = await listTeams(teamCursor, admission.userId, signal, admission.principalMismatch);
          if (page.items.some(item => availableTeams.some(old => old.id === item.id)) || page.nextCursor !== null && teamCursors.has(page.nextCursor)) throw new ApiError("protocol");
          availableTeams.push(...page.items); teamCursor = page.nextCursor; if (teamCursor !== null) teamCursors.add(teamCursor);
        } while (teamCursor !== null);
        await admission.ready(signal); signal.throwIfAborted(); setTeams(availableTeams.filter(team => team.kind === "ordinary"));
        if (owner === null) { setProjects(null); setError(null); return; }
        const availableProjects: Project[] = [], projectCursors = new Set<string>(); let projectCursor: string | null = null;
        do {
          const page = await listProjects({ limit: 100, ...(owner.kind === "team" ? { teamId: owner.id } : {}), ...(projectCursor === null ? {} : { cursor: projectCursor }) }, signal, { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch });
          if (page.items.some(item => availableProjects.some(old => old.id === item.id)) || page.nextCursor !== null && projectCursors.has(page.nextCursor)) throw new ApiError("protocol");
          availableProjects.push(...page.items); projectCursor = page.nextCursor; if (projectCursor !== null) projectCursors.add(projectCursor);
        } while (projectCursor !== null);
        await admission.ready(signal); signal.throwIfAborted(); setProjects({ key, items: availableProjects }); setError(null);
      } catch (failure) { if (!signal.aborted && !admission.isInvalidated) setError(failure); }
    };
    void read(); return () => controller.abort();
  }, [admission, active, key, revision]);
  useEffect(() => {
    const check = () => { if (active && !admission.isInvalidated) setRevision(value => value + 1); };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, [active, admission]);
  return { teams, projects: projects?.key === key ? projects.items : null, error, refresh: () => setRevision(value => value + 1) };
};
