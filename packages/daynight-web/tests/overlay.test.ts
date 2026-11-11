import { describe, expect, it } from 'vitest';
import { isTopOverlay, registerOverlay } from '../src/app/overlay';

describe('overlay ownership', () => {
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
