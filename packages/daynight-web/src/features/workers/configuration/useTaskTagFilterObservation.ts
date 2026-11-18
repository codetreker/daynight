import { useEffect, useState } from 'react';
import { taskTagFilterDigest, taskTagFilterSemantics, type WorkerTaskTagFilter } from '../../../api/worker-task-tag-filter';

export type TaskTagDigest = { readonly state: 'checking' | 'error' } | { readonly state: 'ready'; readonly digest: string };

export const useTaskTagFilterObservation = (principal: object, workerId: string, filter: WorkerTaskTagFilter | undefined): TaskTagDigest => {
  const semantics = filter === undefined ? null : taskTagFilterSemantics(filter);
  const [result, setResult] = useState<{ principal: object; workerId: string; semantics: string; value: TaskTagDigest } | null>(null);
  useEffect(() => {
    if (semantics === null) return;
    let active = true;
    void taskTagFilterDigest(semantics).then(
      digest => { if (active) setResult({ principal, workerId, semantics, value: { state: 'ready', digest } }); },
      () => { if (active) setResult({ principal, workerId, semantics, value: { state: 'error' } }); },
    );
    return () => { active = false; };
  }, [principal, workerId, semantics]);
  return result !== null && result.principal === principal && result.workerId === workerId && result.semantics === semantics ? result.value : { state: 'checking' };
};
