import { useProjectAccessSession } from "./ProjectAccess";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, authRequestsPauseRevision, getTaskSync, isAbortError } from "../../api/client";
import { pollingInterval } from "../../app/polling";
import type { TaskGraph, TaskSummary, WorkerClaim } from "../../api/types";
import type { GraphIndex } from "../task-graph/model";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { taskCacheFailureDiagnostic } from "../task-cache/diagnostics";
import type { CachedProject, TaskSyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { deriveTaskSyncBindings } from "../task-cache/execution-binding";
import { TaskSessionSummaryStore } from "../task-session-summary/store";
import { useOptionalTaskDetailSessions } from '../task-detail/TaskDetailSession';
import { projectCommittedTasks, type CommittedTaskProjection } from './committed-task-projection';

const emptyCommitted: ReadonlyMap<string, CommittedTaskProjection> = new Map();

export type GraphSnapshot = {
  readonly graph: TaskGraph;
  readonly index: GraphIndex;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly pausedTaskIds: ReadonlySet<string>;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, "state" | "machine">>;
} & ({
  readonly observedAt: string;
  readonly receivedMonotonic: number;
  readonly receivedAt: number;
  readonly revision: number;
} | {
  readonly observedAt: null;
  readonly receivedMonotonic: number;
  readonly receivedAt: null;
  readonly revision: 0;
  readonly localTime: number;
});

type GraphState = {
  readonly projectId: string;
  readonly scope: TaskCacheScope;
  readonly snapshot: GraphSnapshot | null;
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly error: unknown;
};
const initialState = (projectId: string, scope: TaskCacheScope): GraphState => ({ projectId, scope, snapshot: null, status: "loading", refreshing: false, error: null });

export const useTaskGraph = (projectId: string) => {
  const scope = useTaskCacheScope();
  const sessions = useOptionalTaskDetailSessions();
  const subscribeCommitted = useCallback((listener: () => void) => sessions?.subscribeCommitted(projectId, listener) ?? (() => {}), [sessions, projectId]);
  const committedSnapshot = useCallback(() => sessions?.committedSnapshot(projectId) ?? emptyCommitted, [sessions, projectId]);
  const committed = useSyncExternalStore(subscribeCommitted, committedSnapshot);
  const access = useProjectAccessSession(projectId);
  const sessionStore = useMemo(() => new TaskSessionSummaryStore(scope, projectId), [scope, projectId]);
  useEffect(() => { sessionStore.start(); return () => sessionStore.dispose(); }, [sessionStore]);
  const [state, setState] = useState<GraphState>(() => initialState(projectId, scope));
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const observingHistory = useRef(false);
  const liveAccess = useRef(false);
  const receipt = useRef<{ observedAt: string; receivedMonotonic: number; receivedAt: number; revision: number } | null>(null);
  const publish = useCallback((project: CachedProject, synced = false) => {
    const sample = receipt.current;
    if (!liveAccess.current || sample === null) return;
    setState((previous) => {
      const current = previous.projectId === projectId && previous.scope === scope;
      return { projectId, scope, snapshot: { graph: project.graph, index: project.index, summaries: project.summaries, pausedTaskIds: project.pausedTaskIds, workerMachines: project.workerMachines, ...sample }, status: "ready",
        refreshing: !synced && current ? previous.refreshing : false, error: !synced && current ? previous.error : null };
    });
  }, [projectId, scope]);
  const request = useCallback(async (automatic = false, historyRetry = false, confirmationRetry = false) => {
    if (automatic && (active.current !== null || access?.projectReadInFlight())) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const revision = ++generation.current;
    const cycleId = crypto.randomUUID();
    setState((previous) => {
      const current = previous.projectId === projectId && previous.scope === scope;
      const snapshot = current ? previous.snapshot : null;
      const error = current && (automatic || snapshot !== null) ? previous.error : null;
      return { projectId, scope, snapshot, status: snapshot !== null ? "ready" : error === null ? "loading" : "error", refreshing: snapshot !== null && !automatic, error };
    });
    let ticket: TaskSyncTicket | null = null;
    let projectReadRevision = scope.getProjectReadRevision(projectId);
    try {
      ticket = await scope.beginSync(projectId, signal);
      if (receipt.current === null && ticket.epoch !== null && scope.canPreviewProject(projectId)) {
        const project = await scope.readProject(projectId, signal);
        if (signal.aborted || revision !== generation.current) return;
        if (project !== null && scope.canPreviewProject(projectId)) {
          const localTime = Date.now();
          const receivedMonotonic = performance.now();
          const snapshot: GraphSnapshot = { graph: project.graph, index: project.index, summaries: project.summaries, pausedTaskIds: project.pausedTaskIds, workerMachines: project.workerMachines, observedAt: null,
            receivedMonotonic, receivedAt: null, revision: 0, localTime };
          setState((previous) => {
            const current = previous.projectId === projectId && previous.scope === scope;
            return { projectId, scope, snapshot: current && previous.snapshot?.graph === project.graph && previous.snapshot.summaries === project.summaries && previous.snapshot.workerMachines === project.workerMachines ? previous.snapshot : snapshot,
              status: "ready", refreshing: current && previous.refreshing, error: current ? previous.error : null };
          });
        }
      }
      const query = ticket.epoch === null ? {} : ticket.maxUpdatedAt === null ? { epoch: ticket.epoch } : { epoch: ticket.epoch, since: ticket.maxUpdatedAt };
      const accessTicket = access?.beginObservation();
      projectReadRevision = scope.getProjectReadRevision(projectId);
      const sessionAdmission = authRequestsPauseRevision();
      const { sync: response, receivedMonotonic } = await getTaskSync(projectId, query, scope.userId, signal, scope.principalMismatch);
      const receivedAt = Date.now();
      if (signal.aborted || revision !== generation.current) return;
      observingHistory.current = true;
      let history: "current" | "retired" | "confirm";
      try { history = await scope.observeHistory(ticket, response.epoch, signal); }
      finally { observingHistory.current = false; }
      if (history === "confirm") {
        if (!confirmationRetry) { void request(false, historyRetry, true); return; }
        throw new ApiError("protocol");
      }
      if (history === "retired") {
        if (!historyRetry) { void request(false, true, confirmationRetry); return; }
        throw new ApiError("protocol");
      }
      const applyStarted = performance.now();
      const result = await scope.applySync(ticket, response, signal);
      console.debug("Task sync", { cycle_id: cycleId, project_id: projectId, received: response.tasks.length,
        changed: result.changedTaskIds.length, duplicate: response.tasks.length - result.changedTaskIds.length,
        cache_hit: ticket.epoch !== null, apply_ms: performance.now() - applyStarted });
      if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch) return;
      if (accessTicket !== undefined) access?.publishSync(accessTicket, response.actorAccess, automatic);
      if (sessionAdmission === authRequestsPauseRevision()) {
        sessionStore.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(ticket, response), sessions: response.sessions, receivedMonotonic });
      }
      liveAccess.current = true;
      receipt.current = { observedAt: response.observedAt, receivedMonotonic, receivedAt, revision };
      publish(result.project, true);
    } catch (error) {
      if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch || isAbortError(error)) return;
      console.warn("Task sync failed", { cycle_id: cycleId, project_id: projectId, ...taskCacheFailureDiagnostic(error) });
      const missing = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
      if (missing) {
        if (ticket !== null && !scope.canRevokeProjectRead(ticket, projectReadRevision)) {
          setState(previous => previous.projectId === projectId && previous.scope === scope ? { ...previous, refreshing: false } : previous);
          if (access !== null) { access.requireProjectReadRecheck(); access.retryProjectRead(); }
          else if (!confirmationRetry) void request(false, historyRetry, true);
          return;
        }
        sessionStore.clear();
        try { if (ticket !== null && !await scope.revokeProject(ticket, signal, true, error as ApiError)) return; }
        catch (storageError) { if (!isAbortError(storageError)) error = storageError; }
        if (scope.hasIdentityMismatch) return;
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, scope, snapshot: null, status: "error", refreshing: false, error });
      }
      if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch) return;
      if (!missing) sessionStore.clear();
      setState((previous) => {
        const snapshot = missing ? null : previous.projectId === projectId && previous.scope === scope ? previous.snapshot : null;
        return { projectId, scope, snapshot, status: snapshot === null ? "error" : "ready", refreshing: false, error };
      });
    } finally { if (revision === generation.current) active.current = null; }
  }, [projectId, scope, publish, access, sessionStore]);

  useEffect(() => {
    liveAccess.current = false; receipt.current = null;
    void request();
    const lifetime = new AbortController();
    const unsubscribe = scope.subscribe((event) => {
      if (event.projectId !== projectId) return;
      if (event.historyChanged === true) {
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, scope, snapshot: null, status: "loading", refreshing: false, error: null });
        if (!observingHistory.current) void request(false, event.historyHint !== true);
        return;
      }
      if (event.accessRestored === true) { void request(); return; }
      if (event.accessRevoked === true) {
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, scope, snapshot: null, status: "error", refreshing: false, error: event.error });
        return;
      }
      if (!liveAccess.current) return;
      if (event.error !== undefined) {
        setState((previous) => ({ ...previous, error: event.error, refreshing: false }));
        return;
      }
      void scope.ready(lifetime.signal).then(() => {
        if (lifetime.signal.aborted || !liveAccess.current) return;
        const project = scope.getAuthorizedProject(projectId);
        if (project !== null) publish(project);
        else {
          liveAccess.current = false; receipt.current = null;
          setState({ projectId, scope, snapshot: null, status: "error", refreshing: false, error: new ApiError("server", 404, "not_found") });
        }
      }).catch((error: unknown) => { if (!lifetime.signal.aborted && !isAbortError(error)) setState((previous) => ({ ...previous, error, refreshing: false })); });
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    const clearTimer = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const resetTimer = () => { clearTimer(); timer = setInterval(() => { void request(true); }, pollingInterval(document.visibilityState === "hidden" ? 'taskSyncInactive' : 'taskSync')); };
    const onVisibilityChange = () => { resetTimer(); if (document.visibilityState !== "hidden") void request(true); };
    resetTimer(); document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer(); unsubscribe(); lifetime.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ++generation.current; active.current?.abort(); active.current = null;
      liveAccess.current = false; receipt.current = null;
    };
  }, [projectId, scope, request, publish]);
  const refresh = useCallback(() => { void request(); }, [request]);
  const visible = state.projectId === projectId && state.scope === scope ? state : initialState(projectId, scope);
  const cacheGeneration = sessions?.projectGeneration(projectId) ?? null;
  const scopeRevision = scope.getProjectRevision(projectId);
  const historyGeneration = scope.getHistoryGeneration(projectId);
  const projection = useMemo(() => visible.snapshot === null ? null : projectCommittedTasks(visible.snapshot, committed, { cacheGeneration, scopeRevision, historyGeneration }),
    [visible.snapshot, committed, cacheGeneration, scopeRevision, historyGeneration]);
  return { snapshot: projection?.snapshot ?? visible.snapshot, status: visible.status, refreshing: visible.refreshing, error: projection?.error ?? visible.error, refresh, sessionStore };
};
