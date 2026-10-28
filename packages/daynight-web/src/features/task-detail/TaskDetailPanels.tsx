import { useId, useState, useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { TaskDetailTab } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';



export const TaskDetailPanels = ({ overview, attachments, session, active: controlledActive, onChange }: { readonly overview: ReactNode | ((showAttachments: () => void) => ReactNode); readonly attachments: ReactNode | ((active: boolean) => ReactNode); readonly session?: ReactNode | ((active: boolean) => ReactNode); readonly active?: TaskDetailTab; readonly onChange?: (tab: TaskDetailTab) => void }) => {
  const { messages } = useI18n();
  const [localActive, setLocalActive] = useState<TaskDetailTab>('overview');
  const tabs: readonly TaskDetailTab[] = session === undefined ? ['overview', 'attachments'] : ['overview', 'attachments', 'session'];
  const requested = controlledActive === undefined ? localActive : controlledActive;
  const active = requested === 'session' && session === undefined ? 'overview' : requested;
  useLayoutEffect(() => { if (active !== requested) { setLocalActive(active); onChange?.(active); } }, [active, requested, onChange]);
  const setActive = (tab: TaskDetailTab) => { setLocalActive(tab); onChange?.(tab); };
  const id = useId();
  const tabId = (tab: TaskDetailTab) => `${id}-tab-${tab}`;
  const panelId = (tab: TaskDetailTab) => `${id}-panel-${tab}`;
  const labels = { overview: messages.inspection.detail.overview, attachments: messages.inspection.attachments.title, session: 'Session' };

  const activate = (tab: TaskDetailTab) => {
    setActive(tab);
    document.getElementById(tabId(tab))!.focus();
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, tab: TaskDetailTab) => {
    let next: TaskDetailTab;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    else if (event.key === 'Home') next = 'overview';
    else if (event.key === 'End') next = tabs[tabs.length - 1]!;
    else return;
    event.preventDefault();
    activate(next);
  };

  return <div className="task-detail-panels">
    <div className="task-detail-tabs" role="tablist" aria-label={messages.inspection.detail.title}>
      {tabs.map((tab) => <button key={tab} className="task-detail-tab" id={tabId(tab)} role="tab" type="button" aria-selected={active === tab} aria-controls={panelId(tab)} tabIndex={active === tab ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(event) => navigate(event, tab)}>{labels[tab]}</button>)}
    </div>
    {tabs.map((tab) => <div key={tab} id={panelId(tab)} className={`task-detail-panel task-detail-panel-${tab}`} role="tabpanel" aria-labelledby={tabId(tab)} hidden={active !== tab} inert={active !== tab}>{tab === 'overview' ? typeof overview === 'function' ? overview(() => setActive('attachments')) : overview : tab === 'attachments' ? typeof attachments === 'function' ? attachments(active === 'attachments') : attachments : typeof session === 'function' ? session(active === 'session') : session}</div>)}
  </div>;
};
