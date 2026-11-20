import { useEffect, useLayoutEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphReadingHintProvider, useGraphReadingHint } from '../src/features/task-graph/GraphReadingHint';

const Source = ({ usage, id = 'task' }: { usage: string | null; id?: string }) => {
  const hint = useGraphReadingHint();
  const reading = { usage, execution: null };
  useLayoutEffect(() => { hint.update(id, reading); }, [hint, id, usage]);
  useEffect(() => () => hint.remove(id), [hint, id]);
  return <button onFocus={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'focus', reading)} onBlur={() => hint.blur(id)}
    onPointerEnter={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'hover', reading)} onPointerLeave={() => hint.leave(id)}
    onClick={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'touch', reading)}>{id === 'task' ? 'Task' : id}</button>;
};

const ReadingSource = ({ id, usage, execution }: { id: string; usage: string | null; execution: string | null }) => {
  const hint = useGraphReadingHint();
  const reading = { usage, execution };
  useLayoutEffect(() => { hint.update(id, reading); }, [hint, id, usage, execution]);
  useEffect(() => () => hint.remove(id), [hint, id]);
  return <button onFocus={(event) => hint.show(id, event.currentTarget, event.currentTarget, 'focus', reading)} onBlur={() => hint.blur(id)}>
    {id}{usage !== null && <span data-testid={`${id}-usage`} onPointerEnter={(event) => hint.show(id, event.currentTarget.closest('button')!, event.currentTarget, 'hover', reading)}>{usage}</span>}
    {execution !== null && <span data-testid={`${id}-execution`} onPointerEnter={(event) => hint.show(id, event.currentTarget.closest('button')!, event.currentTarget, 'hover', reading)}>{execution}</span>}
  </button>;
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

  it('restores focus when a hovered usage anchor is removed, while preserving valid execution data', () => {
    const content = (a: boolean, usage: string | null, execution: string | null) => <GraphReadingHintProvider>
      {a && <ReadingSource id="A" usage="A usage" execution="A duration" />}
      <ReadingSource id="B" usage={usage} execution={execution} />
    </GraphReadingHintProvider>;
    const view = render(content(true, 'B usage', 'B duration'));
    const a = screen.getByRole('button', { name: /A usage/ });
    const tip = view.container.querySelector('.graph-reading-hint')!;
    act(() => a.focus());
    fireEvent.pointerEnter(screen.getByTestId('B-usage'));
    expect(tip).toHaveTextContent('B usage');
    view.rerender(content(true, null, 'B duration'));
    expect(tip).toHaveTextContent('A usage');
    expect(tip).toHaveTextContent('A duration');
    expect(tip).not.toHaveTextContent('B usage');
    expect(a).toHaveFocus();
    fireEvent.pointerEnter(screen.getByTestId('B-execution'));
    expect(tip).toHaveTextContent('B duration');
    expect(tip).not.toHaveTextContent('B usage');
  });

  it('restores focus when a hovered card unmounts and does not undo Escape', () => {
    const content = (b: boolean) => <GraphReadingHintProvider>
      <ReadingSource id="A" usage="A usage" execution={null} />
      {b && <ReadingSource id="B" usage="B usage" execution="B duration" />}
    </GraphReadingHintProvider>;
    const view = render(content(true));
    const a = screen.getByRole('button', { name: /A usage/ });
    const tip = view.container.querySelector('.graph-reading-hint')!;
    act(() => a.focus());
    fireEvent.pointerEnter(screen.getByTestId('B-usage'));
    view.rerender(content(false));
    expect(tip).toHaveTextContent('A usage');
    expect(a).toHaveFocus();
    view.rerender(content(true));
    fireEvent.pointerEnter(screen.getByTestId('B-usage'));
    fireEvent.keyDown(document, { key: 'Escape' });
    view.rerender(content(false));
    expect(tip).toBeEmptyDOMElement();
    expect(a).toHaveFocus();
  });

  it('closes the hovered hint when its anchor disappears without a focused card', () => {
    const content = (usage: string | null) => <GraphReadingHintProvider><ReadingSource id="B" usage={usage} execution="B duration" /></GraphReadingHintProvider>;
    const view = render(content('B usage'));
    const tip = view.container.querySelector('.graph-reading-hint')!;
    fireEvent.pointerEnter(screen.getByTestId('B-usage'));
    view.rerender(content(null));
    expect(tip).toBeEmptyDOMElement();
    fireEvent.pointerEnter(screen.getByTestId('B-execution'));
    expect(tip).toHaveTextContent('B duration');
  });

  it('finishes a delayed hover leave when keyboard focus moves to a card with no reading', () => {
    vi.useFakeTimers();
    try {
      const content = (b: string | null) => <GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /><Source id="B" usage={b} /></GraphReadingHintProvider>;
      const view = render(content(null));
      const details = screen.getByRole('button', { name: 'Details' });
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => details.focus());
      fireEvent.pointerEnter(a);
      expect(tip).toHaveTextContent('A reading');
      fireEvent.pointerLeave(a);
      act(() => { vi.advanceTimersByTime(60); b.focus(); });
      expect(tip).toHaveTextContent('A reading');
      act(() => vi.advanceTimersByTime(60));
      expect(tip).toBeEmptyDOMElement();
      expect(b).toHaveFocus();
      view.rerender(content('B reading'));
      expect(tip).toHaveTextContent('B reading');
      expect(b).toHaveFocus();
    } finally { vi.useRealTimers(); }
  });

  it('keeps a pointer reading visible when its focused body loses focus', () => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphReadingHintProvider><Source id="A" usage="A reading" /><button>Details</button></GraphReadingHintProvider>);
      const a = screen.getByRole('button', { name: 'A' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => a.focus());
      fireEvent.pointerEnter(a);
      act(() => screen.getByRole('button', { name: 'Details' }).focus());
      expect(tip).toHaveTextContent('A reading');
      fireEvent.pointerLeave(a);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

  it('dismisses touch readings on outside interaction, Escape and source removal', () => {
    const content = (present: boolean) => <GraphReadingHintProvider><button>Details</button>{present && <Source id="A" usage="A reading" />}</GraphReadingHintProvider>;
    const view = render(content(true));
    const tip = view.container.querySelector('.graph-reading-hint')!;
    const a = screen.getByRole('button', { name: 'A' });
    const details = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(a);
    expect(tip).toHaveTextContent('A reading');
    fireEvent.pointerDown(details);
    expect(tip).toBeEmptyDOMElement();
    fireEvent.click(a);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip).toBeEmptyDOMElement();
    fireEvent.click(a);
    view.rerender(content(false));
    expect(tip).toBeEmptyDOMElement();
  });

  it('prioritizes a newly focused card with data and restores a still-hovered card on blur', () => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /><Source id="B" usage="B reading" /></GraphReadingHintProvider>);
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      const details = screen.getByRole('button', { name: 'Details' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => details.focus());
      fireEvent.pointerEnter(a);
      act(() => b.focus());
      expect(tip).toHaveTextContent('B reading');
      act(() => details.focus());
      expect(tip).toHaveTextContent('A reading');
      fireEvent.pointerLeave(a);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

  it('shows a newly available focused reading while another card remains hovered', () => {
    const content = (reading: string | null) => <GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /><Source id="B" usage={reading} /></GraphReadingHintProvider>;
    const view = render(content(null));
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    const tip = view.container.querySelector('.graph-reading-hint')!;
    act(() => screen.getByRole('button', { name: 'Details' }).focus());
    fireEvent.pointerEnter(a);
    act(() => b.focus());
    expect(tip).toHaveTextContent('A reading');
    view.rerender(content('B reading'));
    expect(tip).toHaveTextContent('B reading');
    expect(b).toHaveFocus();
  });

  it('does not let a focused card’s tooltip cancel another card’s pending hover leave', () => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /><Source id="B" usage="B reading" /></GraphReadingHintProvider>);
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      const details = screen.getByRole('button', { name: 'Details' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => details.focus());
      fireEvent.pointerEnter(a);
      fireEvent.pointerLeave(a);
      act(() => { vi.advanceTimersByTime(60); b.focus(); });
      expect(tip).toHaveTextContent('B reading');
      fireEvent.pointerEnter(tip);
      act(() => vi.advanceTimersByTime(60));
      act(() => details.focus());
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

  it('keeps a hovered reading open as the pointer moves into its tooltip', () => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphReadingHintProvider><Source id="A" usage="A reading" /></GraphReadingHintProvider>);
      const a = screen.getByRole('button', { name: 'A' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      fireEvent.pointerEnter(a);
      fireEvent.pointerLeave(a);
      act(() => vi.advanceTimersByTime(60));
      fireEvent.pointerEnter(tip);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toHaveTextContent('A reading');
      fireEvent.pointerLeave(tip);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the same hover source when focus also moves to its card', () => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /></GraphReadingHintProvider>);
      const details = screen.getByRole('button', { name: 'Details' });
      const a = screen.getByRole('button', { name: 'A' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => details.focus());
      fireEvent.pointerEnter(a);
      fireEvent.pointerLeave(a);
      act(() => { vi.advanceTimersByTime(60); a.focus(); });
      fireEvent.pointerEnter(tip);
      act(() => vi.advanceTimersByTime(120));
      act(() => details.focus());
      expect(tip).toHaveTextContent('A reading');
      fireEvent.pointerLeave(tip);
      act(() => vi.advanceTimersByTime(120));
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

  it('does not replace a touch reading with data arriving for a different focused card', () => {
    const content = (a: string | null) => <GraphReadingHintProvider><Source id="A" usage={a} /><Source id="B" usage="B reading" /></GraphReadingHintProvider>;
    const view = render(content(null));
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    const tip = view.container.querySelector('.graph-reading-hint')!;
    act(() => a.focus());
    fireEvent.pointerEnter(b);
    fireEvent.pointerDown(b, { pointerType: 'touch' });
    fireEvent.click(b);
    view.rerender(content('A reading'));
    expect(a).toHaveFocus();
    expect(tip).toHaveTextContent('B reading');
  });

  it.each([false, true])('expires a hover in its tooltip when another focused card becomes visible (async: %s)', (delayed) => {
    vi.useFakeTimers();
    try {
      const content = (b: string | null) => <GraphReadingHintProvider><button>Details</button><Source id="A" usage="A reading" /><Source id="B" usage={b} /></GraphReadingHintProvider>;
      const view = render(content(delayed ? null : 'B reading'));
      const details = screen.getByRole('button', { name: 'Details' });
      const a = screen.getByRole('button', { name: 'A' });
      const b = screen.getByRole('button', { name: 'B' });
      const tip = view.container.querySelector('.graph-reading-hint')!;
      act(() => details.focus());
      fireEvent.pointerEnter(a);
      fireEvent.pointerLeave(a);
      fireEvent.pointerEnter(tip);
      act(() => b.focus());
      if (delayed) view.rerender(content('B reading'));
      expect(tip).toHaveTextContent('B reading');
      fireEvent.pointerLeave(tip);
      act(() => vi.advanceTimersByTime(120));
      act(() => details.focus());
      expect(tip).toBeEmptyDOMElement();
    } finally { vi.useRealTimers(); }
  });

});
