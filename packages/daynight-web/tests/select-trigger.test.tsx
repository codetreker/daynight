import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectTrigger } from '../src/ui/selection-control/SelectTrigger';

describe('SelectTrigger', () => {
  it('passes the real button ref, accessibility, form attributes and native disabled behavior', async () => {
    const ref = createRef<HTMLButtonElement>(), click = vi.fn();
    const { rerender } = render(<><form id="filters" /><p id="hint">Choose visible states</p>
      <SelectTrigger ref={ref} id="status" form="filters" name="status" value="todo" aria-describedby="hint"
        aria-expanded={false} aria-controls="status-options" onClick={click}>Statuses</SelectTrigger></>);
    const trigger = screen.getByRole('button', { name: 'Statuses' });
    expect(trigger).toBe(ref.current);
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAccessibleDescription('Choose visible states');
    expect(ref.current!.form).toBe(document.getElementById('filters'));
    await userEvent.click(trigger); expect(click).toHaveBeenCalledOnce();
    rerender(<SelectTrigger ref={ref} disabled onClick={click}>Statuses</SelectTrigger>);
    await userEvent.click(screen.getByRole('button')); expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('retains the element and focus while callers own expanded state and selection', async () => {
    const Host = () => {
      const [open, setOpen] = useState(false);
      return <SelectTrigger density="filter" touchMode="responsive" focusTone="task" pending aria-invalid
        layoutClassName="filter-layout" count={open ? 2 : 0} aria-expanded={open} onClick={() => setOpen(value => !value)}>Tags</SelectTrigger>;
    };
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    trigger.focus(); await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Tags 2' })).toBe(trigger);
    expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('data-density', 'filter');
    expect(trigger).toHaveAttribute('data-touch-mode', 'responsive');
    expect(trigger).toHaveAttribute('data-focus-tone', 'task');
    expect(trigger).toHaveAttribute('data-pending', 'true');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveClass('filter-layout');
    const arrow = trigger.querySelector('svg')!;
    expect(arrow).toHaveAttribute('aria-hidden', 'true'); expect(arrow).toHaveAttribute('focusable', 'false');
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  });

  it('keeps summary as the direct details child and forwards its own ref and events', () => {
    const ref = createRef<HTMLElement>(), click = vi.fn(), keydown = vi.fn();
    render(<details><SelectTrigger as="summary" ref={ref} aria-label="Tag filter" count={3}
      onClick={click} onKeyDown={keydown}>Tags</SelectTrigger><p>Options</p></details>);
    const trigger = screen.getByText('Tags').closest('summary')!;
    expect(trigger).toBe(ref.current); expect(trigger.parentElement!.tagName).toBe('DETAILS');
    expect(trigger.parentElement!.firstElementChild).toBe(trigger);
    expect(trigger).toHaveAccessibleName('Tag filter');
    expect(trigger).not.toHaveAttribute('type'); expect(trigger).not.toHaveAttribute('role');
    fireEvent.click(trigger); fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(click).toHaveBeenCalledOnce(); expect(click.mock.calls[0]![0].target).toBe(trigger);
    expect(keydown).toHaveBeenCalledOnce();
  });
});
