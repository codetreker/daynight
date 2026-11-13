import { memo, useLayoutEffect, useMemo, useRef, type FocusEvent } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, useReactFlow, useStore, type Viewport } from '@xyflow/react';
import { useI18n } from '../../i18n/LocaleProvider';
import { DependencyEdges } from './DependencyEdges';
import { TaskInspectionContext, useTaskInspection, type TaskInspection } from './inspection';
import type { CanvasLayout } from './layout';
import { TaskNode, type TaskFlowNode } from './TaskNode';
import '@xyflow/react/dist/style.css';

const nodeTypes = { task: TaskNode };
const InspectedEdges = memo(({ geometry }: { geometry: CanvasLayout }) => {
  const inspection = useTaskInspection();
  return <DependencyEdges geometry={geometry} inspection={inspection} />;
});

// The graph owner supplies its preferred surviving control; detection remains
// shared so removal of a node or toolbar control follows the same focus policy.
export const useGraphFocusRecovery = (geometry: CanvasLayout, getFallback: () => HTMLElement | null) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const focusedNode = document.activeElement?.closest<HTMLElement>('.react-flow__node');
    const removedNode = focusedNode != null && containerRef.current?.contains(focusedNode) &&
      !geometry.nodes.some((node) => node.id === focusedNode.dataset.id);
    const detachedControl = focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body;
    if (removedNode || detachedControl) getFallback()?.focus({ preventScroll: true });
  }, [geometry, getFallback]);
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => { focusedControl.current = event.target as HTMLElement; };
  return { containerRef, onFocusCapture };
};

type ViewportFactory = (width: number, height: number) => Viewport;

const InitialViewport = ({ viewportFactory, revision, onReset, framingReady, onSizeChange }: { viewportFactory: ViewportFactory; revision: number | null; onReset: () => void; framingReady: boolean; onSizeChange: ((width: number, height: number) => void) | undefined }) => {
  const { setViewport, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const applied = useRef(false);
  const resetSequence = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (width > 0 && height > 0) onSizeChange?.(width, height);
  }, [width, height, onSizeChange]);
  useLayoutEffect(() => {
    if (!framingReady || !viewportInitialized || width <= 0 || height <= 0) return;
    const reset = revision !== null && revision !== resetSequence.current;
    if (applied.current && !reset) return;
    const wasApplied = applied.current;
    applied.current = true;
    if (reset) resetSequence.current = revision;
    void setViewport(viewportFactory(width, height), { duration: 0 });
    if (reset && wasApplied) onReset();
  }, [viewportFactory, revision, onReset, framingReady, viewportInitialized, width, height, setViewport]);
  return null;
};

export const TaskGraphCanvas = ({ canvasId, nodes, geometry, inspection, onClearInspection, viewportFactory, framingKey, framingRevision, onFramingReset, minZoom, maxZoom, fitViewOptions, framingReady = true, onSizeChange }: {
  canvasId: string;
  nodes: TaskFlowNode[];
  geometry: CanvasLayout;
  inspection: TaskInspection;
  onClearInspection: () => void;
  viewportFactory: ViewportFactory;
  framingKey: string;
  framingRevision: number | null;
  onFramingReset: () => void;
  minZoom: number;
  maxZoom: number;
  fitViewOptions: { minZoom: number; maxZoom: number; padding: number };
  framingReady?: boolean;
  onSizeChange?: (width: number, height: number) => void;
}) => {
  const { messages: { graph: m } } = useI18n();
  const canvas = useMemo(() => (
    <ReactFlow<TaskFlowNode>
      id={canvasId}
      aria-label={m.canvas}
      nodes={nodes}
      nodeTypes={nodeTypes}
      minZoom={minZoom}
      maxZoom={maxZoom}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      elementsSelectable={false}
      onPaneClick={onClearInspection}
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
      <InitialViewport key={framingKey} viewportFactory={viewportFactory} revision={framingRevision} onReset={onFramingReset} framingReady={framingReady} onSizeChange={onSizeChange} />
      <InspectedEdges geometry={geometry} />
      <Background variant={BackgroundVariant.Dots} gap={18} size={0.8} color="#d9dee9" bgColor="#fafbfe" />
      <Controls position="bottom-left" orientation="horizontal" showInteractive={false} fitViewOptions={fitViewOptions} />
    </ReactFlow>
  ), [nodes, canvasId, framingKey, geometry, viewportFactory, framingRevision, onFramingReset, onClearInspection, minZoom, maxZoom, fitViewOptions, framingReady, onSizeChange, m]);
  return <div className="task-graph-canvas"><TaskInspectionContext value={inspection}>{canvas}</TaskInspectionContext></div>;
};
