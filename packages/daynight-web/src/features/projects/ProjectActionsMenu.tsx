import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useProjectAccess } from './ProjectAccess';

type ProjectAction = 'settings' | 'refresh' | 'task' | 'goal';

type Props = {
  readonly projectId: string;
  readonly label: string;
  readonly settings: ReactNode;
  readonly refreshLabel: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly taskLabel: string;
  readonly taskDisabled: boolean;
  readonly onCreateTask: () => void;
  readonly goalLabel: string;
  readonly onCreateGoal: () => void;
  readonly headingContainer: RefObject<HTMLDivElement | null>;
  readonly heading: RefObject<HTMLHeadingElement | null>;
};

export function ProjectActionsMenu({ projectId, label, settings, refreshLabel, refreshing, onRefresh, taskLabel, taskDisabled, onCreateTask, goalLabel, onCreateGoal, headingContainer, heading }: Props) {
  const scope = useTaskCacheScope();
  const access = useProjectAccess(projectId);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'first' | 'last'>('first');
  const lastFocused = useRef<{ readonly element: HTMLElement; readonly source: 'menu' | 'desktop' | 'other'; readonly action?: ProjectAction } | null>(null);
  const compact = useRef<boolean | null>(null);
  const menuId = useId();
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const focusItem = (item: HTMLElement) => {
    item.focus({ preventScroll: true });
    const element = menu.current;
    if (element === null) return;
    const bounds = element.getBoundingClientRect();
    const top = bounds.top + element.clientTop;
    const bottom = top + element.clientHeight;
    const itemBounds = item.getBoundingClientRect();
    if (itemBounds.top < top || itemBounds.height > element.clientHeight) element.scrollTop += itemBounds.top - top;
    else if (itemBounds.bottom > bottom) element.scrollTop += itemBounds.bottom - bottom;
  };
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = (edge: 'first' | 'last') => { initial.current = edge; setOpen(true); };

  useLayoutEffect(() => scope.subscribe(event => {
    if (event.projectId === projectId && event.accessRevoked && !access.session.isProjectReadCleanupFailure(event)) setOpen(false);
  }), [scope, projectId, access.session]);
  useLayoutEffect(() => { if (access.status === 'unavailable') setOpen(false); }, [access.status]);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const inMenu = container.current?.contains(target) === true;
      const desktop = headingContainer.current?.contains(target) === true && target.closest('[data-project-action]') !== null;
      const action = target.closest<HTMLElement>('[data-project-menu-action]')?.dataset.projectMenuAction as ProjectAction | undefined;
      lastFocused.current = { element: target, source: inMenu ? 'menu' : desktop ? 'desktop' : 'other', ...(action === undefined ? {} : { action }) };
    };
    const pointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!container.current?.contains(target) && target.closest('[data-project-action]') === null)) lastFocused.current = null;
    };
    document.addEventListener('focusin', remember);
    document.addEventListener('pointerdown', pointer);
    return () => { document.removeEventListener('focusin', remember); document.removeEventListener('pointerdown', pointer); };
  }, [headingContainer]);

  useEffect(() => {
    const region = headingContainer.current;
    if (region === null) return;
    const update = (width: number) => {
      const next = width <= 420;
      if (compact.current === null) { compact.current = next; return; }
      if (compact.current === next) return;
      compact.current = next;
      const active = document.activeElement;
      const remembered = lastFocused.current;
      const focus = !document.hasFocus() ? null : active instanceof HTMLElement && active !== document.body && active !== remembered?.element ? null : remembered;
      if (next) {
        if (focus?.source === 'desktop') trigger.current?.focus({ preventScroll: true });
      } else {
        if (focus?.source === 'menu') {
          // Native popover dismissal may restore its opener; dismiss before transferring focus.
          menu.current?.hidePopover();
          const action = focus.action;
          const target = action === undefined ? region.querySelector<HTMLElement>('[data-project-action]') : region.querySelector<HTMLElement>(`[data-project-action="${action}"]`);
          if (target !== null && !target.matches(':disabled') && target.getClientRects().length > 0) target.focus({ preventScroll: true });
          else heading.current?.focus({ preventScroll: true });
        }
        setOpen(false);
      }
    };
    const measure = () => {
      const style = getComputedStyle(region);
      const inset = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      update(region.getBoundingClientRect().width - inset);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => { const entry = entries[0]; if (entry !== undefined) update(entry.contentRect.width); });
    observer?.observe(region);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [headingContainer, heading]);

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
    const toggled = (event: ToggleEvent) => { if (event.newState === 'closed') setOpen(false); };
    element.addEventListener('toggle', toggled);
    element.showPopover();
    position();
    const options = items();
    const first = options[initial.current === 'first' ? 0 : options.length - 1];
    if (first === undefined) element.focus({ preventScroll: true });
    else focusItem(first);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(element);
    if (trigger.current !== null) observer?.observe(trigger.current);
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggled);
      observer?.disconnect();
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', position, true);
      element.hidePopover();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) { lastFocused.current = null; close(false); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <div className="project-actions-menu" ref={container} onBlur={event => {
    if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) close(false);
  }}>
    <button className="button project-actions-trigger" ref={trigger} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : show('first')} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 'first' : 'last'); }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
    </button>
    {open && <div className="project-action-popover" ref={menu} id={menuId} popover="auto" role="menu" aria-label={label} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const options = items();
        if (options.length === 0) return;
        const current = options.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        const target = options[next];
        if (target !== undefined) focusItem(target);
      }
    }}>
      {settings != null && <div role="none" data-project-menu-action="settings" onClick={() => close(false)} onAuxClick={() => close(false)}>{settings}</div>}
      <button className="project-action-item" type="button" role="menuitem" tabIndex={-1} data-project-menu-action="refresh" disabled={refreshing} aria-busy={refreshing} onClick={() => { close(true); onRefresh(); }}>{refreshLabel}</button>
      <button className="project-action-item" type="button" role="menuitem" tabIndex={-1} data-project-menu-action="task" disabled={taskDisabled} onClick={() => { close(true); onCreateTask(); }}>{taskLabel}</button>
      <button className="project-action-item" type="button" role="menuitem" tabIndex={-1} data-project-menu-action="goal" onClick={() => { close(true); onCreateGoal(); }}>{goalLabel}</button>
    </div>}
  </div>;
}
