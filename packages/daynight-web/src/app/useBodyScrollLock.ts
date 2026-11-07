import { useLayoutEffect } from 'react';

type SavedStyle = { readonly properties: readonly string[]; readonly values: readonly { property: string; value: string; priority: string }[] };
type FrozenPosition = { count: number; readonly x: number; readonly y: number; readonly body: SavedStyle; readonly root: SavedStyle };
type BodyLock = { count: number; readonly overflow: SavedStyle; frozen?: FrozenPosition };
const locks = new WeakMap<HTMLElement, BodyLock>();
const save = (style: CSSStyleDeclaration, properties: readonly string[]): SavedStyle => ({
  properties,
  values: Array.from(style).filter(property => properties.includes(property)).map(property => ({ property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) })),
});
const restore = (style: CSSStyleDeclaration, saved: SavedStyle) => {
  for (const property of saved.properties) style.removeProperty(property);
  for (const { property, value, priority } of saved.values) style.setProperty(property, value, priority);
};

export const useBodyScrollLock = (active: boolean, freezePosition = false) => {
  useLayoutEffect(() => {
    if (!active) return;
    const body = document.body;
    const root = document.documentElement;
    let lock = locks.get(body);
    if (lock === undefined) {
      lock = { count: 0, overflow: save(body.style, ['overflow', 'overflow-x', 'overflow-y']) };
      locks.set(body, lock);
      body.style.overflow = 'hidden';
    }
    lock.count += 1;
    if (freezePosition) {
      if (!lock.frozen) {
        lock.frozen = {
          count: 0, x: window.scrollX, y: window.scrollY,
          body: save(body.style, ['position', 'top', 'left', 'right', 'bottom', 'width', 'box-sizing']),
          root: save(root.style, ['overflow', 'overflow-x', 'overflow-y', 'overscroll-behavior', 'overscroll-behavior-x', 'overscroll-behavior-y']),
        };
        // Overflow alone does not anchor the page while a software keyboard pans
        // the visible viewport. Position ownership is independent of modal locks.
        body.style.setProperty('position', 'fixed');
        body.style.top = `${-lock.frozen.y}px`;
        body.style.left = `${-lock.frozen.x}px`;
        body.style.right = 'auto';
        body.style.bottom = 'auto';
        body.style.width = '100%';
        body.style.boxSizing = 'border-box';
        root.style.overflow = 'hidden';
        root.style.overscrollBehavior = 'none';
      }
      lock.frozen.count += 1;
    }
    return () => {
      const frozen = freezePosition ? lock.frozen : undefined;
      if (frozen && --frozen.count === 0) {
        restore(body.style, frozen.body);
        restore(root.style, frozen.root);
        delete lock.frozen;
      }
      lock.count -= 1;
      if (lock.count === 0) {
        restore(body.style, lock.overflow);
        locks.delete(body);
      }
      // Restore after overflow and positioning so the original document extent
      // is available, even when the last fullscreen and modal owner are the same.
      if (frozen?.count === 0) window.scrollTo({ left: frozen.x, top: frozen.y, behavior: 'instant' });
    };
  }, [active, freezePosition]);
};
