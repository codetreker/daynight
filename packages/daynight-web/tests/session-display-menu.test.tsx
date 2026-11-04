import { useState } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionDisplayMenu } from '../src/features/task-agent-session/SessionDisplayMenu';
import type { SessionDisplayMode } from '../src/features/task-agent-session/display-mode';
import type { SessionDisplayPreferenceIssue } from '../src/features/task-agent-session/display-preference';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
function Menu({ initialIssue = null, failSave = false, onEscape = () => {} }: {
  initialIssue?: SessionDisplayPreferenceIssue | null; failSave?: boolean; onEscape?: () => void;
}) {
  const [mode, setMode] = useState<SessionDisplayMode>('conversation');
  const [issue, setIssue] = useState(initialIssue);
  const [open, setOpen] = useState(false);
  return <div onKeyDown={event => { if (event.key === 'Escape') onEscape(); }}>
    <SessionDisplayMenu mode={mode} issue={issue} open={open} onOpenChange={setOpen}
      onModeChange={next => { setMode(next); if (failSave) setIssue({ kind: 'write' }); }} onRetrySave={() => setIssue(null)} />
    <button type="button">Outside</button>
  </div>;
}
const open = () => { fireEvent.click(screen.getByRole('button', { name: 'Display' })); };

describe('Session display menu', () => {
  it('reflects both selections without closing the menu or changing the available modes', () => {
    render(<Menu />); open();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
    expect(screen.getByRole('menuitemradio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Conversation' }));
    expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveAttribute('aria-checked', 'true');
  });
  it('translates an open menu and its error without resetting selection or nodes', () => {
    const view = render(<Menu failSave />); open();
    const standard = screen.getByRole('menuitemradio', { name: 'Standard' }); fireEvent.click(standard);
    expect(screen.getByRole('alert')).toHaveTextContent('not saved');
    view.setLocale('zh-CN');
    expect(screen.getByRole('menuitemradio', { name: '标准' })).toBe(standard);
    expect(standard).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: '显示' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('未保存');
    fireEvent.click(screen.getByRole('menuitem', { name: '重试保存' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(standard).toHaveFocus();
  });
  it('opens at the selected option and isolates Escape while restoring trigger focus', () => {
    const outer = vi.fn(); render(<Menu onEscape={outer} />); open();
    const selected = screen.getByRole('menuitemradio', { name: 'Conversation' }); expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Display' })).toHaveFocus();
    expect(outer).not.toHaveBeenCalled();
  });
  it('supports arrow opening and cyclic arrow, Home and End navigation', () => {
    render(<Menu />);
    const trigger = screen.getByRole('button', { name: 'Display' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const standard = screen.getByRole('menuitemradio', { name: 'Standard' });
    const conversation = screen.getByRole('menuitemradio', { name: 'Conversation' });
    expect(standard).toHaveFocus();
    fireEvent.keyDown(standard, { key: 'ArrowUp' }); expect(conversation).toHaveFocus();
    fireEvent.keyDown(conversation, { key: 'ArrowDown' }); expect(standard).toHaveFocus();
    fireEvent.keyDown(standard, { key: 'End' }); expect(conversation).toHaveFocus();
    fireEvent.keyDown(conversation, { key: 'Home' }); expect(standard).toHaveFocus();
    fireEvent.keyDown(standard, { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'ArrowUp' }); expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveFocus();
  });
  it('closes on an outside pointer or focus leaving, without taking focus back', () => {
    render(<Menu />); open();
    const outside = screen.getByRole('button', { name: 'Outside' });
    fireEvent.pointerDown(outside); expect(screen.queryByRole('menu')).toBeNull();
    open(); act(() => outside.focus());
    expect(screen.queryByRole('menu')).toBeNull(); expect(outside).toHaveFocus();
  });
  it('closes on Tab with a surviving focus origin for native keyboard traversal', () => {
    render(<Menu />); open();
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Conversation' }), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull(); expect(screen.getByRole('button', { name: 'Display' })).toHaveFocus();
  });
  it.each(['read', 'invalid', 'write'] as const)('shows %s errors only inside the menu and retries the current selection', kind => {
    render(<Menu initialIssue={{ kind }} />);
    expect(screen.queryByRole('alert')).toBeNull(); open();
    expect(screen.getByRole('alert')).toBeVisible();
    const retry = screen.getByRole('menuitem', { name: 'Retry saving' });
    act(() => retry.focus()); fireEvent.click(retry);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Retry saving' })).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveFocus();
  });
  it('keeps a failed selection visible until retry without reporting success', () => {
    render(<Menu failSave />); open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
    expect(screen.getByRole('menuitemradio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('not saved');
    fireEvent.click(screen.getByRole('button', { name: 'Display' })); expect(screen.queryByRole('alert')).toBeNull();
    open(); expect(screen.getByRole('alert')).toHaveTextContent('not saved');
  });
  it('clamps a menu anchored in a narrow edge container and updates on resize', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? { left: 0, right: 240, top: 0, bottom: 160, width: 240, height: 160, x: 0, y: 0, toJSON() {} }
        : { left: 2, right: 70, top: 700, bottom: 740, width: 68, height: 40, x: 2, y: 700, toJSON() {} };
    });
    render(<Menu />); open();
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('8px'); expect(menu.style.top).toBe('536px');
    fireEvent(window, new Event('resize')); expect(menu.style.left).toBe('8px');
    rect.mockRestore();
  });
  it.each([260, 200])('keeps the popover inside its %ipx Session owner on a wide viewport', width => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = (left: number, width: number) => ({ left, right: left + width, top: 100, bottom: 140, width, height: 40, x: left, y: 100, toJSON() {} });
      if (this.classList.contains('task-agent-session')) return box(510, width);
      if (this.getAttribute('role') === 'menu') return box(Number.parseFloat(this.style.left) || 0, Math.min(240, Number.parseFloat(this.style.maxWidth) || 240));
      return box(590, 70);
    });
    render(<section className="task-agent-session"><Menu /></section>); open();
    const menu = screen.getByRole('menu');
    expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(518);
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(510 + width - 8);
    expect(Number.parseFloat(menu.style.maxWidth)).toBe(width - 16);
    rect.mockRestore();
  });
});
