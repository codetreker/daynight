import { useCallback, useEffect, useSyncExternalStore } from "react";
import { emptyTaskStepsState, useTaskDetailSessions } from "./TaskDetailSession";

export const useTaskSteps = (projectId: string, taskId: string, active: boolean) => {
  const sessions = useTaskDetailSessions();
  const subscribe = useCallback((listener: () => void) => active ? sessions.subscribeSteps(projectId, taskId, listener) : () => {}, [sessions, projectId, taskId, active]);
  const snapshot = useCallback(() => active ? sessions.stepsSnapshot(projectId, taskId) : emptyTaskStepsState, [sessions, projectId, taskId, active]);
  const state = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { if (active) sessions.loadSteps(projectId, taskId); }, [sessions, projectId, taskId, active]);
  const retry = useCallback(() => { if (active) sessions.loadSteps(projectId, taskId, true); }, [sessions, projectId, taskId, active]);
  return { ...state, retry };
};
