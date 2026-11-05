import { useCallback, useEffect, useSyncExternalStore } from "react";
import { emptyTaskStepsState, useTaskDetailSessions } from "./TaskDetailSession";
import type { StepPlacement, StepStatus } from "../../api/task-steps";

export const useTaskSteps = (projectId: string, taskId: string, active: boolean) => {
  const sessions = useTaskDetailSessions();
  const subscribe = useCallback((listener: () => void) => active ? sessions.subscribeSteps(projectId, taskId, listener) : () => {}, [sessions, projectId, taskId, active]);
  const snapshot = useCallback(() => active ? sessions.stepsSnapshot(projectId, taskId) : emptyTaskStepsState, [sessions, projectId, taskId, active]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const subscribeDetail = useCallback((listener: () => void) => active ? sessions.subscribe(projectId, taskId, listener) : () => {}, [sessions, projectId, taskId, active]);
  const detailSnapshot = useCallback(() => sessions.snapshot(projectId, taskId), [sessions, projectId, taskId]);
  const detail = useSyncExternalStore(subscribeDetail, detailSnapshot);
  useEffect(() => { if (active) sessions.loadSteps(projectId, taskId); }, [sessions, projectId, taskId, active]);
  const retry = useCallback(() => { if (active) sessions.loadSteps(projectId, taskId, true); }, [sessions, projectId, taskId, active]);
  const setStatus = useCallback((stepId: string, status: StepStatus, version: bigint) => { sessions.setStepStatus(projectId, taskId, stepId, status, version); }, [sessions, projectId, taskId]);
  const add = useCallback((stepId: string, title: string, description: string, status: StepStatus, version: bigint, placement?: { readonly before: string } | { readonly after: string }) => sessions.addStep(projectId, taskId, stepId, title, description, status, version, placement), [sessions, projectId, taskId]);
  const edit = useCallback((stepId: string, title: string, description: string, version: bigint) => sessions.editStep(projectId, taskId, stepId, title, description, version), [sessions, projectId, taskId]);
  const remove = useCallback((stepId: string, version: bigint) => sessions.deleteStep(projectId, taskId, stepId, version), [sessions, projectId, taskId]);
  const move = useCallback((stepId: string, placement: StepPlacement, version: bigint) => { sessions.moveStep(projectId, taskId, stepId, placement, version); }, [sessions, projectId, taskId]);
  const reconcile = useCallback(() => { sessions.reconcile(projectId, taskId); }, [sessions, projectId, taskId]);
  return { ...state, retry, mutation: detail.mutation, canSetStatus: active && sessions.canSetStepStatus(projectId, taskId), canAdd: active && sessions.canSetStepStatus(projectId, taskId), canEdit: active && sessions.canSetStepStatus(projectId, taskId), canDelete: active && sessions.canSetStepStatus(projectId, taskId), canMove: active && sessions.canSetStepStatus(projectId, taskId), setStatus, add, edit, remove, move, reconcile };
};
