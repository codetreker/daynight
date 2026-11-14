import { createContext, useContext, type ReactNode, type MouseEvent, type Ref } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import '../../styles/task-pause.css';

const TaskPauseContext = createContext<ReadonlySet<string>>(new Set());
export const TaskPauseProvider = ({ taskIds, children }: { readonly taskIds: ReadonlySet<string>; readonly children: ReactNode }) =>
  <TaskPauseContext.Provider value={taskIds}>{children}</TaskPauseContext.Provider>;
export const usePausedTaskIds = (): ReadonlySet<string> => useContext(TaskPauseContext);
export const useTaskPaused = (taskId: string): boolean => usePausedTaskIds().has(taskId);

export const TaskPauseIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3.5" height="11" rx=".8" /><rect x="9.5" y="2.5" width="3.5" height="11" rx=".8" /></svg>;

export const TaskPausedBadge = ({ compact = false }: { readonly compact?: boolean }) => {
  const { messages: { inspection: { pause: m } } } = useI18n();
  return <span className={`task-paused-badge${compact ? ' compact' : ''}`}><TaskPauseIcon />{m.label}</span>;
};

export const TaskPauseCount = ({ count, label, onClick, buttonRef, expanded, controls }: { readonly count: number; readonly label?: string; readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void; readonly buttonRef?: Ref<HTMLButtonElement>; readonly expanded?: boolean; readonly controls?: string }) => {
  const { messages: { inspection: { pause: m } }, format } = useI18n();
  if (count === 0) return null;
  const content = <><TaskPauseIcon />{m.count(format.number(count))}</>;
  return onClick === undefined ? <span className="task-pause-count">{content}</span> : <button className="task-pause-count" type="button" ref={buttonRef} aria-label={label} aria-haspopup={expanded === undefined ? undefined : 'menu'} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>{content}</button>;
};
