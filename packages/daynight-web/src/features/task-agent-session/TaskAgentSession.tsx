import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { createSessionApi } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskSessionClient } from './client';
import { SessionView } from './SessionView';
import { useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function TaskAgentSession({ projectId, taskId, claimId, ownerUserId, active, current }: {
  readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly ownerUserId: string; readonly active: boolean; readonly current: boolean;
}) {
  const scope = useTaskCacheScope();
  const currentRef = useRef(current); currentRef.current = current;
  const activeRef = useRef(active); activeRef.current = active;
  const [owned, setOwned] = useState<{ client: TaskSessionClient; scope: typeof scope; projectId: string; taskId: string; claimId: string; ownerUserId: string } | null>(null);
  useEffect(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Browser storage is optional. */ }
    const isCurrent = () => currentRef.current && !scope.isInvalidated;
    const api = createSessionApi(projectId, taskId, scope.userId, scope.principalMismatch);
    const next = new TaskSessionClient({ api, userId: scope.userId, projectId, taskId, claimId, ownerUserId, isCurrent, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
    setOwned({ client: next, scope, projectId, taskId, claimId, ownerUserId });
    const sync = () => { next.setCurrentReadVisible(activeRef.current && document.visibilityState !== 'hidden'); next.syncAvailability(); };
    sync();
    const timer = setInterval(sync, 250);
    document.addEventListener('visibilitychange', sync);
    const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) next.invalidate(); else sync(); });
    const abort = () => next.invalidate(); scope.signal.addEventListener('abort', abort, { once: true });
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sync); unsubscribe(); scope.signal.removeEventListener('abort', abort); next.close(); };
  }, [scope, projectId, taskId, claimId, ownerUserId]);
  const m = useSessionMessages();
  const client = owned?.scope === scope && owned.projectId === projectId && owned.taskId === taskId && owned.claimId === claimId && owned.ownerUserId === ownerUserId ? owned.client : null;
  useLayoutEffect(() => { client?.setCurrentReadVisible(active && document.visibilityState !== 'hidden'); client?.syncAvailability(); }, [client, active]);
  return client ? <SessionView userId={scope.userId} client={client} active={active} current={current} /> : <p className="session-empty" role="status">{m.loading}</p>;
}
