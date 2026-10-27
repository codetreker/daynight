import type { TaskStatus, ExecutionPlatform, GraphTask } from "../../api/types";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { canDeleteTask, canSetStatus, canSetAgentPermission, canSetRequiredPlatform, useTaskDetailSessions, type TaskDetailSessions } from "./TaskDetailSession";

export const useTaskDetail = (projectId: string, taskId: string, revision: number, observedTask: GraphTask | undefined) => {
  const sessions = useTaskDetailSessions();
  const opened = useRef<{ readonly sessions: TaskDetailSessions; readonly projectId: string; readonly taskId: string; readonly revision: number; readonly version: bigint | null; readonly generation: string | null; readonly blockedRead: boolean } | null>(null);
  const sameIdentity = opened.current?.sessions === sessions && opened.current.projectId === projectId && opened.current.taskId === taskId;
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(projectId, taskId, listener), [sessions, projectId, taskId]);
  const snapshot = useCallback(() => sessions.snapshot(projectId, taskId), [sessions, projectId, taskId]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const version = sessions.summaryVersion(projectId, taskId);
  const generation = sessions.projectGeneration(projectId);
  const blockedRead = state.mutation.phase === "pending" || state.mutation.phase === "unknown" || state.mutation.reconciling;
  useEffect(() => {
    if (revision <= 0) return;
    const previous = opened.current;
    const opening = previous === null || previous.sessions !== sessions || previous.projectId !== projectId || previous.taskId !== taskId;
    if (opening) sessions.requireOpeningRead(projectId, taskId);
    const needsRead = sessions.observe(projectId, taskId, observedTask, generation !== null);
    opened.current = { sessions, projectId, taskId, revision, version, generation, blockedRead };
    const newReceipt = previous?.revision !== revision;
    if (!blockedRead && (opening || previous?.generation !== generation || needsRead && (previous?.version !== version || newReceipt || previous?.blockedRead === true))) {
      sessions.load(projectId, taskId, revision, opening ? "open" : "automatic");
    }
  }, [sessions, projectId, taskId, revision, observedTask, blockedRead, version, generation]);
  useEffect(() => () => { sessions.releaseRead(projectId, taskId); }, [sessions, projectId, taskId]);
  const retry = useCallback(() => {
    const mutation = sessions.snapshot(projectId, taskId).mutation;
    if (mutation.phase === "unknown" || mutation.reconciliationError !== null) sessions.reconcile(projectId, taskId);
    else sessions.load(projectId, taskId, revision, "refresh");
  }, [sessions, projectId, taskId, revision]);
  const setStatus = useCallback((status: TaskStatus, version: bigint) => { sessions.setStatus(projectId, taskId, status, version); }, [sessions, projectId, taskId]);
  const setAgentPermission = useCallback((allowAgents: boolean, version: bigint) => { sessions.setAgentPermission(projectId, taskId, allowAgents, version); }, [sessions, projectId, taskId]);
  const setRequiredPlatform = useCallback((requiredPlatform: ExecutionPlatform | null, version: bigint) => { sessions.setRequiredPlatform(projectId, taskId, requiredPlatform, version); }, [sessions, projectId, taskId]);
  const deleteTask = useCallback((version: bigint, removeDepends: boolean) => { sessions.deleteTask(projectId, taskId, version, removeDepends); }, [sessions, projectId, taskId]);
  const reconcile = useCallback(() => { sessions.reconcile(projectId, taskId); }, [sessions, projectId, taskId]);
  const visible = revision > 0 && (sessions.hasCurrentGeneration(projectId, taskId) && (sameIdentity || state.mutation.phase !== "idle") || sameIdentity && state.detail === null && state.status === "error") ? state
    : { ...state, detail: null, loadedRevision: null, status: "loading" as const, refreshing: false, error: null };
  const requiresFreshRead = revision <= 0 || !sameIdentity || sessions.requiresFreshRead(projectId, taskId, observedTask);
  return { ...visible, requiresFreshRead, retry, deleteTask, setStatus, setAgentPermission, setRequiredPlatform, reconcile, canDelete: canDeleteTask({ ...visible, requiresFreshRead }), canSetRequiredPlatform: canSetRequiredPlatform({ ...visible, requiresFreshRead }), canSetAgentPermission: canSetAgentPermission({ ...visible, requiresFreshRead }), canSetStatus: canSetStatus({ ...visible, requiresFreshRead }) };
};
