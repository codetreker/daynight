import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, readAuthRequestGeneration, waitForAuthRequests } from '../../api/client';
import { getPullRequestDetail, type PullRequestDetail } from './api';

export type PullRequestDetailOptions = {
  readonly userId: string; readonly projectId: string; readonly number: string;
  /** False means the caller has withdrawn Project access; active=false only suspends reads. */
  readonly canRead: boolean; readonly active: boolean;
  readonly onPrincipalMismatch: () => void;
  readonly onAccessError?: ((error: ApiError) => void) | undefined;
};
type Snapshot = { readonly key: string; readonly detail: PullRequestDetail | null; readonly loading: boolean; readonly error: ApiError | null };
const empty = (key: string): Snapshot => ({ key, detail: null, loading: false, error: null });
const READ_TIMEOUT_MS = 30_000;

/** Owns the selected identity's reads. Call refresh for explicit or background revalidation. */
export const usePullRequestDetail = ({ userId, projectId, number, canRead, active, onPrincipalMismatch, onAccessError }: PullRequestDetailOptions) => {
  const key = JSON.stringify([userId, projectId, number]);
  const current = useRef({ key, canRead, active, onPrincipalMismatch, onAccessError });
  current.current = { key, canRead, active, onPrincipalMismatch, onAccessError };
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(key));
  const generation = useRef(0), pending = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (current.current.key !== key || !current.current.canRead || !current.current.active) return;
    pending.current?.abort();
    const controller = new AbortController(), requestGeneration = ++generation.current, authGeneration = readAuthRequestGeneration();
    pending.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const admitted = () => generation.current === requestGeneration && current.current.key === key && current.current.canRead && current.current.active;
    setSnapshot(previous => ({ ...(previous.key === key ? previous : empty(key)), loading: true, error: null }));
    void (async () => {
      try {
        const detail = await getPullRequestDetail(projectId, number, controller.signal, {
          userId,
          onPrincipalMismatch: () => {},
          onDispatch: () => { timer = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS); },
        });
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        await waitForAuthRequests(controller.signal);
        if (!admitted()) return;
        if (authGeneration !== readAuthRequestGeneration()) { setSnapshot(empty(key)); return; }
        setSnapshot(previous => {
          const existing = previous.key === key ? previous.detail : null;
          return { key, detail: existing !== null && BigInt(existing.revision) > BigInt(detail.revision) ? existing : detail, loading: false, error: null };
        });
      } catch (cause: unknown) {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        if (!admitted()) return;
        if (!timedOut && controller.signal.aborted) return;
        if (!timedOut && isAbortError(cause)) {
          try { await waitForAuthRequests(controller.signal); } catch { if (admitted()) setSnapshot(empty(key)); return; }
          if (!admitted()) return;
          if (authGeneration === readAuthRequestGeneration()) refresh();
          else setSnapshot(empty(key));
          return;
        }
        const error = timedOut ? new ApiError('network') : cause instanceof ApiError ? cause : new ApiError('protocol', null, 'protocol', null, cause);
        const accessError = error.kind === 'server' && (error.status === 403 || error.status === 404);
        const revoked = error.code === 'principal_mismatch' || error.status === 401 || accessError;
        if (!timedOut) {
          try { await waitForAuthRequests(controller.signal); } catch { if (admitted()) setSnapshot(empty(key)); return; }
          if (!admitted()) return;
          if (authGeneration !== readAuthRequestGeneration()) { setSnapshot(empty(key)); return; }
        }
        setSnapshot(previous => ({ key, detail: revoked || previous.key !== key ? null : previous.detail, loading: false, error }));
        if (error.code === 'principal_mismatch' && admitted()) current.current.onPrincipalMismatch();
        if (accessError && admitted()) current.current.onAccessError?.(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (pending.current === controller) pending.current = null;
      }
    })();
  }, [key, userId, projectId, number]);

  useEffect(() => {
    if (!canRead) setSnapshot(empty(key));
    else if (active) refresh();
    else setSnapshot(previous => previous.key === key ? { ...previous, loading: false } : empty(key));
    return () => { generation.current += 1; pending.current?.abort(); pending.current = null; };
  }, [key, canRead, active, refresh]);

  const visible = canRead && snapshot.key === key ? snapshot : empty(key);
  return { detail: visible.detail, loading: visible.loading || (canRead && active && visible.detail === null && visible.error === null), error: visible.error, refresh };
};
