import { getViewportForBounds, type Viewport } from '@xyflow/react';
import type { CanvasLayout } from './layout';

export const getInitialTaskViewport = (geometry: CanvasLayout, rootId: string, width: number, height: number, anchorRoot = false): Viewport => {
  const left = Math.min(...geometry.nodes.map((node) => node.position.x));
  const top = Math.min(...geometry.nodes.map((node) => node.position.y));
  const right = Math.max(...geometry.nodes.map((node) => node.position.x + node.width));
  const bottom = Math.max(...geometry.nodes.map((node) => node.position.y + node.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const fitted = getViewportForBounds(bounds, width, height, 0.8, 1, 0.15);
  if (bounds.width * fitted.zoom <= width && bounds.height * fitted.zoom <= height) return fitted;
  const root = geometry.nodes.find((node) => node.id === rootId)!;
  if (geometry.direction === 'vertical') {
    const firstRank = Math.min(...geometry.nodes.map((node) => node.position.y + node.height / 2));
    const upstreamLeft = Math.min(...geometry.nodes.filter((node) => node.position.y + node.height / 2 === firstRank).map((node) => node.position.x));
    if (anchorRoot) return { x: width / 2 - (root.position.x + root.width / 2) * fitted.zoom, y: 32 - root.position.y * fitted.zoom, zoom: fitted.zoom };
    return {
      x: root.position.y + root.height / 2 === firstRank ? width / 2 - (root.position.x + root.width / 2) * fitted.zoom : 32 - upstreamLeft * fitted.zoom,
      y: 32 - top * fitted.zoom,
      zoom: fitted.zoom,
    };
  }
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
