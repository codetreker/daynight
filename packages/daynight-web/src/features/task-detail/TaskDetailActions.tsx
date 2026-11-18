import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskDetailNotice } from './TaskDetailNotice';

export const TaskDetailActions = ({ popout, copyUrl, canDelete, onDelete }: {
  readonly popout?: string;
  readonly copyUrl?: string;
  readonly canDelete: boolean;
  readonly onDelete?: () => void;
}) => {
  const { messages } = useI18n();
  const m = messages.inspection.detail;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const [copyResult, setCopyResult] = useState<{ generation: number; state: 'pending' | 'copied' | 'failed' } | null>(null);
  const copyIdentity = useRef({ url: copyUrl, generation: 0, pending: false });
  if (copyIdentity.current.url !== copyUrl) copyIdentity.current = { url: copyUrl, generation: copyIdentity.current.generation + 1, pending: false };
  useLayoutEffect(() => () => { copyIdentity.current.generation++; }, []);
  const copyState = copyResult?.generation === copyIdentity.current.generation ? copyResult.state : null;
  const copy = async () => {
    if (copyUrl === undefined || copyIdentity.current.pending) return;
    copyIdentity.current.pending = true;
    const generation = ++copyIdentity.current.generation;
    setCopyResult({ generation, state: 'pending' });
    try {
      await navigator.clipboard.writeText(copyUrl);
      if (generation === copyIdentity.current.generation) setCopyResult({ generation, state: 'copied' });
    } catch {
      if (generation === copyIdentity.current.generation) setCopyResult({ generation, state: 'failed' });
    } finally {
      if (generation === copyIdentity.current.generation) copyIdentity.current.pending = false;
    }
  };
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current!.focus();
  };
  const show = (edge: 'first' | 'last') => { initial.current = edge; setOpen(true); };
  const items = () => Array.from(menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));

  useLayoutEffect(() => {
    if (!open) return;
    const element = menu.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      element.style.top = `${anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === 'closed') setOpen(false); };
    element.addEventListener('toggle', toggled);
    element.showPopover();
    const options = items();
    (options[initial.current === 'first' ? 0 : options.length - 1] ?? element).focus();
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      element.hidePopover();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current!.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <div className="task-detail-actions" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button className="button task-detail-more" type="button" ref={trigger} aria-label={m.moreActions} title={m.moreActions} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : show('first')} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 'first' : 'last'); }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
    </button>
    {open && <div className="task-detail-action-menu" ref={menu} id={menuId} popover="auto" role="menu" aria-label={m.moreActions} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const options = items();
        const current = options.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    }}>
      {popout !== undefined && <a className="task-detail-action-item task-detail-popout" role="menuitem" tabIndex={-1} href={popout} target="_blank" rel="noopener noreferrer" onClick={() => close(true)} onAuxClick={() => close(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 3h7v7M21 3 10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" /></svg><span>{m.openInNewTab}</span>
      </a>}
      {copyUrl !== undefined && <button className="task-detail-action-item" type="button" role="menuitem" tabIndex={-1} disabled={copyState === 'pending'} onClick={() => { void copy(); close(true); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg><span>{m.copyLink}</span>
      </button>}
      {onDelete !== undefined && <button className="task-detail-action-item task-detail-delete" type="button" role="menuitem" tabIndex={-1} disabled={!canDelete} onClick={() => { close(true); onDelete(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg><span>{messages.inspection.deletion.action}</span>
      </button>}
    </div>}
    <TaskDetailNotice active={copyState === 'copied' || copyState === 'failed'} event={copyResult} tone={copyState === 'failed' ? 'error' : 'success'}>
      {copyState === 'copied' && <span role="status">{m.linkCopied}</span>}
      {copyState === 'failed' && <span role="alert">{m.copyLinkFailed}</span>}
    </TaskDetailNotice>
  </div>;
};
