import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getTaskSync, isAbortError } from "../../api/client";
import type { TaskGraph } from "../../api/types";
import type { GraphIndex } from "../task-graph/model";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { taskCacheFailureDiagnostic } from "../task-cache/diagnostics";
import type { CachedProject } from "../task-cache/project-cache";

export type GraphSnapshot = {
  readonly graph: TaskGraph;
  readonly index: GraphIndex;
  readonly observedAt: string;
  readonly receivedMonotonic: number;
  readonly receivedAt: number;
  readonly revision: number;
};

type GraphState = {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot | null;
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly error: unknown;
};
const initialState = (projectId: string): GraphState => ({ projectId, snapshot: null, status: "loading", refreshing: false, error: null });

export const useTaskGraph = (projectId: string) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<GraphState>(() => initialState(projectId));
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const liveAccess = useRef(false);
  const receipt = useRef<{ observedAt: string; receivedMonotonic: number; receivedAt: number; revision: number } | null>(null);
  const publish = useCallback((project: CachedProject) => {
    const sample = receipt.current;
    if (!liveAccess.current || sample === null) return;
    setState({ projectId, snapshot: { graph: project.graph, index: project.index, ...sample }, status: "ready", refreshing: false, error: null });
  }, [projectId]);
  const request = useCallback(async (automatic = false) => {
    if (automatic && active.current !== null) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const revision = ++generation.current;
    const cycleId = crypto.randomUUID();
    setState((previous) => {
      const snapshot = previous.projectId === projectId ? previous.snapshot : null;
      const error = previous.projectId === projectId && (automatic || snapshot !== null) ? previous.error : null;
      return { projectId, snapshot, status: snapshot !== null ? "ready" : error === null ? "loading" : "error", refreshing: snapshot !== null && !automatic, error };
    });
    try {
      const ticket = await scope.beginSync(projectId, signal);
      const query = ticket.epoch === null ? {} : ticket.maxUpdatedAt === null ? { epoch: ticket.epoch } : { epoch: ticket.epoch, since: ticket.maxUpdatedAt };
      const response = await getTaskSync(projectId, query, scope.userId, signal, scope.principalMismatch);
      // The monotonic anchor belongs to this response and cannot come from disk or another tab.
      const receivedMonotonic = performance.now();
      const receivedAt = Date.now();
      if (signal.aborted || revision !== generation.current) return;
      const applyStarted = performance.now();
      const result = await scope.applySync(ticket, response, signal);
      console.debug("Task sync", { cycle_id: cycleId, project_id: projectId, received: response.tasks.length,
        changed: result.changedTaskIds.length, duplicate: response.tasks.length - result.changedTaskIds.length,
        cache_hit: ticket.epoch !== null, apply_ms: performance.now() - applyStarted });
      if (signal.aborted || revision !== generation.current) return;
      liveAccess.current = true;
      receipt.current = { observedAt: response.observedAt, receivedMonotonic, receivedAt, revision };
      publish(result.project);
    } catch (error) {
      if (signal.aborted || revision !== generation.current || isAbortError(error)) return;
      console.warn("Task sync failed", { cycle_id: cycleId, project_id: projectId, ...taskCacheFailureDiagnostic(error) });
      const missing = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
      if (missing) {
        liveAccess.current = false; receipt.current = null;
        setState({ projectId, snapshot: null, status: "error", refreshing: false, error });
        try { await scope.invalidateProject(projectId, signal); }
        catch (storageError) { if (!isAbortError(storageError)) error = storageError; }
      }
      if (signal.aborted || revision !== generation.current) return;
      setState((previous) => {
        const snapshot = missing ? null : previous.projectId === projectId ? previous.snapshot : null;
        return { projectId, snapshot, status: snapshot === null ? "error" : "ready", refreshing: false, error };
      });
    } finally { if (revision === generation.current) active.current = null; }
  }, [projectId, scope, publish]);

  useEffect(() => {
    liveAccess.current = false; receipt.current = null;
    void request();
    const lifetime = new AbortController();
    const unsubscribe = scope.subscribe((event) => {
      if (event.projectId !== projectId || !liveAccess.current) return;
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
          setState({ projectId, snapshot: null, status: "error", refreshing: false, error: new ApiError("server", 404, "not_found") });
        }
      }).catch((error: unknown) => { if (!lifetime.signal.aborted && !isAbortError(error)) setState((previous) => ({ ...previous, error, refreshing: false })); });
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    const pause = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const resume = () => { pause(); if (document.visibilityState !== "hidden") timer = setInterval(() => { void request(true); }, 5_000); };
    const onVisibilityChange = () => { resume(); if (document.visibilityState !== "hidden") void request(true); };
    resume(); document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      pause(); unsubscribe(); lifetime.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ++generation.current; active.current?.abort(); active.current = null;
      liveAccess.current = false; receipt.current = null;
    };
  }, [projectId, scope, request, publish]);
  const refresh = useCallback(() => { void request(); }, [request]);
  const visible = state.projectId === projectId ? state : initialState(projectId);
  return { snapshot: visible.snapshot, status: visible.status, refreshing: visible.refreshing, error: visible.error, refresh };
};
