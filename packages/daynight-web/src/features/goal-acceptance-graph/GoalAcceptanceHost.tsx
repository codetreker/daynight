import { useEffect, useRef, useState } from 'react';
import { browserNavigation } from '../../app/navigation';
import { OverlayOwnerContext } from '../../app/overlay';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskDetailDialog } from '../task-detail/TaskDetailDialog';
import { LocalTaskDraftHost } from '../task-detail/TaskDraftNavigation';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { GoalAcceptanceDialog } from './GoalAcceptanceDialog';
import { useGoalRelationSession } from './useGoalRelationSession';
import { relationTargets } from './relation-projection';
import { useGoalAcceptanceOwner } from './GoalAcceptanceContext';

export const GoalAcceptanceHost = ({ projectId, snapshot, detailSnapshot, trigger, onClose, onRefreshGraph, graphError, initialSelectedId = null, onRestoreFocus, onSourceUnavailable }: {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot;
  readonly detailSnapshot: GraphSnapshot | null;
  readonly trigger: HTMLElement;
  readonly onClose: () => void;
  readonly onRefreshGraph: () => void;
  readonly graphError?: unknown;
  readonly initialSelectedId?: string | null;
  readonly onRestoreFocus?: () => void;
  readonly onSourceUnavailable?: () => void;
}) => {
  const scope = useTaskCacheScope();
  const acceptanceOwner = useGoalAcceptanceOwner();
  const relations = useGoalRelationSession(projectId, detailSnapshot === null ? null : snapshot.summaries, initialSelectedId);
  const external = relationTargets([...relations.snapshot.sources.values()].flatMap(source => source.contribution === null ? [] : [source.contribution]), relations.snapshot.deniedIds);
  const [detail, setDetail] = useState<{ id: string; projectId: string; trigger: HTMLElement; historyGeneration: number; draftIdentity: object } | null>(null);
  const navigation = browserNavigation();
  const entry = useRef(navigation.snapshot());
  useEffect(() => navigation.subscribe(() => {
    const next = navigation.snapshot(), original = entry.current;
    if (next.entryId !== original.entryId || next.pathname !== original.pathname || next.search !== original.search || next.hash !== original.hash) onClose();
  }), [navigation, onClose]);
  const requestDetailAction = (action: () => void) => {
    if (detail === null) action();
    else navigation.requestScopeAction({ identity: detail.draftIdentity, projectId: detail.projectId, taskId: detail.id }, action);
  };
  const requestClose = () => requestDetailAction(onClose);
  useEffect(() => { if (initialSelectedId !== null && relations.snapshot.deniedIds.has(initialSelectedId)) (onSourceUnavailable ?? onClose)(); }, [initialSelectedId, relations.snapshot.deniedIds, onClose, onSourceUnavailable]);
  const selected = detail !== null && detailSnapshot !== null && !relations.snapshot.deniedIds.has(detail.id) && detail.historyGeneration === scope.getHistoryGeneration(detail.projectId) &&
    (detail.projectId === projectId ? detailSnapshot.summaries.get(detail.id)?.type === 'goal' : external.get(detail.id)?.projectId === detail.projectId) ? detail : null;
  if (detail !== null && selected === null) setDetail(null);
  const openDetail = (id: string, control: HTMLElement) => {
    const sourceProjectId = detailSnapshot?.summaries.get(id)?.type === 'goal' ? projectId : external.get(id)?.projectId;
    if (detailSnapshot !== null && sourceProjectId !== undefined && !relations.snapshot.deniedIds.has(id)) requestDetailAction(() => setDetail({ id, projectId: sourceProjectId, trigger: control, historyGeneration: scope.getHistoryGeneration(sourceProjectId), draftIdentity: {} }));
  };
  return <GoalAcceptanceDialog projectId={projectId} summaries={snapshot.summaries} initialSelectedId={initialSelectedId} relationSnapshot={relations.snapshot} onRetryRelations={relations.retry} onInspectRelations={relations.inspect} onExpandRelations={relations.expand} onOpenGoal={openDetail} onClose={requestClose} graphError={graphError} onRefreshGraph={onRefreshGraph}
    onRestoreFocus={onRestoreFocus ?? (() => { (trigger.isConnected ? trigger : document.getElementById('project-task-tab-goals'))?.focus({ preventScroll: true }); })}
    renderNested={owner => {
      if (selected === null) return null;
      const reader = <LocalTaskDraftHost identity={selected.draftIdentity}>
        <TaskDetailDialog key={`${scope.userId}/${selected.projectId}/${selected.id}`} projectId={selected.projectId} taskId={selected.id} snapshot={selected.projectId === projectId ? detailSnapshot : null}
          {...(selected.projectId === projectId ? {} : { observation: { kind: 'direct' as const } })}
          onSelectTask={id => requestDetailAction(() => setDetail({ id, projectId: selected.projectId, trigger: selected.trigger, historyGeneration: scope.getHistoryGeneration(selected.projectId), draftIdentity: {} }))}
          onClose={() => requestDetailAction(() => setDetail(null))} onRestoreFocus={() => { (selected.trigger.isConnected ? selected.trigger : owner.current?.querySelector<HTMLElement>('.graph-reset-overview'))?.focus({ preventScroll: true }); }} onRefreshGraph={onRefreshGraph} />
      </LocalTaskDraftHost>;
      return <OverlayOwnerContext value={owner}>{acceptanceOwner === null ? reader : acceptanceOwner.renderRelated(selected.projectId, reader)}</OverlayOwnerContext>;
    }} />;
};
