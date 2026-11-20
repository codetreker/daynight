import { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphReadingHintProvider, useGraphReadingHint } from '../src/features/task-graph/GraphReadingHint';

const Source = ({ usage, id = 'task' }: { usage: string | null; id?: string }) => {
  const hint = useGraphReadingHint();
  const reading = { usage, execution: null };
  useLayoutEffect(() => { hint.update(id, reading); }, [hint, id, usage]);
  return <button onFocus={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'focus', reading)} onBlur={() => hint.dismiss(id)}
    onPointerEnter={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'hover', reading)} onPointerLeave={() => hint.leave(id)}>{id === 'task' ? 'Task' : id}</button>;
};

describe('graph reading hint', () => {
  it('shows readings that arrive or recover while the body retains focus, without reopening after Escape', () => {
    const view = render(<GraphReadingHintProvider><Source usage={null} /></GraphReadingHintProvider>);
    const button = screen.getByRole('button', { name: 'Task' });
    act(() => button.focus());
    const tip = view.container.querySelector('.graph-reading-hint')!;
    expect(tip).toBeEmptyDOMElement();
    view.rerender(<GraphReadingHintProvider><Source usage="Known output: 10" /></GraphReadingHintProvider>);
    expect(tip).toHaveTextContent('Known output: 10');
    view.rerender(<GraphReadingHintProvider><Source usage={null} /></GraphReadingHintProvider>);
    expect(tip).toBeEmptyDOMElement();
    expect(button).toHaveFocus();
    view.rerender(<GraphReadingHintProvider><Source usage="Known output: 12" /></GraphReadingHintProvider>);
    expect(tip).toHaveTextContent('Known output: 12');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip).toBeEmptyDOMElement();
    view.rerender(<GraphReadingHintProvider><Source usage="Known output: 14" /></GraphReadingHintProvider>);
    expect(tip).toBeEmptyDOMElement();
    expect(button).toHaveFocus();
  });
  it('scrolls an oversized reading with the keyboard while keeping focus on the body', () => {
    const view = render(<GraphReadingHintProvider><Source usage="A long reading" /></GraphReadingHintProvider>);
    const button = screen.getByRole('button', { name: 'Task' });
    act(() => button.focus());
    const tip = view.container.querySelector<HTMLElement>('.graph-reading-hint')!;
    Object.defineProperties(tip, { scrollHeight: { value: 300 }, clientHeight: { value: 100 } });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(tip.scrollTop).toBe(40);
    fireEvent.keyDown(button, { key: 'PageDown' });
    expect(tip.scrollTop).toBe(140);
    expect(button).toHaveFocus();
  });

  it('restores the focused card’s latest reading after another card is hovered, unless dismissed', () => {
    vi.useFakeTimers();
    try {
      const content = (a: string | null, b: string | null) => <GraphReadingHintProvider><Source id="A" usage={a} /><Source id="B" usage={b} /></GraphReadingHintProvider>;
      const view = render(content('A: 10', 'B: 20'));
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => a.focus());
      expect(tip).toHaveTextContent('A: 10');
      fireEvent.pointerEnter(b);
      expect(tip).toHaveTextContent('B: 20');
      view.rerender(content('A: 11', 'B: 21'));
      expect(tip).toHaveTextContent('B: 21');
      fireEvent.pointerLeave(b);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toHaveTextContent('A: 11');
      expect(a).toHaveFocus();

      fireEvent.pointerEnter(b);
      view.rerender(content(null, 'B: 21'));
      fireEvent.pointerLeave(b);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
      view.rerender(content('A: 12', 'B: 21'));
      expect(tip).toHaveTextContent('A: 12');

      fireEvent.pointerEnter(b);
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.pointerLeave(b);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
      view.rerender(content('A: 13', 'B: 21'));
      expect(tip).toBeEmptyDOMElement();
      expect(a).toHaveFocus();
    } finally { vi.useRealTimers(); }
  });

});
