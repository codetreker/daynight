import { memo, useId, useMemo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { useI18n } from '../../i18n/LocaleProvider';
import { DEPENDENCY_DASH_ARRAY, DEPENDENCY_DASH_PERIOD } from './dashes';
import type { TaskInspection } from './inspection';
import type { CanvasEdge, CanvasLayout } from './layout';
import { compileDependencyRoute } from './routes';

type EdgeState = 'normal' | 'highlighted' | 'unrelated';
type Route = ReturnType<typeof compileDependencyRoute>;
const colors: Record<EdgeState, string> = { normal: '#abb2c7', highlighted: '#6762ce', unrelated: '#c7cddb' };
const bodyStyle = { fill: 'none', stroke: 'inherit', strokeWidth: 1.5, pointerEvents: 'none' } as const;
const dashStyle = { ...bodyStyle, strokeDasharray: DEPENDENCY_DASH_ARRAY, strokeLinecap: 'butt', strokeLinejoin: 'miter' } as const;

const DashPaint = memo(({ route }: { route: Route }) => <>{route.pieces.map((piece, position) => {
  const attributes = {
    className: 'task-dependency-paint-piece', 'data-piece-kind': piece.kind,
    'aria-hidden': true as const, focusable: false as const,
    style: { ...dashStyle, strokeDashoffset: piece.startDistance % DEPENDENCY_DASH_PERIOD },
  };
  return piece.kind === 'line'
    ? <line key={position} {...attributes} x1="0" y1="0" x2={piece.length} y2="0"
      transform={`matrix(${piece.cosine} ${piece.sine} ${-piece.sine} ${piece.cosine} ${piece.from.x} ${piece.from.y})`} />
    : <path key={position} {...attributes} d={piece.d} />;
})}</>);

const DependencyEdge = memo(({ edge, route, state, marker, label }: {
  edge: CanvasEdge; route: Route; state: EdgeState; marker: string; label: string;
}) => <g className="react-flow__edge task-dependency-edge" data-id={edge.id} data-source={edge.source} data-target={edge.target}
  data-external={edge.external} data-inspection={state} role="img" aria-label={label} focusable="false">
  <g className="task-dependency-body" stroke={colors[state]} aria-hidden="true" focusable="false">
    {edge.external && <DashPaint route={route} />}
    <path className="react-flow__edge-path" data-source={edge.source} data-target={edge.target} data-external={edge.external}
      d={route.d} markerEnd={`url(#${marker})`} aria-hidden="true" focusable="false"
      style={edge.external ? { ...bodyStyle, stroke: 'none' } : bodyStyle} />
  </g>
</g>);

export const DependencyEdges = memo(({ geometry, inspection }: { geometry: CanvasLayout; inspection: TaskInspection }) => {
  const { messages: { graph: m } } = useI18n();
  const markerId = `task-dependency-arrow-${useId()}`;
  const routes = useMemo(() => geometry.edges.map((edge) => ({ edge, route: compileDependencyRoute(edge.points, edge.external, geometry.direction) })), [geometry]);
  return <ViewportPortal>
    <svg className="task-dependency-edges" data-testid="task-dependency-edges" width="100%" height="100%"
      data-paint-piece-count={routes.reduce((total, { route }) => total + route.pieces.length, 0)}
      role="group" aria-label={m.dependencyGroup} focusable="false">
      <defs>{(Object.keys(colors) as EdgeState[]).map((state) => <marker key={state} id={`${markerId}-${state}`}
        markerWidth="16" markerHeight="16" viewBox="-10 -10 20 20" markerUnits="strokeWidth" orient="auto-start-reverse" refX="0" refY="0">
        <polyline className="arrowclosed" points="-5,-4 0,0 -5,4 -5,-4" stroke={colors[state]} fill={colors[state]}
          strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      </marker>)}</defs>
      {routes.map(({ edge, route }) => {
        const state = inspection.selectedTaskId === null ? 'normal'
          : inspection.highlightedIds.has(edge.source) && inspection.highlightedIds.has(edge.target) ? 'highlighted' : 'unrelated';
        return <DependencyEdge key={edge.id} edge={edge} route={route} state={state} marker={`${markerId}-${state}`}
          label={`${m.dependencyLabel({ source: edge.source, target: edge.target, external: edge.external })}${state === 'highlighted' ? m.dependencyHighlightedSuffix : ''}`} />;
      })}
    </svg>
  </ViewportPortal>;
});
