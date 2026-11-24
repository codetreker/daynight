import { createContext, type RefObject } from 'react';
import { acquireInert } from './inert';

/** The owner follows the React tree across portals. */
export const OverlayOwnerContext = createContext<RefObject<HTMLElement | null> | null>(null);

type VisualLayer = { readonly surface: HTMLElement; readonly original: string; readonly base: number; assigned: number };
type Layer = { readonly root: HTMLElement; readonly parent: HTMLElement | null; readonly sequence: number; readonly visual: VisualLayer | null };
const layers = new Map<HTMLElement, Layer>();
let sequence = 0;
const cssStack = (element: HTMLElement | null): number => {
  if (element === null) return 0;
  const value = getComputedStyle(element).zIndex;
  return value === 'auto' || value === '' ? 0 : Number(value);
};
const stackVisualLayers = () => {
  const resolved = new Map<Layer, number>();
  const stack = (layer: Layer): number => {
    const previous = resolved.get(layer);
    if (previous !== undefined) return previous;
    const parent = layer.parent === null ? undefined : layers.get(layer.parent);
    const parentStack = parent === undefined ? cssStack(layer.parent) : stack(parent);
    const value = layer.visual === null ? Math.max(cssStack(layer.root), parentStack) : Math.max(layer.visual.base, parentStack + 1);
    resolved.set(layer, value);
    if (layer.visual !== null) { layer.visual.assigned = value; layer.visual.surface.style.zIndex = String(value); }
    return value;
  };
  for (const layer of layers.values()) stack(layer);
};

/** Hold the parent's inert lease and stack the optional portal surface above it.
 * A dialog root cannot escape its backdrop's stacking context. */
export const registerOverlay = (root: HTMLElement, parent: HTMLElement | null, surface: HTMLElement | null = null): (() => void) => {
  if (layers.has(root)) throw new Error('The overlay is already registered.');
  const visual = surface === null ? null : { surface, original: surface.style.zIndex, base: cssStack(surface), assigned: 0 };
  const layer: Layer = { root, parent, sequence: ++sequence, visual };
  const releaseInert = parent === null ? undefined : acquireInert(parent);
  layers.set(root, layer);
  stackVisualLayers();
  return () => {
    if (layers.get(root) !== layer) return;
    layers.delete(root);
    if (visual !== null && visual.surface.style.zIndex === String(visual.assigned)) visual.surface.style.zIndex = visual.original;
    stackVisualLayers();
    releaseInert?.();
  };
};

/** Resolve the active leaf from explicit ownership, independent of portal DOM order. */
const topOverlay = (): Layer | undefined => {
  const children = (parent: HTMLElement | null): Layer[] => [...layers.values()].filter(layer =>
    parent === null ? layer.parent === null || !layers.has(layer.parent) : layer.parent === parent);
  const latest = (layer: Layer): number => Math.max(layer.sequence, ...children(layer.root).map(latest));
  let candidates = children(null);
  let current: Layer | undefined;
  while (candidates.length > 0) {
    current = candidates.reduce((a, b) => latest(a) > latest(b) ? a : b);
    candidates = children(current.root);
  }
  return current;
};

export const isTopOverlay = (root: HTMLElement): boolean => topOverlay()?.root === root;

/** Find the nearest registered owner of the active overlay, including itself. */
export const nearestOverlayOwner = (owners: ReadonlySet<HTMLElement>): HTMLElement | null => {
  let layer = topOverlay();
  while (layer !== undefined) {
    if (owners.has(layer.root)) return layer.root;
    layer = layer.parent === null ? undefined : layers.get(layer.parent);
  }
  return null;
};
