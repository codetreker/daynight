import { useEffect, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { createTestSessionApi } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskSessionClient } from './client';
import { SessionView } from './SessionView';
import { useSessionMessages } from './messages';
import { useTestSessionListMessages } from './test-session-list-messages';
import { followSessionLink } from './TestSessionListPage';

export function TestSessionPage({ sessionId }: { readonly sessionId: string }) {
  const scope = useTaskCacheScope();
  const [owned, setOwned] = useState<{ client: TaskSessionClient; scope: typeof scope; sessionId: string } | null>(null);
  const m = useSessionMessages(), listMessages = useTestSessionListMessages();
  useEffect(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Browser storage is optional. */ }
    const isCurrent = () => !scope.isInvalidated;
    const next = new TaskSessionClient({ api: createTestSessionApi(sessionId, scope.userId, scope.principalMismatch), userId: scope.userId, testSessionId: sessionId, isCurrent, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
    setOwned({ client: next, scope, sessionId });
    next.syncAvailability();
    const timer = setInterval(next.syncAvailability, 250);
    const abort = () => next.invalidate(); scope.signal.addEventListener('abort', abort, { once: true });
    return () => { clearInterval(timer); scope.signal.removeEventListener('abort', abort); next.close(); };
  }, [scope, sessionId]);
  const client = owned?.scope === scope && owned.sessionId === sessionId ? owned.client : null;
  return <section className="test-session-page"><a className="test-session-back" href="/test-sessions" onClick={followSessionLink}>‹ {listMessages.back}</a><h1>{listMessages.session}</h1>{client ? <SessionView userId={scope.userId} client={client} active current /> : <p role="status">{m.loading}</p>}</section>;
}
