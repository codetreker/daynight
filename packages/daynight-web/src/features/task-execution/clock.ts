import type { GraphTask } from "../../api/types";

export type ExecutionTask = Pick<GraphTask, "status" | "allowAgents" | "startedAt" | "completedAt">;
export type TaskExecution = {
  readonly kind: "running" | "completed";
  readonly elapsedMilliseconds: number;
  readonly overdue: boolean;
  readonly warningMinutes: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
};
export type ClockInput = {
  readonly observedAt: string | null;
  readonly receivedMonotonic: number;
  readonly warningMinutes: number;
};
export type ClockSnapshot = {
  readonly serverMilliseconds: number | null;
  readonly warningMinutes: number;
};
export type WarningSnapshot = { readonly warningMinutes: number };

export const executionKind = (task: ExecutionTask): TaskExecution["kind"] | null =>
  task.startedAt === null ? null : task.status === "in_progress" ? "running"
    : task.status === "done" && task.completedAt !== null ? "completed" : null;

export const taskExecution = (task: ExecutionTask, snapshot: ClockSnapshot): TaskExecution | null => {
  const kind = executionKind(task);
  if (kind === null) return null;
  if (kind === "running" && snapshot.serverMilliseconds === null) return null;
  const startedAt = task.startedAt!;
  // A new start can render before its matching clock anchor is committed by the layout effect.
  const elapsedMilliseconds = kind === "running"
    ? Math.max(0, snapshot.serverMilliseconds! - Date.parse(startedAt))
    : Date.parse(task.completedAt!) - Date.parse(startedAt);
  return {
    kind, elapsedMilliseconds, overdue: task.allowAgents && kind === "running" && elapsedMilliseconds > snapshot.warningMinutes * 60_000,
    warningMinutes: snapshot.warningMinutes, startedAt, completedAt: task.completedAt,
  };
};

type Timer = ReturnType<typeof setInterval>;
export type ClockEnvironment = {
  readonly now: () => number;
  readonly visible: () => boolean;
  readonly schedule: (tick: () => void) => Timer;
  readonly cancel: (timer: Timer) => void;
  readonly listen: (listener: () => void) => () => void;
};
const browserEnvironment: ClockEnvironment = {
  now: () => performance.now(),
  visible: () => document.visibilityState === "visible",
  schedule: (tick) => setInterval(tick, 1_000),
  cancel: (timer) => clearInterval(timer),
  listen: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export const createTaskExecutionClock = (initial: ClockInput, environment: ClockEnvironment = browserEnvironment) => {
  let anchor = initial;
  const serverTime = () => anchor.observedAt === null ? null : Date.parse(anchor.observedAt) + environment.now() - anchor.receivedMonotonic;
  let clock: ClockSnapshot = {
    serverMilliseconds: serverTime(),
    warningMinutes: initial.warningMinutes,
  };
  let warning: WarningSnapshot = { warningMinutes: initial.warningMinutes };
  const runningListeners = new Set<() => void>();
  const settingsListeners = new Set<() => void>();
  let mounted = false;
  let timer: Timer | null = null;
  let releaseVisibility: (() => void) | null = null;

  const publishClock = () => {
    const serverMilliseconds = serverTime();
    if (serverMilliseconds === clock.serverMilliseconds && anchor.warningMinutes === clock.warningMinutes) return;
    clock = { serverMilliseconds, warningMinutes: anchor.warningMinutes };
    for (const listener of [...runningListeners]) listener();
  };
  const onVisibility = () => { if (environment.visible()) publishClock(); synchronizeActivity(); };
  const synchronizeActivity = () => {
    const active = mounted && runningListeners.size > 0 && anchor.observedAt !== null;
    if (active && releaseVisibility === null) releaseVisibility = environment.listen(onVisibility);
    if (!active && releaseVisibility !== null) { releaseVisibility(); releaseVisibility = null; }
    if (!active || !environment.visible()) {
      if (timer !== null) environment.cancel(timer);
      timer = null;
    } else if (timer === null) timer = environment.schedule(publishClock);
  };
  const subscribeRunning = (listener: () => void) => {
    runningListeners.add(listener);
    publishClock();
    synchronizeActivity();
    return () => { runningListeners.delete(listener); synchronizeActivity(); };
  };
  const subscribeSettings = (listener: () => void) => {
    settingsListeners.add(listener);
    return () => { settingsListeners.delete(listener); };
  };
  const update = (input: ClockInput) => {
    anchor = input;
    const changed = input.warningMinutes !== warning.warningMinutes;
    if (changed) warning = { warningMinutes: input.warningMinutes };
    publishClock();
    synchronizeActivity();
    if (changed) for (const listener of [...settingsListeners]) listener();
  };
  const mount = () => {
    mounted = true;
    synchronizeActivity();
    return () => { mounted = false; synchronizeActivity(); };
  };
  return { getSnapshot: () => clock, getWarningSnapshot: () => warning, subscribeRunning, subscribeSettings, update, mount };
};

export type TaskExecutionClock = ReturnType<typeof createTaskExecutionClock>;
