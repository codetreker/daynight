import { useEffect, useRef, useState } from 'react';
import { browserNavigation } from '../../app/navigation';
import { OverlayOwnerContext } from '../../app/overlay';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskDetailDialog } from '../task-detail/TaskDetailDialog';
import { ProjectDraftHost } from '../task-detail/TaskDraftNavigation';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { GoalAcceptanceDialog } from './GoalAcceptanceDialog';

export const GoalAcceptanceHost = ({ projectId, snapshot, detailSnapshot, trigger, onClose, onRefreshGraph, graphError }: {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot;
  readonly detailSnapshot: GraphSnapshot | null;
  readonly trigger: HTMLElement;
  readonly onClose: () => void;
  readonly onRefreshGraph: () => void;
  readonly graphError?: unknown;
}) => {
  const scope = useTaskCacheScope();
  const [detail, setDetail] = useState<{ id: string; trigger: HTMLElement; historyGeneration: number } | null>(null);
  const navigation = browserNavigation();
  const entry = useRef(navigation.snapshot());
  useEffect(() => navigation.subscribe(() => {
    const next = navigation.snapshot(), original = entry.current;
    if (next.entryId !== original.entryId || next.pathname !== original.pathname || next.search !== original.search || next.hash !== original.hash) onClose();
  }), [navigation, onClose]);
  const requestClose = () => navigation.requestAction(onClose);
  const selected = detail !== null && detailSnapshot !== null && detail.historyGeneration === scope.getHistoryGeneration(projectId) && detailSnapshot.summaries.get(detail.id)?.type === 'goal' ? detail : null;
  if (detail !== null && selected === null) setDetail(null);
  const openDetail = (id: string, control: HTMLElement) => { if (detailSnapshot !== null && detailSnapshot.summaries.get(id)?.type === 'goal') navigation.requestAction(() => setDetail({ id, trigger: control, historyGeneration: scope.getHistoryGeneration(projectId) })); };
  return <GoalAcceptanceDialog projectId={projectId} summaries={snapshot.summaries} onOpenGoal={openDetail} onClose={requestClose} graphError={graphError} onRefreshGraph={onRefreshGraph}
    onRestoreFocus={() => { (trigger.isConnected ? trigger : document.getElementById('project-task-tab-goals'))?.focus({ preventScroll: true }); }}
    renderNested={owner => selected === null ? null : <OverlayOwnerContext value={owner}>
      <ProjectDraftHost projectId={projectId} taskId={selected.id} source="summary" summaryType="goal" insideProjectGraph={false} graphWitness={null}>
        <TaskDetailDialog key={`${scope.userId}/${projectId}/${selected.id}`} projectId={projectId} taskId={selected.id} snapshot={detailSnapshot}
          onSelectTask={id => navigation.requestAction(() => setDetail({ id, trigger: selected.trigger, historyGeneration: scope.getHistoryGeneration(projectId) }))}
          onClose={() => setDetail(null)} onRestoreFocus={() => { (selected.trigger.isConnected ? selected.trigger : owner.current?.querySelector<HTMLElement>('.graph-reset-overview'))?.focus({ preventScroll: true }); }} onRefreshGraph={onRefreshGraph} />
      </ProjectDraftHost>
    </OverlayOwnerContext>} />;
};
