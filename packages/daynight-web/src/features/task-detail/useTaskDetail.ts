import type { TaskStatus, ExecutionPlatform, GraphTask } from "../../api/types";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { pollingInterval } from "../../app/polling";
import { canDeleteTask, canUnpause, canWithdrawClaim, canSetStatus, canSetAgentPermission, canSetAssignedTo, canSetRequiredPlatform, canSetParent, canEditGoal, canSetTags, useTaskDetailSessions, type TaskDetailSessions, type TaskObservationInput } from "./TaskDetailSession";

export const useTaskDetail = (projectId: string, taskId: string, input: TaskObservationInput | number, task?: GraphTask) => {
  const observation: TaskObservationInput = typeof input === "number" ? { kind: "project-summary", revision: input, task } : input;
  const direct = observation.kind === "direct";
  const revision = observation.kind === "project-summary" ? observation.revision : 1;
  const observedTask = observation.kind === "project-summary" ? observation.task : undefined;
  const sessions = useTaskDetailSessions();
  const opened = useRef<{ readonly sessions: TaskDetailSessions; readonly projectId: string; readonly taskId: string; readonly source: TaskObservationInput["kind"]; readonly revision: number; readonly version: bigint | null; readonly generation: string | null; readonly blockedRead: boolean } | null>(null);
  const sameTask = opened.current?.sessions === sessions && opened.current.projectId === projectId && opened.current.taskId === taskId;
  const sameIdentity = sameTask && opened.current?.source === observation.kind;
  const changingSource = sameTask && !sameIdentity;
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(projectId, taskId, listener), [sessions, projectId, taskId]);
  const snapshot = useCallback(() => sessions.snapshot(projectId, taskId), [sessions, projectId, taskId]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const version = sessions.summaryVersion(projectId, taskId);
  const generation = sessions.projectGeneration(projectId);
  const historyGeneration = sessions.historyGeneration(projectId);
  const blockedRead = state.mutation.phase === "pending" || state.mutation.phase === "unknown" || state.mutation.reconciling;
  useEffect(() => {
    if (direct || revision <= 0) return;
    const previous = opened.current;
    const opening = previous === null || previous.sessions !== sessions || previous.projectId !== projectId || previous.taskId !== taskId || previous.source !== observation.kind;
    if (opening) sessions.requireOpeningRead(projectId, taskId);
    const needsRead = sessions.observe(projectId, taskId, observedTask, generation !== null);
    opened.current = { sessions, projectId, taskId, source: observation.kind, revision, version, generation, blockedRead };
    const newReceipt = previous?.revision !== revision;
    if (!blockedRead && (opening || previous?.generation !== generation || needsRead && (previous?.version !== version || newReceipt || previous?.blockedRead === true))) {
      sessions.load(projectId, taskId, revision, opening ? "open" : "automatic");
    }
  }, [sessions, projectId, taskId, revision, observedTask, blockedRead, version, generation, direct]);
  useEffect(() => {
    if (!direct) return;
    opened.current = { sessions, projectId, taskId, source: 'direct', revision, version: null, generation: null, blockedRead: false };
    sessions.openDirect(projectId, taskId);
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (timer !== null) clearInterval(timer);
      timer = document.visibilityState === "hidden" ? null : setInterval(() => sessions.load(projectId, taskId, 1, "automatic"), pollingInterval("taskSync"));
    };
    const onVisibilityChange = () => {
      schedule();
      if (document.visibilityState !== "hidden") sessions.load(projectId, taskId, 1, "automatic");
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { if (timer !== null) clearInterval(timer); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [sessions, projectId, taskId, direct]);
  useEffect(() => () => { sessions.releaseRead(projectId, taskId); }, [sessions, projectId, taskId]);
  const retry = useCallback(() => {
    const mutation = sessions.snapshot(projectId, taskId).mutation;
    if (mutation.phase === "unknown" || mutation.reconciliationError !== null) sessions.reconcile(projectId, taskId);
    else sessions.load(projectId, taskId, revision, "refresh");
  }, [sessions, projectId, taskId, revision]);
  const setStatus = useCallback((status: TaskStatus, version: bigint) => { sessions.setStatus(projectId, taskId, status, version); }, [sessions, projectId, taskId]);
  const setAgentPermission = useCallback((allowAgents: boolean, version: bigint) => { sessions.setAgentPermission(projectId, taskId, allowAgents, version); }, [sessions, projectId, taskId]);
  const unpause = useCallback((version: bigint) => { sessions.unpause(projectId, taskId, version); }, [sessions, projectId, taskId]);
  const setRequiredPlatform = useCallback((requiredPlatform: ExecutionPlatform | null, version: bigint) => { sessions.setRequiredPlatform(projectId, taskId, requiredPlatform, version); }, [sessions, projectId, taskId]);
  const setAssignedTo = useCallback((assignedTo: string | null, version: bigint) => { sessions.setAssignedTo(projectId, taskId, assignedTo, version); }, [sessions, projectId, taskId]);
  const setParent = useCallback((parentId: string | null, version: bigint) => { sessions.setParent(projectId, taskId, parentId, version); }, [sessions, projectId, taskId]);
  const editGoal = useCallback((title: string, description: string, version: bigint) => { sessions.editGoal(projectId, taskId, title, description, version); }, [sessions, projectId, taskId]);
  const setTags = useCallback((tagIds: readonly string[], version: bigint) => { sessions.setTags(projectId, taskId, tagIds, version); }, [sessions, projectId, taskId]);
  const withdrawClaim = useCallback((claimId: string, version: bigint) => { sessions.withdrawClaim(projectId, taskId, claimId, version); }, [sessions, projectId, taskId]);
  const deleteTask = useCallback((version: bigint, removeDepends: boolean) => { sessions.deleteTask(projectId, taskId, version, removeDepends); }, [sessions, projectId, taskId]);
  const reconcile = useCallback(() => { sessions.reconcile(projectId, taskId); }, [sessions, projectId, taskId]);
  const visible = !changingSource && (direct ? sameIdentity : revision > 0 && (sessions.hasCurrentGeneration(projectId, taskId) && (sameIdentity || state.mutation.phase !== "idle") || sameIdentity && state.detail === null && state.status === "error")) ? state
    : { ...state, detail: null, loadedRevision: null, status: "loading" as const, refreshing: false, error: null };
  const requiresFreshRead = !sameIdentity || (direct ? sessions.directRequiresFreshRead(projectId, taskId) : revision <= 0 || sessions.requiresFreshRead(projectId, taskId, observedTask));
  const displayRequiresFreshRead = !sameIdentity || (direct ? sessions.directRequiresFreshRead(projectId, taskId, true) : requiresFreshRead);
  const assignmentUncertain = visible.mutation.operation?.action === "assignedTo" && (visible.mutation.phase === "unknown" ||
    visible.mutation.phase === "confirmed" && (requiresFreshRead || visible.error !== null || visible.mutation.reconciling || visible.mutation.reconciliationError !== null));
  return { ...visible, historyGeneration, requiresFreshRead, displayRequiresFreshRead, canDisplayAssignee: canSetAssignedTo({ ...visible, requiresFreshRead: displayRequiresFreshRead }), canDisplayStatus: canSetStatus({ ...visible, requiresFreshRead: displayRequiresFreshRead }), canDisplayDelete: canDeleteTask({ ...visible, requiresFreshRead: displayRequiresFreshRead }), canDisplayAgentPermission: canSetAgentPermission({ ...visible, requiresFreshRead: displayRequiresFreshRead }), canDisplayRequiredPlatform: canSetRequiredPlatform({ ...visible, requiresFreshRead: displayRequiresFreshRead }), canDisplayWithdrawClaim: canWithdrawClaim({ ...visible, requiresFreshRead: displayRequiresFreshRead }), sessionCurrent: direct && sameIdentity && sessions.directSessionCurrent(projectId, taskId), assignmentUncertain, retry, unpause, canUnpause: canUnpause({ ...visible, requiresFreshRead }), deleteTask, withdrawClaim, canWithdrawClaim: canWithdrawClaim({ ...visible, requiresFreshRead }), setStatus, setAgentPermission, setAssignedTo, setRequiredPlatform, setParent, editGoal, setTags, reconcile, canDelete: canDeleteTask({ ...visible, requiresFreshRead }), canSetAssignedTo: canSetAssignedTo({ ...visible, requiresFreshRead }), canSetRequiredPlatform: canSetRequiredPlatform({ ...visible, requiresFreshRead }), canSetAgentPermission: canSetAgentPermission({ ...visible, requiresFreshRead }), canSetStatus: canSetStatus({ ...visible, requiresFreshRead }), canSetParent: canSetParent({ ...visible, requiresFreshRead }), canEditGoal: canEditGoal({ ...visible, requiresFreshRead }), canSetTags: canSetTags({ ...visible, requiresFreshRead }) };
};
