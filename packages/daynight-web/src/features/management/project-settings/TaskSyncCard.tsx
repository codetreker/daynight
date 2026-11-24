import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, isAbortError } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import { useProjectAccess } from '../../projects/ProjectAccess';
import type { TaskSyncTicket } from '../../task-cache/project-cache';
import { executeTaskSync } from '../../task-cache/task-sync-execution';
import { settingsWorkspaceMessages } from './messages';

type Result = 'success' | 'empty' | 'failure' | 'denied' | null;

export const TaskSyncCard = ({ projectId, active, onRoute }: { readonly projectId: string; readonly active: boolean; readonly onRoute: boolean }) => {
  const { locale } = useI18n();
  const m = settingsWorkspaceMessages[locale].sync;
  const access = useProjectAccess(projectId);
  const scope = access.session.scope;
  const title = useId(), description = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const pending = useRef<AbortController | null>(null);
  const visible = useRef(false);
  visible.current = active && onRoute;
  const readable = access.access !== null && access.status !== 'unavailable' && !scope.isInvalidated && !scope.hasIdentityMismatch;
  useLayoutEffect(() => {
    if (!active || !onRoute || !readable) {
      pending.current?.abort(); pending.current = null;
      setBusy(false); setResult(null);
    }
  }, [active, onRoute, readable]);
  useLayoutEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);

  const run = async () => {
    if (pending.current !== null || !visible.current || !readable || authRequestsPaused()) return;
    const controller = new AbortController();
    pending.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
    setBusy(true); setResult(null);
    let ticket: TaskSyncTicket | null = null;
    let projectReadRevision = scope.getProjectReadRevision(projectId);
    try {
      ticket = await scope.beginSync(projectId, signal);
      const accessTicket = access.session.beginObservation();
      projectReadRevision = scope.getProjectReadRevision(projectId);
      const execution = await executeTaskSync({ scope, projectId, signal, ticket, trigger: 'manual-rebuild' });
      signal.throwIfAborted();
      if (execution.history !== 'current') throw new ApiError('protocol');
      if (!await scope.isSyncCommitCurrent(execution.project.manifest, signal)) throw new ApiError('protocol');
      signal.throwIfAborted();
      access.session.publishSync(accessTicket, execution.sync.actorAccess);
      scope.notifyTagColors(projectId);
      if (visible.current) setResult(execution.sync.tasks.length === 0 ? 'empty' : 'success');
    } catch (error) {
      if (signal.aborted || !visible.current || scope.hasIdentityMismatch) return;
      const missing = error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found';
      const denied = error instanceof ApiError && error.kind === 'server' && error.status === 403;
      if (missing && ticket !== null) {
        if (scope.canRevokeProjectRead(ticket, projectReadRevision)) {
          try { await scope.revokeProject(ticket, signal, true, error); }
          catch (failure) { if (!isAbortError(failure) && !signal.aborted && visible.current) setResult('failure'); }
        } else { access.session.requireProjectReadRecheck(); access.session.retryProjectRead(); }
      } else setResult(denied ? 'denied' : 'failure');
    } finally {
      if (pending.current === controller) { pending.current = null; if (visible.current) setBusy(false); }
    }
  };
  const notice = result === 'denied' ? m.denied : result === 'failure' ? m.failure : result === 'empty' ? m.empty : result === 'success' ? m.success : null;
  return <section className="panel project-settings-panel task-sync-card" aria-labelledby={title}>
    <div className="panel-heading panel-heading-description"><div><h2 id={title}>{m.title}</h2><p id={description}>{m.description}</p></div>
      <button className="button" type="button" aria-describedby={description} aria-disabled={busy || undefined} aria-busy={busy || undefined} disabled={!active || !onRoute || !readable} onClick={() => { void run(); }}>{busy ? m.busy : result === 'failure' || result === 'denied' ? m.retry : m.action}</button>
    </div>
    <div className="task-sync-result" aria-live="polite">{notice !== null && <p className={`notice ${result === 'failure' ? 'error' : result === 'denied' ? 'warning' : 'success'}`} role={result === 'failure' ? 'alert' : 'status'}>{notice}</p>}</div>
  </section>;
};
