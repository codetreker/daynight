import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { createSessionApi } from '../../api/sessions';
import type { SessionRecordingReference, TerminalSessionApi } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';

/** Completion removes write controls before the Session's separate archive lifecycle settles. */
export function useCompletedTaskSession({ projectId, taskId, claimId, mode, api, active }: {
  readonly projectId: string; readonly taskId: string; readonly claimId: string | undefined;
  readonly mode: 'web' | 'herdr' | undefined; readonly api: TerminalSessionApi; readonly active: boolean;
}) {
  const scope = useTaskCacheScope();
  const nativeApi = useMemo(() => createSessionApi(projectId, taskId, scope.userId, scope.principalMismatch), [scope, projectId, taskId]);
  const owner = useMemo(() => ({}), [scope, projectId, taskId, claimId, mode]);
  type State = { owner: object; item: SessionRecordingReference | null; loading: boolean; error: unknown; availability: 'not_registered' | 'not_applicable' | null; preparing: boolean };
  const initial = (): State => ({ owner, item: null, loading: true, error: null, availability: null, preparing: false });
  const [state, setState] = useState<State>(initial);
  const [revision, setRevision] = useState(0);
  const activeRef = useRef(active); activeRef.current = active;
  const current = state.owner === owner ? state : initial();
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const revoke = () => setState({ ...initial(), loading: false, error: new ApiError('server', 403) });
    scope.signal.addEventListener('abort', revoke);
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked || event.scopeSuspended) revoke();
      else if (event.accessRestored) refresh();
    });
    return () => { scope.signal.removeEventListener('abort', revoke); unsubscribe(); };
  }, [scope, owner, projectId]);
  useEffect(() => {
    if (!active || claimId === undefined || mode === undefined || scope.isInvalidated || scope.isProjectSuspended(projectId)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(); scope.signal.addEventListener('abort', abort);
    const unsubscribe = scope.subscribe(event => { if (event.projectId === projectId && (event.accessRevoked || event.scopeSuspended)) abort(); });
    setState(old => ({ ...(old.owner === owner ? old : initial()), loading: true, error: null }));
    void (async () => {
      await scope.ready(controller.signal);
      const result = mode === 'web' ? await nativeApi.current(controller.signal) : await api.current(controller.signal);
      await scope.ready(controller.signal);
      if (controller.signal.aborted || !activeRef.current || scope.isInvalidated || scope.isProjectSuspended(projectId) || authRequestsPaused()) return;
      if (result.status !== 'registered') {
        if ('claimId' in result && result.claimId !== null && result.claimId !== claimId) throw new ApiError('protocol');
        setState({ owner, item: null, loading: false, error: null, availability: result.status, preparing: false });
        if (result.status === 'not_registered') timer = setTimeout(refresh, 3000);
        return;
      }
      const session = 'session' in result ? result.session : result;
      if (session.claimId !== claimId || 'identity' in session && (session.identity.projectId !== projectId || session.identity.taskId !== taskId)) throw new ApiError('protocol');
      const preparing = 'lifecycle' in session && session.lifecycle !== 'archived';
      const item: SessionRecordingReference = { sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration, agentControlMode: mode };
      setState(old => ({ owner, item: old.owner === owner && JSON.stringify(old.item) === JSON.stringify(item) ? old.item : item, loading: false, error: null, availability: null, preparing }));
      if (preparing) timer = setTimeout(refresh, 3000);
    })().catch(error => {
      if (controller.signal.aborted) return;
      const denied = error instanceof ApiError && (error.kind === 'protocol' || [401, 403, 404, 410].includes(error.status ?? 0));
      setState(old => ({ owner, item: !denied && old.owner === owner ? old.item : null, loading: false, error, availability: null, preparing: false }));
    });
    return () => { controller.abort(); clearTimeout(timer); unsubscribe(); scope.signal.removeEventListener('abort', abort); };
  }, [owner, scope, projectId, taskId, claimId, mode, api, nativeApi, active, revision]);
  return { ...current, refresh };
}
