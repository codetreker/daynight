import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { resolveProjectTagColors, type ProjectTagColor } from '../../api/task-tags';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

export type TagColorsSnapshot = {
  readonly items: ReadonlyMap<string, ProjectTagColor>;
  readonly loading: boolean;
  readonly error: unknown;
};

const empty = (): TagColorsSnapshot => ({ items: new Map(), loading: false, error: null });

// One projection combines only IDs currently observed in this account and project.
export class TagColorProjection {
  private readonly interests = new Map<symbol, readonly string[]>();
  private readonly listeners = new Set<() => void>();
  private value = empty();
  private generation = 0;
  private controller: AbortController | null = null;
  private scheduled = false;
  private blocked = false;
  private unsubscribeScope: (() => void) | null = null;
  private unsubscribeColors: (() => void) | null = null;

  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string) {}

  snapshot = (): TagColorsSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(value: TagColorsSnapshot): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  private ids(): string[] { return [...new Set([...this.interests.values()].flat())].sort(); }
  private cancel(): void { ++this.generation; this.controller?.abort(); this.controller = null; }
  private readonly onScopeAbort = (): void => {
    this.cancel(); this.blocked = true;
    this.unsubscribeScope?.(); this.unsubscribeScope = null;
    this.unsubscribeColors?.(); this.unsubscribeColors = null;
    this.publish(empty());
  };
  private start(): void {
    this.blocked = this.scope.isProjectSuspended(this.projectId) || this.scope.isInvalidated || this.scope.signal.aborted;
    if (this.blocked) this.publish({ items: new Map(), loading: false, error: new ApiError('server', 404, 'not_found') });
    this.scope.signal.addEventListener('abort', this.onScopeAbort, { once: true });
    this.unsubscribeScope = this.scope.subscribe(event => {
      if (event.projectId !== this.projectId) return;
      if (event.accessRevoked || event.directAccessUncertain) {
        this.blocked = true; this.cancel();
        this.publish({ items: new Map(), loading: false, error: event.error ?? new ApiError('server', 404, 'not_found') });
      } else if (event.accessRestored) {
        this.blocked = false; this.invalidate();
      } else if (event.historyChanged) {
        this.cancel(); this.publish(empty()); this.invalidate();
      }
    });
    this.unsubscribeColors = this.scope.subscribeTagColors((projectId, admitted) => {
      if (projectId !== this.projectId) return;
      if (admitted) { if (!this.blocked) return; this.blocked = false; }
      this.invalidate();
    });
  }
  private stop(): void {
    this.cancel(); this.unsubscribeScope?.(); this.unsubscribeScope = null;
    this.unsubscribeColors?.(); this.unsubscribeColors = null;
    this.scope.signal.removeEventListener('abort', this.onScopeAbort);
    this.publish(empty());
  }
  observe(): { readonly update: (ids: readonly string[]) => void; readonly close: () => void } {
    const key = Symbol();
    if (this.interests.size === 0) this.start();
    this.interests.set(key, []);
    const update = (ids: readonly string[]) => {
      if (!this.interests.has(key)) return;
      const before = JSON.stringify(this.ids());
      this.interests.set(key, [...new Set(ids)]);
      if (JSON.stringify(this.ids()) === before) return;
      const current = new Set(this.ids());
      this.publish({ ...this.value, items: new Map([...this.value.items].filter(([id]) => current.has(id))) });
      this.invalidate();
    };
    const close = () => {
      const beforeRemoval = JSON.stringify(this.ids());
      if (!this.interests.delete(key)) return;
      if (this.interests.size === 0) { this.stop(); return; }
      if (JSON.stringify(this.ids()) === beforeRemoval) return;
      const current = new Set(this.ids());
      const retained = new Map([...this.value.items].filter(([id]) => current.has(id)));
      this.publish({ ...this.value, items: retained });
      this.invalidate();
    };
    return { update, close };
  }
  watch(ids: readonly string[]): () => void {
    const interest = this.observe();
    interest.update(ids);
    return interest.close;
  }
  invalidate = (): void => {
    this.cancel();
    if (this.blocked || this.interests.size === 0 || this.scope.isInvalidated || this.scope.signal.aborted) return;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.blocked && this.interests.size > 0 && !this.scope.isInvalidated && !this.scope.signal.aborted) void this.read();
    });
  };
  private async read(): Promise<void> {
    const ids = this.ids();
    if (ids.length === 0) { this.publish(empty()); return; }
    const controller = new AbortController(); this.controller = controller;
    const signal = AbortSignal.any([controller.signal, this.scope.signal]);
    const generation = ++this.generation;
    this.publish({ ...this.value, loading: true, error: null });
    const live = () => !signal.aborted && generation === this.generation && !this.scope.isInvalidated && !this.scope.isProjectSuspended(this.projectId) && !this.blocked;
    try {
      await this.scope.ready(signal);
      let items: ProjectTagColor[] = [];
      for (let attempt = 0; ; attempt++) {
        items = [];
        let epoch: string | null = null;
        try {
          for (let offset = 0; offset < ids.length; offset += 100) {
            const page = await resolveProjectTagColors(this.projectId, ids.slice(offset, offset + 100), epoch, signal,
              { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
            if (!live()) return;
            if (epoch !== null && epoch !== page.catalogEpoch) throw new ApiError('server', 409, 'catalog_changed');
            epoch = page.catalogEpoch;
            items.push(...page.items);
          }
          break;
        } catch (error) {
          if (!live()) return;
          if (attempt === 0 && error instanceof ApiError && error.code === 'catalog_changed') continue;
          throw error;
        }
      }
      await this.scope.ready(signal);
      if (!live()) return;
      this.publish({ items: new Map(items.map(item => [item.id, item])), loading: false, error: null });
    } catch (error) {
      if (!live() || isAbortError(error)) return;
      const denied = error instanceof ApiError && (error.status === 403 || error.status === 404);
      this.publish({ items: denied ? new Map() : this.value.items, loading: false, error });
      if (denied && live()) void this.scope.revalidateProjectAccess(this.projectId).catch(() => {});
    } finally { if (generation === this.generation) this.controller = null; }
  }
}

const projections = new WeakMap<TaskCacheScope, Map<string, TagColorProjection>>();
const projectionFor = (scope: TaskCacheScope, projectId: string): TagColorProjection => {
  let projects = projections.get(scope);
  if (projects === undefined) { projects = new Map(); projections.set(scope, projects); }
  let projection = projects.get(projectId);
  if (projection === undefined) { projection = new TagColorProjection(scope, projectId); projects.set(projectId, projection); }
  return projection;
};

export const invalidateTagColors = (scope: TaskCacheScope, projectId: string): void => {
  projections.get(scope)?.get(projectId)?.invalidate();
};

export const useTagColors = (projectId: string, ids: readonly string[]) => {
  const scope = useTaskCacheScope();
  const projection = useMemo(() => projectionFor(scope, projectId), [scope, projectId]);
  const key = JSON.stringify([...new Set(ids)].sort());
  const interest = useRef<ReturnType<TagColorProjection['observe']> | null>(null);
  useEffect(() => {
    const current = projection.observe(); interest.current = current;
    return () => { current.close(); if (interest.current === current) interest.current = null; };
  }, [projection]);
  useEffect(() => { interest.current?.update(JSON.parse(key) as string[]); }, [projection, key]);
  const value = useSyncExternalStore(projection.subscribe, projection.snapshot, projection.snapshot);
  return { ...value, loading: value.loading || value.error === null && ids.some(id => !value.items.has(id)), retry: projection.invalidate };
};
