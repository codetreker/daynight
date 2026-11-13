import { useCallback, useEffect, useRef, useState } from "react";
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
  const read = useCallback(async (retried = false, automatic = false): Promise<void> => {
    if (automatic && active.current !== null) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, session.scope.signal]);
    const generation = ++sequence.current;
    const revision = session.scope.getProjectRevision(projectId);
    const admission = session.scope.getAdmissionRevision(projectId);
    let ticket = 0;
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
      const project = await getProject(projectId, signal, { userId: session.scope.userId, onPrincipalMismatch: session.scope.principalMismatch });
      await session.scope.ready(signal);
      if (current() && session.publishProjectRead(ticket)) setState({ session, projectId, project, error: null });
      else retrySuperseded();
    } catch (error) {
      if (isAbortError(error)) return;
      if (!current()) { retrySuperseded(); return; }
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
        if (!session.withdrawProjectRead(ticket, historyTicket, error)) retrySuperseded();
        return;
      }
      setState(previous => ({ session, projectId, project: previous.session === session && previous.projectId === projectId ? previous.project : null, error }));
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [projectId, session]);
  useEffect(() => {
    void session.revalidate();
    void read();
    const unsubscribeRetry = session.subscribeProjectReadRetry(() => { void read(); });
    const unsubscribe = session.scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked && !session.isProjectReadCleanupFailure(event)) {
        ++sequence.current; active.current?.abort();
        setState({ session, projectId, project: null, error: event.error ?? null });
      }
    });
    const refresh = () => { if (document.visibilityState !== "hidden") void read(false, true); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      ++sequence.current; active.current?.abort(); unsubscribe(); unsubscribeRetry(); clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [projectId, session, read]);
  useEffect(() => {
    if (access.status === "ready") void read(false, true);
  }, [access.status, read]);
  const retry = useCallback(() => { void session.revalidate(); void read(); }, [session, read]);
  const currentState = state.session === session && state.projectId === projectId ? state : null;
  const project = session.canObserveProjectRead() && !session.scope.isInvalidated ? currentState?.project ?? null : null;
  return { project, error: currentState?.error ?? (access.status === "unavailable" || access.status === "error" && project === null ? access.error : null), retry };
};
