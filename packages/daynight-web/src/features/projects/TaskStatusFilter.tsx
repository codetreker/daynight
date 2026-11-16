import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { TaskStatus } from '../../api/types';
import { nearestOverlayOwner } from '../../app/overlay';
import { useI18n } from '../../i18n/LocaleProvider';
import { isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';
import { ALL_TASK_STATUSES } from './task-status-filter';
import './task-status-filter.css';

const filterOpened = 'daynight:tag-filter-opened';
const interactive = (element: HTMLElement): boolean => {
  if (!element.isConnected || element.closest('[hidden], [inert]')) return false;
  const view = element.ownerDocument.defaultView;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
};

export const TaskStatusFilter = ({ value, onChange }: { readonly value: readonly TaskStatus[]; readonly onChange: (value: readonly TaskStatus[]) => void }) => {
  const { messages: { workspace: { project: m } } } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const count = value.length;
  const summary = count === ALL_TASK_STATUSES.length ? m.allStatuses : count === 0 ? m.noStatuses : count === 1 ? m.statusOptions[value[0]!] : m.selectedStatuses({ count });

  useLayoutEffect(() => {
    if (allRef.current) allRef.current.indeterminate = count > 0 && count < ALL_TASK_STATUSES.length;
  }, [count, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current, trigger = triggerRef.current, panel = panelRef.current;
    if (!root || !trigger || !panel) return;
    const doc = root.ownerDocument, view = doc.defaultView;
    if (!view) return;
    const competing = (event: Event) => {
      if ((event as CustomEvent<HTMLElement>).detail !== root && interactive(root)) setOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (interactive(root) && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    const escapeOutside = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !(event.target instanceof Node) || root.contains(event.target) || !interactive(root) || isNativeSelectPopupOpen(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('dialog, [role="dialog"], [role="alertdialog"]') !== root.closest('dialog, [role="dialog"], [role="alertdialog"]')) return;
      const overlay = nearestOverlayOwner(new Set(doc.querySelectorAll<HTMLElement>('*')));
      if (overlay !== null && !overlay.contains(root)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus();
    };
    const position = () => {
      const viewport = view.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? doc.documentElement.clientWidth, height = viewport?.height ?? doc.documentElement.clientHeight;
      const marginX = Math.min(12, Math.max(0, (width - 48) / 2));
      const marginY = Math.min(12, Math.max(0, (height - 48) / 2));
      const left = x + marginX, right = x + width - marginX, top = y + marginY, bottom = y + height - marginY;
      const anchor = trigger.getBoundingClientRect();
      panel.style.maxWidth = `${Math.max(0, right - left)}px`;
      const panelWidth = panel.getBoundingClientRect().width;
      const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const belowStart = Math.max(top, Math.min(bottom, anchor.bottom + 5));
      const aboveEnd = Math.max(top, Math.min(bottom, anchor.top - 5));
      const below = bottom - belowStart, above = aboveEnd - top;
      let panelTop: number, available: number;
      if (naturalHeight <= below || below >= above) { panelTop = belowStart; available = below; }
      else { available = above; panelTop = aboveEnd - Math.min(naturalHeight, above); }
      if (available < 48) { panelTop = top; available = bottom - top; }
      panel.style.left = `${Math.max(left, Math.min(anchor.left, right - panelWidth))}px`;
      panel.style.top = `${panelTop}px`;
      panel.style.maxHeight = `${Math.max(0, available)}px`;
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(trigger); observer?.observe(panel);
    view.addEventListener('resize', position); view.addEventListener('scroll', position, true);
    view.visualViewport?.addEventListener('resize', position); view.visualViewport?.addEventListener('scroll', position);
    doc.addEventListener(filterOpened, competing);
    if (interactive(root)) doc.dispatchEvent(new CustomEvent(filterOpened, { detail: root }));
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', escapeOutside);
    return () => {
      observer?.disconnect();
      view.removeEventListener('resize', position); view.removeEventListener('scroll', position, true);
      view.visualViewport?.removeEventListener('resize', position); view.visualViewport?.removeEventListener('scroll', position);
      doc.removeEventListener(filterOpened, competing);
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', escapeOutside);
    };
  }, [open]);

  return <div ref={rootRef} className="task-status-filter task-status-multifilter" onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const root = rootRef.current;
    if (!root) return;
    const overlay = nearestOverlayOwner(new Set(root.ownerDocument.querySelectorAll<HTMLElement>('*')));
    if (overlay !== null && !overlay.contains(root)) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
  }}>
    <span>{m.statusFilter}</span>
    <button ref={triggerRef} type="button" className="task-status-filter-trigger" aria-label={`${m.statusFilter}: ${summary}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(previous => !previous)}>
      <span>{summary}</span><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 4 3 3 3-3" /></svg>
    </button>
    {open && <div ref={panelRef} id={panelId} className="task-status-filter-panel" role="group" aria-label={m.statusFilter}>
      <label className="task-status-filter-all"><input ref={allRef} type="checkbox" checked={count === ALL_TASK_STATUSES.length} onChange={() => onChange(count === ALL_TASK_STATUSES.length ? [] : ALL_TASK_STATUSES)} />{m.allStatuses}</label>
      {ALL_TASK_STATUSES.map(status => <label key={status}><input type="checkbox" checked={value.includes(status)} onChange={event => onChange(ALL_TASK_STATUSES.filter(item => item === status ? event.currentTarget.checked : value.includes(item)))} /><i className={`task-status-filter-dot task-status-filter-dot-${status}`} aria-hidden="true" />{m.statusOptions[status]}</label>)}
    </div>}
  </div>;
};
