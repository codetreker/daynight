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
  const contextRef = useRef({ owner, scope, projectId }); contextRef.current = { owner, scope, projectId };
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const flight = useRef<{ readonly owner: object; readonly controller: AbortController } | null>(null);
  useEffect(() => {
    const sync = () => {
      const visible = document.visibilityState !== 'hidden';
      if (!visible) flight.current?.controller.abort();
      setDocumentVisible(visible);
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
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
    if (!active || !documentVisible || document.visibilityState === 'hidden' || flight.current !== null || claimId === undefined || mode === undefined || scope.isInvalidated || scope.isProjectSuspended(projectId)) return;
    const controller = new AbortController();
    const reading = { owner, controller }; flight.current = reading;
    const isCurrent = () => !controller.signal.aborted && contextRef.current.owner === owner && activeRef.current && document.visibilityState !== 'hidden' && !scope.isInvalidated && !scope.isProjectSuspended(projectId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(); scope.signal.addEventListener('abort', abort);
    const unsubscribe = scope.subscribe(event => { if (event.projectId === projectId && (event.accessRevoked || event.scopeSuspended)) abort(); });
    setState(old => ({ ...(old.owner === owner ? old : initial()), loading: true, error: null }));
    void (async () => {
      do { await scope.ready(controller.signal); if (!isCurrent()) return; } while (authRequestsPaused());
      const result = mode === 'web' ? await nativeApi.current(controller.signal) : await api.current(controller.signal);
      if (!isCurrent()) return;
      do { await scope.ready(controller.signal); if (!isCurrent()) return; } while (authRequestsPaused());
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
      if (!isCurrent()) return;
      const denied = error instanceof ApiError && (error.kind === 'protocol' || [401, 403, 404, 410].includes(error.status ?? 0));
      setState(old => ({ owner, item: !denied && old.owner === owner ? old.item : null, loading: false, error, availability: null, preparing: false }));
    }).finally(() => {
      if (flight.current !== reading) return;
      flight.current = null;
      const latest = contextRef.current;
      if (controller.signal.aborted && activeRef.current && document.visibilityState !== 'hidden' && !latest.scope.isInvalidated && !latest.scope.isProjectSuspended(latest.projectId)) refresh();
    });
    return () => { controller.abort(); clearTimeout(timer); unsubscribe(); scope.signal.removeEventListener('abort', abort); };
  }, [owner, scope, projectId, taskId, claimId, mode, api, nativeApi, active, documentVisible, revision]);
  return { ...current, refresh };
}
