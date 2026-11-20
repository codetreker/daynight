import { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphReadingHintProvider, useGraphReadingHint } from '../src/features/task-graph/GraphReadingHint';

const Source = ({ usage }: { usage: string | null }) => {
  const hint = useGraphReadingHint();
  const reading = { usage, execution: null };
  useLayoutEffect(() => { hint.update('task', reading); }, [hint, usage]);
  return <button onFocus={(event) => hint.show('task', event.currentTarget, event.currentTarget, 'focus', reading)} onBlur={() => hint.dismiss('task')}>Task</button>;
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

});
