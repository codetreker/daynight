import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, isAbortError } from "../../api/client";
import { getProject } from "../../api/project-settings";
import type { Project } from "../../api/types";
import { useProjectAccess } from "./ProjectAccess";

// Project metadata has its own lifecycle; task-sync availability must not gate it.
export const useProjectPageRead = (projectId: string) => {
  const access = useProjectAccess(projectId);
  const { session } = access;
  const [state, setState] = useState<{ session: typeof session; projectId: string; project: Project | null; error: unknown }>({ session, projectId, project: null, error: null });
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const directRecheck = useMemo(() => ({ pending: false }), [session, projectId]);
  const read = useCallback(async (retried = false, automatic = false): Promise<void> => {
    if (directRecheck.pending) return;
    if (automatic && active.current !== null && !active.current.signal.aborted) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, session.scope.signal]);
    const generation = ++sequence.current;
    const revision = session.scope.getProjectRevision(projectId);
    const admission = session.scope.getAdmissionRevision(projectId);
    let ticket = 0;
    let projectReadRevision = session.scope.getProjectReadRevision(projectId);
    let projectRead: symbol | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const deadlineAbort = new AbortController();
    let historyTicket: ReturnType<typeof session.scope.getObservedHistoryTicket> = null;
    const current = () => !signal.aborted && generation === sequence.current && !session.scope.isInvalidated
      && revision === session.scope.getProjectRevision(projectId) && admission === session.scope.getAdmissionRevision(projectId)
      && session.canObserveProjectRead();
    const retrySuperseded = () => {
      if (!retried && !signal.aborted && generation === sequence.current && !session.scope.isInvalidated
        && session.canObserveProjectRead()) void read(true);
    };
    try {
      await session.scope.ready(signal);
      if (!current()) return;
      historyTicket = session.scope.getObservedHistoryTicket(projectId);
      ticket = session.beginObservation();
      projectReadRevision = session.scope.getProjectReadRevision(projectId);
      projectRead = session.beginProjectRead();
      let expire!: (error: unknown) => void;
      const timeout = new Promise<never>((_, reject) => { expire = reject; });
      const dispatch = () => {
        deadline = setTimeout(() => {
          deadlineAbort.abort();
          expire(new ApiError("network", null, "network", null, new Error("Project read timed out.")));
        }, 60_000);
      };
      const project = await Promise.race([getProject(projectId, AbortSignal.any([signal, deadlineAbort.signal]),
        { userId: session.scope.userId, onPrincipalMismatch: session.scope.principalMismatch }, dispatch), timeout]);
      await session.scope.ready(signal);
      if (current() && session.publishProjectRead(ticket)) setState({ session, projectId, project, error: null });
      else retrySuperseded();
    } catch (error) {
      if (isAbortError(error)) return;
      if (!current()) {
        if (!signal.aborted && generation === sequence.current && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") session.requireProjectReadRecheck();
        retrySuperseded(); return;
      }
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
        if (projectReadRevision !== session.scope.getProjectReadRevision(projectId) || !session.withdrawProjectRead(ticket, historyTicket, error)) {
          session.requireProjectReadRecheck();
          retrySuperseded();
        }
        return;
      }
      setState(previous => ({ session, projectId, project: previous.session === session && previous.projectId === projectId ? previous.project : null, error }));
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      deadlineAbort.abort();
      if (projectRead !== null) session.endProjectRead(projectRead);
      if (active.current === controller) active.current = null;
    }
  }, [projectId, session, directRecheck]);
  useEffect(() => {
    void session.revalidate();
    void read();
    const unsubscribeRetry = session.subscribeProjectReadRetry(automatic => { if (!automatic) session.scope.retryProjectVerification(projectId); void read(false, automatic); });
    const withdraw = (error: unknown) => {
      ++sequence.current; active.current?.abort();
      setState({ session, projectId, project: null, error });
    };
    const unsubscribeWithdrawal = session.subscribeProjectReadWithdrawal(() => withdraw(null));
    const unsubscribe = session.scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.directAccessUncertain) { directRecheck.pending = true; withdraw(event.error ?? null); return; }
      if (event.directAccessRecheck && event.error === undefined) { directRecheck.pending = false; void read(false, true); }
      else if (event.directAccessRecheck) {
        if (event.error instanceof ApiError && event.error.kind === "server" && event.error.status === 404 && event.error.code === "not_found") directRecheck.pending = false;
        setState({ session, projectId, project: null, error: event.error });
      }
      if (event.accessRevoked && !session.isProjectReadCleanupFailure(event)) withdraw(event.error ?? null);
    });
    const refresh = () => { if (document.visibilityState !== "hidden") void read(false, true); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      ++sequence.current; active.current?.abort(); unsubscribe(); unsubscribeRetry(); unsubscribeWithdrawal(); clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [projectId, session, read, directRecheck]);
  useEffect(() => {
    if (access.status === "ready") void read(false, true);
  }, [access.status, read, session]);
  const retry = useCallback(() => { session.scope.retryProjectVerification(projectId); void session.revalidate(); void read(); }, [session, projectId, read]);
  const currentState = state.session === session && state.projectId === projectId ? state : null;
  const project = session.canObserveProjectRead() && !session.scope.isInvalidated ? currentState?.project ?? null : null;
  return { project, error: currentState?.error ?? (access.status === "unavailable" || access.status === "error" && project === null ? access.error : null), retry };
};
