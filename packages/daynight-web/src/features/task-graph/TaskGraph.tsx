import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskSummary } from '../../api/types';
import { getTaskNodeHeight, layoutGraph, type CanvasLayout, type GraphDirection } from './layout';
import { projectChain, tracePrerequisites, type GraphIndex, type ChainProjection } from './model';
import type { TaskFlowNode } from './TaskNode';
import { getInitialTaskViewport } from './chain-viewport';
import { TaskGraphCanvas, useGraphFocusRecovery } from './TaskGraphCanvas';
import { TaskGraphToolbar } from './TaskGraphToolbar';
import { createGraphOverview, getTaskExpansion, projectVisibleTasks, reconcileVisibleTasks, type TaskExpansionDirection, type TaskExpansions } from './visibility';

type TaskGraphProps = {
  index: GraphIndex;
  summaries?: ReadonlyMap<string, TaskSummary>;
  direction?: GraphDirection;
  onDirectionChange?: (direction: GraphDirection) => void;
  directionIssue?: 'read' | 'invalid' | 'write' | undefined;
  rootId: string;
  onOpenTask: (id: string, trigger: HTMLElement) => void;
  onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  fullscreen?: { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };
};

const emptyHighlight: ReadonlySet<string> = new Set();
const viewportFitOptions = { minZoom: 0.2, maxZoom: 1, padding: 0.15 };
type ViewportAction = { readonly kind: 'expand'; readonly sequence: number; readonly anchorId: string } | { readonly kind: 'reset'; readonly sequence: number };

type CanvasProps = TaskGraphProps & { topologyKey: string; selectedTaskId: string | null; onInspectTask: (id: string) => void; clearInspection: () => void; geometry: CanvasLayout; projection: ChainProjection; visibleIds: ReadonlySet<string>; expansions: ReadonlyMap<string, TaskExpansions>; action: ViewportAction | null; onExpandTask: (id: string, direction: TaskExpansionDirection) => void; onResetOverview: () => void };

const TaskCanvas = ({ index, summaries, rootId, onOpenTask, onNavigateExternalTask = onOpenTask, fullscreen, direction = 'horizontal', onDirectionChange, directionIssue, geometry, projection, visibleIds, expansions, action, onExpandTask, onResetOverview, topologyKey, selectedTaskId, onInspectTask, clearInspection }: CanvasProps) => {
  const { messages: { graph: m } } = useI18n();
  const resetButton = useRef<HTMLButtonElement>(null);
  const { containerRef, onFocusCapture } = useGraphFocusRecovery(geometry, fullscreen?.buttonRef ?? resetButton, fullscreen);
  const highlightedIds = useMemo(() => selectedTaskId === null ? emptyHighlight : tracePrerequisites(index, selectedTaskId), [index, selectedTaskId]);
  const inspection = useMemo(() => ({ selectedTaskId, highlightedIds }), [selectedTaskId, highlightedIds]);
  const hiddenUpstreamCount = useMemo(() => [...highlightedIds].filter((id) => !visibleIds.has(id)).length, [highlightedIds, visibleIds]);
  const totalTasks = projection.mainIds.size + projection.externalIds.size;
  const folded = visibleIds.size < totalTasks;
  const nodes = useMemo<TaskFlowNode[]>(() => geometry.nodes.map((node) => ({
    id: node.id, position: node.position, type: 'task', width: node.width, height: node.height,
    style: { width: node.width, height: node.height },
    data: {
      task: index.nodes.get(node.id)!, kind: node.kind,
      ownerLabel: summaries === undefined ? null : (() => {
        const parentId = index.nodes.get(node.id)!.parentId;
        if (parentId === null) return m.unassignedGoal;
        const goal = summaries.get(parentId);
        return goal?.type === 'goal' ? m.goalOwner({ title: `${goal.titlePreview}${goal.titleTruncated ? '…' : ''}` }) : m.unavailableGoal({ id: parentId });
      })(),
      center: { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 },
      size: { width: node.width, height: node.height },
      onInspectTask, onOpenTask, onNavigateExternalTask, onExpandTask,
      revealRequest: action?.kind === 'expand' && action.anchorId === node.id ? action.sequence : null,
      expansions: expansions.get(node.id)!,
    },
  })), [geometry, index, summaries, m, expansions, action, onInspectTask, onOpenTask, onNavigateExternalTask, onExpandTask]);
  const viewportFactory = useCallback((width: number, height: number) => getInitialTaskViewport(geometry, rootId, width, height, folded), [geometry, rootId, folded]);
  const onFramingReset = useCallback(() => resetButton.current?.focus({ preventScroll: true }), []);
  return (
    <div className="task-graph" data-hidden-upstream-count={hiddenUpstreamCount} data-visible-task-count={visibleIds.size} data-total-task-count={totalTasks} ref={containerRef} onFocusCapture={onFocusCapture}>
      <TaskGraphToolbar
        title={m.title}
        summary={m.counts({ main: projection.mainIds.size, external: projection.externalIds.size, visible: visibleIds.size, total: totalTasks, edges: geometry.edges.length, dependencies: projection.edges.length })}
        status={hiddenUpstreamCount === 0 ? '' : m.hiddenPrerequisites({ count: hiddenUpstreamCount })}
        direction={direction} onDirectionChange={onDirectionChange} directionLabel={m.orientation}
        horizontalLabel={m.horizontal} verticalLabel={m.vertical}
        fullscreen={fullscreen} enterFullscreenLabel={m.enterFullscreen} exitFullscreenLabel={m.exitFullscreen}
        resetButton={resetButton} onReset={onResetOverview} resetLabel={m.resetOverview}
        notice={directionIssue === undefined ? undefined : m.orientationIssue[directionIssue]}
      />
      <TaskGraphCanvas canvasId={`flow-${rootId}`} nodes={nodes} geometry={geometry} inspection={inspection}
        onClearInspection={clearInspection} viewportFactory={viewportFactory} framingKey={`${topologyKey}:${direction}`}
        framingRevision={action?.kind === 'reset' ? action.sequence : null} onFramingReset={onFramingReset}
        minZoom={0.2} maxZoom={1.8} fitViewOptions={viewportFitOptions} />
      <div className="graph-foot"><span>{m.directionLegend}</span><span>{m.externalLegend}</span></div>
    </div>
  );
};

const LayoutError = () => {
  const { messages: { graph: m } } = useI18n();
  return <div className="graph-error" role="alert"><h3>{m.layoutErrorTitle}</h3><p>{m.layoutErrorDescription}</p></div>;
};

type GraphVisibility = {
  readonly projection: ChainProjection;
  readonly topologyKey: string;
  readonly ids: ReadonlySet<string>;
  readonly action: ViewportAction | null;
  readonly inspectionId: string | null;
};

const VisibleTaskGraph = ({ projection, ...props }: TaskGraphProps & { projection: ChainProjection }) => {
  const topologyKey = [...projection.mainIds].join(',');
  const [visibility, setVisibility] = useState<GraphVisibility>(() => ({
    projection, topologyKey, ids: createGraphOverview(props.index, projection), action: null, inspectionId: null,
  }));
  const sequence = useRef(0);
  const topologyChanged = visibility.topologyKey !== topologyKey;
  const visibleIds = useMemo(() => topologyChanged ? createGraphOverview(props.index, projection)
    : visibility.projection === projection ? visibility.ids : reconcileVisibleTasks(projection, visibility.ids), [props.index, projection, topologyChanged, visibility]);
  const action = topologyChanged ? null : visibility.action;
  const selectedTaskId = !topologyChanged && visibility.inspectionId !== null && visibleIds.has(visibility.inspectionId) ? visibility.inspectionId : null;
  useEffect(() => {
    if (visibility.projection !== projection) setVisibility({ projection, topologyKey, ids: visibleIds, action, inspectionId: selectedTaskId });
  }, [projection, topologyKey, visibility.projection, visibleIds, action, selectedTaskId]);
  const visibleProjection = useMemo(() => projectVisibleTasks(projection, visibleIds), [projection, visibleIds]);
  const expansions = useMemo(() => new Map([...visibleIds].map((id) => [id, {
    prerequisites: getTaskExpansion(props.index, projection, visibleIds, id, 'prerequisites'),
    successors: getTaskExpansion(props.index, projection, visibleIds, id, 'successors'),
  }])), [props.index, projection, visibleIds]);
  const result = useMemo(() => {
    try {
      performance.clearMeasures('daynight:task-layout');
      const started = performance.now();
      const geometry = layoutGraph(visibleProjection, new Map([...expansions].map(([id, directions]) => [id, getTaskNodeHeight(directions, projection.externalIds.has(id))])), props.direction ?? 'horizontal');
      performance.measure('daynight:task-layout', { start: started, end: performance.now(), detail: { rootId: props.rootId } });
      return { kind: 'ready' as const, geometry };
    } catch (error) { return { kind: 'error' as const, error }; }
  }, [visibleProjection, expansions, projection.externalIds, props.rootId, props.direction]);
  const onInspectTask = useCallback((id: string) => {
    setVisibility((current) => ({ ...current, inspectionId: current.inspectionId === id ? null : id }));
  }, []);
  const clearInspection = useCallback(() => {
    setVisibility((current) => current.inspectionId === null ? current : { ...current, inspectionId: null });
  }, []);
  const onExpandTask = useCallback((id: string, direction: TaskExpansionDirection) => {
    const expansion = expansions.get(id)![direction];
    if (expansion.ids.length === 0) return;
    const action: ViewportAction = { kind: 'expand', sequence: ++sequence.current, anchorId: id };
    setVisibility((current) => ({ projection, topologyKey, ids: new Set([...visibleIds, ...expansion.ids]), action,
      inspectionId: current.topologyKey === topologyKey ? current.inspectionId : null }));
  }, [expansions, projection, topologyKey, visibleIds]);
  const onResetOverview = useCallback(() => {
    const ids = createGraphOverview(props.index, projection);
    const action: ViewportAction = { kind: 'reset', sequence: ++sequence.current };
    setVisibility((current) => ({ projection, topologyKey, ids, action,
      inspectionId: current.topologyKey === topologyKey && current.inspectionId !== null && ids.has(current.inspectionId) ? current.inspectionId : null }));
  }, [props.index, projection, topologyKey]);
  return result.kind === 'error' ? <LayoutError /> : <TaskCanvas {...props} topologyKey={topologyKey} selectedTaskId={selectedTaskId}
    onInspectTask={onInspectTask} clearInspection={clearInspection} geometry={result.geometry} projection={projection} visibleIds={visibleIds}
    expansions={expansions} action={action} onExpandTask={onExpandTask} onResetOverview={onResetOverview} />;
};

export const TaskGraph = (props: TaskGraphProps) => {
  const result = useMemo(() => {
    try { return { kind: 'ready' as const, projection: projectChain(props.index, props.rootId) }; }
    catch (error) { return { kind: 'error' as const, error }; }
  }, [props.index, props.rootId]);
  return result.kind === 'error' ? <LayoutError /> : <VisibleTaskGraph key={props.rootId} {...props} projection={result.projection} />;
};
