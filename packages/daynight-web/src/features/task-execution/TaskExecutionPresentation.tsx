import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskExecution } from "./clock";

export type { TaskExecution } from "./clock";

const ClockIcon = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="8" cy="8" r="5.7" /><path d="M8 4.5V8l2.5 1.5" /></svg>;

export const TaskExecutionWarning = () => {
  const { messages: { execution: m } } = useI18n();
  return <span className="task-stuck-label"><svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1 11 10H1Z" fill="currentColor" /><path d="M6 4v2.6m0 1.2v.7" stroke="#fff" strokeWidth="1.1" /></svg>{m.possiblyStuck}</span>;
};

export const TaskExecutionDuration = ({ execution, tooltip = "execution" }: {
  readonly execution: TaskExecution;
  readonly tooltip?: "execution" | "duration";
}) => {
  const { format, messages: { execution: m } } = useI18n();
  const duration = format.duration(execution.elapsedMilliseconds);
  return <time className="task-duration" dateTime={`PT${(execution.elapsedMilliseconds / 1000).toFixed(3)}S`}
    title={tooltip === "duration" ? duration : m.description({ ...execution, duration })}><ClockIcon /><span>{duration}</span></time>;
};

export const TaskExecutionDescription = ({ execution, id }: { readonly execution: TaskExecution; readonly id: string }) => {
  const { format, messages: { execution: m } } = useI18n();
  return <span id={id} className="task-execution-description">{m.description({ ...execution, duration: format.duration(execution.elapsedMilliseconds) })}</span>;
};
