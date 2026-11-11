import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, listProjects } from "../../api/client";
import { listTeams, type Team } from "../../api/teams";
import type { Project } from "../../api/types";
import { getWebhook, listWebhooks, type WebhookEndpoint, type WebhookEndpointSummary, type WebhookListQuery, type WebhookOwner } from "../../api/webhooks";
import { assertOwnerDisclosure, ownerAuthorization, type WebhookAuthorizationResolver, type WebhookConfigurationObservation, type WebhookOwnerDenial, type WebhookOwnerManagementRestriction, type WebhookTeamObservation } from "./authorization";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

export type WebhookReadFence = { readonly ownerKey: string; readonly generation: number; readonly authorizationKey: string };

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
  readonly authorizationKey: string | null;
};
const empty = (): WebhookData => ({ items: null, nextCursor: null, endpoint: null, endpointId: null, error: null, detailError: null, refreshing: false, queryKey: null, pageCount: 0, authorizationKey: null });
const serverFailure = (error: unknown, status: number, code: string): error is ApiError => error instanceof ApiError && error.kind === "server" && error.status === status && error.code === code;
export const webhookOwnerKey = (owner: WebhookOwner): string => `${owner.kind}:${owner.id}`;

export const useWebhookData = (owner: WebhookOwner | null, endpointId: string | null, query: WebhookListQuery, admission: TaskCacheScope, active: boolean, getAuthorization: WebhookAuthorizationResolver, authorizationRevision: number, observeConfiguration: WebhookConfigurationObservation, observeOwnerDenied: WebhookOwnerDenial) => {
  const [states, setStates] = useState<ReadonlyMap<string, WebhookData>>(new Map());
  const stored = useRef(states); stored.current = states;
  const generations = useRef(new Map<string, number>()), requests = useRef(new Map<string, AbortController>());
  const current = useRef({ owner, endpointId, query, active, getAuthorization }); current.current = { owner, endpointId, query, active, getAuthorization };
  const key = owner === null ? null : webhookOwnerKey(owner);
  const retained = key === null ? empty() : states.get(key) ?? empty();
  const authorization = owner === null ? null : getAuthorization(owner);
  const snapshot = retained.authorizationKey === authorization?.key ? retained : { ...empty(), endpointId: retained.endpointId };
  const update = useCallback((scope: string, transform: (old: WebhookData) => WebhookData) => {
    const next = new Map(stored.current); next.set(scope, transform(next.get(scope) ?? empty())); stored.current = next; setStates(next);
  }, []);
  useLayoutEffect(() => {
    const next = new Map(stored.current); let changed = false;
    for (const [scope, state] of next) {
      const kind = scope.startsWith("team:") ? "team" : "personal";
      const owner = { kind, id: scope.slice(kind.length + 1) } as WebhookOwner;
      if (state.authorizationKey !== null && state.authorizationKey !== getAuthorization(owner).key) {
        next.set(scope, { ...empty(), endpointId: state.endpointId });
        generations.current.set(scope, (generations.current.get(scope) ?? 0) + 1); requests.current.get(scope)?.abort(); changed = true;
      }
    }
    if (changed) { stored.current = next; setStates(next); }
  }, [authorizationRevision, getAuthorization]);
  const load = useCallback(async (scope: WebhookOwner, selected: string | null, filters: WebhookListQuery, append: boolean, visible: boolean): Promise<void> => {
    if (!current.current.active || admission.isInvalidated) return;
    let authorization = current.current.getAuthorization(scope);
    if (!authorization.readable) return;
    const scopeKey = webhookOwnerKey(scope), generation = (generations.current.get(scopeKey) ?? 0) + 1;
    generations.current.set(scopeKey, generation); requests.current.get(scopeKey)?.abort();
    const controller = new AbortController(); requests.current.set(scopeKey, controller);
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const live = () => !signal.aborted && !admission.isInvalidated && current.current.active && current.current.getAuthorization(scope).key === authorization.key && generations.current.get(scopeKey) === generation;
    if (visible) update(scopeKey, old => ({ ...old, refreshing: true }));
    const requestAdmission = { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch };
    try {
      await admission.ready(signal);
      const retained = stored.current.get(scopeKey) ?? empty();
      const previous = retained.authorizationKey === authorization.key ? retained : empty();
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
        const nextAuthorization = page.items.reduce((current, item) => observeConfiguration(item, current.key), authorization);
        if (nextAuthorization.key !== authorization.key) {
          authorization = nextAuthorization;
          update(scopeKey, old => ({ ...empty(), endpointId: selected ?? old.endpointId, authorizationKey: authorization.key }));
        }
        page.items.forEach(item => assertOwnerDisclosure(authorization, item));
        items.push(...page.items); nextCursor = page.nextCursor; pages++;
        if (nextCursor === null || pages >= targetPages) break;
        cursor = nextCursor;
      } while (true);
      const chosen = selected ?? previous.endpointId ?? items[0]?.id ?? null;
      update(scopeKey, old => ({ ...old, items: append ? [...(old.items ?? []), ...items] : items, nextCursor, endpointId: chosen, error: null, refreshing: false, queryKey, pageCount: append ? previous.pageCount + pages : pages, authorizationKey: authorization.key }));
      if (chosen !== null) {
        try {
          const endpoint = await getWebhook(scope, chosen, signal, requestAdmission);
          await admission.ready(signal); if (!live()) return;
          const endpointAuthorization = observeConfiguration(endpoint, authorization.key);
          assertOwnerDisclosure(endpointAuthorization, endpoint);
          update(scopeKey, previous => {
            const old = previous.authorizationKey === endpointAuthorization.key ? previous : empty();
            if (old.endpoint?.id === endpoint.id && BigInt(endpoint.configVersion) < BigInt(old.endpoint.configVersion)) return old;
            return { ...old, endpoint, endpointId: chosen, detailError: null, authorizationKey: endpointAuthorization.key };
          });
        } catch (detailError) {
          if (live()) {
            if (serverFailure(detailError, 403, "forbidden")) {
              const denied = observeOwnerDenied(scope, authorization.key);
              update(scopeKey, () => ({ ...empty(), endpointId: chosen, detailError, authorizationKey: denied.key }));
            } else update(scopeKey, old => ({ ...old, endpointId: chosen, endpoint: serverFailure(detailError, 404, "not_found") ? null : old.endpoint?.id === chosen ? old.endpoint : null, detailError }));
          }
        }
      } else update(scopeKey, old => ({ ...old, endpoint: null, endpointId: null, detailError: null }));
    } catch (error) {
      if (live()) {
        if (serverFailure(error, 403, "forbidden")) {
          const denied = observeOwnerDenied(scope, authorization.key);
          update(scopeKey, () => ({ ...empty(), error, authorizationKey: denied.key }));
        } else update(scopeKey, previous => ({
          ...(previous.authorizationKey === authorization.key ? previous : { ...empty(), endpointId: selected ?? previous.endpointId }),
          ...(serverFailure(error, 404, "not_found") ? { items: null, endpoint: null } : {}),
          error, refreshing: false, authorizationKey: authorization.key,
        }));
      }
    }
  }, [admission, observeConfiguration, observeOwnerDenied, update]);
  const loadRef = useRef(load); loadRef.current = load;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    if (owner !== null && active) void loadRef.current(owner, endpointId, query, false, false);
  }, [key, endpointId, queryKey, active, authorization?.key]);
  useEffect(() => {
    const check = () => { const scope = current.current; if (scope.owner !== null && scope.active) void loadRef.current(scope.owner, scope.endpointId, scope.query, false, false); };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => () => { for (const request of requests.current.values()) request.abort(); requests.current.clear(); generations.current.clear(); }, []);
  const fenceCurrent = (fence: WebhookReadFence): boolean => current.current.owner !== null && webhookOwnerKey(current.current.owner) === fence.ownerKey && current.current.active && !admission.isInvalidated && current.current.getAuthorization(current.current.owner).key === fence.authorizationKey && (generations.current.get(fence.ownerKey) ?? 0) === fence.generation;
  const captureFence = (): WebhookReadFence | null => owner === null ? null : { ownerKey: webhookOwnerKey(owner), generation: generations.current.get(webhookOwnerKey(owner)) ?? 0, authorizationKey: current.current.getAuthorization(owner).key };
  const accept = (endpoint: WebhookEndpoint, fence: WebhookReadFence | null): boolean => {
    if (fence === null || webhookOwnerKey(endpoint.owner) !== fence.ownerKey || !fenceCurrent(fence)) return false;
    const authorization = observeConfiguration(endpoint, fence.authorizationKey);
    assertOwnerDisclosure(authorization, endpoint);
    const previous = stored.current.get(fence.ownerKey);
    if (previous?.endpoint?.id === endpoint.id && BigInt(previous.endpoint.configVersion) > BigInt(endpoint.configVersion)) return false;
    generations.current.set(fence.ownerKey, fence.generation + 1); requests.current.get(fence.ownerKey)?.abort();
    update(fence.ownerKey, previous => ({ ...(previous.authorizationKey === authorization.key ? previous : empty()), endpoint, endpointId: endpoint.id, detailError: null, authorizationKey: authorization.key }));
    return true;
  };
  const readEndpoint = async (endpointId: string, operationSignal?: AbortSignal): Promise<{ readonly endpoint: WebhookEndpoint; readonly fence: WebhookReadFence } | null> => {
    if (owner === null || !current.current.active || admission.isInvalidated || operationSignal?.aborted) return null;
    const authorization = current.current.getAuthorization(owner);
    if (!authorization.readable) return null;
    const ownerKey = webhookOwnerKey(owner), generation = (generations.current.get(ownerKey) ?? 0) + 1;
    generations.current.set(ownerKey, generation); requests.current.get(ownerKey)?.abort();
    const controller = new AbortController(); requests.current.set(ownerKey, controller);
    const signal = AbortSignal.any([controller.signal, admission.signal, ...(operationSignal ? [operationSignal] : [])]), fence = { ownerKey, generation, authorizationKey: authorization.key };
    try {
      await admission.ready(signal);
      const endpoint = await getWebhook(owner, endpointId, signal, { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch, ready: readySignal => admission.ready(readySignal) });
      await admission.ready(signal);
      if (!fenceCurrent(fence)) return null;
      const endpointAuthorization = observeConfiguration(endpoint, authorization.key);
      assertOwnerDisclosure(endpointAuthorization, endpoint);
      return { endpoint, fence: { ...fence, authorizationKey: endpointAuthorization.key } };
    } catch (error) {
      if (signal.aborted || !fenceCurrent(fence)) return null;
      if (serverFailure(error, 403, "forbidden")) {
        const denied = observeOwnerDenied(owner, authorization.key);
        update(ownerKey, old => ({ ...empty(), endpointId: old.endpointId, authorizationKey: denied.key }));
      } else if (serverFailure(error, 404, "not_found")) update(ownerKey, old => ({ ...old, items: old.items === null ? null : old.items.filter(item => item.id !== endpointId), endpoint: old.endpoint?.id === endpointId ? null : old.endpoint, detailError: old.endpointId === endpointId ? error : old.detailError }));
      throw error;
    }
  };
  return {
    ...snapshot,
    pendingQuery: snapshot.queryKey !== JSON.stringify(query),
    endpoint: snapshot.endpoint?.id === (endpointId ?? snapshot.endpointId) ? snapshot.endpoint : null,
    refresh: () => { if (owner !== null) void loadRef.current(owner, endpointId, query, false, true); },
    refreshCurrent: () => { const target = current.current; if (target.owner !== null) void loadRef.current(target.owner, target.endpointId, target.query, false, false); },
    more: () => { if (owner !== null && snapshot.nextCursor !== null && !snapshot.refreshing) void loadRef.current(owner, endpointId, { ...query, cursor: snapshot.nextCursor }, true, true); },
    withdraw: (endpointId: string) => { if (owner !== null) update(webhookOwnerKey(owner), old => ({ ...old, items: old.items === null ? null : old.items.filter(item => item.id !== endpointId), endpoint: old.endpoint?.id === endpointId ? null : old.endpoint })); },
    captureFence, fenceCurrent, readEndpoint, accept,
  };
};

export const useWebhookDirectories = (owner: WebhookOwner | null, admission: TaskCacheScope, active: boolean) => {
  const [teams, setTeams] = useState<readonly Team[] | null>(null), [projects, setProjects] = useState<{ readonly key: string; readonly items: readonly Project[] } | null>(null), [error, setError] = useState<unknown>(null), [revision, setRevision] = useState(0);
  const observations = useRef<{ observed: boolean; teams: ReadonlyMap<string, WebhookTeamObservation> }>({ observed: false, teams: new Map() });
  const [authorizationRevision, setAuthorizationRevision] = useState(0);
  const getAuthorization = useCallback<WebhookAuthorizationResolver>(owner => ownerAuthorization(owner, admission.userId, observations.current.observed, observations.current.teams), [admission.userId]);
  const observeManagementRestricted = useCallback<WebhookOwnerManagementRestriction>((owner, authorizationKey) => {
    const authorization = getAuthorization(owner);
    if (authorization.key !== authorizationKey || owner.kind !== "team") return authorization;
    const old = observations.current.teams.get(owner.id);
    if (old !== undefined && old.role === "admin" && !old.restricted) {
      const next = new Map(observations.current.teams); next.set(owner.id, { ...old, restricted: true, epoch: old.epoch + 1 });
      observations.current = { ...observations.current, teams: next }; setAuthorizationRevision(value => value + 1);
    }
    return getAuthorization(owner);
  }, [getAuthorization]);
  const observeConfiguration = useCallback<WebhookConfigurationObservation>((endpoint, authorizationKey) => {
    const authorization = getAuthorization(endpoint.owner);
    if (authorization.key !== authorizationKey || endpoint.owner.kind !== "team" || "lifecycle" in endpoint && endpoint.lifecycle === "deleted" || "capabilities" in endpoint && endpoint.capabilities.manage || !("capabilities" in endpoint) && endpoint.destination.url !== null) return authorization;
    if (endpoint.destination.url !== null || "capabilities" in endpoint && (endpoint.capabilities.readSecret || endpoint.capabilities.redeliver)) throw new ApiError("protocol");
    return observeManagementRestricted(endpoint.owner, authorizationKey);
  }, [getAuthorization, observeManagementRestricted]);
  const observeOwnerDenied = useCallback<WebhookOwnerDenial>((owner, authorizationKey) => {
    const authorization = getAuthorization(owner);
    if (authorization.key !== authorizationKey && authorization.readKey !== authorizationKey || owner.kind !== "team") return authorization;
    const old = observations.current.teams.get(owner.id);
    if (old !== undefined && !old.denied) {
      const next = new Map(observations.current.teams); next.set(owner.id, { ...old, denied: true, epoch: old.epoch + 1 });
      observations.current = { ...observations.current, teams: next }; setAuthorizationRevision(value => value + 1);
      setTeams(teams => teams === null ? null : teams.filter(team => team.id !== owner.id));
      setProjects(projects => projects?.key === webhookOwnerKey(owner) ? null : projects);
    }
    return getAuthorization(owner);
  }, [getAuthorization]);
  const key = owner === null ? "personal" : webhookOwnerKey(owner);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, admission.signal]);
    const read = async () => {
      try {
        await admission.ready(signal);
        const initialObservations = observations.current.teams;
        const availableTeams: Team[] = [], teamCursors = new Set<string>(); let teamCursor: string | null = null;
        do {
          const page = await listTeams(teamCursor, admission.userId, signal, admission.principalMismatch);
          if (page.items.some(item => availableTeams.some(old => old.id === item.id)) || page.nextCursor !== null && teamCursors.has(page.nextCursor)) throw new ApiError("protocol");
          availableTeams.push(...page.items); teamCursor = page.nextCursor; if (teamCursor !== null) teamCursors.add(teamCursor);
        } while (teamCursor !== null);
        await admission.ready(signal); signal.throwIfAborted();
        const ordinaryTeams = availableTeams.filter(team => team.kind === "ordinary"), nextObservations = new Map(observations.current.teams);
        let changed = !observations.current.observed;
        for (const [id, old] of nextObservations) if (old.role !== null && !ordinaryTeams.some(team => team.id === id)) { nextObservations.set(id, { role: null, membershipVersion: null, membershipCreatedAt: null, restricted: false, denied: false, epoch: old.epoch + 1 }); changed = true; }
        for (const team of ordinaryTeams) {
          const old = nextObservations.get(team.id), membershipVersion = String(team.membership.version), membershipCreatedAt = team.membership.createdAt;
          const initial = initialObservations.get(team.id);
          if (old !== undefined && initial?.epoch !== old.epoch && (old.denied || old.restricted && team.membership.role === "admin")) continue;
          if (old?.membershipCreatedAt === membershipCreatedAt && old.membershipVersion !== null && team.membership.version < BigInt(old.membershipVersion)) continue;
          if (old === undefined || old.role !== team.membership.role || old.membershipVersion !== membershipVersion || old.membershipCreatedAt !== membershipCreatedAt) {
            nextObservations.set(team.id, { role: team.membership.role, membershipVersion, membershipCreatedAt, restricted: false, denied: false, epoch: (old?.epoch ?? 0) + 1 }); changed = true;
          }
        }
        observations.current = { observed: true, teams: nextObservations };
        if (changed) setAuthorizationRevision(value => value + 1);
        setTeams(ordinaryTeams.filter(team => getAuthorization({ kind: "team", id: team.id }).readable));
        if (owner === null || !getAuthorization(owner).readable) { setProjects(null); setError(null); return; }
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
  return { teams, getAuthorization, observeConfiguration, observeManagementRestricted, observeOwnerDenied, authorizationRevision, projects: projects?.key === key ? projects.items : null, error, refresh: () => setRevision(value => value + 1) };
};
