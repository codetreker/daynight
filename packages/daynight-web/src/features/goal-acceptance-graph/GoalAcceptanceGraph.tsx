import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Background, BackgroundVariant, Controls, getViewportForBounds, ReactFlow, useReactFlow, useStore } from '@xyflow/react';
import type { TaskSummary } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { DependencyEdges } from '../task-graph/DependencyEdges';
import { TaskInspectionContext, InspectionLegend, type TaskInspection } from '../task-graph/inspection';
import { layoutGraph, type CanvasLayout, type GraphDirection } from '../task-graph/layout';
import { scaleGraph, useGraphFontScale } from '../task-graph/graph-scale';
import { TaskGraphToolbar } from '../task-graph/TaskGraphToolbar';
import { useGraphFocusRecovery } from '../task-graph/TaskGraphCanvas';
import { GoalAcceptanceNode, type GoalAcceptanceFlowNode } from './GoalAcceptanceNode';
import { acceptanceTopology, projectGoalAcceptance, traceGoalRelations, type GoalAcceptanceGoal } from './model';
import { goalAcceptanceMessages } from './messages';
import './goal-acceptance-graph.css';
import { combineGoalRelations, relationTargets, selectLegalContributions } from './relation-projection';
import type { GoalRelationSnapshot } from './relation-session';
import { GoalRelationStatus } from './GoalRelationStatus';

const nodeTypes = { goalAcceptance: GoalAcceptanceNode };
const InitialFraming = ({ geometry, fullFit }: { geometry: CanvasLayout; fullFit: boolean }) => {
  const { setViewport, viewportInitialized } = useReactFlow();
  const width = useStore(state => state.width), height = useStore(state => state.height);
  const applied = useRef(false);
  useLayoutEffect(() => {
    if (applied.current || !viewportInitialized || width <= 0 || height <= 0 || geometry.nodes.length === 0) return;
    applied.current = true;
    const left = Math.min(...geometry.nodes.map(node => node.position.x));
    const top = Math.min(...geometry.nodes.map(node => node.position.y));
    const right = Math.max(...geometry.nodes.map(node => node.position.x + node.width));
    const bottom = Math.max(...geometry.nodes.map(node => node.position.y + node.height));
    const fit = getViewportForBounds({ x: left, y: top, width: right - left, height: bottom - top }, width, height, fullFit ? 0.00001 : Math.max(0.2, Math.min(0.8, (width - 40) / 240)), 1, 0.15);
    void setViewport(fit, { duration: 0 });
  }, [geometry, fullFit, viewportInitialized, width, height, setViewport]);
  return null;
};

export const GoalAcceptanceGraph = ({ projectId, summaries, onOpenGoal, initialSelectedId = null, fullscreen, relationSnapshot, onRetryRelations }: {
  readonly projectId: string;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly initialSelectedId?: string | null;
  readonly fullscreen?: { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };
  readonly relationSnapshot?: GoalRelationSnapshot;
  readonly onRetryRelations?: (id: string) => void;
}) => {
  const { locale, messages: { graph: graphMessages, common } } = useI18n();
  const m = goalAcceptanceMessages(locale);
  const [direction, setDirection] = useState<GraphDirection>('horizontal');
  const [selected, setSelected] = useState(initialSelectedId);
  const projection = useMemo(() => {
    const baseline = projectGoalAcceptance(summaries, initialSelectedId);
    return relationSnapshot === undefined ? baseline : combineGoalRelations(projectId, baseline,
      [...relationSnapshot.sources.values()].flatMap(source => source.contribution === null ? [] : [source.contribution]), relationSnapshot.deniedIds);
  }, [projectId, summaries, initialSelectedId, relationSnapshot]);
  const readingSnapshot = useMemo(() => {
    if (relationSnapshot === undefined) return undefined;
    const legal = selectLegalContributions(projectId, projectGoalAcceptance(summaries, initialSelectedId),
      [...relationSnapshot.sources.values()].flatMap(source => source.contribution === null ? [] : [source.contribution]), relationSnapshot.deniedIds);
    return legal.conflictingIds.size === 0 ? relationSnapshot : { ...relationSnapshot, sources: new Map([...relationSnapshot.sources].map(([id, source]) =>
      [id, legal.conflictingIds.has(id) ? { ...source, phase: 'conflict' as const, contribution: null } : source])) };
  }, [projectId, summaries, initialSelectedId, relationSnapshot]);
  const selectedId = selected !== null && projection.goals.has(selected) ? selected : null;
  if (selected !== selectedId) setSelected(selectedId);
  const inspect = useCallback((id: string) => setSelected(current => current === id ? null : id), []);
  const clear = useCallback(() => setSelected(null), []);
  const inspection = useMemo<TaskInspection>(() => ({ selectedTaskId: selectedId,
    highlightedIds: traceGoalRelations(projection.prerequisites, selectedId), successorIds: traceGoalRelations(projection.successors, selectedId),
  }), [projection, selectedId]);
  const topology = acceptanceTopology(projection);
  const scale = useGraphFontScale();
  const previous = useRef<{ geometry: CanvasLayout; direction: GraphDirection; scale: number } | null>(null);
  const geometry = useMemo(() => {
    const next = scaleGraph(layoutGraph(projection, undefined, direction), scale);
    const prior = previous.current;
    const anchor = prior !== null && prior.direction === direction && prior.scale === scale
      ? next.nodes.find(node => prior.geometry.nodes.some(old => old.id === node.id)) : undefined;
    const old = anchor === undefined ? undefined : prior!.geometry.nodes.find(node => node.id === anchor.id)!;
    const dx = old === undefined ? 0 : old.position.x - anchor!.position.x;
    const dy = old === undefined ? 0 : old.position.y - anchor!.position.y;
    const anchored = { ...next, nodes: next.nodes.map(node => ({ ...node, position: { x: node.position.x + dx, y: node.position.y + dy } })),
      edges: next.edges.map(edge => ({ ...edge, points: edge.points.map(point => ({ x: point.x + dx, y: point.y + dy })) })) };
    previous.current = { geometry: anchored, direction, scale };
    return anchored;
  }, [topology, direction, scale]);
  const reset = useRef<HTMLButtonElement>(null);
  const fallback = useCallback(() => reset.current, []);
  const { containerRef, onFocusCapture } = useGraphFocusRecovery(geometry, fallback);
  const nodes = useMemo<GoalAcceptanceFlowNode[]>(() => geometry.nodes.map(node => ({ id: node.id, type: 'goalAcceptance',
    position: node.position, width: node.width, height: node.height, style: { width: node.width, height: node.height },
    data: { goal: projection.goals.get(node.id)!, progress: projection.progress.get(node.id), onInspect: inspect, onOpen: onOpenGoal },
  })), [geometry, projection.goals, projection.progress, inspect, onOpenGoal]);
  const [fitRevision, setFitRevision] = useState(0);
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const followRelation = (id: string) => {
    setSelected(id);
    inspectionHeading.current?.focus({ preventScroll: true });
  };
  const targets = readingSnapshot === undefined ? new Map() : relationTargets(
    [...readingSnapshot.sources.values()].flatMap(source => source.contribution === null ? [] : [source.contribution]), readingSnapshot.deniedIds);
  const selectedRelations = selectedId === null ? null : readingSnapshot?.sources.get(selectedId)?.contribution;
  const inspectedPrerequisites = selectedRelations == null ? selectedId === null ? [] : projection.prerequisites.get(selectedId)!
    : selectedRelations.prerequisites.flatMap(item => item.target === null || readingSnapshot!.deniedIds.has(item.target.goalId) || !projection.goals.has(item.target.goalId) && !targets.has(item.target.goalId) ? [] : [item.target.goalId]);
  const inspectedSuccessors = selectedRelations == null ? selectedId === null ? [] : projection.successors.get(selectedId)!
    : selectedRelations.successors.filter(goal => !readingSnapshot!.deniedIds.has(goal.goalId) && (projection.goals.has(goal.goalId) || targets.has(goal.goalId))).map(goal => goal.goalId);
  const relations = (label: string, ids: readonly string[]) => <section><h4>{label}</h4>{ids.length === 0 ? <p>{m.none}</p>
    : <ul>{ids.map(id => { const related = targets.get(id);
      const goal: GoalAcceptanceGoal = projection.goals.get(id) ?? { id, titlePreview: related!.title, titleTruncated: false, status: related!.status,
        ...(related!.projectId === projectId ? {} : { project: { id: related!.projectId, name: related!.projectName } }) }; return <li key={id}>
      <button type="button" className="goal-acceptance-relation" onClick={event => projection.goals.has(id) ? followRelation(id) : onOpenGoal(id, event.currentTarget)}>{goal.titlePreview}</button>
      {goal.project !== undefined && <span className="goal-acceptance-context">{goal.project.name}</span>}<span className={`graph-status graph-status-${goal.status}`}>{common.status[goal.status]}</span>
      {label === m.prerequisites && <span className="goal-acceptance-relation-state">{goal.status === 'done' ? m.satisfied : m.blocking}</span>}
    </li>; })}</ul>}</section>;
  return <div className="task-graph goal-acceptance-graph" ref={containerRef} onFocusCapture={onFocusCapture}>
    <TaskGraphToolbar title={m.title} summary={m.count(projection.goals.size, projection.edges.length)} status=""
      direction={direction} onDirectionChange={setDirection} directionLabel={graphMessages.orientation} horizontalLabel={graphMessages.horizontal} verticalLabel={graphMessages.vertical}
      fullscreen={fullscreen} enterFullscreenLabel={graphMessages.enterFullscreen} exitFullscreenLabel={graphMessages.exitFullscreen}
      resetButton={reset} onReset={() => setFitRevision(current => current + 1)} resetLabel={m.fit} notice={undefined} />
    {readingSnapshot !== undefined && onRetryRelations !== undefined && <GoalRelationStatus snapshot={readingSnapshot} onRetry={onRetryRelations} />}
    <div className="goal-acceptance-reading"><TaskInspectionContext value={inspection}><div className="task-graph-canvas">
      <ReactFlow<GoalAcceptanceFlowNode> id={`goal-acceptance-${projectId}`} aria-label={m.canvas} nodes={nodes} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false}
        onPaneClick={clear} minZoom={0.00001} maxZoom={1.8} deleteKeyCode={null} panActivationKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} autoPanOnNodeFocus={false} ariaLabelConfig={graphMessages.flowAriaLabels}>
        <InitialFraming key={`${direction}:${fitRevision}`} geometry={geometry} fullFit={fitRevision > 0} /><DependencyEdges geometry={geometry} inspection={inspection} />
        <Background variant={BackgroundVariant.Dots} gap={18} size={0.8} color="#d9dee9" bgColor="#fafbfe" />
        <Controls orientation="horizontal" position="bottom-left" showInteractive={false} />
      </ReactFlow>
      {projection.goals.size === 0 && <div className="goal-acceptance-empty">{m.empty}</div>}
    </div></TaskInspectionContext>
    <aside className="goal-acceptance-inspection" aria-label={m.inspect}>
      <p className="goal-acceptance-scope">{m.knownOnly}</p>
      {selectedId === null ? <p>{m.inspect}</p> : <><h3 ref={inspectionHeading} tabIndex={-1}>{projection.goals.get(selectedId)!.titlePreview}</h3>
        <p><span className={`graph-status graph-status-${projection.goals.get(selectedId)!.status}`}>{common.status[projection.goals.get(selectedId)!.status]}</span></p>
        {projection.goals.get(selectedId)!.project !== undefined && <p>{projection.goals.get(selectedId)!.project!.name}</p>}
        {projection.progress.has(selectedId) && <p>{m.progress(projection.progress.get(selectedId)!.done, projection.progress.get(selectedId)!.total)}</p>}
        {relations(m.prerequisites, inspectedPrerequisites)}{relations(m.successors, inspectedSuccessors)}
        <button type="button" className="button secondary" aria-haspopup="dialog" onClick={event => onOpenGoal(selectedId, event.currentTarget)}>{m.details}</button></>}
    </aside></div>
    <div className="graph-foot"><span>{graphMessages.directionLegend}</span><InspectionLegend /></div>
  </div>;
};
