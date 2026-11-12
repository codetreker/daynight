import type { GraphTask } from "../../api/types";
import { timestampNanoseconds } from "../../time/timestamp";

export type ExecutionTask = Pick<GraphTask, "status" | "allowAgents" | "startedAt" | "completedAt" | "cancelledAt">;
export type TaskExecution = {
  readonly kind: "running" | "completed";
  readonly elapsedMilliseconds: number;
  readonly overdue: boolean;
  readonly warningMinutes: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
};
export type ClockInput = { readonly warningMinutes: number } & (
  | { readonly observedAt: string; readonly receivedMonotonic: number }
  | { readonly observedAt: null; readonly localTime: number; readonly receivedMonotonic: number }
);
export type ClockSnapshot = {
  readonly serverMilliseconds: number | null;
  readonly warningMinutes: number;
};
export type WarningSnapshot = { readonly warningMinutes: number };

export const executionKind = (task: ExecutionTask): TaskExecution["kind"] | null =>
  task.startedAt === null ? null : task.status === "in_progress" ? "running"
    : (task.status === "done" || task.status === "cancelled") && task.completedAt !== null ? "completed" : null;

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

export const createTaskExecutionClock = (initial: ClockInput | null, environment: ClockEnvironment = browserEnvironment) => {
  let anchor = initial;
  let anchorNanoseconds = anchor === null ? null : anchor.observedAt === null
    ? BigInt(anchor.localTime) * 1_000_000n : timestampNanoseconds(anchor.observedAt);
  let clock: ClockSnapshot | null = null;
  let warning: WarningSnapshot | null = null;
  let completionNow: bigint | null = null;
  const runningListeners = new Set<() => void>();
  const completionListeners = new Set<() => void>();
  const settingsListeners = new Set<() => void>();
  let mounted = false;
  let timer: Timer | null = null;
  let releaseVisibility: (() => void) | null = null;

  // Publish all samples before notifying any consumer, so a receipt is atomic.
  const publish = () => {
    const now = anchor === null ? null : environment.now();
    const elapsed = anchor === null ? null : now! - anchor.receivedMonotonic;
    const serverMilliseconds = anchor?.observedAt == null ? null : Date.parse(anchor.observedAt) + elapsed!;
    const nextCompletion = anchorNanoseconds === null ? null : anchorNanoseconds + BigInt(Math.trunc(elapsed! * 1_000_000));
    const nextWarning = anchor === null ? null : anchor.warningMinutes;
    const clockChanged = anchor === null ? clock !== null : clock === null || clock.serverMilliseconds !== serverMilliseconds || clock.warningMinutes !== nextWarning;
    const warningChanged = nextWarning === null ? warning !== null : warning === null || warning.warningMinutes !== nextWarning;
    const completionChanged = completionNow !== nextCompletion;
    if (clockChanged) clock = anchor === null ? null : { serverMilliseconds, warningMinutes: anchor.warningMinutes };
    if (warningChanged) warning = nextWarning === null ? null : { warningMinutes: nextWarning };
    completionNow = nextCompletion;
    if (clockChanged) for (const listener of [...runningListeners]) listener();
    if (warningChanged) for (const listener of [...settingsListeners]) listener();
    if (completionChanged) for (const listener of [...completionListeners]) listener();
  };
  const onVisibility = () => { if (environment.visible()) publish(); synchronizeActivity(); };
  const synchronizeActivity = () => {
    const active = mounted && anchor !== null && (completionListeners.size > 0 || (runningListeners.size > 0 && anchor.observedAt !== null));
    if (active && releaseVisibility === null) releaseVisibility = environment.listen(onVisibility);
    if (!active && releaseVisibility !== null) { releaseVisibility(); releaseVisibility = null; }
    if (!active || !environment.visible()) {
      if (timer !== null) environment.cancel(timer);
      timer = null;
    } else if (timer === null) timer = environment.schedule(publish);
  };
  const subscribeRunning = (listener: () => void) => {
    runningListeners.add(listener);
    publish();
    synchronizeActivity();
    return () => { runningListeners.delete(listener); synchronizeActivity(); };
  };
  const subscribeCompletion = (listener: () => void) => {
    completionListeners.add(listener);
    publish();
    synchronizeActivity();
    return () => { completionListeners.delete(listener); synchronizeActivity(); };
  };
  const subscribeSettings = (listener: () => void) => {
    settingsListeners.add(listener);
    return () => { settingsListeners.delete(listener); };
  };
  const update = (input: ClockInput | null) => {
    anchor = input;
    anchorNanoseconds = input === null ? null : input.observedAt === null
      ? BigInt(input.localTime) * 1_000_000n : timestampNanoseconds(input.observedAt);
    publish();
    synchronizeActivity();
  };
  const mount = () => {
    mounted = true;
    synchronizeActivity();
    return () => { mounted = false; synchronizeActivity(); };
  };
  publish();
  return { getSnapshot: () => clock, getWarningSnapshot: () => warning, getCompletionNow: () => completionNow,
    subscribeRunning, subscribeCompletion, subscribeSettings, update, mount };
};

export type TaskExecutionClock = ReturnType<typeof createTaskExecutionClock>;
