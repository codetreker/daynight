import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { GraphTask } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskPauseCount } from '../task-pause/TaskPause';
import './project-paused-tasks.css';

export function ProjectPausedTasks({ tasks, active, onOpenTask, onFocusFallback }: {
  readonly tasks: readonly GraphTask[];
  readonly active: boolean;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onFocusFallback: () => void;
}) {
  const { messages: { inspection: { pause: m }, common } } = useI18n();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  const previousIds = useRef<readonly string[]>([]);
  const latest = useRef({ onFocusFallback }); latest.current = { onFocusFallback };
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const close = (restore: boolean) => { setOpen(false); focused.current = null; if (restore) trigger.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open) return;
    const element = menu.current!;
    const viewport = window.visualViewport;
    const position = () => {
      if (trigger.current === null) return;
      const anchor = trigger.current.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      element.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
      element.style.maxHeight = `${Math.max(0, bottom - top - 16)}px`;
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(anchor.right - box.width, right - box.width - 8))}px`;
      const preferredTop = anchor.bottom + box.height + 8 <= bottom ? anchor.bottom + 4 : anchor.top - box.height - 4;
      element.style.top = `${Math.max(top + 8, Math.min(preferredTop, bottom - box.height - 8))}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === 'closed') { focused.current = null; setOpen(false); } };
    element.addEventListener('toggle', toggled);
    element.showPopover();
    items()[0]?.focus({ preventScroll: true });
    position();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    resize?.observe(element);
    if (trigger.current !== null) resize?.observe(trigger.current);
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
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useLayoutEffect(() => {
    const ids = tasks.map(task => task.id);
    const oldIndex = focused.current === null ? -1 : previousIds.current.indexOf(focused.current);
    const removed = focused.current !== null && !ids.includes(focused.current);
    if (open && removed && (document.activeElement === document.body || menu.current?.contains(document.activeElement))) {
      if (ids.length === 0) { focused.current = null; setOpen(false); latest.current.onFocusFallback(); }
      else items()[Math.min(Math.max(oldIndex, 0), ids.length - 1)]?.focus({ preventScroll: true });
    } else if (open && ids.length === 0) { focused.current = null; setOpen(false); }
    previousIds.current = ids;
  }, [tasks, open]);
  useLayoutEffect(() => { if (!active && open) close(false); }, [active, open]);

  return <div className="project-paused-tasks" ref={container} onBlur={event => {
    if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) close(false);
  }}>
    <TaskPauseCount count={tasks.length} buttonRef={trigger} expanded={open} {...(open ? { controls: menuId } : {})} onClick={() => open ? close(false) : setOpen(true)} />
    {open && <div className="project-paused-menu" id={menuId} ref={menu} role="menu" aria-label={m.listTitle} popover="auto" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const options = items();
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    }}>
      <div className="project-paused-menu-title">{m.listTitle}</div>
      {tasks.map(task => <button key={task.id} className="project-paused-option" type="button" role="menuitem" tabIndex={-1} onFocus={() => { focused.current = task.id; }} onClick={() => {
        const anchor = trigger.current;
        close(false);
        if (anchor !== null) onOpenTask(task.id, anchor);
      }}>
        <span className="project-paused-option-title">{task.titlePreview}{task.titleTruncated && <>… <span className="project-paused-truncated">({m.truncated})</span></>}</span>
        <span className="project-paused-option-meta"><span>{task.id.slice(0, 8)}</span><span>{common.status[task.status]}</span></span>
      </button>)}
    </div>}
  </div>;
}
