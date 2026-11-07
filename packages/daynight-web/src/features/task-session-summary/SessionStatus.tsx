import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TaskProgressStatus } from '../../api/task-status';
import { useI18n } from '../../i18n/LocaleProvider';

type Indicator = 'working' | 'notice' | 'warning';
type Props = {
  readonly title: string;
  readonly status: TaskProgressStatus;
  readonly indicator: Indicator | null;
  readonly onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly chain?: boolean;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly statusId?: string;
};

const descriptions = {
  'zh-CN': {
    task: { working: '会话工作中', notice: '会话需要响应', warning: '任务仍在进行中，会话需要检查' },
    chain: { working: '会话工作中', notice: '存在需要响应的会话', warning: '存在需要检查的会话' },
    accessible: '当前会话可访问', open: '打开 Session', expand: '展开子任务',
  },
  en: {
    task: { working: 'Session is working', notice: 'Session needs a response', warning: 'Task is in progress; check the Session' },
    chain: { working: 'Sessions are working', notice: 'A Session needs a response', warning: 'A Session needs checking' },
    accessible: 'Current Session is accessible', open: 'Open Session', expand: 'Expand tasks',
  },
} as const;

export const SessionStatus = ({ title, status, indicator, onActivate, chain = false, expanded, controls, statusId }: Props) => {
  const { locale, messages: { common } } = useI18n();
  const m = descriptions[locale];
  const detail = indicator === null ? m.accessible : m[chain ? 'chain' : 'task'][indicator];
  const hint = `${detail}${locale === 'zh-CN' ? '，' : ', '}${chain ? m.expand : m.open}`;
  const label = `${title}${locale === 'zh-CN' ? '，' : ', '}${common.status[status]}${locale === 'zh-CN' ? '，' : ', '}${hint}`;
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = onActivate !== undefined && !dismissed && (hovered || focused);
  useLayoutEffect(() => {
    if (!open || button.current === null || tooltip.current === null) return;
    const position = () => {
      if (button.current === null || tooltip.current === null) return;
      const box = button.current.getBoundingClientRect();
      const tip = tooltip.current.getBoundingClientRect();
      tooltip.current.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tip.width - 8))}px`;
      tooltip.current.style.top = `${box.bottom + tip.height + 8 < window.innerHeight ? box.bottom + 6 : Math.max(8, box.top - tip.height - 6)}px`;
    };
    position();
    window.addEventListener('scroll', position, true); window.addEventListener('resize', position);
    return () => { window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); };
  }, [open, hint]);
  const text = <span id={statusId} className={`root-status session-status-label graph-status-${status}`}>{common.status[status]}
    {indicator !== null && <span className="session-status-annotation" aria-hidden="true" lang="en">{indicator}</span>}
  </span>;
  return <span className={`session-status-slot${status === 'in_progress' ? ' session-status-progress' : ''}`}>
    {onActivate === undefined ? <span className="session-status-control" data-session-indicator={indicator ?? undefined}>{text}</span> : <button
      ref={button} className="session-status-control session-status-action" type="button" data-session-indicator={indicator ?? undefined}
      aria-label={label} aria-describedby={open ? id : undefined}
      aria-expanded={chain ? expanded : undefined} aria-controls={chain ? controls : undefined} onClick={onActivate}
      onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setDismissed(true); } }}>
      {text}
    </button>}
    {open && createPortal(<span id={id} ref={tooltip} role="tooltip" className="session-status-tooltip">{hint}</span>, document.body)}
  </span>;
};
