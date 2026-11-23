import { useId, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskGraphDialogShell } from '../task-graph/TaskGraphDialogShell';
import { ProjectGraphErrorDetail } from '../projects/ProjectGraphError';
import { GoalAcceptanceGraph } from './GoalAcceptanceGraph';
import { goalAcceptanceMessages } from './messages';

export const GoalAcceptanceDialog = ({ onClose, onRestoreFocus, renderNested, graphError, onRefreshGraph, ...graph }: ComponentProps<typeof GoalAcceptanceGraph> & {
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly graphError?: unknown;
  readonly onRefreshGraph?: () => void;
}) => {
  const { locale, messages: { workspace: { project } } } = useI18n(), m = goalAcceptanceMessages(locale), titleId = useId();
  return <TaskGraphDialogShell dialogId={`goal-acceptance-dialog-${graph.projectId}`} labelId={titleId} focusRevision={graph.summaries}
    onClose={onClose} onRestoreFocus={onRestoreFocus} {...(renderNested === undefined ? {} : { renderNested })}
    header={close => <header className="task-chain-header"><span className="task-chain-icon" aria-hidden="true">◎</span>
      <div className="task-chain-heading"><h2 id={titleId}>{m.title}</h2></div>
      <button ref={close} type="button" className="task-chain-close" aria-label={m.close} onClick={onClose}>×</button>
    </header>}>
    {fullscreen => <><GoalAcceptanceGraph {...graph} fullscreen={fullscreen} />
      {graphError != null && <div className="task-detail-graph-error" role="alert"><h2>{project.refreshFailed}</h2><p>{project.showingSnapshot}</p><ProjectGraphErrorDetail error={graphError} />
        {onRefreshGraph !== undefined && <button type="button" className="button" onClick={onRefreshGraph}>{project.retryRefresh}</button>}</div>}</>}
  </TaskGraphDialogShell>;
};
