import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { Background, BackgroundVariant, Controls, getViewportForBounds, ReactFlow, useReactFlow, useStore, type Viewport } from '@xyflow/react';
import { getTaskNodeHeight, layoutGraph, type CanvasLayout } from './layout';
import { projectChain, tracePrerequisites, type GraphIndex, type ChainProjection } from './model';
import { TaskNode, type TaskFlowNode } from './TaskNode';
import { DependencyEdges } from './DependencyEdges';
import { TaskInspectionContext, useTaskInspection } from './inspection';
import { createGraphOverview, getTaskExpansion, projectVisibleTasks, reconcileVisibleTasks, type TaskExpansionDirection, type TaskExpansions } from './visibility';
import '@xyflow/react/dist/style.css';

type TaskGraphProps = {
  index: GraphIndex;
  rootId: string;
  onOpenTask: (id: string, trigger: HTMLElement) => void;
  fullscreen?: { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };
};

const emptyHighlight: ReadonlySet<string> = new Set();
const InspectedEdges = memo(({ geometry }: { geometry: CanvasLayout }) => {
  const inspection = useTaskInspection();
  return <DependencyEdges geometry={geometry} inspection={inspection} />;
});

const nodeTypes = { task: TaskNode };
const viewportFitOptions = { minZoom: 0.2, maxZoom: 1, padding: 0.15 };
export const getInitialTaskViewport = (geometry: CanvasLayout, rootId: string, width: number, height: number, anchorRoot = false): Viewport => {
  const left = Math.min(...geometry.nodes.map((node) => node.position.x));
  const top = Math.min(...geometry.nodes.map((node) => node.position.y));
  const right = Math.max(...geometry.nodes.map((node) => node.position.x + node.width));
  const bottom = Math.max(...geometry.nodes.map((node) => node.position.y + node.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const fitted = getViewportForBounds(bounds, width, height, 0.8, 1, 0.15);
  if (bounds.width * fitted.zoom <= width && bounds.height * fitted.zoom <= height) return fitted;
  const root = geometry.nodes.find((node) => node.id === rootId)!;
  const upstreamTop = Math.min(...geometry.nodes.filter((node) => node.position.x === left).map((node) => node.position.y));
  if (anchorRoot) return { x: 32 - root.position.x * fitted.zoom, y: height / 2 - (root.position.y + root.height / 2) * fitted.zoom, zoom: fitted.zoom };
  return {
    x: 32 - left * fitted.zoom,
    y: root.position.x === left
      ? height / 2 - (root.position.y + root.height / 2) * fitted.zoom
      : 32 - upstreamTop * fitted.zoom,
    zoom: fitted.zoom,
  };
};

type ViewportAction = { readonly kind: 'expand'; readonly sequence: number; readonly anchorId: string } | { readonly kind: 'reset'; readonly sequence: number };

const InitialViewport = ({ geometry, rootId, folded, action, resetButton }: { geometry: CanvasLayout; rootId: string; folded: boolean; action: ViewportAction | null; resetButton: { current: HTMLButtonElement | null } }) => {
  const { setViewport, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const applied = useRef(false);
  const resetSequence = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!viewportInitialized || width <= 0 || height <= 0) return;
    const reset = action?.kind === 'reset' && action.sequence !== resetSequence.current;
    if (applied.current && !reset) return;
    applied.current = true;
    if (reset) resetSequence.current = action.sequence;
    void setViewport(getInitialTaskViewport(geometry, rootId, width, height, folded), { duration: 0 });
    if (reset) resetButton.current?.focus({ preventScroll: true });
  }, [geometry, rootId, folded, action, resetButton, viewportInitialized, width, height, setViewport]);
  return null;
};

type CanvasProps = TaskGraphProps & { topologyKey: string; selectedTaskId: string | null; onInspectTask: (id: string) => void; clearInspection: () => void; geometry: CanvasLayout; projection: ChainProjection; visibleIds: ReadonlySet<string>; expansions: ReadonlyMap<string, TaskExpansions>; action: ViewportAction | null; onExpandTask: (id: string, direction: TaskExpansionDirection) => void; onResetOverview: () => void };

const TaskCanvas = ({ index, rootId, onOpenTask, fullscreen, geometry, projection, visibleIds, expansions, action, onExpandTask, onResetOverview, topologyKey, selectedTaskId, onInspectTask, clearInspection }: CanvasProps) => {
  const { messages: { graph: m } } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const focusedNode = document.activeElement?.closest<HTMLElement>('.react-flow__node');
    const removedNode = focusedNode != null && containerRef.current?.contains(focusedNode) &&
      !geometry.nodes.some((node) => node.id === focusedNode.dataset.id);
    const detachedControl = focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body;
    if (removedNode || detachedControl) (fullscreen?.buttonRef.current ?? resetButton.current)?.focus({ preventScroll: true });
  }, [geometry, fullscreen]);
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
      center: { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 },
      size: { width: node.width, height: node.height },
      onInspectTask, onOpenTask, onExpandTask,
      revealRequest: action?.kind === 'expand' && action.anchorId === node.id ? action.sequence : null,
      expansions: expansions.get(node.id)!,
    },
  })), [geometry, index, expansions, action, onInspectTask, onOpenTask, onExpandTask]);
  const canvas = useMemo(() => (
    <ReactFlow<TaskFlowNode>
      id={`flow-${rootId}`}
      aria-label={m.canvas}
      nodes={nodes}
      nodeTypes={nodeTypes}
      minZoom={0.2}
      maxZoom={1.8}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      elementsSelectable={false}
      onPaneClick={clearInspection}
      connectOnClick={false}
      deleteKeyCode={null}
      panActivationKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      autoPanOnNodeFocus={false}
      onlyRenderVisibleElements={false}
      ariaLabelConfig={m.flowAriaLabels}
      attributionPosition="bottom-right"
    >
      <InitialViewport key={topologyKey} geometry={geometry} rootId={rootId} folded={folded} action={action} resetButton={resetButton} />
      <InspectedEdges geometry={geometry} />
      <Background variant={BackgroundVariant.Dots} gap={18} size={0.8} color="#d9dee9" bgColor="#fafbfe" />
      <Controls position="bottom-left" orientation="horizontal" showInteractive={false} fitViewOptions={viewportFitOptions} />
    </ReactFlow>
  ), [nodes, rootId, topologyKey, geometry, folded, action, clearInspection, m]);
  return (
    <div className="task-graph" data-hidden-upstream-count={hiddenUpstreamCount} data-visible-task-count={visibleIds.size} data-total-task-count={totalTasks} ref={containerRef} onFocusCapture={(event) => { focusedControl.current = event.target as HTMLElement; }}>
      <div className="graph-toolbar">
        <div className="graph-toolbar-summary">
          <span>{m.title}</span>
          <span className="graph-counts">{m.counts({ main: projection.mainIds.size, external: projection.externalIds.size, visible: visibleIds.size, total: totalTasks, edges: geometry.edges.length, dependencies: projection.edges.length })}</span>
          <span className="graph-hidden-prerequisites" role="status">{hiddenUpstreamCount === 0 ? '' : m.hiddenPrerequisites({ count: hiddenUpstreamCount })}</span>
        </div>
        <div className="graph-toolbar-actions">
          {fullscreen !== undefined && <button className="button graph-fullscreen-toggle" type="button" ref={fullscreen.buttonRef} onClick={fullscreen.onToggle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d={fullscreen.active ? 'M4 9h5V4m6 0v5h5M4 15h5v5m6 0v-5h5' : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'} />
            </svg>
            {fullscreen.active ? m.exitFullscreen : m.enterFullscreen}
          </button>}
          <button className="button graph-reset-overview" type="button" ref={resetButton} onClick={onResetOverview}>{m.resetOverview}</button>
        </div>
      </div>
      <div className="task-graph-canvas">
        <TaskInspectionContext value={inspection}>{canvas}</TaskInspectionContext>
      </div>
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
      const geometry = layoutGraph(visibleProjection, new Map([...expansions].map(([id, directions]) => [id, getTaskNodeHeight(directions)])));
      performance.measure('daynight:task-layout', { start: started, end: performance.now(), detail: { rootId: props.rootId } });
      return { kind: 'ready' as const, geometry };
    } catch (error) { return { kind: 'error' as const, error }; }
  }, [visibleProjection, expansions, props.rootId]);
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
