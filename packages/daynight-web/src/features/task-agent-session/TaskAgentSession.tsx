import { useEffect, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { createSessionApi } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskSessionClient } from './client';
import { SessionView } from './SessionView';
import { useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function TaskAgentSession({ projectId, taskId, claimId, active, current }: {
  readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly active: boolean; readonly current: boolean;
}) {
  const scope = useTaskCacheScope();
  const currentRef = useRef(current); currentRef.current = current;
  const [client, setClient] = useState<TaskSessionClient | null>(null);
  useEffect(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Browser storage is optional. */ }
    const isCurrent = () => currentRef.current && !scope.isInvalidated;
    const api = createSessionApi(projectId, taskId, scope.userId, scope.principalMismatch);
    const next = new TaskSessionClient({ api, userId: scope.userId, projectId, taskId, claimId, isCurrent, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
    setClient(next);
    next.syncAvailability();
    const timer = setInterval(next.syncAvailability, 250);
    const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) next.invalidate(); else next.syncAvailability(); });
    const abort = () => next.invalidate(); scope.signal.addEventListener('abort', abort, { once: true });
    return () => { clearInterval(timer); unsubscribe(); scope.signal.removeEventListener('abort', abort); next.close(); };
  }, [scope, projectId, taskId, claimId]);
  const m = useSessionMessages();
  return client ? <SessionView client={client} active={active} current={current} /> : <p className="session-empty" role="status">{m.loading}</p>;
}
