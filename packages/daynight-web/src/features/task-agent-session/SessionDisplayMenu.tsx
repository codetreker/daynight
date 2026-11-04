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
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      element.style.top = `${anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
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
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', position);
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
