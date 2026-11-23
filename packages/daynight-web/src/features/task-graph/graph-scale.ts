import { useLayoutEffect, useState } from 'react';
import type { CanvasLayout } from './layout';

// Layout is calculated in the graph's own coordinates. Scale those coordinates
// with the root font so React Flow's fixed node boxes continue to fit rem text.
const rootScale = () => {
  if (typeof document === 'undefined') return 1;
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 16 ? size / 16 : 1;
};

export const useGraphFontScale = () => {
  const [scale, setScale] = useState(rootScale);
  useLayoutEffect(() => {
    const probe = document.createElement('span');
    Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', width: '1rem', height: '0' });
    document.body.append(probe);
    const update = () => setScale(rootScale());
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(probe);
    return () => { observer?.disconnect(); probe.remove(); };
  }, []);
  return scale;
};

export const scaleGraph = (geometry: CanvasLayout, scale: number): CanvasLayout => {
  if (scale === 1) return geometry;
  const point = ({ x, y }: { x: number; y: number }) => ({ x: x * scale, y: y * scale });
  return { ...geometry, width: geometry.width * scale, height: geometry.height * scale,
    nodes: geometry.nodes.map(node => ({ ...node, position: point(node.position), width: node.width * scale, height: node.height * scale })),
    edges: geometry.edges.map(edge => ({ ...edge, points: edge.points.map(point) })) };
};
