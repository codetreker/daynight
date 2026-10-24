import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { TaskDetail, TaskStatus } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskMutationState } from './TaskDetailSession';
import { TaskDetailNotice, useMutationNoticeEvent } from './TaskDetailNotice';

const statuses: readonly TaskStatus[] = ['todo', 'in_progress', 'done'];
export const TaskStatusMenu = ({ status, disabled, onSelect }: {
  readonly status: TaskStatus;
  readonly disabled: boolean;
  readonly onSelect: (status: TaskStatus) => void;
}) => {
  const { messages } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = (index: number) => { setActive(index); setOpen(true); };
  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current!.getBoundingClientRect();
    const height = menu.current!.getBoundingClientRect().height;
    menu.current!.style.top = `${box.bottom + height + 12 < window.innerHeight ? box.bottom + 6 : Math.max(8, box.top - height - 6)}px`;
    menu.current!.style.left = `${Math.max(8, Math.min(box.right - 174, window.innerWidth - 182))}px`;
    options.current[active]?.focus();
  }, [open, active]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current!.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="task-status-picker" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button className="button task-status-trigger" ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      disabled={disabled} onClick={() => open ? close(false) : show(statuses.indexOf(status))}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 0 : statuses.length - 1); } }}>
      <i className={`task-detail-dot-${status}`} aria-hidden="true" />{messages.common.status[status]}<span className="task-status-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="task-status-menu" ref={menu} id={menuId} role="menu" aria-label={messages.inspection.status.menu} onKeyDown={(event) => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : event.key === 'End' ? statuses.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + statuses.length) % statuses.length);
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(false);
    }}>{statuses.map((value, index) => <button key={value} ref={(node) => { options.current[index] = node; }} type="button" role="menuitemradio" aria-checked={status === value} tabIndex={index === active ? 0 : -1}
      className="task-status-option" onFocus={() => setActive(index)} onClick={() => { close(true); onSelect(value); }}>
      <i className={`task-detail-dot-${value}`} aria-hidden="true" /><span>{messages.common.status[value]}</span><span aria-hidden="true">{status === value ? '✓' : ''}</span>
    </button>)}</div>}
  </div>;
};

const StatusError = ({ error }: { readonly error: unknown }) => {
  const { messages: { inspection: { status: m }, common } } = useI18n();
  const message = error instanceof ApiError
    ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
      : error.code === 'version_conflict' ? m.versionConflict : error.code === 'dependency_unsatisfied' ? m.dependencyUnsatisfied
        : error.code === 'not_found' ? m.notFound : m.refused
    : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}{' '}<code>{error.requestId}</code></p>}</>;
};

export const TaskStatusFeedback = ({ mutation, onReconcile }: {
  readonly detail: TaskDetail | null;
  readonly mutation: TaskMutationState;
  readonly onReconcile: () => void;
}) => {
  const { messages: { inspection: { status: m } } } = useI18n();
  const event = useMutationNoticeEvent(mutation);
  const relevant = mutation.phase !== 'idle' && mutation.operation?.action === 'status';
  const busy = mutation.phase === 'pending' || mutation.reconciling;
  const unresolved = mutation.phase === 'unknown' || mutation.reconciliationError !== null;
  const summary = mutation.reconciling ? m.checking : mutation.phase === 'pending' ? m.pending
    : mutation.phase === 'confirmed' ? m.confirmed : mutation.phase === 'unknown' ? m.unknown : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  const tone = mutation.phase === 'confirmed' ? 'success' : mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info';
  return <TaskDetailNotice active={relevant} event={event} initiallyVisible={mutation.phase !== 'confirmed'} tone={tone} recoverable={unresolved}><section className="task-status-feedback" data-tone={tone} aria-label={m.menu} aria-busy={busy}>
    {unresolved && <div className="task-status-controls"><button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button></div>}
    {summary !== null && <p className="task-status-message" role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{summary}</p>}
    {mutation.error !== null && <div className="task-status-error" role="alert"><StatusError error={mutation.error} /></div>}
    {mutation.reconciliationError !== null && <div className="task-status-error" role="alert"><p>{m.checkFailed}</p><StatusError error={mutation.reconciliationError} /></div>}
  </section></TaskDetailNotice>;
};
