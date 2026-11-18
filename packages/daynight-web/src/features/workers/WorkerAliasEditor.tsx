import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { getWorkerAlias, normalizeWorkerAlias, saveWorkerAlias, type WorkerAlias } from '../../api/worker-alias';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';

export const WorkerAliasEditor = ({ workerId, resource, readEnabled, onSaved }: {
  readonly workerId: string; readonly resource: WorkerAlias; readonly readEnabled: boolean; readonly onSaved: (alias: WorkerAlias) => void;
}) => {
  const scope = useTaskCacheScope();
  const { messages: { workers: { alias: m } } } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState<{ value: string; version: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [error, setError] = useState<'failed' | 'conflict' | 'unknown' | 'checked' | null>(null);
  const input = useRef<HTMLInputElement>(null), opener = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const admissionWaiters = useRef(new Set<() => void>());
  const context = useRef({ workerId, scope, readEnabled, onSaved });
  context.current = { workerId, scope, readEnabled, onSaved };
  useLayoutEffect(() => () => { operation.current?.abort(); operation.current = null; }, [workerId, scope]);
  useLayoutEffect(() => { if (readEnabled) for (const resume of admissionWaiters.current) resume(); }, [readEnabled]);
  useLayoutEffect(() => {
    if (draft === null && restoreFocus.current) { restoreFocus.current = false; opener.current?.focus(); }
  }, [draft]);
  const permitted = () => context.current.workerId === workerId && context.current.scope === scope && context.current.readEnabled && !scope.isInvalidated && !authRequestsPaused();
  const waitForPublication = async (signal: AbortSignal) => {
    while (true) {
      await scope.ready(signal);
      signal.throwIfAborted();
      if (context.current.workerId !== workerId || context.current.scope !== scope) throw new DOMException('Worker alias target changed.', 'AbortError');
      if (permitted()) return;
      if (!context.current.readEnabled) await new Promise<void>((resolve, reject) => {
        const finish = () => { admissionWaiters.current.delete(finish); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { admissionWaiters.current.delete(finish); reject(signal.reason); };
        admissionWaiters.current.add(finish); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  };
  const close = () => { if (operation.current !== null) return; restoreFocus.current = true; setDraft(null); setError(null); };
  const run = async (value: string | null, check = false) => {
    if (!permitted() || operation.current !== null || draft === null || !check && needsCheck) return;
    const controller = new AbortController();
    operation.current = controller; setPending(true);
    const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
    let dispatched = false;
    try {
      await scope.ready(signal);
      signal.throwIfAborted();
      if (!permitted()) return;
      const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
      const incoming = check ? await getWorkerAlias(workerId, signal, admission)
        : await saveWorkerAlias(workerId, value, draft.version, signal, admission, () => {
          if (!permitted()) throw new DOMException('Worker alias admission changed.', 'AbortError');
          dispatched = true;
        });
      await waitForPublication(signal);
      if (context.current.workerId !== workerId || context.current.scope !== scope || scope.isInvalidated) return;
      context.current.onSaved(incoming);
      setNeedsCheck(false);
      if (check) { setDraft(old => old === null ? null : { ...old, version: incoming.version }); setError('checked'); }
      else { restoreFocus.current = true; setDraft(null); setError(null); }
    } catch (failure) {
      if (signal.aborted || context.current.workerId !== workerId || context.current.scope !== scope || scope.isInvalidated) return;
      try { await waitForPublication(signal); }
      catch (publicationError) {
        if (signal.aborted || scope.isInvalidated || isAbortError(publicationError)) return;
        if (dispatched) setNeedsCheck(true);
        setError('failed');
        return;
      }
      const kind = failure instanceof ApiError && failure.code === 'version_conflict' ? 'conflict'
        : !check && dispatched && !(failure instanceof ApiError && failure.kind === 'server' && failure.status !== null && failure.status >= 400 && failure.status < 500) ? 'unknown' : 'failed';
      if (kind === 'conflict' || kind === 'unknown') setNeedsCheck(true);
      setError(kind);
    } finally {
      if (operation.current === controller) { operation.current = null; setPending(false); }
    }
  };
  const normalized = draft === null ? null : normalizeWorkerAlias(draft.value);
  const blocked = pending || !readEnabled || scope.isInvalidated;
  return <section className="worker-alias" aria-label={m.label}>
    <button ref={opener} className="button secondary" type="button" hidden={draft !== null} disabled={!readEnabled} onClick={() => {
      setDraft({ value: resource.value ?? '', version: resource.version }); setError(needsCheck ? 'unknown' : null);
      queueMicrotask(() => input.current?.focus());
    }}>{resource.value === null ? m.set : m.edit}</button>
    {draft !== null && <form className="worker-alias-form" aria-busy={pending} onSubmit={event => {
      event.preventDefault();
      if (normalized !== null) void run(normalized);
    }} onKeyDown={event => {
      if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); close(); }
    }}>
      <label htmlFor={`${id}-input`}>{m.label}</label>
      <input id={`${id}-input`} ref={input} value={draft.value} disabled={pending} aria-describedby={`${id}-hint`} aria-invalid={normalized === null} autoComplete="off"
        onChange={event => setDraft({ ...draft, value: event.target.value })} />
      <p className="worker-alias-hint" id={`${id}-hint`}>{m.hint}</p>
      <p className="worker-alias-current">{m.current}: <bdi>{resource.value ?? m.none}</bdi></p>
      {error !== null && <p className={error === 'checked' ? 'worker-alias-hint' : 'notice error'} role={error === 'checked' ? 'status' : 'alert'}>{m[error]}</p>}
      <div className="worker-alias-actions">
        <button className="button primary" type="submit" disabled={blocked || normalized === null || needsCheck}>{pending ? m.saving : m.save}</button>
        <button className="button secondary" type="button" disabled={blocked || resource.value === null || needsCheck} onClick={() => void run(null)}>{m.clear}</button>
        {needsCheck && <button className="button secondary" type="button" disabled={blocked} onClick={() => void run(null, true)}>{m.check}</button>}
        <button className="button secondary" type="button" disabled={pending} onClick={close}>{m.cancel}</button>
      </div>
    </form>}
  </section>;
};
