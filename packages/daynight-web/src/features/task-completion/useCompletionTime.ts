import { useMemo, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { timestampNanoseconds } from "../../time/timestamp";
import { useTaskExecutionClock } from "../task-execution/TaskExecutionClock";
import type { TaskExecutionClock } from "../task-execution/clock";
import { formatCompletionLabel } from "./format";
import { completionReading, type CompletionReading } from "./model";

export type CompletionValue = { readonly timestamp: string; readonly label: string; readonly exact: string };

const equalReading = (left: CompletionReading | null, right: CompletionReading): boolean => {
  if (left === null || left.kind !== right.kind) return false;
  if (left.kind === "relative" && right.kind === "relative") return left.unit === right.unit && left.value === right.value;
  if (left.kind === "absolute" && right.kind === "absolute") return left.includeYear === right.includeYear;
  return true;
};

const inactiveSubscription = () => () => {};
const inactiveSnapshot = () => null;

// This adapter is local to a hook instance; render-time reads acquire no global resources.
const completionAdapter = (clock: TaskExecutionClock, completedAt: string) => {
  const timestamp = timestampNanoseconds(completedAt);
  let cached: CompletionReading | null = null;
  return {
    subscribe: clock.subscribeCompletion,
    getSnapshot: () => {
      const now = clock.getCompletionNow();
      if (now === null) return cached = null;
      const next = completionReading(timestamp, now);
      if (!equalReading(cached, next)) cached = next;
      return cached;
    },
  };
};

export const useCompletionTime = (completedAt: string | null): CompletionValue | null => {
  const clock = useTaskExecutionClock();
  if (completedAt !== null && clock === null) throw new Error("A completion time requires TaskExecutionClockProvider.");
  const { locale, format } = useI18n();
  const adapter = useMemo(() => clock === null || completedAt === null ? null : completionAdapter(clock, completedAt), [clock, completedAt]);
  const reading = useSyncExternalStore(adapter?.subscribe ?? inactiveSubscription, adapter?.getSnapshot ?? inactiveSnapshot, adapter?.getSnapshot ?? inactiveSnapshot);
  return useMemo(() => reading === null || completedAt === null ? null : {
    timestamp: completedAt, label: formatCompletionLabel(reading, completedAt, locale), exact: format.dateTime(completedAt),
  }, [reading, completedAt, locale, format]);
};
