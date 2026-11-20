import { useId, useRef, useState, useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
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
  readonly usage?: PanelSlot;
  readonly active?: TaskDetailTab;
  readonly suspended?: boolean;
  readonly onChange?: (tab: TaskDetailTab) => void;
};

export const TaskDetailPanels = ({ overview, steps, attachments, discussion, session, usage, active: controlledActive, onChange, suspended = false }: TaskDetailPanelsProps) => {
  const { messages, locale } = useI18n();
  const [localActive, setLocalActive] = useState<OrdinaryTaskTab>('overview');
  const tabs: readonly OrdinaryTaskTab[] = ['overview', 'attachments', 'steps', ...(discussion === undefined ? [] : ['discussion'] as const), ...(session === undefined ? [] : ['session'] as const), ...(usage === undefined ? [] : ['usage'] as const)];
  const requested = controlledActive === undefined ? localActive : controlledActive;
  const active = tabs.find((tab) => tab === requested) ?? 'overview';
  // A Goal-only URL can be visited in browser history; don't push a new entry
  // while displaying its ordinary Task fallback.
  useLayoutEffect(() => { if (active !== requested && requested !== 'description') { setLocalActive(active); onChange?.(active); } }, [active, requested, onChange]);
  const setActive = (tab: OrdinaryTaskTab) => { setLocalActive(tab); onChange?.(tab); };
  const id = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const tabId = (tab: OrdinaryTaskTab) => `${id}-tab-${tab}`;
  const panelId = (tab: OrdinaryTaskTab) => `${id}-panel-${tab}`;
  const updateEdges = () => {
    const bar = barRef.current;
    if (!bar) return;
    const start = bar.scrollLeft > 1, end = bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 1;
    setEdges(previous => previous.start === start && previous.end === end ? previous : { start, end });
  };
  const reveal = (tab: OrdinaryTaskTab) => {
    const bar = barRef.current, item = document.getElementById(tabId(tab));
    if (!bar || !item || bar.clientWidth === 0) return;
    const outer = bar.getBoundingClientRect(), inner = item.getBoundingClientRect();
    if (inner.left < outer.left + 12) bar.scrollLeft += inner.left - outer.left - 12;
    else if (inner.right > outer.right - 12) bar.scrollLeft += inner.right - outer.right + 12;
    updateEdges();
  };
  // Observe label and container geometry, not scrolling, so manual swipes keep their position.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const refresh = () => { reveal(active); updateEdges(); };
    refresh();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refresh);
    observer.observe(bar);
    for (const child of bar.children) observer.observe(child);
    return () => observer.disconnect();
  }, [id, active, messages, session !== undefined, usage !== undefined, discussion !== undefined, suspended]);
  const labels = { overview: messages.inspection.detail.overview, steps: messages.inspection.steps.title, attachments: messages.inspection.attachments.title, discussion: messages.inspection.discussion.title, session: 'Session', usage: locale === 'zh-CN' ? '用量' : 'Usage' };
  const slots = { steps, attachments, discussion, session, usage };
  const content = (tab: OrdinaryTaskTab) => {
    if (tab === 'overview') return typeof overview === 'function' ? overview(() => setActive('attachments')) : overview;
    const slot = slots[tab];
    return typeof slot === 'function' ? slot(active === tab) : slot;
  };
  const activate = (tab: OrdinaryTaskTab) => {
    setActive(tab);
    document.getElementById(tabId(tab))!.focus({ preventScroll: true });
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
    <div className="ordinary-task-tabs-wrap">
      <div ref={barRef} className="task-detail-tabs" role="tablist" aria-label={messages.inspection.detail.title} onScroll={updateEdges}>
        {tabs.map((tab) => <button key={tab} className="task-detail-tab" id={tabId(tab)} role="tab" type="button" aria-selected={active === tab} aria-controls={panelId(tab)} tabIndex={active === tab ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(event) => navigate(event, tab)}>{labels[tab]}</button>)}
      </div>
      <span className="ordinary-task-tabs-edge start" data-visible={edges.start} aria-hidden="true" />
      <span className="ordinary-task-tabs-edge end" data-visible={edges.end} aria-hidden="true" />
    </div>
    {tabs.map((tab) => <KeptMountedSlot key={tab} id={panelId(tab)} className={`task-detail-panel task-detail-panel-${tab}`} role="tabpanel" aria-labelledby={tabId(tab)} active={active === tab}>{content(tab)}</KeptMountedSlot>)}
  </div>;
};
