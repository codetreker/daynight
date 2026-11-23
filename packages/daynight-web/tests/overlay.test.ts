import { describe, expect, it } from 'vitest';
import { isTopOverlay, registerOverlay } from '../src/app/overlay';

describe('overlay ownership', () => {
  it('stacks portaled visual surfaces above their owners through repeated Goal and graph layers and restores them', () => {
    const application = document.createElement('main');
    const surfaces = [30, 31, 30, 31, 30, 31].map(base => {
      const backdrop = document.createElement('div'), root = document.createElement('section');
      backdrop.style.position = 'fixed'; backdrop.style.zIndex = String(base); backdrop.append(root); document.body.append(backdrop);
      return { backdrop, root, base };
    });
    const releases: (() => void)[] = [];
    try {
      for (const [index, surface] of surfaces.entries()) releases.push(registerOverlay(surface.root, index === 0 ? application : surfaces[index - 1]!.root, surface.backdrop));
      expect(surfaces.map(surface => Number(getComputedStyle(surface.backdrop).zIndex))).toEqual([30, 31, 32, 33, 34, 35]);
      expect(isTopOverlay(surfaces.at(-1)!.root)).toBe(true);
      for (const [index, surface] of surfaces.entries()) if (index < surfaces.length - 1) expect(surface.root).toHaveAttribute('inert');
    } finally {
      for (const release of releases.reverse()) release();
      for (const surface of surfaces) { expect(surface.backdrop.style.zIndex).toBe(String(surface.base)); surface.backdrop.remove(); }
    }
    expect(application).not.toHaveAttribute('inert');
  });

  it('updates a child visual surface when its parent registers later and releases duplicate leases once', () => {
    const parent = document.createElement('section'), child = document.createElement('section');
    const parentSurface = document.createElement('div'), childSurface = document.createElement('div');
    parentSurface.style.zIndex = '80'; childSurface.style.zIndex = '31';
    parentSurface.append(parent); childSurface.append(child); document.body.append(parentSurface, childSurface);
    const releaseChild = registerOverlay(child, parent, childSurface), releaseParent = registerOverlay(parent, null, parentSurface);
    try {
      expect(childSurface.style.zIndex).toBe('81');
      releaseChild(); releaseChild();
      expect(childSurface.style.zIndex).toBe('31');
      expect(parent).not.toHaveAttribute('inert');
      expect(isTopOverlay(parent)).toBe(true);
    } finally { releaseChild(); releaseParent(); parentSurface.remove(); childSurface.remove(); }
    expect(parentSurface.style.zIndex).toBe('80');
  });
  it('lets a portal child own the keyboard even when its parent registers later', () => {
    const application = document.createElement('main');
    const parent = document.createElement('section');
    const child = document.createElement('section');
    const releaseChild = registerOverlay(child, parent);
    const releaseParent = registerOverlay(parent, application);
    try {
      expect(application).toHaveAttribute('inert');
      expect(parent).toHaveAttribute('inert');
      expect(isTopOverlay(child)).toBe(true);
      expect(isTopOverlay(parent)).toBe(false);
      releaseChild();
      expect(parent).not.toHaveAttribute('inert');
      expect(isTopOverlay(parent)).toBe(true);
      expect(application).toHaveAttribute('inert');
    } finally { releaseChild(); releaseParent(); }
    expect(application).not.toHaveAttribute('inert');
  });

  it('keeps the parent inert until all child leases end and respects an original inert attribute', () => {
    const parent = document.createElement('section');
    parent.setAttribute('inert', '');
    const first = document.createElement('section'), second = document.createElement('section');
    const releaseFirst = registerOverlay(first, parent);
    const releaseSecond = registerOverlay(second, parent);
    try {
      expect(isTopOverlay(first)).toBe(false);
      expect(isTopOverlay(second)).toBe(true);
      releaseSecond(); releaseSecond();
      expect(parent).toHaveAttribute('inert');
      expect(isTopOverlay(first)).toBe(true);
    } finally { releaseFirst(); releaseSecond(); }
    expect(parent).toHaveAttribute('inert');
  });

  it('does not release another child lease after a duplicate cleanup', () => {
    const parent = document.createElement('section');
    const releaseFirst = registerOverlay(document.createElement('section'), parent);
    const releaseSecond = registerOverlay(document.createElement('section'), parent);
    try {
      releaseFirst(); releaseFirst();
      expect(parent).toHaveAttribute('inert');
    } finally { releaseFirst(); releaseSecond(); }
    expect(parent).not.toHaveAttribute('inert');
  });
});
