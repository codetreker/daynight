import { useCallback, useLayoutEffect, useRef } from 'react';
import { authRequestsPaused } from '../../api/client';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { BotDeletionCoordinator, BotDeletionRecord } from './deletion-coordinator';

const automatic = (record: BotDeletionRecord) => ['unknown', 'pending', 'failed'].includes(record.phase);

/** Own independent deletion reads for one visible page, separate from mutations. */
export function useBotDeletionChecks(coordinator: BotDeletionCoordinator, enabled: boolean, records: readonly BotDeletionRecord[], ownerKey?: string) {
  const scope = useTaskCacheScope();
  const latest = useRef(records);
  const entry = useRef<{ check: (id: string) => Promise<void>; reconcile: () => void } | null>(null);
  const check = useCallback((id: string) => entry.current?.check(id) ?? Promise.resolve(), []);

  useLayoutEffect(() => {
    latest.current = records;
  }, [records]);

  useLayoutEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let targets = new Set<string>();
    const allowed = () => enabled && !scope.isInvalidated && !scope.signal.aborted && document.visibilityState !== 'hidden';
    const run = (ids: ReadonlySet<string>) => {
      if (!controller || controller.signal.aborted || !allowed() || authRequestsPaused()) return;
      const owner = controller;
      const current = coordinator.snapshot();
      for (const id of ids) {
        if (controller !== owner || owner.signal.aborted) break;
        const record = current.find(value => value.id === id);
        if (record && automatic(record) && !record.busy) void coordinator.check(id, owner.signal);
      }
    };
    const reconcile = () => {
      if (!controller) return;
      const next = new Set(latest.current.filter(automatic).map(record => record.id));
      const added = new Set([...next].filter(id => !targets.has(id)));
      targets = next;
      if (next.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
      if (next.size !== 0 && timer === null) timer = setInterval(() => run(targets), 5_000);
      run(added);
    };
    const stop = () => {
      entry.current = null;
      if (timer !== null) clearInterval(timer);
      timer = null; targets = new Set();
      const old = controller; controller = null;
      old?.abort();
    };
    const sync = () => {
      if (!allowed()) { stop(); return; }
      if (controller) return;
      controller = new AbortController();
      entry.current = {
        check: id => controller && allowed() && !authRequestsPaused() ? coordinator.check(id, controller.signal) : Promise.resolve(),
        reconcile,
      };
      reconcile();
    };
    document.addEventListener('visibilitychange', sync);
    scope.signal.addEventListener('abort', stop, { once: true });
    sync();
    return () => { document.removeEventListener('visibilitychange', sync); scope.signal.removeEventListener('abort', stop); stop(); };
  }, [coordinator, enabled, scope, ownerKey]);
  useLayoutEffect(() => { entry.current?.reconcile(); }, [records]);
  return { check };
}
