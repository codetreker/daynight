import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SessionV2Archive } from '../../../../daynight/src/session/v2/types';
import { sessionFence, sessionFenceKey } from '../../../../daynight/src/session/protocol';
import { ApiError, authRequestsPaused, isAbortError, readAuthRequestGeneration } from '../../api/client';
import type { LoadedSessionArchive } from '../../api/sessions';
import { createTerminalSessionApi, SessionDenialProtocolError, type SessionHistoryItem, type SessionRecordingReference, type TerminalSessionApi } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { SyncTicket } from '../task-cache/project-cache';
import { useTaskDetailSessions } from '../task-detail/TaskDetailSession';
import { beginSessionHistoryPagination, beginSessionHistoryRefresh, clearSessionHistory, isSessionHistoryClearCurrent, readCachedSessionHistory, readSessionHistoryOwnership, readSessionHistoryPaginationState, releaseSessionHistoryRefresh, saveSessionHistory, completeSessionHistoryPagination } from './session-history-cache';
import { useCompletedTaskSession } from './automatic-task-session';
import { SessionDisplayMenu } from './SessionDisplayMenu';
import { useSessionDisplayPreference } from './useSessionDisplayPreference';
import type { SessionDisplayMode } from './display-mode';
import { TaskAgentSession } from './TaskAgentSession';
import { TerminalSessionView } from './TerminalSessionView';
import { TerminalRecordingView } from './TerminalRecordingView';
import { SessionTimeline } from './SessionTimeline';
import { useInvalidImageBindings, type InvalidImageBindings } from './useInvalidImageBindings';
import { SessionImageScope } from './images/SessionImageScope';
import { ImageFailure, pageImageStore } from './images/image-store';
import { emptySessionState } from './state';
import { useTerminalHostMessages } from './terminal-host-messages';
import { sessionNativeLabels, useSessionMessages } from './messages';
import { useSessionFullscreen } from './useSessionFullscreen';
import { useDirectSessionRecords } from './useDirectSessionRecords';
import './terminal-session.css';
import './terminal-host.css';

import type { AttachmentRecordSlots } from '../task-detail/attachments/TaskAttachments';

type ScopeProps = { readonly projectId: string; readonly taskId: string; readonly active: boolean; readonly direct?: boolean };
type Records = ReturnType<typeof useRecords>;
type RecordsPage = { items: SessionHistoryItem[]; cursor: string | null };
type RecordsState = { owner: object; api: TerminalSessionApi; page: RecordsPage | null; first: RecordsPage | null; error: unknown; loading: boolean; checking: boolean; denied: boolean };
const samePage = (a: RecordsPage | null, b: RecordsPage): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);
function useRecords(projectId: string, taskId: string, active: boolean, automatic = false) {
  const scope = useTaskCacheScope();
  const api = useMemo(() => createTerminalSessionApi(projectId, taskId, scope.userId, scope.principalMismatch), [projectId, taskId, scope]);
  const owner = useMemo(() => ({}), [scope, projectId, taskId]);
  const initial = (): RecordsState => ({ owner, api, page: null, first: null, error: null, loading: false, checking: true, denied: false });
  const [state, setState] = useState<RecordsState>(initial);
  const current = state.owner === owner ? state : initial();
  const stateRef = useRef(current); stateRef.current = current;
  const [request, setRequest] = useState<{ cursor: string | null; sequence: number }>({ cursor: null, sequence: 0 });
  const [lifecycle, setLifecycle] = useState(0);
  const guard = useRef<{ owner: object; generation: string | null }>({ owner, generation: null });
  const blocked = useRef(false);
  const interaction = useRef(0);
  const ownedRefresh = useRef<string | null>(null);
  const retryPending = useRef(false);
  const successSequence = useRef(0);
  const invalidationSequence = useRef(0);
  if (guard.current.owner !== owner) { guard.current = { owner, generation: null }; blocked.current = false; retryPending.current = false; successSequence.current = 0; invalidationSequence.current = 0; }
  useLayoutEffect(() => { setRequest(old => old.cursor === null ? old : { cursor: null, sequence: old.sequence + 1 }); }, [owner]);
  useEffect(() => { if (!active) setRequest(old => old.cursor === null ? old : { cursor: null, sequence: old.sequence + 1 }); }, [active]);
  useEffect(() => {
    const abort = () => setState(old => old.owner === owner ? { ...old, page: null, first: null, loading: false, checking: false, denied: true } : old);
    scope.signal.addEventListener('abort', abort);
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.sessionHistoryUncertain?.taskId === taskId) {
        const expected = event.sessionHistoryUncertain.expectedToken;
        const newerOwned = !event.sessionHistoryUncertain.unbound && ownedRefresh.current !== null && expected !== null && ownedRefresh.current !== expected;
        if (!newerOwned) invalidationSequence.current++;
        setState(old => old.owner === owner ? { ...old, page: null, first: null, error: new ApiError('server', 403), checking: false, denied: true } : old);
        const observedSuccess = successSequence.current;
        const superseded = () => successSequence.current !== observedSuccess;
        void scope.beginSync(projectId, scope.signal).then(ticket => scope.inspectHistoryUncertain(ticket, taskId, expected, scope.signal, event.sessionHistoryUncertain?.expectedPaginationToken, event.sessionHistoryUncertain?.expectedLeaseExpiresAt)).then(result => {
          if (superseded() || !result.current || scope.isInvalidated) return;
          const retryStarted = result.refreshing || retryPending.current || newerOwned;
          blocked.current = !retryStarted;
          setState({ owner, api, page: null, first: null, error: new ApiError('server', 403), loading: retryStarted, checking: false, denied: true });
          if (!retryStarted || ownedRefresh.current === null) setLifecycle(value => value + 1);
        }).catch(() => {
          if (superseded() || scope.isInvalidated) return;
          const retryStarted = retryPending.current || newerOwned;
          blocked.current = !retryStarted;
          setState({ owner, api, page: null, first: null, error: new ApiError('server', 403), loading: retryStarted, checking: false, denied: true });
          if (!retryStarted || ownedRefresh.current === null) setLifecycle(value => value + 1);
        });
      } else if (event.sessionHistoryCleared?.taskId === taskId) {
        const token = event.sessionHistoryCleared.token;
        const observedInteraction = interaction.current;
        void scope.beginSync(projectId, scope.signal).then(ticket => isSessionHistoryClearCurrent(scope, ticket, taskId, token, scope.signal)).then(current => {
          if (current.current && !scope.isInvalidated) {
            const retryStarted = current.refreshing || retryPending.current || interaction.current !== observedInteraction;
            blocked.current = !retryStarted;
            setState({ owner, api, page: null, first: null, error: new ApiError('server', 403), loading: retryStarted, checking: false, denied: true });
            if (!retryStarted || ownedRefresh.current === null) setLifecycle(value => value + 1);
          }
        }).catch(() => {});
      } else if (event.cacheGenerationChanged) {
        guard.current.generation = null;
        setState({ ...initial(), denied: true });
        setLifecycle(value => value + 1);
      } else if (event.accessRevoked || event.scopeSuspended) {
        blocked.current = true;
        setState({ owner, api, page: null, first: null, error: event.error ?? new ApiError('server', 403), loading: false, checking: false, denied: true });
        setLifecycle(value => value + 1);
      } else if (event.accessRestored) { blocked.current = false; setLifecycle(value => value + 1); }
      else if (!event.error && guard.current.generation !== null && !scope.isInvalidated && !authRequestsPaused()) {
        const project = scope.getAuthorizedProject(projectId);
        if (project !== null && (project.manifest.cacheGeneration !== guard.current.generation || !project.summaries.has(taskId))) {
          guard.current.generation = project?.manifest.cacheGeneration ?? null;
          setState({ ...initial(), denied: true, ...(project?.summaries.has(taskId) ? {} : { checking: false, error: new ApiError('server', 404) }) });
          setLifecycle(value => value + 1);
        }
      }
    });
    return () => { scope.signal.removeEventListener('abort', abort); unsubscribe(); };
  }, [scope, projectId, taskId, api, owner]);
  useEffect(() => {
    if (!active || blocked.current || scope.isInvalidated || scope.isProjectSuspended(projectId)) return;
    const controller = new AbortController();
    if (authRequestsPaused()) { void scope.ready(controller.signal).then(() => setLifecycle(value => value + 1)).catch(() => {}); return () => controller.abort(); }
    const abort = () => { controller.abort(); setState(old => old.owner === owner ? { ...old, page: null, first: null, loading: false, checking: false, denied: true } : old); };
    scope.signal.addEventListener('abort', abort);
    const signal = controller.signal; const projectRevision = scope.getProjectRevision(projectId);
    const requestInvalidation = invalidationSequence.current;
    const authorized = scope.getAuthorizedProject(projectId);
    if (authorized) guard.current.generation = authorized.manifest.cacheGeneration;
    let ticket: SyncTicket | null = null;
    let admitted = false;
    let readSequence = 0;
    let proofRefreshRequested = false;
    let settlementSequence = 0;
    let waitingForAdmission = false;
    let ownedToken: string | null = null;
    let leaseExpiresAt: number | null = null;
    let settlement: { token: string; outcome: 'saved' | 'cancelled' | 'failed' } | null = null;
    let wake: (() => void) | null = null;
    let recovering = false;
    const valid = () => {
      if (authRequestsPaused()) {
        if (!recovering) { recovering = true; void scope.ready(signal).then(() => setLifecycle(value => value + 1)).catch(() => {}); }
        return false;
      }
      if (invalidationSequence.current !== requestInvalidation || signal.aborted || scope.isInvalidated || scope.isProjectSuspended(projectId) || !scope.canPreviewProject(projectId) || scope.getProjectRevision(projectId) !== projectRevision) return false;
      if (admitted && ticket !== null && !scope.isSessionHistoryTicketCurrent(ticket)) return false;
      const currentProject = scope.getAuthorizedProject(projectId);
      if (ticket !== null && admitted && currentProject !== null && (currentProject.manifest.cacheGeneration !== ticket.cacheGeneration || !currentProject.summaries.has(taskId))) return false;
      return authorized === null || currentProject !== null && currentProject.manifest.cacheGeneration === authorized.manifest.cacheGeneration && currentProject.summaries.has(taskId);
    };
    const update = (fn: (value: RecordsState) => RecordsState) => { if (valid()) setState(old => fn(old.owner === owner ? old : initial())); };
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId || event.accessRevoked || event.error) return;
      if (waitingForAdmission) { waitingForAdmission = false; setLifecycle(value => value + 1); return; }
      if (event.sessionHistorySettled) {
        settlementSequence++;
        if (event.sessionHistorySettled.taskId === taskId) settlement = event.sessionHistorySettled;
        wake?.();
      }
      if (!valid()) {
        if (!signal.aborted && !scope.isInvalidated && !scope.isProjectSuspended(projectId) && !authRequestsPaused()) {
          const project = scope.getAuthorizedProject(projectId);
          if (project === null || project.summaries.has(taskId)) setState({ ...initial(), denied: true });
          else setState(old => old.owner === owner ? { ...old, page: null, first: null, error: new ApiError('server', 404), loading: false, checking: false, denied: true } : old);
          setLifecycle(value => value + 1);
        }
        return;
      }
      if (ticket === null) return;
      const observed = ++readSequence;
      void readCachedSessionHistory(scope, ticket, taskId, signal).then(cached => {
        if (!cached || observed !== readSequence || !valid()) return;
        const first = { items: cached.items, cursor: cached.nextCursor };
        const previous = stateRef.current;
        if (!cached.confirmedCompleteEmpty && first.cursor !== null && first.items.length === 0 && previous.owner === owner &&
          previous.page !== null && previous.page.items.length === 0 && previous.page.cursor === null && samePage(previous.first, first)) {
          if (!proofRefreshRequested) { proofRefreshRequested = true; setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); }
          return;
        }
        const page = cached.confirmedCompleteEmpty ? { items: [], cursor: null } : first;
        update(old => samePage(old.first, first) && !cached.confirmedCompleteEmpty ? old : { ...old, page, first, checking: false });
      }).catch(() => { /* Cache notifications are hints, not access grants. */ });
    });
    void (async () => {
      let token: string | null = null;
      let unreservedSnapshot: Awaited<ReturnType<typeof readSessionHistoryOwnership>> | null = null;
      let hasUnreservedSnapshot = false;
      let pagination: Awaited<ReturnType<typeof readSessionHistoryPaginationState>> = null;
      const requestedFirst = stateRef.current.first;
      let knownEmpty = stateRef.current.owner === owner && stateRef.current.page !== null && stateRef.current.page.items.length === 0 && stateRef.current.page.cursor === null;
      try {
        ticket = await scope.beginSync(projectId, signal);
        if (request.cursor !== null) {
          pagination = await beginSessionHistoryPagination(scope, ticket, taskId, signal);
          admitted = true; guard.current.generation = ticket.cacheGeneration;
          if (pagination === null || pagination.refreshing || pagination.page === null || !samePage(requestedFirst, { items: pagination.page.items, cursor: pagination.page.nextCursor })) {
            setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
          }
        }
        else {
          {
            const cached = await readCachedSessionHistory(scope, ticket, taskId, signal);
            admitted = true; guard.current.generation = ticket.cacheGeneration;
            if (cached && valid()) {
              const first = { items: cached.items, cursor: cached.nextCursor };
              knownEmpty = cached.confirmedCompleteEmpty || first.items.length === 0 && first.cursor === null || knownEmpty && samePage(stateRef.current.first, first);
              const page = cached.confirmedCompleteEmpty ? { items: [], cursor: null } : first;
              update(old => ({ ...old, page: cached.confirmedCompleteEmpty ? page : samePage(old.first, first) && old.page !== null ? old.page : page, first, checking: false }));
            }
          }
          while (valid()) {
            const observedSettlement = settlementSequence;
            const lease = await beginSessionHistoryRefresh(scope, ticket, taskId, signal);
            admitted = true; guard.current.generation = ticket.cacheGeneration;
            if (!valid()) return;
            if (lease === null) { update(old => ({ ...old, page: null, first: null, loading: false, checking: false, error: new ApiError('server', 404), denied: true })); return; }
            if (lease.kind === 'lease' && lease.acquired) { token = lease.token; ownedToken = token; ownedRefresh.current = token; leaseExpiresAt = lease.expiresAt; break; }
            update(old => ({ ...old, checking: false, loading: true, error: null }));
            await new Promise<void>(resolve => {
              const timer = setTimeout(done, Math.max(0, lease.expiresAt - Date.now()));
              function done() { clearTimeout(timer); signal.removeEventListener('abort', done); wake = null; resolve(); }
              wake = done;
              signal.addEventListener('abort', done, { once: true });
              if (signal.aborted || settlementSequence !== observedSettlement || lease.kind === 'lease' && settlement?.token === lease.token) done();
            });
            if (!valid()) return;
            const completed = settlement as { token: string; outcome: 'saved' | 'cancelled' | 'failed' } | null;
            settlement = null;
            if (lease.kind === 'lease' && completed?.token === lease.token && completed.outcome === 'failed') {
              retryPending.current = false; update(old => ({ ...old, checking: false, loading: false, error: new Error('Session history refresh failed.') })); return;
            }
            if (lease.kind === 'lease' && completed?.token === lease.token && completed.outcome === 'saved') {
              const cached = await readCachedSessionHistory(scope, ticket, taskId, signal);
              if (cached) {
                if (knownEmpty && cached.items.length === 0 && cached.nextCursor !== null && !cached.confirmedCompleteEmpty) continue;
                const first = { items: cached.items, cursor: cached.nextCursor };
                retryPending.current = false; successSequence.current++;
                const page = cached.confirmedCompleteEmpty ? { items: [], cursor: null } : first;
                update(old => ({ ...old, page: cached.confirmedCompleteEmpty ? page : samePage(old.first, first) ? old.page : first, first, checking: false, loading: false, error: null, denied: false }));
                return;
              }
            }
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          if (authRequestsPaused()) { void scope.ready(signal).then(() => setLifecycle(value => value + 1)).catch(() => {}); return; }
          if (!signal.aborted && !scope.isInvalidated && !scope.isProjectSuspended(projectId) && scope.canPreviewProject(projectId)) {
            waitingForAdmission = true;
            setState(old => ({ ...(old.owner === owner ? old : initial()), checking: false, loading: true }));
            const project = scope.getAuthorizedProject(projectId);
            if (project && ticket && project.manifest.cacheGeneration !== ticket.cacheGeneration) { waitingForAdmission = false; setLifecycle(value => value + 1); }
          }
          return;
        }
        // Preserve the observed token even when reservation or LRU maintenance cannot write.
        ticket ??= scope.getObservedHistoryTicket(projectId);
        if (ticket) {
          try {
            const observedSettlement = settlementSequence;
            await scope.sessionHistoryTransaction(ticket, signal, async () => undefined);
            unreservedSnapshot = await readSessionHistoryOwnership(scope, ticket, taskId, signal);
            hasUnreservedSnapshot = true; admitted = true; guard.current.generation = ticket.cacheGeneration;
            if (unreservedSnapshot.kind === 'task_absent') { update(old => ({ ...old, page: null, first: null, loading: false, checking: false, error: new ApiError('server', 404), denied: true })); return; }
            if (unreservedSnapshot.kind === 'present' && unreservedSnapshot.refreshing) {
              update(old => ({ ...old, checking: false, loading: true, error: null }));
              await new Promise<void>(resolve => {
                const timer = setTimeout(done, Math.max(0, (unreservedSnapshot?.kind === 'present' ? unreservedSnapshot.leaseExpiresAt ?? Date.now() : Date.now()) - Date.now()));
                function done() { clearTimeout(timer); signal.removeEventListener('abort', done); wake = null; resolve(); }
                wake = done; signal.addEventListener('abort', done, { once: true });
                if (signal.aborted || settlementSequence !== observedSettlement) done();
              });
              if (valid()) setRequest(old => ({ cursor: null, sequence: old.sequence + 1 }));
              return;
            }
          } catch (cause) { if (isAbortError(cause)) return; }
        }
        /* Storage is optional; an authenticated network request can still succeed. */
      }
      if (!valid()) return;
      update(old => ({ ...old, checking: false, loading: true, error: null }));
      try {
        const requestSignal = leaseExpiresAt === null ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, leaseExpiresAt - Date.now()))]);
        const initialResult = await api.history(request.cursor, requestSignal);
        let result = initialResult;
        let completeProof: boolean | undefined;
        if (request.cursor === null && (knownEmpty || automatic) && result.items.length === 0 && result.nextCursor !== null) {
          const visited = new Set<string>();
          while (result.items.length === 0 && result.nextCursor !== null) {
            if (visited.has(result.nextCursor)) throw new ApiError('protocol');
            visited.add(result.nextCursor);
            result = await api.history(result.nextCursor, requestSignal);
            if (!valid()) return;
          }
          completeProof = result.items.length === 0 && result.nextCursor === null;
        }
        if (!valid()) return;
        if (token === null && pagination === null) {
          try {
            const observed = ticket ?? scope.getObservedHistoryTicket(projectId) ?? await scope.beginSync(projectId, signal);
            await scope.sessionHistoryTransaction(observed, signal, async () => undefined);
            if (hasUnreservedSnapshot) {
              const latest = await readSessionHistoryOwnership(scope, observed, taskId, signal);
              const previous = unreservedSnapshot?.kind === 'present' ? unreservedSnapshot : null;
              const current = latest.kind === 'present' ? latest : null;
              if (latest.kind !== unreservedSnapshot?.kind || current?.refreshing || (current?.token ?? null) !== (previous?.token ?? null) ||
                (current?.paginationToken ?? null) !== (previous?.paginationToken ?? null) ||
                (current?.leaseExpiresAt ?? null) !== (previous?.leaseExpiresAt ?? null)) {
                update(old => ({ ...old, loading: false })); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
              }
            }
            update(old => ({ ...old, checking: false, loading: false, error: new Error('Session history storage is unavailable.') })); return;
          } catch (cause) {
            if (isAbortError(cause)) {
              update(old => ({ ...old, checking: false, loading: false, error: new Error('Session history admission changed.') })); return;
            }
          }
        }
        if (request.cursor !== null && ticket && pagination) {
          try {
            const latest = await readSessionHistoryPaginationState(scope, ticket, taskId, signal);
            if (latest && !latest.refreshing && latest.token === pagination.token && latest.paginationToken !== pagination.paginationToken) {
              update(old => ({ ...old, loading: false, error: new Error('Session history pagination was superseded.') })); return;
            }
            if (!latest || latest.refreshing || latest.token !== pagination.token || latest.page === null || !samePage(requestedFirst, { items: latest.page.items, cursor: latest.page.nextCursor })) {
              update(old => ({ ...old, loading: false })); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
            }
          } catch (error) { if (isAbortError(error)) return; }
        }
        if (request.cursor === null && ticket && token) {
          try {
            if (!await saveSessionHistory(scope, ticket, taskId, initialResult, token, signal, completeProof)) { update(old => ({ ...old, loading: false })); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return; }
            ownedToken = null; ownedRefresh.current = null;
          } catch (error) {
            if (isAbortError(error)) return;
            if (leaseExpiresAt !== null && Date.now() >= leaseExpiresAt) { setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return; }
            if (ownedToken) { void releaseSessionHistoryRefresh(scope, ticket, taskId, ownedToken, 'failed', scope.signal).catch(() => {}); ownedToken = null; ownedRefresh.current = null; }
            try {
              await scope.sessionHistoryTransaction(ticket, signal, async () => undefined);
              update(old => ({ ...old, checking: false, loading: false, error: new Error('Session history storage is unavailable.') })); return;
            } catch (cause) { if (isAbortError(cause)) return; }
            /* Fully unavailable storage cannot fence another tab; use the accepted fallback. */
          }
        }
        if (request.cursor !== null && ticket && pagination && pagination.paginationToken && requestedFirst) {
          const existingItems = stateRef.current.page?.items ?? [];
          try {
            if (!await completeSessionHistoryPagination(scope, ticket, taskId, { items: requestedFirst.items, nextCursor: requestedFirst.cursor }, pagination.token, pagination.paginationToken,
              requestedFirst.items.length === 0 && requestedFirst.cursor !== null ? (result.items.length !== 0 || existingItems.length !== 0 ? false : result.nextCursor === null ? true : null) : null, signal)) {
              const latest = await readSessionHistoryPaginationState(scope, ticket, taskId, signal);
              if (latest && !latest.refreshing && latest.token === pagination.token && latest.paginationToken !== pagination.paginationToken) {
                update(old => ({ ...old, loading: false, error: new Error('Session history pagination was superseded.') })); return;
              }
              update(old => ({ ...old, loading: false })); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
            }
          } catch (error) {
            if (isAbortError(error)) return;
            try {
              await scope.sessionHistoryTransaction(ticket, signal, async () => undefined);
              update(old => ({ ...old, loading: false, error: new Error('Session history storage is unavailable.') })); return;
            } catch (cause) { if (isAbortError(cause)) return; }
          }
        }
        if (!valid()) return;
        ++readSequence; retryPending.current = false; if (request.cursor === null) successSequence.current++;
        const first = { items: initialResult.items, cursor: initialResult.nextCursor };
        const refreshedPage = { items: result.items, cursor: result.nextCursor };
        update(old => {
          if (request.cursor === null) {
            return { ...old, page: completeProof !== undefined ? refreshedPage : samePage(old.first, first) ? old.page : first, first, loading: false, checking: false, error: null, denied: false };
          }
          if (requestedFirst === null || !samePage(old.first, requestedFirst)) return { ...old, loading: false };
          const items = old.page?.items ?? [];
          return { ...old, page: { items: [...items, ...result.items.filter(item => !items.some(previous => previous.sessionId === item.sessionId))], cursor: result.nextCursor }, loading: false, error: null, denied: false };
        });
      } catch (error) {
        if (!valid()) return;
        const denied = error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0);
        const unreserved = token === null && pagination === null;
        if (denied && (!ticket || unreserved && !hasUnreservedSnapshot)) {
          const observed = ticket ?? scope.getObservedHistoryTicket(projectId);
          if (observed) await scope.reportHistoryUncertain(observed, taskId, null, scope.signal, true).catch(() => {});
        }
        if (denied && ticket && (!unreserved || hasUnreservedSnapshot)) {
          try {
            const previous = unreservedSnapshot?.kind === 'present' ? unreservedSnapshot : null;
            const expectedToken = unreserved ? previous?.token ?? null : request.cursor === null ? token : pagination?.token ?? null;
            const expectedPagination = unreserved ? previous?.paginationToken ?? null : request.cursor === null ? undefined : pagination?.paginationToken ?? undefined;
            if (!await clearSessionHistory(scope, ticket, taskId, expectedToken, signal, expectedPagination, unreserved ? previous?.leaseExpiresAt ?? null : undefined)) {
              if (pagination) {
                const latest = await readSessionHistoryPaginationState(scope, ticket, taskId, signal);
                if (latest && !latest.refreshing && latest.token === pagination.token && latest.paginationToken !== pagination.paginationToken) {
                  update(old => ({ ...old, loading: false, error: new Error('Session history pagination was superseded.') })); return;
                }
              }
              update(old => ({ ...old, loading: false })); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
            }
          }
          catch (cause) { if (isAbortError(cause)) return; }
        } else if (ticket && pagination) {
          try { const latest = await readSessionHistoryPaginationState(scope, ticket, taskId, signal); if (!latest || latest.refreshing || latest.token !== pagination.token || latest.paginationToken !== pagination.paginationToken) { update(old => ({ ...old, loading: false })); return; } }
          catch (cause) { if (isAbortError(cause)) return; }
        }
        retryPending.current = false;
        if (denied) blocked.current = true;
        if (ownedToken && ticket && !denied && !signal.aborted) {
          try {
            if (!await releaseSessionHistoryRefresh(scope, ticket, taskId, ownedToken, 'failed', scope.signal)) {
              ownedToken = null; ownedRefresh.current = null; setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); return;
            }
          } catch (cause) { if (isAbortError(cause)) return; }
          ownedToken = null; ownedRefresh.current = null;
        }
        update(old => ({ ...old, ...(denied ? { page: null, first: null } : {}), error, loading: false, checking: false, denied: denied || old.denied }));
      }
    })();
    return () => { if (ownedRefresh.current === ownedToken) ownedRefresh.current = null; controller.abort(); wake?.(); unsubscribe(); scope.signal.removeEventListener('abort', abort); if (ownedToken && ticket && !scope.isInvalidated) void releaseSessionHistoryRefresh(scope, ticket, taskId, ownedToken, 'cancelled', scope.signal).catch(() => {}); };
  }, [api, scope, projectId, taskId, active, request, lifecycle, owner, automatic]);
  const page = current.page ?? { items: [], cursor: null };
  const confirmedEmpty = current.page !== null && page.items.length === 0 && page.cursor === null;
  return { api, scope, ...page, error: current.error, loading: current.loading, checking: current.checking,
    confirmedEmpty, denied: scope.isInvalidated || scope.isProjectSuspended(projectId) || current.denied, refresh: () => { interaction.current++; retryPending.current = true; blocked.current = false; setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); },
    more: () => { if (page.cursor !== null) setRequest(old => ({ cursor: page.cursor, sequence: old.sequence + 1 })); } };
}

function recordLabel(item: SessionHistoryItem): string {
  return `${item.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')} · ${item.agentControlMode === 'herdr' ? 'Herdr' : 'Web'}`;
}
/** Resolve presence without requiring the Session tab to be selected. */
export function useTaskSessionRecords(projectId: string, taskId: string, active: boolean, direct = false, automatic = true) {
  const summary = useRecords(projectId, taskId, active && !direct, true);
  const observed = useDirectSessionRecords(projectId, taskId, active && direct, automatic);
  return direct ? observed : summary;
}
type SessionHostProps = ScopeProps & {
  readonly current: boolean; readonly completed?: boolean;
  readonly records?: ReturnType<typeof useTaskSessionRecords>;
} & ({ readonly claimId: string; readonly ownerUserId: string; readonly mode: 'web' | 'herdr' } | { readonly claimId?: never; readonly ownerUserId?: never; readonly mode?: never });
export function TaskSessionHost(props: SessionHostProps) {
  return props.direct ? <DirectSessionHost {...props} /> : <SummarySessionHost {...props} />;
}
function DirectSessionHost(props: SessionHostProps) {
  const localRecords = useDirectSessionRecords(props.projectId, props.taskId, props.records === undefined && props.claimId === undefined && props.active && props.current, true);
  const sessions = useTaskDetailSessions();
  const presentationCurrent = sessions.directSessionCurrent(props.projectId, props.taskId, true);
  return <SessionHostContent {...props} history={props.records ?? localRecords} presentationCurrent={presentationCurrent} />;
}
function SummarySessionHost(props: SessionHostProps) {
  const localRecords = useRecords(props.projectId, props.taskId, props.records === undefined && props.claimId === undefined && props.active && props.current, true);
  return <SessionHostContent {...props} history={props.records ?? localRecords} presentationCurrent={props.current} />;
}
function SessionHostContent({ projectId, taskId, claimId, ownerUserId, mode, active, current, completed = false, direct = false, history, presentationCurrent }: SessionHostProps & { readonly history: Records; readonly presentationCurrent: boolean }) {
  const m = useTerminalHostMessages();
  useLayoutEffect(() => {
    try { sessionStorage.removeItem(`daynight:recording:${history.scope.userId}:${projectId}:${taskId}`); } catch { /* Storage is optional. */ }
  }, [history.scope, projectId, taskId]);
  const sessionKey = `${history.scope.userId}/${projectId}/${taskId}/${claimId}`;
  if (claimId !== undefined && mode !== undefined && !completed) return <div className="task-session-host"><div className="task-session-current">
    {mode === 'web' ? <TaskAgentSession key={sessionKey} projectId={projectId} taskId={taskId} claimId={claimId} ownerUserId={ownerUserId} active={active} current={current} /> : <TerminalSessionView key={sessionKey} projectId={projectId} api={history.api} claimId={claimId} active={active} current={current} />}
  </div></div>;
  if (history.denied && (direct || claimId === undefined)) return <div className="task-session-host"><p className="session-error" role="alert">{recordingError(history.error ?? new ApiError('server', 403), m)} <button className="button" disabled={history.loading || !current} onClick={history.refresh}>{m.refresh}</button></p></div>;
  if (claimId !== undefined) return <CompletedSessionContent projectId={projectId} taskId={taskId} claimId={claimId} mode={mode} active={active} current={current} presentationCurrent={presentationCurrent} history={history} />;
  const item = history.items[0] ?? null;
  const error = history.error;
  const loading = history.loading || history.checking;
  const refresh = history.refresh;
  return <div className="task-session-host">
    {error ? <p className="session-error" role="alert">{recordingError(error, m, direct)} <button className="button" disabled={loading || !current} onClick={refresh}>{m.refresh}</button></p> : null}
    {item ? <FixedSessionRecording key={`${item.sessionId}/${item.executionGeneration}`} projectId={projectId} api={history.api} item={item} active={active && presentationCurrent} current={current} /> : !error ? <div className="session-empty" role="status"><p>{loading ? m.loading : m.empty}</p></div> : null}
  </div>;
}
function CompletedSessionContent({ projectId, taskId, claimId, mode, active, current, presentationCurrent, history }: { readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly mode: 'web' | 'herdr' | undefined; readonly active: boolean; readonly current: boolean; readonly presentationCurrent: boolean; readonly history: Records }) {
  const m = useTerminalHostMessages();
  const resolved = useCompletedTaskSession({ projectId, taskId, claimId, mode, api: history.api, active: active && current });
  return <div className="task-session-host">
    {resolved.error ? <p className="session-error" role="alert">{recordingError(resolved.error, m)} <button className="button" disabled={resolved.loading || !current} onClick={resolved.refresh}>{m.refresh}</button></p> : null}
    {resolved.item ? <FixedSessionRecording key={`${resolved.item.sessionId}/${resolved.item.executionGeneration}`} projectId={projectId} api={history.api} item={resolved.item} active={active && presentationCurrent} current={current} preparing={resolved.preparing} /> : !resolved.error ? <div className="session-empty" role="status"><p>{resolved.loading ? m.loading : resolved.availability === 'not_registered' ? m.notRegistered : m.unavailable}</p>{!resolved.loading ? <button className="button" disabled={!current} onClick={resolved.refresh}>{m.refresh}</button> : null}</div> : null}
  </div>;
}
type ManagedRecordsProps = ScopeProps & { readonly resetSelection?: object; readonly records?: Records; readonly children: (records: AttachmentRecordSlots) => ReactNode };
export function ManagedSessionRecords(props: ManagedRecordsProps) {
  return props.direct ? <DirectManagedRecords {...props} /> : <SummaryManagedRecords {...props} />;
}
function DirectManagedRecords(props: ManagedRecordsProps) {
  const history = useDirectSessionRecords(props.projectId, props.taskId, props.active && props.records === undefined);
  return <ManagedRecordsContent {...props} history={props.records ?? history} />;
}
function SummaryManagedRecords(props: ManagedRecordsProps) {
  const history = useRecords(props.projectId, props.taskId, props.active);
  return <ManagedRecordsContent {...props} history={history} />;
}
function ManagedRecordsContent({ projectId, taskId, active, direct, resetSelection, children, history }: ManagedRecordsProps & { readonly history: Records }) {
  const m = useTerminalHostMessages();
  const [selection, setSelection] = useState<{ scope: typeof history.scope; projectId: string; taskId: string; item: SessionHistoryItem | null }>(() => ({ scope: history.scope, projectId, taskId, item: null }));
  const selected = selection.scope === history.scope && selection.projectId === projectId && selection.taskId === taskId && !history.denied ? selection.item : null;
  const setSelected = (item: SessionHistoryItem | null) => setSelection({ scope: history.scope, projectId, taskId, item });
  useLayoutEffect(() => { setSelection({ scope: history.scope, projectId, taskId, item: null }); }, [resetSelection, history.scope, projectId, taskId]);
  useLayoutEffect(() => { if (history.denied) setSelection({ scope: history.scope, projectId, taskId, item: null }); }, [history.denied, history.scope, projectId, taskId]);
  const clearSelection = () => setSelected(null);
  const sidebar = history.checking ? null : history.confirmedEmpty ? (history.error ? <div className="session-error" role="alert">{recordingError(history.error, m, direct)} <button className="button" onClick={history.refresh}>{m.refresh}</button></div> : null) : <section className="managed-session-records" aria-label={m.records}>
    <div className="terminal-host-toolbar"><h4>{m.records}</h4><button className="button" disabled={history.loading} onClick={history.refresh}>{m.refresh}</button></div>
    {history.error ? <p role="alert" className="session-error">{recordingError(history.error, m, direct)}</p> : null}
    {history.loading && history.items.length === 0 ? <p role="status">{m.loading}</p> : null}
    <ul className="managed-session-list">{history.items.map(item => <li key={item.sessionId}><button className="button" aria-pressed={selected?.sessionId === item.sessionId} onClick={() => setSelected(item)}>{recordLabel(item)} · {m[item.archive.state === 'ready' ? 'readonly' : item.archive.state]}</button></li>)}</ul>
    {history.cursor ? <button className="button" disabled={history.loading} onClick={history.more}>{m.more}</button> : null}
  </section>;
  const preview = selected && !history.denied ? <><div className="managed-recording-close"><button className="button" onClick={clearSelection}>{m.close}</button></div><FixedSessionRecording key={`${selected.sessionId}/${selected.executionGeneration}`} projectId={projectId} api={history.api} item={selected} active={active} /></> : null;
  return children({ sidebar, preview, clearSelection });
}
export function FixedSessionRecording({ api, item, active, projectId, current = true, preparing = false }: { readonly api: TerminalSessionApi; readonly item: SessionRecordingReference; readonly active: boolean; readonly projectId?: string; readonly current?: boolean; readonly preparing?: boolean }) {
  const scope = useTaskCacheScope(); const m = useTerminalHostMessages(); const sm = useSessionMessages();
  const owner = useMemo(() => ({}), [scope, api, item.sessionId, item.claimId, item.executionGeneration, item.agentControlMode]);
  const [revision, refresh] = useState(0);
  type Loaded = { terminal?: SessionV2Archive; native?: LoadedSessionArchive; nativeRevision?: string; status: string };
  const [state, setState] = useState<{ owner: object; loaded: Loaded | null; error: unknown; loading: boolean; referenceKey?: string }>({ owner, loaded: null, error: null, loading: false });
  const view = state.owner === owner ? state : { owner, loaded: null, error: null, loading: false };
  const identity = useRef({});
  const fullscreen = useSessionFullscreen({ client: identity.current, userId: scope.userId, identity: item.sessionId, active });
  const display = useSessionDisplayPreference({ userId: scope.userId, sessionId: item.sessionId });
  const [displayOpen, setDisplayOpen] = useState(false);
  const nativeResources = useRef<(() => Promise<void>) | null>(null);
  const denyResources = useCallback((error: unknown) => {
    void nativeResources.current?.();
    setState({ owner, loaded: null, error, loading: false });
  }, [owner]);
  useEffect(() => { setDisplayOpen(false); }, [owner, active]);
  const readCurrent = current || active && authRequestsPaused();
  const referenceKey = JSON.stringify([item.sessionId, item.claimId, item.executionGeneration, item.agentControlMode, item.archive]);
  const reference = useMemo(() => item, [referenceKey]);
  useEffect(() => {
    const revoke = () => denyResources(new ApiError('server', 403));
    scope.signal.addEventListener('abort', revoke);
    const unsubscribe = scope.subscribe(event => {
      if (projectId !== undefined && event.projectId !== projectId) return;
      if (event.accessRevoked || event.scopeSuspended) revoke();
      else if (event.accessRestored) refresh(value => value + 1);
    });
    return () => { scope.signal.removeEventListener('abort', revoke); unsubscribe(); };
  }, [denyResources, projectId, scope]);
  useEffect(() => {
    if (!active || !readCurrent || scope.isInvalidated || projectId !== undefined && scope.isProjectSuspended(projectId)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(); scope.signal.addEventListener('abort', abort);
    const unsubscribe = scope.subscribe(event => { if ((projectId === undefined || event.projectId === projectId) && (event.accessRevoked || event.scopeSuspended)) abort(); });
    setState(old => ({ owner, loaded: old.owner === owner ? old.loaded : null, error: null, loading: true, ...(old.referenceKey === undefined ? {} : { referenceKey: old.referenceKey }) }));
    void (async () => {
      await scope.ready(controller.signal);
      let loaded: Loaded;
      if (reference.agentControlMode === 'herdr') {
        const result = await api.archive(reference, controller.signal);
        loaded = { status: result.status.payload.state, ...(result.archive ? { terminal: result.archive } : {}) };
      } else {
        const result = await api.nativeArchive(reference, controller.signal);
        if (result.archive && (result.status.state !== 'ready' || !result.status.sha256)) throw new ApiError('protocol');
        loaded = { status: result.status.state, ...(result.archive ? { native: result.archive, nativeRevision: result.status.sha256! } : {}) };
      }
      await scope.ready(controller.signal);
      if (controller.signal.aborted || scope.isInvalidated || projectId !== undefined && scope.isProjectSuspended(projectId)) return;
      setState(old => ({ owner, loaded: old.owner === owner && old.loaded?.status === 'ready' && loaded.status === 'ready' && old.referenceKey === referenceKey && old.loaded.nativeRevision === loaded.nativeRevision ? old.loaded : loaded, error: null, loading: false, referenceKey }));
      if (loaded.status === 'pending' || loaded.status === 'unavailable' && preparing) timer = setTimeout(() => refresh(value => value + 1), 3000);
    })().catch(error => {
      if (controller.signal.aborted) return;
      const denied = error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0);
      if (denied) { denyResources(error); return; }
      setState(old => ({ owner, loaded: !denied && old.owner === owner ? old.loaded : null, error, loading: false }));
    });
    return () => { controller.abort(); clearTimeout(timer); unsubscribe(); scope.signal.removeEventListener('abort', abort); };
  }, [api, reference, referenceKey, active, readCurrent, revision, scope, owner, projectId, preparing, denyResources]);
  const loaded = view.loaded;
  const refreshBindings = useCallback(() => refresh(value => value + 1), []);
  const invalidImageBindings = useInvalidImageBindings(owner, loaded?.nativeRevision ?? null, loaded?.native?.entries ?? [], active && current && !view.loading && !scope.isInvalidated && !authRequestsPaused() && (projectId === undefined || !scope.isProjectSuspended(projectId)), refreshBindings);
  const provider = loaded?.native?.provider;
  const native = item.agentControlMode === 'web';
  return <section ref={fullscreen.sectionRef} className={`task-agent-session${native ? ' session-default-header-layout' : ' terminal-session'}${fullscreen.fullscreen ? ' session-fullscreen' : ''}`} onKeyDown={fullscreen.onKeyDown}>
    <header className="session-header session-header-default"><div className="session-header-identity"><strong className="session-provider">{provider === 'claude' ? 'Claude Code' : provider === 'copilot' ? 'GitHub Copilot' : provider === 'codex' ? 'Codex' : m.readonly}</strong>{provider ? <span className="session-status offline" role="status" lang="en">{sessionNativeLabels.archived}</span> : null}</div><div className="session-header-actions">
      {native ? <SessionDisplayMenu mode={display.mode} issue={display.issue} onModeChange={display.setMode} onRetrySave={display.retrySave} open={active && displayOpen} onOpenChange={setDisplayOpen} /> : null}
      <button ref={fullscreen.buttonRef} className="button session-fullscreen-toggle" aria-label={fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen} title={fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen} aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.fullscreen ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} /></svg>
        <span className="session-fullscreen-tooltip" aria-hidden="true">{fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen}</span>
      </button>
      <button className="button session-refresh-toggle" aria-label={m.refresh} disabled={view.loading || !active || !current || authRequestsPaused()} onClick={() => refresh(value => value + 1)}>
        <span className="session-refresh-label">{m.refresh}</span><svg className="session-refresh-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg><span className="session-refresh-tooltip" aria-hidden="true">{m.refresh}</span>
      </button>
    </div></header>
    {view.error ? <p role="alert" className="session-error">{recordingError(view.error, m)}</p> : null}
    {loaded?.terminal ? <TerminalRecordingView archive={loaded.terminal} active={active} /> : loaded?.native ? <NativeRecording archive={loaded.native} archiveRevision={loaded.nativeRevision!} api={api} projectId={projectId} rootRef={fullscreen.sectionRef} resourcesRef={nativeResources} onDenied={denyResources} onInvalidImageBindings={invalidImageBindings} active={active} displayMode={display.mode} current={current} /> : !view.error ? <p role="status">{!loaded ? m.loading : loaded.status === 'unavailable' && preparing ? sm.archivePreparing : m[loaded.status === 'pending' ? 'pending' : loaded.status === 'failed' ? 'failed' : 'unavailable']}</p> : null}
  </section>;
}
function NativeRecording({ archive, archiveRevision, api, projectId, rootRef, resourcesRef, onDenied, onInvalidImageBindings, active, displayMode, current }: {
  readonly onInvalidImageBindings: InvalidImageBindings;
  readonly archive: LoadedSessionArchive; readonly archiveRevision: string; readonly api: TerminalSessionApi; readonly projectId: string | undefined;
  readonly rootRef: RefObject<HTMLElement | null>; readonly resourcesRef: RefObject<(() => Promise<void>) | null>; readonly onDenied: (error: unknown) => void;
  readonly active: boolean; readonly displayMode: SessionDisplayMode; readonly current: boolean;
}) {
  const authority = useTaskCacheScope();
  const admission = useRef({ active, current }); admission.current = { active, current };
  const generation = readAuthRequestGeneration();
  const lifetime = useMemo(() => {
    let retired = false, draining: Promise<void> | null = null;
    let reader: ReturnType<TerminalSessionApi['resources']> | null = null;
    const admitted = () => !retired && admission.current.active && admission.current.current && !authority.isInvalidated && !authRequestsPaused() && readAuthRequestGeneration() === generation && (projectId === undefined || !authority.isProjectSuspended(projectId));
    const read = async (id: string, signal: AbortSignal, onProgress?: () => void): Promise<Blob> => {
      signal.throwIfAborted();
      if (!admitted()) throw new ImageFailure('access_pending', 'Archived resource access is being checked.');
      try {
        let blob: Blob;
        if (archive.schemaVersion === 3) {
          const item = archive.resources.find(value => value.resource.resourceId === id);
          if (!item || item.blobId === null) throw new Error('Archived resource unavailable.');
          reader ??= api.resources(sessionFence(archive), admitted);
          const bytes = await reader.readResource(item.resource, signal, onProgress);
          blob = new Blob([bytes], { type: item.resource.mediaType ?? 'application/octet-stream' });
        } else {
          const item = archive.resources.find(value => value.resource.resourceId === id);
          if (!item || item.data === null) throw new Error('Archived resource unavailable.');
          blob = new Blob([Uint8Array.from(atob(item.data), char => char.charCodeAt(0))], { type: item.resource.mediaType ?? 'application/octet-stream' });
          onProgress?.();
        }
        signal.throwIfAborted();
        if (!admitted()) throw new ImageFailure('access_pending', 'Archived resource access is being checked.');
        return blob;
      } catch (error) {
        if (!retired && error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0)) { void close(); onDenied(error); }
        throw error;
      }
    };
    const images = pageImageStore.createScope({ identity: {
      serverOrigin: window.location.origin, actorUserId: authority.userId, authorizationGeneration: String(generation + 1),
      owner: { kind: 'record', recordId: archive.sessionId, namespace: JSON.stringify(['task-record', projectId ?? null, sessionFenceKey(archive)]), revision: archiveRevision },
    }, read, canRead: admitted, canDownload: admitted });
    function close(): Promise<void> {
      if (draining) return draining;
      retired = true;
      const invalidated = images.invalidate();
      const stopped = reader?.close() ?? Promise.resolve();
      draining = Promise.allSettled([invalidated, stopped]).then(() => {});
      return draining;
    }
    return { images, read, close };
  }, [api, archive, archiveRevision, authority, generation, onDenied, projectId]);
  useLayoutEffect(() => {
    resourcesRef.current = lifetime.close;
    return () => { if (resourcesRef.current === lifetime.close) resourcesRef.current = null; void lifetime.close(); };
  }, [lifetime, resourcesRef]);
  const state = useMemo(() => ({ ...emptySessionState(), entries: archive.entries, resources: new Map(archive.resources.map(item => [item.resource.resourceId, item.resource])) }), [archive]);
  return <SessionImageScope scope={lifetime.images} rootRef={rootRef} active={active} readAdmitted={current && !authRequestsPaused()}>
    <SessionTimeline state={state} active={active} displayMode={displayMode} canRespond={false} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} historyReady historyComplete recordIdentity={{ scope: lifetime.images.key, historyEpoch: archiveRevision }} onLoadResource={lifetime.read} onInvalidImageBindings={onInvalidImageBindings} />
  </SessionImageScope>;
}

function recordingError(error: unknown, m: ReturnType<typeof useTerminalHostMessages>, direct = false): string {
  if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0) && (!direct || error.kind === 'server' || error instanceof SessionDenialProtocolError)) return m.permission;
  if (error instanceof ApiError && ['unsupported_protocol', 'unsupported_content_kind'].includes(error.code)) return m.unsupported;
  return m.error;
}
