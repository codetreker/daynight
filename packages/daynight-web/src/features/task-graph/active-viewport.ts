import type { Viewport } from '@xyflow/react';
import type { CanvasLayout } from './layout';
import type { GraphIndex } from './model';

type Rectangle = { left: number; right: number; top: number; bottom: number };

// Rectangles describe all translations that make a card completely visible.
export const prioritizeActiveTasks = (base: Viewport, width: number, height: number, geometry: CanvasLayout, index: GraphIndex): Viewport => {
  const active = geometry.nodes.filter((node) => index.nodes.get(node.id)?.status === 'in_progress');
  if (active.length === 0) return base;
  const rectangles: Rectangle[] = active.map((node) => ({
    left: -node.position.x * base.zoom,
    right: width - (node.position.x + node.width) * base.zoom,
    top: -node.position.y * base.zoom,
    bottom: height - (node.position.y + node.height) * base.zoom,
  })).filter((rect) => rect.left <= rect.right && rect.top <= rect.bottom);
  if (rectangles.length === 0) {
    const centers = active.map((node) => ({
      x: width / 2 - (node.position.x + node.width / 2) * base.zoom,
      y: height / 2 - (node.position.y + node.height / 2) * base.zoom,
    }));
    centers.sort((a, b) => distance(a, base) - distance(b, base) || a.x - b.x || a.y - b.y);
    return { ...base, ...centers[0]! };
  }
  if (rectangles.length === active.length && rectangles.every((r) => r.left <= base.x && base.x <= r.right && r.top <= base.y && base.y <= r.bottom)) return base;

  const xs = [...new Set([base.x, ...rectangles.flatMap((r) => [r.left, r.right])])].sort((a, b) => a - b);
  const ys = [...new Set([base.y, ...rectangles.flatMap((r) => [r.top, r.bottom])])].sort((a, b) => a - b);
  const sortedEvents = rectangles.flatMap((rect) => [{ y: rect.top, delta: 1, rect }, { y: rect.bottom, delta: -1, rect }])
    .sort((a, b) => a.y - b.y || b.delta - a.delta);
  let best = base; let bestCount = -1; let bestDistance = Infinity;
  for (const x of xs) {
    const events = sortedEvents.filter(({ rect }) => rect.left <= x && x <= rect.right);
    let count = 0; let eventIndex = 0;
    for (const y of ys) {
      while (eventIndex < events.length && events[eventIndex]!.y < y) count += events[eventIndex++]!.delta;
      while (eventIndex < events.length && events[eventIndex]!.y === y && events[eventIndex]!.delta === 1) count += events[eventIndex++]!.delta;
      const candidate = { x, y, zoom: base.zoom };
      const candidateDistance = distance(candidate, base);
      if (count > bestCount || (count === bestCount && (candidateDistance < bestDistance ||
        (candidateDistance === bestDistance && (x < best.x || (x === best.x && y < best.y)))))) {
        best = candidate; bestCount = count; bestDistance = candidateDistance;
      }
      while (eventIndex < events.length && events[eventIndex]!.y === y) count += events[eventIndex++]!.delta;
    }
  }
  return best;
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
