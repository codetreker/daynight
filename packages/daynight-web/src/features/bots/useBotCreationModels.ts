import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { discoverWorkerModels, type WorkerModelInput, type WorkerModelResult, type WorkerModelOption, type WorkerReadonlyBinding } from '../../api/worker-readonly';
import type { WorkerAgent } from '../../api/types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';

/** A catalog belongs to one target and one complete, bounded native snapshot. */
export function useBotCreationModels(enabled: boolean, workerId: string | null, provider: WorkerAgent | null, cwd: string | null, model: string | null) {
  const scope = useTaskCacheScope(), request = useRef<AbortController | null>(null), generation = useRef(0);
  const key = JSON.stringify([workerId, provider, cwd, model]);
  const [state, setState] = useState<{ key: string; value: WorkerModelResult | null; error: unknown; busy: boolean }>({ key, value: null, error: null, busy: false });
  const load = useCallback(async () => {
    request.current?.abort();
    if (!enabled || workerId === null || provider === null) return;
    const controller = new AbortController(), ticket = ++generation.current;
    request.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const current = () => !signal.aborted && ticket === generation.current;
    setState(old => ({ key, value: old.key === key ? old.value : null, error: null, busy: true }));
    try {
      await scope.ready(signal);
      const input: WorkerModelInput = { provider, ...(cwd === null ? {} : { cwd }), ...(model === null ? {} : { model }), limit: 100 };
      let complete: WorkerModelResult | null = null, binding: WorkerReadonlyBinding | undefined;
      const cursors = new Set<string>(), ids = new Set<string>(), options: WorkerModelOption[] = [];
      do {
        const cursor: string | null = complete?.nextCursor ?? null;
        const page = await discoverWorkerModels(workerId, { ...input, ...(cursor === null ? {} : { cursor }) }, signal,
          { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, isCurrent: current }, binding === undefined ? {} : { binding });
        await scope.ready(signal);
        if (!current()) return;
        const result = page.result;
        if (complete !== null && (result.configurationGeneration !== complete.configurationGeneration || result.catalogGeneration !== complete.catalogGeneration || result.cwd !== complete.cwd || result.provider !== complete.provider)) throw new ApiError('protocol');
        for (const option of result.models) { if (ids.has(option.id)) throw new ApiError('protocol'); ids.add(option.id); }
        if (ids.size > 500 || cursors.size >= 500) throw new ApiError('protocol');
        if (result.nextCursor !== null) { if (cursors.has(result.nextCursor)) throw new ApiError('protocol'); cursors.add(result.nextCursor); }
        binding ??= { connectionId: page.connectionId, capabilityGeneration: page.capabilityGeneration };
        options.push(...result.models);
        complete = { ...result, models: [...options] };
      } while (complete.nextCursor !== null);
      if (current()) setState({ key, value: complete, error: null, busy: false });
    } catch (error) {
      if (!current() || isAbortError(error)) return;
      setState({ key, value: null, error, busy: false });
    }
  }, [scope, enabled, workerId, provider, cwd, model, key]);
  useEffect(() => {
    void load();
    return () => { ++generation.current; request.current?.abort(); };
  }, [load]);
  return { value: state.key === key ? state.value : null, error: state.key === key ? state.error : null, busy: enabled && (state.key !== key || state.busy), reload: load };
}
