import { useId, useState, useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { TaskDetailTab } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { KeptMountedSlot } from './DetailFrame';

type PanelSlot = ReactNode | ((active: boolean) => ReactNode);
type OrdinaryTaskTab = Exclude<TaskDetailTab, 'description'>;
type TaskDetailPanelsProps = {
  readonly overview: ReactNode | ((showAttachments: () => void) => ReactNode);
  readonly steps?: PanelSlot;
  readonly attachments: PanelSlot;
  readonly discussion?: PanelSlot;
  readonly session?: PanelSlot;
  readonly active?: TaskDetailTab;
  readonly suspended?: boolean;
  readonly onChange?: (tab: TaskDetailTab) => void;
};

export const TaskDetailPanels = ({ overview, steps, attachments, discussion, session, active: controlledActive, onChange, suspended = false }: TaskDetailPanelsProps) => {
  const { messages } = useI18n();
  const [localActive, setLocalActive] = useState<OrdinaryTaskTab>('overview');
  const tabs: readonly OrdinaryTaskTab[] = ['overview', 'attachments', 'steps', ...(discussion === undefined ? [] : ['discussion'] as const), ...(session === undefined ? [] : ['session'] as const)];
  const requested = controlledActive === undefined ? localActive : controlledActive;
  const active = tabs.find((tab) => tab === requested) ?? 'overview';
  // A Goal-only URL can be visited in browser history; don't push a new entry
  // while displaying its ordinary Task fallback.
  useLayoutEffect(() => { if (active !== requested && requested !== 'description') { setLocalActive(active); onChange?.(active); } }, [active, requested, onChange]);
  const setActive = (tab: OrdinaryTaskTab) => { setLocalActive(tab); onChange?.(tab); };
  const id = useId();
  const tabId = (tab: OrdinaryTaskTab) => `${id}-tab-${tab}`;
  const panelId = (tab: OrdinaryTaskTab) => `${id}-panel-${tab}`;
  const reveal = (tab: OrdinaryTaskTab) => document.getElementById(tabId(tab))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  // The selected font and translated label can widen a tab after native focus.
  useLayoutEffect(() => { reveal(active); }, [id, active, messages]);
  const labels = { overview: messages.inspection.detail.overview, steps: messages.inspection.steps.title, attachments: messages.inspection.attachments.title, discussion: messages.inspection.discussion.title, session: 'Session' };
  const slots = { steps, attachments, discussion, session };
  const content = (tab: OrdinaryTaskTab) => {
    if (tab === 'overview') return typeof overview === 'function' ? overview(() => setActive('attachments')) : overview;
    const slot = slots[tab];
    return typeof slot === 'function' ? slot(active === tab) : slot;
  };
  const activate = (tab: OrdinaryTaskTab) => {
    setActive(tab);
    document.getElementById(tabId(tab))!.focus();
    reveal(tab);
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, tab: OrdinaryTaskTab) => {
    let next: OrdinaryTaskTab;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    else if (event.key === 'Home') next = 'overview';
    else if (event.key === 'End') next = tabs[tabs.length - 1]!;
    else return;
    event.preventDefault();
    activate(next);
  };

  return <div className="task-detail-panels" hidden={suspended} inert={suspended} style={suspended ? { display: 'none' } : undefined}>
    <div className="task-detail-tabs" role="tablist" aria-label={messages.inspection.detail.title}>
      {tabs.map((tab) => <button key={tab} className="task-detail-tab" id={tabId(tab)} role="tab" type="button" aria-selected={active === tab} aria-controls={panelId(tab)} tabIndex={active === tab ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(event) => navigate(event, tab)}>{labels[tab]}</button>)}
    </div>
    {tabs.map((tab) => <KeptMountedSlot key={tab} id={panelId(tab)} className={`task-detail-panel task-detail-panel-${tab}`} role="tabpanel" aria-labelledby={tabId(tab)} active={active === tab}>{content(tab)}</KeptMountedSlot>)}
  </div>;
};
