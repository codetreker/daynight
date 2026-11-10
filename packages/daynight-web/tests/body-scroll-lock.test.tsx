import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBodyScrollLock, useBodyScrollLock } from '../src/app/useBodyScrollLock';

const Lock = ({ active = true, freezePosition = false }: { active?: boolean; freezePosition?: boolean }) => {
  useBodyScrollLock(active, freezePosition);
  return null;
};

const styles = (element: HTMLElement) => Object.fromEntries(Array.from(element.style).map(property => [property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]]));

const position = (x: number, y: number) => {
  vi.spyOn(window, 'scrollX', 'get').mockReturnValue(x);
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(y);
};

afterEach(() => {
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
});

describe('body scroll locks', () => {
  it('lets an imperative modal release synchronously without releasing a surrounding owner', () => {
    position(0, 120); document.body.style.overflow = 'scroll';
    const surrounding = render(<Lock />);
    const release = acquireBodyScrollLock(true);
    expect(document.body.style.position).toBe('fixed');
    release();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('hidden');
    release();
    expect(document.body.style.overflow).toBe('hidden');
    surrounding.unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });
  it.each(['first', 'second'] as const)('restores the original overflow only after both locks release when %s exits first', (firstRelease) => {
    document.body.style.overflow = 'scroll';
    const first = render(<Lock />);
    const second = render(<Lock />);
    expect(document.body.style.overflow).toBe('hidden');
    const views = firstRelease === 'first' ? [first, second] : [second, first];
    views[0]!.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    views[1]!.unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('acquires and releases when fullscreen changes without losing another active lock', () => {
    document.body.style.overflow = 'auto';
    const graph = render(<Lock active={false} />);
    expect(document.body.style.overflow).toBe('auto');
    graph.rerender(<Lock active={true} />);
    const dialog = render(<Lock />);
    graph.rerender(<Lock active={false} />);
    expect(document.body.style.overflow).toBe('hidden');
    dialog.unmount();
    expect(document.body.style.overflow).toBe('auto');
    graph.unmount();
    expect(document.body.style.position).toBe('');
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('freezes the page at its current position and restores its styles and position without smooth scrolling', () => {
    position(14, 240);
    document.body.style.cssText = 'position: relative !important; top: 3px; left: 5px !important; right: 7px; bottom: 9px; width: 80%; box-sizing: content-box; overflow-x: scroll !important; overflow-y: auto; color: red';
    document.documentElement.style.cssText = 'overflow-x: auto !important; overflow-y: scroll; overscroll-behavior: contain !important; scroll-behavior: smooth';
    const body = styles(document.body);
    const root = styles(document.documentElement);
    const mounted = render(<Lock freezePosition />);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-240px');
    expect(document.body.style.left).toBe('-14px');
    expect(document.body.style.right).toBe('auto');
    expect(document.body.style.bottom).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('hidden');
    document.body.style.color = 'blue';
    mounted.unmount();
    expect(styles(document.body)).toEqual({ ...body, color: ['blue', ''] });
    expect(styles(document.documentElement)).toEqual(root);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ left: 14, top: 240, behavior: 'instant' });
  });

  it('restores inset and overflow shorthand priorities after repeated fullscreen entry', () => {
    position(0, 120);
    document.body.style.cssText = 'inset: 10px 20px 30px 40px !important; height: 100%; margin: 8px; overflow: auto scroll !important';
    document.documentElement.style.cssText = 'overflow: scroll auto !important; overscroll-behavior: contain none !important';
    const body = styles(document.body), root = styles(document.documentElement);
    for (let entry = 0; entry < 2; entry++) {
      const mounted = render(<Lock freezePosition />);
      expect(document.body.style.top).toBe('-120px');
      expect(document.body.style.height).toBe('100%');
      expect(document.body.style.margin).toBe('8px');
      mounted.unmount();
      expect(styles(document.body)).toEqual(body);
      expect(styles(document.documentElement)).toEqual(root);
    }
  });

  it.each(['ordinary', 'fullscreen'] as const)('preserves independent lock ownership when %s exits first', firstRelease => {
    position(0, 360);
    document.body.style.overflow = 'scroll';
    const ordinary = render(<Lock />);
    const fullscreen = render(<Lock freezePosition />);
    expect(document.body.style.top).toBe('-360px');
    if (firstRelease === 'ordinary') {
      ordinary.unmount();
      expect(document.body.style.position).toBe('fixed');
      expect(document.body.style.overflow).toBe('hidden');
      expect(window.scrollTo).not.toHaveBeenCalled();
      fullscreen.unmount();
    } else {
      fullscreen.unmount();
      expect(document.body.style.position).toBe('');
      expect(document.documentElement.style.overflow).toBe('');
      expect(document.body.style.overflow).toBe('hidden');
      expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 360, behavior: 'instant' });
      ordinary.unmount();
    }
    expect(document.body.style.overflow).toBe('scroll');
    expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 360, behavior: 'instant' });
  });

  it.each(['first', 'second'] as const)('restores the first frozen position only after both fullscreen owners release when %s exits first', firstRelease => {
    position(-8, -20);
    const first = render(<Lock freezePosition />);
    position(0, 0);
    const second = render(<Lock freezePosition />);
    expect(document.body.style.top).toBe('20px');
    expect(document.body.style.left).toBe('8px');
    const views = firstRelease === 'first' ? [first, second] : [second, first];
    views[0]!.unmount();
    expect(document.body.style.position).toBe('fixed');
    expect(window.scrollTo).not.toHaveBeenCalled();
    views[1]!.unmount();
    expect(document.body.style.position).toBe('');
    expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: -8, top: -20, behavior: 'instant' });
  });

  it('changes freeze ownership while an ordinary owner keeps the shared overflow lock', () => {
    position(0, 75);
    const ordinary = render(<Lock />);
    const fullscreen = render(<Lock freezePosition={false} />);
    fullscreen.rerender(<Lock freezePosition />);
    expect(document.body.style.top).toBe('-75px');
    fullscreen.rerender(<Lock freezePosition={false} />);
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('hidden');
    expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 75, behavior: 'instant' });
    fullscreen.unmount(); ordinary.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('releases all styles after StrictMode acquisition and inactive transitions', () => {
    position(0, 90);
    const mounted = render(<StrictMode><Lock freezePosition /></StrictMode>);
    expect(document.body.style.position).toBe('fixed');
    mounted.rerender(<StrictMode><Lock active={false} freezePosition /></StrictMode>);
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
    mounted.unmount();
  });
});
