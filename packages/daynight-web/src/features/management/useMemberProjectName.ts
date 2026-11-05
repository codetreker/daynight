import { useEffect, useState } from 'react';
import { isAbortError } from '../../api/client';
import { getProject } from '../../api/project-settings';
import { useProjectAccess } from '../projects/ProjectAccess';

export const useMemberProjectName = (projectId: string, active: boolean) => {
  const access = useProjectAccess(projectId);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const session = access.session;
  useEffect(() => {
    if (access.status === 'unavailable') { setName(null); setError(null); }
    if (!active || access.status !== 'ready') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.scope.signal]);
    const revision = session.scope.getProjectRevision(projectId);
    const current = () => !signal.aborted && !session.scope.isInvalidated
      && revision === session.scope.getProjectRevision(projectId) && session.snapshot().status !== 'unavailable';
    const unsubscribe = session.scope.subscribe((event) => {
      if (event.projectId !== projectId || !event.accessRevoked) return;
      controller.abort(); setName(null); setError(null);
    });
    setError(null);
    void (async () => {
      try {
        const admitted = await session.waitForFreshAccess(signal, true);
        if (admitted === null || !current()) return;
        const project = await getProject(projectId, signal, { userId: session.scope.userId, onPrincipalMismatch: session.scope.principalMismatch });
        await session.scope.ready(signal);
        if (current()) setName(project.name);
      } catch (failure) {
        if (isAbortError(failure) || !current()) return;
        setName(null); setError(failure);
      }
    })();
    return () => { controller.abort(); unsubscribe(); };
  }, [projectId, session, access.status, active, attempt]);
  return {
    name: access.status === 'unavailable' || session.scope.isInvalidated ? null : name,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
};
