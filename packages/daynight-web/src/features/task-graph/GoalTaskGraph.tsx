import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { getViewportForBounds } from '@xyflow/react';
import type { TaskSummary } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { layoutGraph, type CanvasLayout, type GraphDirection } from './layout';
import { projectGoal, goalTopologyKey } from './goal-projection';
import type { GraphIndex } from './model';
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

const emptyInspection = { selectedTaskId: null, highlightedIds: new Set<string>() };
const clearInspection = () => {};
const padding = 0.15;
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
  const [revision, setRevision] = useState(0);
  const [layoutAttempt, setLayoutAttempt] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const resetButton = useRef<HTMLButtonElement>(null);
  const projection = useMemo(() => projectGoal(index, goalId), [index, goalId]);
  const topologyKey = goalTopologyKey(projection);
  const result = useMemo(() => {
    try {
      const started = performance.now();
      const geometry = layoutGraph(projection, undefined, direction);
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
  }, [topologyKey, direction, projectId, goalId, layoutAttempt]);
  const geometry = result.geometry;
  const fallbackGeometry = useMemo<CanvasLayout>(() => geometry ?? { nodes: [], edges: [], width: 0, height: 0 }, [geometry]);
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
        size: { width: node.width, height: node.height }, actions: { kind: 'goal', onOpenTask },
      } };
  }), [geometry, index, summaries, m, onOpenTask]);
  const viewportFactory = useCallback((width: number, height: number) => getViewportForBounds(boundsOf(geometry!), width, height, 0.00000001, 1, padding), [geometry]);
  const minZoom = geometry !== null && geometry.nodes.length > 0 && size.width > 0 && size.height > 0
    ? Math.min(0.2, viewportFactory(size.width, size.height).zoom) : 0.00000001;
  const fitViewOptions = useMemo(() => ({ minZoom, maxZoom: 1, padding }), [minZoom]);
  const onSizeChange = useCallback((width: number, height: number) => setSize((current) => current.width === width && current.height === height ? current : { width, height }), []);
  const onFramingReset = useCallback(() => resetButton.current?.focus({ preventScroll: true }), []);
  return <div className="task-graph" data-visible-task-count={projection.mainIds.size + projection.externalIds.size} data-total-task-count={projection.mainIds.size + projection.externalIds.size} ref={containerRef} onFocusCapture={onFocusCapture}>
    <TaskGraphToolbar title={m.goalTitle} summary={m.goalCounts({ main: projection.mainIds.size, external: projection.externalIds.size, edges: projection.edges.length })} status=""
      direction={direction} onDirectionChange={onDirectionChange} directionLabel={m.orientation} horizontalLabel={m.horizontal} verticalLabel={m.vertical}
      fullscreen={fullscreen} enterFullscreenLabel={m.enterFullscreen} exitFullscreenLabel={m.exitFullscreen}
      resetButton={resetButton} onReset={() => setRevision((value) => value + 1)} resetLabel={m.goalFit}
      notice={directionIssue === undefined ? undefined : m.orientationIssue[directionIssue]} />
    {result.error ? <div className="graph-error" role="alert"><h3>{m.layoutErrorTitle}</h3><p>{m.goalLayoutError}</p><button type="button" className="button" onClick={() => setLayoutAttempt((value) => value + 1)}>{project.retryRefresh}</button></div>
      : geometry!.nodes.length === 0 ? <div className="graph-error">{m.goalEmpty}</div>
        : <><TaskGraphCanvas canvasId={`flow-${goalId}`} nodes={nodes} geometry={geometry!} inspection={emptyInspection} onClearInspection={clearInspection}
          viewportFactory={viewportFactory} framingKey={`${topologyKey}:${direction}`} framingRevision={revision} onFramingReset={onFramingReset}
          minZoom={minZoom} maxZoom={1.8} fitViewOptions={fitViewOptions} onSizeChange={onSizeChange} />
          <div className="graph-foot"><span>{m.directionLegend}</span><span>{m.goalExternalLegend}</span></div></>}
  </div>;
};
