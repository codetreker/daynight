import { createContext, type RefObject } from 'react';
import { acquireInert } from './inert';

/** The owner follows the React tree across portals. */
export const OverlayOwnerContext = createContext<RefObject<HTMLElement | null> | null>(null);

type Layer = { readonly root: HTMLElement; readonly parent: HTMLElement | null; readonly sequence: number };
const layers = new Map<HTMLElement, Layer>();
let sequence = 0;

/** Register a layer and hold its parent's inert lease until this layer closes. */
export const registerOverlay = (root: HTMLElement, parent: HTMLElement | null): (() => void) => {
  if (layers.has(root)) throw new Error('The overlay is already registered.');
  const layer: Layer = { root, parent, sequence: ++sequence };
  const releaseInert = parent === null ? undefined : acquireInert(parent);
  layers.set(root, layer);
  return () => {
    if (layers.get(root) !== layer) return;
    layers.delete(root);
    releaseInert?.();
  };
};

/** Resolve the active leaf from explicit ownership, independent of portal DOM order. */
export const isTopOverlay = (root: HTMLElement): boolean => {
  if (!layers.has(root)) return false;
  const children = (parent: HTMLElement | null): Layer[] => [...layers.values()].filter(layer =>
    parent === null ? layer.parent === null || !layers.has(layer.parent) : layer.parent === parent);
  const latest = (layer: Layer): number => Math.max(layer.sequence, ...children(layer.root).map(latest));
  let candidates = children(null);
  let current: Layer | undefined;
  while (candidates.length > 0) {
    current = candidates.reduce((a, b) => latest(a) > latest(b) ? a : b);
    candidates = children(current.root);
  }
  return current?.root === root;
};
