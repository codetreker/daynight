import type { MouseEvent } from 'react';
import type { TaskStatus } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskRowSession } from './model';

const labels = {
  'zh-CN': {
    no_session: '无当前会话', not_registered: '会话未注册', pending: '待同步',
    working: '工作中', notice: '需要响应', warning: '需要检查',
    unavailable: '会话不可用', unobserved: '会话尚未观测', expired: '会话状态已过期',
    attention: '需要关注', open: '打开 Session',
  },
  en: {
    no_session: 'No current session', not_registered: 'Not registered', pending: 'Pending sync',
    working: 'Working', notice: 'Needs a response', warning: 'Needs checking',
    unavailable: 'Unavailable', unobserved: 'Not yet observed', expired: 'Observation expired',
    attention: 'Needs attention', open: 'Open Session',
  },
} as const;

export const TaskRowStatus = ({ title, status, observation, allowAgents, onActivate }: {
  readonly title: string;
  readonly status: TaskStatus;
  readonly allowAgents: boolean;
  readonly observation: TaskRowSession | null;
  readonly onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
}) => {
  const { locale, messages: { common } } = useI18n();
  const m = labels[locale];
  const lifecycle = common.status[status];
  const current = status === 'in_progress' ? observation : null;
  const state = current?.state;
  const detail = state == null || (!allowAgents && state === 'no_session') ? lifecycle : m[state];
  const text = state === 'notice' ? m.notice : current?.needsAttention === true ? m.attention : detail;
  const open = current?.canOpen === true && onActivate !== undefined;
  const separator = locale === 'zh-CN' ? '，' : ', ';
  const label = [title, lifecycle, ...(text === lifecycle ? [] : [text]), m.open].join(separator);
  const attributes = {
    'data-session-state': state ?? undefined,
    'data-needs-attention': current?.needsAttention === true || undefined,
  };
  return <span className="project-session-status">
    {open ? <button className="task-row-primary-status project-session-control session-status-action" type="button"
      {...attributes} aria-label={label} title={m.open} onClick={onActivate}>{text}</button>
      : <span className={`task-row-primary-status project-session-text${text === lifecycle ? ` root-status graph-status-${status}` : ''}`} {...attributes}>
        {text}{text !== lifecycle && <span className="task-row-status-lifecycle">{separator}{lifecycle}</span>}
      </span>}
  </span>;
};
