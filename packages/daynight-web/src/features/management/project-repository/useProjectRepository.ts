import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause } from '../../../api/client';
import { getProject } from '../../../api/project-settings';
import { previewProjectRepository, saveProjectRepository, type RepositoryPreview, type RepositoryReceipt } from '../../../api/project-repository';
import { useProjectAccess } from '../../projects/ProjectAccess';
import { publishRepositoryChange } from '../../projects/repository-changes';
import { useOperation } from '../../teams/TeamManagement';
import type { ProjectManagementGuard } from '../ProjectManagementGuard';
import type { ProjectSettingsSectionState } from '../project-settings/section-state';

export type RepositoryEditorProps = {
  readonly projectId: string; readonly repoUrl: string | null; readonly active: boolean; readonly onRoute: boolean; readonly unavailable: boolean;
  readonly guard: ProjectManagementGuard; readonly onRetentionChange: (retain: boolean) => void; readonly onStateChange: (state: ProjectSettingsSectionState) => void;
};

const abortable = <T,>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const cleanup = () => signal.removeEventListener('abort', abort);
  const abort = () => { cleanup(); reject(signal.reason); };
  void work.then(value => { cleanup(); resolve(value); }, (failure: unknown) => { cleanup(); reject(failure); });
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});

export const useProjectRepository = ({ projectId, repoUrl, active, onRoute, unavailable, guard, onRetentionChange, onStateChange }: RepositoryEditorProps) => {
  const access = useProjectAccess(projectId), scope = access.session.scope, op = useOperation(scope);
  const [draft, setDraft] = useState(''), [dialog, setDialog] = useState(false), [preview, setPreview] = useState<RepositoryPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<'invalid' | 'tooLong' | null>(null), [conflict, setConflict] = useState(false);
  const [observed, setObserved] = useState<string | null>(null), [saved, setSaved] = useState<RepositoryReceipt | null>(null);
  const read = useRef<AbortController | null>(null), preparing = useRef(false), revision = useRef(0);
  const [preparingWrite, setPreparingWrite] = useState(false);
  const mounted = useRef(true), current = useRef({ active, onRoute, dialog, draft, preview }); current.current = { active, onRoute, dialog, draft, preview };
  const unknown = op.result?.kind === 'unknown';
  const privateAvailable = !unavailable && !scope.isInvalidated && !scope.isProjectSuspended(projectId) && access.status !== 'unavailable';
  const editable = privateAvailable && access.ready && access.access?.effectiveRole === 'admin';
  const busy = op.pending || op.publicationPending || preparingWrite;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; read.current?.abort(); guard.release('repository'); }; }, [scope, projectId, guard]);
  useEffect(() => { if (!active || !onRoute) { revision.current++; read.current?.abort(); read.current = null; setReading(false); } }, [active, onRoute]);
  useEffect(() => {
    if (privateAvailable) return;
    revision.current++; read.current?.abort(); read.current = null; setReading(false); setDraft(''); setPreview(null); setObserved(null); setAcknowledged(false); setSaved(null); setError(null);
  }, [privateAvailable]);
  useEffect(() => subscribeAuthPause(() => { read.current?.abort(); read.current = null; setReading(false); }), []);
  useLayoutEffect(() => { onRetentionChange(busy || op.publicationError !== null || unknown); }, [busy, op.publicationError, unknown, onRetentionChange]);
  const dirty = draft !== '' && draft !== repoUrl && !unknown;
  const needsAttention = error !== null || invalid !== null || conflict || op.result !== null || op.publicationError !== null;
  useLayoutEffect(() => { onStateChange({ dirty, pending: busy, needsAttention }); }, [dirty, busy, needsAttention, onStateChange]);

  const close = () => { if (busy) return; revision.current++; read.current?.abort(); read.current = null; setReading(false); setDialog(false); };
  const change = (value: string) => {
    if (unknown || busy) return;
    revision.current++; read.current?.abort(); read.current = null; setReading(false); setDraft(value); setPreview(null); setAcknowledged(false); setInvalid(null); setError(null); setConflict(false); setSaved(null); op.clear();
  };
  const inspect = async () => {
    if (!active || !onRoute || !editable || op.guarded() || read.current !== null || busy) return;
    if (draft.trim() === '' || !draft.isWellFormed()) { setInvalid('invalid'); return; }
    if (new TextEncoder().encode(draft).length > 4096) { setInvalid('tooLong'); return; }
    const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
    const token = ++revision.current, target = draft;
    setDialog(true); setReading(true); setPreview(null); setError(null); setInvalid(null); setConflict(false); setAcknowledged(false); setSaved(null); op.clear();
    try {
      await abortable(access.session.revalidate(), signal);
      const fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (fresh?.effectiveRole !== 'admin' || !current.current.active || !current.current.onRoute) return;
      const value = await previewProjectRepository(projectId, target, scope.userId, signal, scope.principalMismatch);
      await scope.ready(signal);
      const latest = await abortable(access.session.waitForFreshAccess(signal), signal);
      if (signal.aborted || revision.current !== token || latest?.effectiveRole !== 'admin') return;
      if (String(latest.ownership.version) !== value.ownershipVersion) { setConflict(true); return; }
      setPreview(value);
    } catch (failure) {
      if (!signal.aborted && !isAbortError(failure) && !scope.isInvalidated && revision.current === token) {
        setError(failure);
        if (failure instanceof ApiError && failure.code === 'invalid_input') { setInvalid('invalid'); setDialog(false); }
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) void access.session.revalidate();
      }
    } finally { if (read.current === controller) { read.current = null; if (mounted.current) setReading(false); } }
  };
  const submit = () => {
    const selected = preview;
    if (!active || !onRoute || !editable || selected === null || selected.classification === 'unchanged' || selected.classification === 'unverified' && !acknowledged || reading || preparing.current || op.guarded() || !guard.tryAcquire('repository')) return;
    preparing.current = true;
    setPreparingWrite(true);
    const token = revision.current;
    void op.run(async (signal, dispatched) => {
      await abortable(access.session.revalidate(), signal);
      const fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (signal.aborted || authRequestsPaused() || !current.current.active || !current.current.onRoute || !current.current.dialog || current.current.preview !== selected || revision.current !== token || fresh?.effectiveRole !== 'admin' || String(fresh.ownership.version) !== selected.ownershipVersion) throw new Error('Repository change admission changed');
      return saveProjectRepository(selected, selected.classification === 'unverified', scope.userId, signal, scope.principalMismatch, dispatched);
    }, receipt => {
      publishRepositoryChange({ userId: scope.userId, projectId });
      setSaved(receipt);
      setPreview(null);
      if (revision.current === token) { setDialog(false); setDraft(''); }
      guard.release('repository');
    }, failure => {
      guard.release('repository');
      if (failure instanceof ApiError && failure.status === 409) { setPreview(null); setAcknowledged(false); setConflict(true); }
      if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) void access.session.revalidate();
    }).finally(() => { preparing.current = false; if (mounted.current) setPreparingWrite(false); if (!op.guarded() && !op.publishing()) guard.release('repository'); });
  };
  const check = async () => {
    if (!active || !onRoute || read.current !== null || !unknown) return;
    const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]), token = revision.current;
    setReading(true); setError(null);
    try {
      await abortable(access.session.revalidate(), signal);
      const fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (fresh === null) throw new Error('Project access unavailable');
      const value = await getProject(projectId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      await scope.ready(signal);
      if (!signal.aborted && revision.current === token && access.session.snapshot().status === 'ready') { setObserved(value.repoUrl); publishRepositoryChange({ userId: scope.userId, projectId }); }
    } catch (failure) { if (!signal.aborted && !scope.isInvalidated && revision.current === token) setError(failure); }
    finally { if (read.current === controller) { read.current = null; if (mounted.current) setReading(false); } }
  };
  return { op, draft, dialog, preview, acknowledged, setAcknowledged, reading, error, invalid, conflict, observed, saved, unknown, privateAvailable, editable, busy, close, change, inspect, submit, check, reopen: () => setDialog(true) };
};
