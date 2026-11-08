import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { SessionDisplayMode } from './display-mode';
import type { SessionDisplayPreferenceIssue } from './display-preference';
import { useSessionMessages } from './messages';
import './session-display-menu.css';

const modes: readonly SessionDisplayMode[] = ['standard', 'conversation'];

export function SessionDisplayMenu({ mode, issue, onModeChange, onRetrySave, open, onOpenChange }: {
  readonly mode: SessionDisplayMode;
  readonly issue: SessionDisplayPreferenceIssue | null;
  readonly onModeChange: (mode: SessionDisplayMode) => void;
  readonly onRetrySave: () => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const m = useSessionMessages();
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'selected' | 'first' | 'last'>('selected');
  const latest = useRef({ mode, onOpenChange }); latest.current = { mode, onOpenChange };
  const items = () => Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'));
  const close = (restore: boolean) => { onOpenChange(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = (edge: typeof initial.current) => { initial.current = edge; onOpenChange(true); };

  useLayoutEffect(() => {
    if (!open) return;
    const element = menu.current!;
    const owner = trigger.current!.closest('.task-agent-session');
    const viewport = window.visualViewport;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const ownerBox = owner?.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const left = Math.max(viewportLeft, ownerBox?.left ?? viewportLeft);
      const right = Math.min(viewportLeft + (viewport?.width ?? window.innerWidth), ownerBox?.right ?? Infinity);
      // Top-layer placement avoids clipping, but the menu still belongs to this Session's width.
      element.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
      element.style.maxHeight = `${Math.max(0, bottom - top - 16)}px`;
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(anchor.right - box.width, right - box.width - 8))}px`;
      const preferredTop = anchor.bottom + box.height + 8 <= bottom ? anchor.bottom + 4 : anchor.top - box.height - 4;
      element.style.top = `${Math.max(top + 8, Math.min(preferredTop, bottom - box.height - 8))}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === 'closed') latest.current.onOpenChange(false); };
    element.addEventListener('toggle', toggled);
    element.showPopover();
    const options = items();
    const index = initial.current === 'first' ? 0 : initial.current === 'last' ? options.length - 1 : modes.indexOf(latest.current.mode);
    options[index]?.focus({ preventScroll: true });
    position();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    resize?.observe(element);
    if (owner !== null) resize?.observe(owner);
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', position, true);
      resize?.disconnect();
      element.hidePopover();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current!.contains(event.target as Node)) latest.current.onOpenChange(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const issueText = issue?.kind === 'read' ? m.displayReadError : issue?.kind === 'invalid' ? m.displayInvalidError : m.displayWriteError;
  return <div className="session-display-picker" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) close(false);
  }}>
    <button className="button session-display-trigger" type="button" ref={trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : show('selected')} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 'first' : 'last'); }
      }}>{m.display}<span aria-hidden="true"> ▾</span></button>
    {open && <div className="session-display-menu" id={menuId} ref={menu} role="menu" aria-label={m.display} popover="auto" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const options = items();
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus({ preventScroll: true });
      }
    }}>
      {modes.map(value => <button className="session-display-option" key={value} type="button" role="menuitemradio" aria-checked={mode === value} tabIndex={-1} onClick={() => onModeChange(value)}>
        <span>{value === 'standard' ? m.displayStandard : m.displayConversation}</span><span aria-hidden="true">{mode === value ? '✓' : ''}</span>
      </button>)}
      {issue !== null && <><p className="session-display-issue" role="alert">{issueText}</p><button className="session-display-option" type="button" role="menuitem" tabIndex={-1} onClick={() => {
        // A successful retry removes its button, so preserve focus on the current mode.
        items()[modes.indexOf(mode)]?.focus({ preventScroll: true });
        onRetrySave();
      }}>{m.displayRetry}</button></>}
    </div>}
  </div>;
}
