import { useEffect, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { createSessionApi } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { SessionStartupReport } from '../../../../daynight/src/session/startup';
import { TaskSessionClient } from './client';
import { SessionView } from './SessionView';
import { useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function TaskAgentSession({ projectId, taskId, claimId, ownerUserId, startupReport, active, current }: {
  readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly ownerUserId: string; readonly startupReport?: SessionStartupReport; readonly active: boolean; readonly current: boolean;
}) {
  const scope = useTaskCacheScope();
  const currentRef = useRef(current); currentRef.current = current;
  const activeRef = useRef(active); activeRef.current = active;
  const reportRef = useRef(startupReport); reportRef.current = startupReport;
  const [owned, setOwned] = useState<{ client: TaskSessionClient; scope: typeof scope; projectId: string; taskId: string; claimId: string; ownerUserId: string } | null>(null);
  useEffect(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Browser storage is optional. */ }
    const isCurrent = () => currentRef.current && !scope.isInvalidated;
    const api = createSessionApi(projectId, taskId, scope.userId, scope.principalMismatch);
    const next = new TaskSessionClient({ api, userId: scope.userId, projectId, taskId, claimId, ownerUserId, isCurrent, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
    setOwned({ client: next, scope, projectId, taskId, claimId, ownerUserId });
    next.setVisible(activeRef.current);
    next.observeTaskStartupReport(reportRef.current);
    next.syncAvailability();
    const timer = setInterval(next.syncAvailability, 250);
    const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) next.invalidate(); else next.syncAvailability(); });
    const abort = () => next.invalidate(); scope.signal.addEventListener('abort', abort, { once: true });
    return () => { clearInterval(timer); unsubscribe(); scope.signal.removeEventListener('abort', abort); next.close(); };
  }, [scope, projectId, taskId, claimId, ownerUserId]);
  const m = useSessionMessages();
  const client = owned?.scope === scope && owned.projectId === projectId && owned.taskId === taskId && owned.claimId === claimId && owned.ownerUserId === ownerUserId ? owned.client : null;
  useEffect(() => { client?.setVisible(active); client?.observeTaskStartupReport(startupReport); }, [client, active, startupReport]);
  return client ? <SessionView userId={scope.userId} client={client} active={active} current={current} /> : <p className="session-empty" role="status">{m.loading}</p>;
}
