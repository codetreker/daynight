import { useProjectAccessSession, type ProjectAccessSession } from "./ProjectAccess";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, authRequestsPauseRevision, getTaskSync, isAbortError } from "../../api/client";
import { pollingInterval } from "../../app/polling";
import type { TaskGraph, TaskSummary, WorkerMachine } from "../../api/types";
import type { GraphIndex } from "../task-graph/model";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { taskCacheFailureDiagnostic } from "../task-cache/diagnostics";
import type { CachedProject, TaskSyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { deriveTaskSyncBindings, deriveTaskSyncVersions, validateTaskSyncObservationBindings } from "../task-cache/execution-binding";
import { TaskSessionSummaryStore } from "../task-session-summary/store";
import { ProjectTaskObservationsStore } from "../task-session-summary/project-observations";
import { useOptionalTaskDetailSessions } from '../task-detail/TaskDetailSession';
import { projectCommittedTasks, type CommittedTaskProjection } from './committed-task-projection';

const emptyCommitted: ReadonlyMap<string, CommittedTaskProjection> = new Map();

export type GraphSnapshot = {
  readonly graph: TaskGraph;
  readonly index: GraphIndex;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly pausedTaskIds: ReadonlySet<string>;
  readonly workerMachines: ReadonlyMap<string, WorkerMachine>;
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
  readonly displaySnapshot: GraphSnapshot | null;
  readonly access: ProjectAccessSession | null;
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly error: unknown;
};
const initialState = (projectId: string, scope: TaskCacheScope, access: ProjectAccessSession | null): GraphState => ({ projectId, scope, access, snapshot: null, displaySnapshot: null, status: "loading", refreshing: false, error: null });

export const useTaskGraph = (projectId: string) => {
  const scope = useTaskCacheScope();
  const sessions = useOptionalTaskDetailSessions();
  const subscribeCommitted = useCallback((listener: () => void) => sessions?.subscribeCommitted(projectId, listener) ?? (() => {}), [sessions, projectId]);
  const committedSnapshot = useCallback(() => sessions?.committedSnapshot(projectId) ?? emptyCommitted, [sessions, projectId]);
  const committed = useSyncExternalStore(subscribeCommitted, committedSnapshot);
  const access = useProjectAccessSession(projectId);
  const sessionStore = useMemo(() => new TaskSessionSummaryStore(scope, projectId), [scope, projectId]);
  const observationStore = useMemo(() => new ProjectTaskObservationsStore(scope, projectId), [scope, projectId]);
  useEffect(() => { sessionStore.start(); observationStore.start(); return () => { sessionStore.dispose(); observationStore.dispose(); }; }, [sessionStore, observationStore]);
  const [state, setState] = useState<GraphState>(() => initialState(projectId, scope, access));
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const observingHistory = useRef(false);
  const liveAccess = useRef(false);
  const receipt = useRef<{ observedAt: string; receivedMonotonic: number; receivedAt: number; revision: number } | null>(null);
  const publish = useCallback((project: CachedProject, synced = false) => {
    const sample = receipt.current;
    if (!liveAccess.current || sample === null) return;
    setState((previous) => {
      const current = previous.projectId === projectId && previous.scope === scope && previous.access === access;
      const snapshot = { graph: project.graph, index: project.index, summaries: project.summaries, pausedTaskIds: project.pausedTaskIds, workerMachines: project.workerMachines, ...sample };
      return { projectId, scope, access, snapshot, displaySnapshot: snapshot, status: "ready",
        refreshing: !synced && current ? previous.refreshing : false, error: !synced && current ? previous.error : null };
    });
  }, [projectId, scope, access]);
  const request = useCallback(async (mode: "manual" | "automatic" | "reconcile" = "manual", historyRetry = false, confirmationRetry = false) => {
    const automatic = mode === "automatic";
    if (automatic && (active.current !== null || access?.projectReadInFlight())) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const revision = ++generation.current;
    const cycleId = crypto.randomUUID();
    setState((previous) => {
      const current = previous.projectId === projectId && previous.scope === scope && previous.access === access;
      const snapshot = current ? previous.snapshot : null;
      const displaySnapshot = current ? previous.displaySnapshot : null;
      const error = current && (mode !== "manual" || displaySnapshot !== null) ? previous.error : null;
      return { projectId, scope, access, snapshot, displaySnapshot, status: displaySnapshot !== null ? "ready" : error === null ? "loading" : "error", refreshing: displaySnapshot !== null && mode === "manual", error };
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
            const current = previous.projectId === projectId && previous.scope === scope && previous.access === access;
            const preview = current && previous.snapshot?.graph === project.graph && previous.snapshot.summaries === project.summaries && previous.snapshot.workerMachines === project.workerMachines ? previous.snapshot : snapshot;
            return { projectId, scope, access, snapshot: preview, displaySnapshot: current && previous.displaySnapshot !== null ? previous.displaySnapshot : preview,
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
        if (!confirmationRetry) { void request("reconcile", historyRetry, true); return; }
        throw new ApiError("protocol");
      }
      if (history === "retired") {
        if (!historyRetry) { void request("reconcile", true, confirmationRetry); return; }
        throw new ApiError("protocol");
      }
      const observedBindings = deriveTaskSyncBindings(ticket, response);
      const observedVersions = deriveTaskSyncVersions(ticket, response);
      validateTaskSyncObservationBindings(response, observedBindings, observedVersions);
      const applyStarted = performance.now();
      const result = await scope.applySync(ticket, response, signal);
      console.debug("Task sync", { cycle_id: cycleId, project_id: projectId, received: response.tasks.length,
        changed: result.changedTaskIds.length, duplicate: response.tasks.length - result.changedTaskIds.length,
        cache_hit: ticket.epoch !== null, apply_ms: performance.now() - applyStarted });
      if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch) return;
      if (accessTicket !== undefined) access?.publishSync(accessTicket, response.actorAccess, mode !== "manual");
      scope.notifyTagColors(projectId);
      if (sessionAdmission === authRequestsPauseRevision()) {
        sessionStore.replace({ project: result.project, observedBindings, sessions: response.sessions, receivedMonotonic });
        observationStore.replace({ project: result.project, observedBindings, observedVersions, sync: response, receivedMonotonic });
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
          else if (!confirmationRetry) void request("reconcile", historyRetry, true);
          return;
        }
        sessionStore.clear(); observationStore.clear();
        try { if (ticket !== null && !await scope.revokeProject(ticket, signal, true, error as ApiError)) return; }
        catch (storageError) { if (!isAbortError(storageError)) error = storageError; }
        if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch) return;
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, scope, access, snapshot: null, displaySnapshot: null, status: "error", refreshing: false, error });
      }
      if (signal.aborted || revision !== generation.current || scope.hasIdentityMismatch) return;
      if (!missing) { sessionStore.clear(); observationStore.fail(); }
      setState((previous) => {
        const current = previous.projectId === projectId && previous.scope === scope && previous.access === access;
        const snapshot = missing || !current ? null : previous.snapshot;
        const displaySnapshot = missing || !current ? null : previous.displaySnapshot;
        return { projectId, scope, access, snapshot, displaySnapshot, status: displaySnapshot === null ? "error" : "ready", refreshing: false, error };
      });
    } finally { if (revision === generation.current) active.current = null; }
  }, [projectId, scope, publish, access, sessionStore, observationStore]);

  useEffect(() => {
    liveAccess.current = false; receipt.current = null;
    void request();
    const lifetime = new AbortController();
    const unsubscribe = scope.subscribe((event) => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked === true) {
        ++generation.current; active.current?.abort(); active.current = null;
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, scope, access, snapshot: null, displaySnapshot: null, status: "error", refreshing: false, error: event.error });
        return;
      }
      if (event.historyChanged === true) {
        liveAccess.current = false; receipt.current = null;
        setState(previous => {
          const current = previous.projectId === projectId && previous.scope === scope && previous.access === access;
          const error = current ? previous.error : null;
          return { projectId, scope, access, snapshot: null, displaySnapshot: null, status: error === null ? "loading" : "error", refreshing: false, error };
        });
        if (!observingHistory.current) void request("reconcile", event.historyHint !== true);
        return;
      }
      if (event.accessRestored === true) { void request("reconcile"); return; }
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
          setState({ projectId, scope, access, snapshot: null, displaySnapshot: null, status: "error", refreshing: false, error: new ApiError("server", 404, "not_found") });
        }
      }).catch((error: unknown) => { if (!lifetime.signal.aborted && !isAbortError(error)) setState((previous) => ({ ...previous, error, refreshing: false })); });
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    const clearTimer = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const resetTimer = () => { clearTimer(); timer = setInterval(() => { void request("automatic"); }, pollingInterval(document.visibilityState === "hidden" ? 'taskSyncInactive' : 'taskSync')); };
    const onVisibilityChange = () => { resetTimer(); if (document.visibilityState !== "hidden") void request("automatic"); };
    resetTimer(); document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer(); unsubscribe(); lifetime.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ++generation.current; active.current?.abort(); active.current = null;
      liveAccess.current = false; receipt.current = null;
    };
  }, [projectId, scope, access, request, publish]);
  const reconcile = useCallback(() => { void request("reconcile"); }, [request]);
  const refresh = useCallback(() => { void request(); }, [request]);
  const visible = state.projectId === projectId && state.scope === scope && state.access === access && !scope.isInvalidated && !scope.hasIdentityMismatch ? state : initialState(projectId, scope, access);
  const cacheGeneration = sessions?.projectGeneration(projectId) ?? null;
  const scopeRevision = scope.getProjectRevision(projectId);
  const historyGeneration = scope.getHistoryGeneration(projectId);
  const projection = useMemo(() => visible.snapshot === null ? null : projectCommittedTasks(visible.snapshot, committed, { cacheGeneration, scopeRevision, historyGeneration }),
    [visible.snapshot, committed, cacheGeneration, scopeRevision, historyGeneration]);
  const displaySnapshot = visible.snapshot !== null && visible.snapshot === visible.displaySnapshot ? projection?.snapshot ?? visible.displaySnapshot : visible.displaySnapshot;
  const synchronizedDisplay = useRef<{ projectId: string; scope: TaskCacheScope; access: ProjectAccessSession | null; snapshot: GraphSnapshot | null }>({ projectId, scope, access, snapshot: null });
  if (synchronizedDisplay.current.projectId !== projectId || synchronizedDisplay.current.scope !== scope || synchronizedDisplay.current.access !== access || visible.displaySnapshot === null)
    synchronizedDisplay.current = { projectId, scope, access, snapshot: null };
  if (visible.snapshot !== null) synchronizedDisplay.current.snapshot = visible.snapshot;
  // Every presentation expires with its project history, including read-only graphs.
  return { syncedSnapshot: synchronizedDisplay.current.snapshot, snapshot: projection?.snapshot ?? visible.snapshot, displaySnapshot, reconcile, status: visible.status, refreshing: visible.refreshing, error: projection?.error ?? visible.error, refresh, sessionStore, observationStore };
};
