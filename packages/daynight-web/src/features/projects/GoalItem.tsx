import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import type { GraphIndex } from '../task-graph/model';
import { projectTaskScope } from '../task-graph/scope';
import { ScopedTaskChainRow } from '../task-graph/ScopedTaskChainRow';
import { goalListContents } from './goal-list-model';
import { StandaloneTaskRow } from './StandaloneTaskRow';

export const GoalItem = ({ projectId, index, goal, workerMachines, openChainId, onOpenGoal, onOpenListTask, onOpenListChain, onOpenSession }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly goal: TaskSummary;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>>;
  readonly openChainId: string | null;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly onOpenListTask: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenListChain: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
}) => {
  const { messages: { workspace: { goals: m }, graph, common } } = useI18n();
  const scope = useMemo(() => projectTaskScope(index, goal.id), [index, goal.id]);
  const contents = useMemo(() => goalListContents(scope, index), [scope, index]);
  const [expanded, setExpanded] = useState(false);
  const [expandedChainIds, setExpandedChainIds] = useState<ReadonlySet<string>>(() => new Set());
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const valid = new Set(contents.chains.map((chain) => chain.representativeId));
    setExpandedChainIds((current) => {
      if ([...current].every((id) => valid.has(id))) return current;
      return new Set([...current].filter((id) => valid.has(id)));
    });
  }, [contents.chains]);
  const title = `${goal.titlePreview}${goal.titleTruncated ? '…' : ''}`;
  const childrenId = `project-goal-children-${goal.id}`;
  const { total: count, done, cancelled } = scope.progress;
  return <li className="goal-list-card" data-goal-id={goal.id} ref={root}>
    <div className="goal-list-row">
      <button ref={toggle} className="goal-list-toggle" type="button" aria-label={m.toggle({ title, expanded })} aria-expanded={expanded} aria-controls={childrenId} onClick={() => {
        if (expanded && content.current?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true });
        setExpanded(!expanded);
      }}><svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
      <span className="goal-list-icon" aria-hidden="true">◎</span>
      <span className="goal-list-main"><button className="goal-list-title" id={`project-goal-${goal.id}`} type="button" aria-haspopup="dialog" onClick={(event) => onOpenGoal(goal.id, event.currentTarget)}>{title}</button>
        <span className="goal-list-meta"><TaskAssigneeIdentity projectId={projectId} assignedTo={goal.assignedTo} /><span>{m.composition({ chains: scope.chains.length, standalone: scope.standaloneIds.length })}</span></span></span>
      <span className="goal-list-progress"><span>{graph.progress({ done, cancelled, total: count })}</span><span className="goal-list-track" aria-hidden="true"><i style={{ width: `${count === 0 ? 0 : done / count * 100}%` }} /><i className="goal-list-cancelled" style={{ width: `${count === 0 ? 0 : cancelled / count * 100}%` }} /></span></span>
      <span className={`root-status graph-status-${goal.status}`}>{common.status[goal.status]}</span>
    </div>
    <div id={childrenId} ref={content} hidden={!expanded} className="goal-list-contents">{expanded && <>
      {count === 0 && <p className="goal-list-empty">{m.emptyTasks}</p>}
      {contents.standaloneIds.length > 0 && <section aria-label={m.standalone}><h3>{m.standalone} <span>{contents.standaloneIds.length}</span></h3><ul className="standalone-list">{contents.standaloneIds.map((id) => <StandaloneTaskRow key={id} projectId={projectId} task={index.nodes.get(id)!} instanceId={`goal-${goal.id}-task-${id}`} onSelectTask={(taskId, trigger) => onOpenListTask(taskId, trigger, goal.id)} />)}</ul></section>}
      {contents.chains.length > 0 && <section aria-label={m.chains}><h3>{m.chains} <span>{contents.chains.length}</span></h3><ul className="root-list">{contents.chains.map((chain) => {
        const instanceId = `goal-${goal.id}-chain-${chain.representativeId}`;
        return <ScopedTaskChainRow key={chain.representativeId} projectId={projectId} index={index} rootId={chain.representativeId} memberIds={chain.memberIds} progress={chain.progress} workerMachines={workerMachines} instanceId={instanceId} expanded={expandedChainIds.has(chain.representativeId)} onExpandedChange={(value) => {
          if (!value) {
            const children = root.current?.querySelector<HTMLElement>(`[id="goal-children-${instanceId}"]`);
            if (children?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>(`[id="task-root-${instanceId}"]`)?.focus({ preventScroll: true });
          }
          setExpandedChainIds((current) => { const next = new Set(current); if (value) next.add(chain.representativeId); else next.delete(chain.representativeId); return next; });
        }} open={openChainId === chain.representativeId} onOpenChain={(id, trigger) => onOpenListChain(id, trigger, goal.id)} onOpenTask={(id, trigger) => onOpenListTask(id, trigger, goal.id)} {...(onOpenSession === undefined ? {} : { onOpenSession })} />;
      })}</ul></section>}
    </>}</div>
  </li>;
};
