import { UsageProjectProvider } from '../usage/UsageSummaryView';
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { getViewportForBounds } from '@xyflow/react';
import type { TaskSummary } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { type CanvasLayout, type GraphDirection } from './layout';
import { layoutGoalGraph, type GoalLayoutSize } from './goal-layout';
import { projectGoal, goalTopologyKey } from './goal-projection';
import { tracePrerequisites, type GraphIndex, type GraphProjection } from './model';
import { TaskGraphCanvas, useGraphFocusRecovery } from './TaskGraphCanvas';
import { TaskGraphToolbar } from './TaskGraphToolbar';
import type { TaskFlowNode } from './TaskNode';

type Props = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
  readonly goalId: string;
  readonly direction: GraphDirection;
  readonly onDirectionChange: (direction: GraphDirection) => void;
  readonly directionIssue?: 'read' | 'invalid' | 'write' | undefined;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly fullscreen?: { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };
};

const emptyHighlight: ReadonlySet<string> = new Set();
const onFramingReset = () => {};
const emptyGeometry: CanvasLayout = { nodes: [], edges: [], width: 0, height: 0, direction: 'horizontal' };
const padding = 0.15;
type LayoutRequest = { readonly goalId: string; readonly topologyKey: string; readonly direction: GraphDirection;
  readonly projection: GraphProjection; readonly size: GoalLayoutSize; readonly mode: 'readable' | 'overview' };
const boundsOf = (geometry: CanvasLayout) => {
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const node of geometry.nodes) {
    left = Math.min(left, node.position.x); top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + node.width); bottom = Math.max(bottom, node.position.y + node.height);
  }
  for (const edge of geometry.edges) for (const point of edge.points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const GoalTaskGraph = ({ projectId, index, summaries, goalId, direction, onDirectionChange, directionIssue, onOpenTask, fullscreen }: Props) => {
  const { messages: { graph: m, workspace: { project } } } = useI18n();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const latestSize = useRef<GoalLayoutSize | null>(null);
  const [request, setRequest] = useState<LayoutRequest | null>(null);
  const [framingRevision, setFramingRevision] = useState(0);
  const resetButton = useRef<HTMLButtonElement>(null);
  const projection = useMemo(() => projectGoal(index, goalId), [index, goalId]);
  const visibleIds = useMemo(() => new Set([...projection.mainIds, ...projection.externalIds]), [projection]);
  const [selection, setSelection] = useState<{ goalId: string; taskId: string | null }>({ goalId, taskId: null });
  const selectedTaskId = selection.goalId === goalId && selection.taskId !== null && visibleIds.has(selection.taskId) ? selection.taskId : null;
  if (selection.goalId !== goalId || selection.taskId !== selectedTaskId) setSelection({ goalId, taskId: selectedTaskId });
  const highlightedIds = useMemo(() => selectedTaskId === null ? emptyHighlight : tracePrerequisites(index, selectedTaskId), [index, selectedTaskId]);
  const inspection = useMemo(() => ({ selectedTaskId, highlightedIds }), [selectedTaskId, highlightedIds]);
  const hiddenUpstreamCount = useMemo(() => [...highlightedIds].filter((id) => !visibleIds.has(id)).length, [highlightedIds, visibleIds]);
  const onInspectTask = useCallback((id: string) => {
    setSelection((current) => ({ goalId, taskId: current.goalId === goalId && current.taskId === id ? null : id }));
  }, [goalId]);
  const clearInspection = useCallback(() => {
    setSelection((current) => current.taskId === null ? current : { goalId, taskId: null });
  }, [goalId]);
  const topologyKey = goalTopologyKey(projection);
  const hasTasks = projection.mainIds.size + projection.externalIds.size > 0;
  const createRequest = useCallback((layoutSize: GoalLayoutSize, mode: LayoutRequest['mode']): LayoutRequest => ({
    goalId, topologyKey, direction, projection, size: layoutSize, mode,
  }), [goalId, topologyKey, direction, projection]);
  // Replace obsolete requests before rendering nodes from a different projection.
  let activeRequest = request;
  if (!hasTasks && request !== null) {
    activeRequest = null;
    setRequest(null);
  } else if (hasTasks && latestSize.current !== null && (request === null || request.goalId !== goalId || request.topologyKey !== topologyKey || request.direction !== direction)) {
    activeRequest = createRequest(latestSize.current, 'readable');
    setRequest(activeRequest);
  }
  const result = useMemo(() => {
    if (activeRequest === null) return { geometry: null, error: false };
    try {
      const started = performance.now();
      const geometry = layoutGoalGraph(activeRequest.projection, activeRequest.size, activeRequest.direction);
      performance.clearMeasures('daynight:task-layout');
      performance.measure('daynight:task-layout', { start: started, end: performance.now(), detail: {
        scopeKind: 'goal', goalId, mainCount: projection.mainIds.size, externalCount: projection.externalIds.size, edgeCount: projection.edges.length, direction,
      } });
      return { geometry, error: false };
    } catch (cause) {
      const errorName = cause instanceof RangeError ? 'RangeError' : cause instanceof TypeError ? 'TypeError' : cause instanceof Error ? 'Error' : 'NonError';
      console.warn('Goal graph layout failed', { projectId, scopeKind: 'goal', resourceId: goalId, stage: 'layout', errorName, reason: cause instanceof Error ? 'layout_error' : 'non_error' });
      return { geometry: null, error: true };
    }
  }, [activeRequest, projectId, goalId]);
  const geometry = result.geometry;
  const fallbackGeometry = geometry ?? emptyGeometry;
  const focusFallback = useCallback(() => resetButton.current ?? fullscreen?.buttonRef.current ?? null, [fullscreen]);
  const { containerRef, onFocusCapture } = useGraphFocusRecovery(fallbackGeometry, focusFallback);
  const nodes = useMemo<TaskFlowNode[]>(() => (geometry?.nodes ?? []).map((node) => {
    const task = index.nodes.get(node.id)!;
    const owner = task.parentId === null ? m.unassignedGoal : (() => {
      const goal = summaries?.get(task.parentId!);
      return goal?.type === 'goal' ? m.goalOwner({ title: `${goal.titlePreview}${goal.titleTruncated ? '…' : ''}` }) : m.unavailableGoal({ id: task.parentId! });
    })();
    return { id: node.id, position: node.position, type: 'task', width: node.width, height: node.height,
      style: { width: node.width, height: node.height }, data: {
        task, kind: node.kind, ownerLabel: node.kind === 'external' ? owner : null,
        center: { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 },
        size: { width: node.width, height: node.height }, actions: { kind: 'goal', onInspectTask, onOpenTask },
      } };
  }), [geometry, index, summaries, m, onInspectTask, onOpenTask]);
  const viewportFactory = useCallback(() => {
    const bounds = boundsOf(geometry!);
    const { width, height } = activeRequest!.size;
    const fit = getViewportForBounds(bounds, width, height, 0.00000001, 1, padding);
    if (activeRequest!.mode === 'overview') return fit;
    const zoom = Math.max(0.8, Math.min(1, fit.zoom));
    return { zoom,
      x: bounds.width * zoom <= width ? (width - bounds.width * zoom) / 2 - bounds.x * zoom : 32 - bounds.x * zoom,
      y: bounds.height * zoom <= height ? (height - bounds.height * zoom) / 2 - bounds.y * zoom : 32 - bounds.y * zoom };
  }, [geometry, activeRequest]);
  const minZoom = geometry !== null && geometry.nodes.length > 0 && size.width > 0 && size.height > 0
    ? Math.min(0.2, getViewportForBounds(boundsOf(geometry), size.width, size.height, 0.00000001, 1, padding).zoom) : 0.00000001;
  const fitViewOptions = useMemo(() => ({ minZoom, maxZoom: 1, padding }), [minZoom]);
  const onSizeChange = useCallback((width: number, height: number) => {
    const firstMeasurement = latestSize.current === null;
    latestSize.current = { width, height };
    setSize((current) => !firstMeasurement && current.width === width && current.height === height ? current : { width, height });
  }, []);
  const fit = useCallback(() => {
    if (latestSize.current !== null && hasTasks) {
      setRequest(createRequest(latestSize.current, 'overview'));
      setFramingRevision((revision) => revision + 1);
    }
  }, [createRequest, hasTasks]);
  const retry = useCallback(() => { if (latestSize.current !== null) setRequest(createRequest(latestSize.current, 'readable')); }, [createRequest]);
  return <div className="task-graph" data-hidden-upstream-count={hiddenUpstreamCount} data-visible-task-count={projection.mainIds.size + projection.externalIds.size} data-total-task-count={projection.mainIds.size + projection.externalIds.size} ref={containerRef} onFocusCapture={onFocusCapture}>
    <TaskGraphToolbar title={m.goalTitle} summary={m.goalCounts({ main: projection.mainIds.size, external: projection.externalIds.size, edges: projection.edges.length })} status={hiddenUpstreamCount === 0 ? '' : m.hiddenPrerequisites({ count: hiddenUpstreamCount })}
      direction={direction} onDirectionChange={onDirectionChange} directionLabel={m.orientation} horizontalLabel={m.horizontal} verticalLabel={m.vertical}
      fullscreen={fullscreen} enterFullscreenLabel={m.enterFullscreen} exitFullscreenLabel={m.exitFullscreen}
      resetButton={resetButton} onReset={fit} resetLabel={m.goalFit}
      notice={directionIssue === undefined ? undefined : m.orientationIssue[directionIssue]} />
    <UsageProjectProvider projectId={projectId}><TaskGraphCanvas canvasId={`flow-${goalId}`} nodes={nodes} geometry={fallbackGeometry} inspection={inspection} onClearInspection={clearInspection}
          viewportFactory={viewportFactory} framingKey={`${goalId}:${direction}`} framingRevision={framingRevision} onFramingReset={onFramingReset}
          minZoom={minZoom} maxZoom={1.8} fitViewOptions={fitViewOptions} framingReady={geometry !== null} onSizeChange={onSizeChange} onFitView={fit}
          emptyState={!hasTasks ? <div className="graph-error">{m.goalEmpty}</div> : undefined}
          overlay={result.error ? <div className="graph-error" role="alert"><h3>{m.layoutErrorTitle}</h3><p>{m.goalLayoutError}</p><button type="button" className="button" onClick={retry}>{project.retryRefresh}</button></div> : undefined} /></UsageProjectProvider>
    {hasTasks && !result.error && <div className="graph-foot"><span>{m.directionLegend}</span><span>{m.goalExternalLegend}</span></div>}
  </div>;
};
