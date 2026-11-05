import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { authRequestsPaused } from '../../api/client';
import { createTestSessionApi } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskSessionClient } from './client';
import { SessionView } from './SessionView';
import { useSessionMessages } from './messages';
import { useTestSessionListMessages } from './test-session-list-messages';
import { followSessionLink } from './TestSessionListPage';
import { getBotDeletionCoordinator } from '../bots/deletion-coordinator';
import { BotDeletionStatus } from '../bots/BotDeletionStatus';

export function TestSessionPage({ sessionId }: { readonly sessionId: string }) {
  const scope = useTaskCacheScope();
  const coordinator = getBotDeletionCoordinator(scope);
  const records = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
  const record = records.find(value => value.sessionId === sessionId && (value.result || value.phase === 'unavailable')) ?? records.find(value => value.sessionId === sessionId);
  const admission = coordinator.sessionAdmission(sessionId);
  const [owned, setOwned] = useState<{ client: TaskSessionClient; scope: typeof scope; sessionId: string } | null>(null);
  const m = useSessionMessages(), listMessages = useTestSessionListMessages();
  useLayoutEffect(() => {
    if (scope.isInvalidated || admission !== 'allowed') { setOwned(null); return; }
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Browser storage is optional. */ }
    const isCurrent = () => !scope.isInvalidated && coordinator.sessionAdmission(sessionId) === 'allowed';
    const next = new TaskSessionClient({ api: createTestSessionApi(sessionId, scope.userId, scope.principalMismatch), userId: scope.userId, testSessionId: sessionId, isCurrent, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
    setOwned({ client: next, scope, sessionId });
    // Close synchronously: retained handlers and requests awaiting identity must
    // lose their lifetime before any deletion observation can publish again.
    const unsubscribe = coordinator.subscribe(() => {
      const current = coordinator.sessionAdmission(sessionId);
      if (current === 'revoked') next.invalidate();
      else if (current === 'blocked') next.close();
      if (current !== 'allowed') setOwned(value => value?.client === next ? null : value);
    });
    next.syncAvailability();
    const timer = setInterval(next.syncAvailability, 250);
    const abort = () => next.invalidate(); scope.signal.addEventListener('abort', abort, { once: true });
    return () => { unsubscribe(); clearInterval(timer); scope.signal.removeEventListener('abort', abort); next.close(); };
  }, [scope, sessionId, coordinator, admission, record]);
  useEffect(() => {
    if (!record || !['unknown', 'pending', 'failed'].includes(record.phase)) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !record.busy) void coordinator.check(record.id); }, 5_000);
    return () => clearInterval(timer);
  }, [coordinator, record]);
  const client = admission === 'allowed' && !scope.isInvalidated && owned?.scope === scope && owned.sessionId === sessionId ? owned.client : null;
  return <section className="test-session-page"><a className="test-session-back" href="/test-sessions" onClick={followSessionLink}>‹ {listMessages.back}</a><h1>{listMessages.session}</h1>{admission !== 'allowed' && record ? <BotDeletionStatus record={record} coordinator={coordinator} enabled={!scope.isInvalidated && !authRequestsPaused()} /> : client ? <SessionView userId={scope.userId} client={client} active current /> : <p role="status">{m.loading}</p>}</section>;
}
