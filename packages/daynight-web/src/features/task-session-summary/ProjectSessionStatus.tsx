import type { MouseEvent } from 'react';
import type { TaskProgressStatus } from '../../api/task-status';
import { useI18n } from '../../i18n/LocaleProvider';

type State = 'no_session' | 'not_registered' | 'pending' | 'working' | 'notice' | 'warning' | 'unavailable' | 'unobserved' | 'expired' | null;
type Observation = { readonly state: State; readonly needsAttention: boolean | null; readonly canOpen: boolean };

const labels = {
  'zh-CN': {
    no_session: '无当前 Session', not_registered: 'Session 未注册', pending: 'Session 待同步',
    working: 'Session 工作中', notice: 'Session 需要响应', warning: 'Session 需要检查',
    unavailable: 'Session 不可用', unobserved: 'Session 尚未观测', expired: 'Session 观测过期', accessible: '当前 Session 可访问',
    attention: '需要关注', open: '打开 Session',
  },
  en: {
    no_session: 'No current Session', not_registered: 'Session not registered', pending: 'Session pending',
    working: 'Session working', notice: 'Session needs a response', warning: 'Session needs checking',
    unavailable: 'Session unavailable', unobserved: 'Session not observed', expired: 'Session observation expired', accessible: 'Current Session accessible',
    attention: 'Needs attention', open: 'Open Session',
  },
} as const;

export function ProjectSessionStatus({ title, status, statusId, observation, onActivate, showTaskStatus = true }: {
  readonly title: string; readonly status: TaskProgressStatus; readonly statusId?: string;
  readonly observation: Observation | null; readonly onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly showTaskStatus?: boolean;
}) {
  const { locale, messages: { common } } = useI18n();
  const m = labels[locale];
  const detail = observation?.state == null ? null : m[observation.state];
  const attention = observation?.needsAttention === true ? m.attention : null;
  const description = [detail, attention].filter(Boolean).join(' · ');
  const open = observation?.canOpen === true && onActivate !== undefined;
  const separator = locale === 'zh-CN' ? '，' : ', ';
  const label = [title, common.status[status], description || m.accessible, m.open].join(separator);
  return <span className="project-session-status">
    {showTaskStatus && <span id={statusId} className={`root-status graph-status-${status}`}>{common.status[status]}</span>}
    {observation !== null && (open ? <button className="project-session-control session-status-action" type="button"
      data-session-state={observation.state ?? undefined} data-needs-attention={observation.needsAttention === true || undefined} aria-label={label} onClick={onActivate}>
      {description || m.open}
    </button> : description && <span className="project-session-text" data-session-state={observation.state ?? undefined} data-needs-attention={observation.needsAttention === true || undefined}>{description}</span>)}
  </span>;
}
