import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GraphSnapshot } from "../projects/useTaskGraph";
import { createTaskExecutionClock, executionKind, taskExecution, type ClockInput, type ExecutionTask, type TaskExecution, type TaskExecutionClock } from "./clock";

const ClockContext = createContext<TaskExecutionClock | null>(null);
const inactiveSubscription = () => () => {};
const inactiveSnapshot = () => null;

const inputFor = (snapshot: GraphSnapshot | null): ClockInput | null => {
  if (snapshot === null) return null;
  const warningMinutes = snapshot.graph.project.settings.executionWarningMinutes;
  return snapshot.observedAt === null
    ? { observedAt: null, localTime: snapshot.localTime, receivedMonotonic: snapshot.receivedMonotonic, warningMinutes }
    : { observedAt: snapshot.observedAt, receivedMonotonic: snapshot.receivedMonotonic, warningMinutes };
};

type ClockProps = {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot | null;
  readonly children: ReactNode;
};
const ClockScope = ({ projectId, snapshot, children }: ClockProps) => {
  if (snapshot !== null && snapshot.graph.project.id !== projectId) throw new Error("The task execution clock requires its project's graph snapshot.");
  const [clock] = useState(() => createTaskExecutionClock(inputFor(snapshot)));
  useLayoutEffect(() => clock.mount(), [clock]);
  useLayoutEffect(() => { clock.update(inputFor(snapshot)); }, [clock, snapshot]);
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
};

export const TaskExecutionClockProvider = (props: ClockProps) => <ClockScope key={props.projectId} {...props} />;
export const useTaskExecutionClock = () => useContext(ClockContext);

export const useTaskExecution = (task: ExecutionTask): TaskExecution | null => {
  const clock = useTaskExecutionClock();
  const kind = executionKind(task);
  if (kind !== null && clock === null) throw new Error("A timed task requires TaskExecutionClockProvider.");
  const running = kind === "running";
  const completed = kind === "completed";
  const sample = useSyncExternalStore(running ? clock!.subscribeRunning : inactiveSubscription,
    running ? clock!.getSnapshot : inactiveSnapshot, running ? clock!.getSnapshot : inactiveSnapshot);
  const warning = useSyncExternalStore(completed ? clock!.subscribeSettings : inactiveSubscription,
    completed ? clock!.getWarningSnapshot : inactiveSnapshot, completed ? clock!.getWarningSnapshot : inactiveSnapshot);
  if (kind === null) return null;
  const current = running ? sample : warning === null ? null : { serverMilliseconds: null, warningMinutes: warning.warningMinutes };
  return current === null ? null : taskExecution(task, current);
};
