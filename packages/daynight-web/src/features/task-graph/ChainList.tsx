import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphIndex } from './model';
import { TaskChainDialog } from './TaskChainDialog';
import '../../styles/graph.css';

type ChainListProps = {
  readonly index: GraphIndex;
  readonly representativeIds: readonly string[];
  readonly allRepresentativeIds: readonly string[];
  readonly openChainId: string | null;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
  readonly onCloseChain: () => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly showCompleted: boolean;
  readonly onShowCompletedChange: (show: boolean) => void;
};

type ChainRowProps = Pick<ChainListProps, 'index' | 'onOpenChain'> & {
  readonly rootId: string;
  readonly open: boolean;
};

const ChainRow = memo(({ index, rootId, open, onOpenChain }: ChainRowProps) => {
  const { messages: { graph: m, common } } = useI18n();
  const task = index.nodes.get(rootId)!;
  const progress = index.components.get(rootId)!.progress;
  return <li className="root-row">
    <button className="root-toggle" type="button" id={`task-root-${rootId}`} aria-haspopup="dialog"
      aria-controls={open ? `task-graph-${rootId}` : undefined} onClick={(event) => { onOpenChain(rootId, event.currentTarget); }}>
      <span className="root-graph-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></span>
      <span className="root-heading">
        <span className="root-title">{task.titlePreview}{task.titleTruncated ? '…' : ''}</span>
        <span className="root-meta">{m.rootSummary({ total: progress.total, remaining: progress.total - progress.done })}</span>
      </span>
      <span className="root-progress"><span className="root-progress-label">{m.progress({ done: progress.done, total: progress.total })}</span><span className="root-progress-track" aria-hidden="true"><i style={{ width: `${progress.done / progress.total * 100}%` }} /></span></span>
      <span className={`root-status graph-status-${progress.status}`}>{common.status[progress.status]}</span>
      <svg className="root-open-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
    </button>
  </li>;
});

const focusAvailable = (element: HTMLElement | null | undefined) => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return true;
};

export const ChainList = ({ index, representativeIds, allRepresentativeIds, openChainId, onOpenChain, onCloseChain, onOpenTask, showCompleted, onShowCompletedChange }: ChainListProps) => {
  const { messages: { graph: m } } = useI18n();
  const checkbox = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openedTask = useRef<string | null>(null);
  const state = useRef({ index, representativeIds });
  state.current = { index, representativeIds };
  const openChain = useCallback((id: string, trigger: HTMLElement) => {
    opener.current = trigger;
    openedTask.current = id;
    onOpenChain(id, trigger);
  }, [onOpenChain]);
  const restoreFocus = useCallback(() => {
    if (focusAvailable(opener.current)) return;
    const { index, representativeIds } = state.current;
    const representative = openedTask.current === null ? undefined : index.componentByTask.get(openedTask.current);
    const target = representative !== undefined && representativeIds.includes(representative) ? representative : representativeIds[0];
    if (target !== undefined && focusAvailable(container.current?.querySelector<HTMLElement>(`#task-root-${target}`))) return;
    if (focusAvailable(checkbox.current) || focusAvailable(container.current)) return;
    const panel = container.current?.closest<HTMLElement>('[role="tabpanel"]');
    const tabId = panel?.getAttribute('aria-labelledby');
    if (tabId !== undefined && tabId !== null) focusAvailable(document.getElementById(tabId));
  }, []);
  useLayoutEffect(() => {
    if (openChainId !== null || focusedControl.current === null || focusedControl.current.isConnected || document.activeElement !== document.body) return;
    restoreFocus();
  }, [index, openChainId, representativeIds, restoreFocus]);
  const completedCount = useMemo(() => allRepresentativeIds.filter((id) => index.components.get(id)!.progress.status === 'done').length, [index, allRepresentativeIds]);
  return <section aria-label={m.chainList} ref={container} tabIndex={-1} onFocusCapture={(event) => {
    if (event.currentTarget.contains(event.target)) focusedControl.current = event.target;
  }}>
    <div className="task-view-toolbar">
      {allRepresentativeIds.length > 0 && <label className="completed-chain-control"><input ref={checkbox} type="checkbox" checked={showCompleted} onChange={(event) => { onShowCompletedChange(event.currentTarget.checked); }} />{m.showCompletedCount({ count: completedCount })}</label>}
      <span className="task-view-summary" aria-label={m.chainSummaryLabel({ shown: representativeIds.length, total: allRepresentativeIds.length })}>{m.chainSummary({ shown: representativeIds.length, total: allRepresentativeIds.length })}</span>
    </div>
    <p className="graph-note">{m.chainNote}</p>
    {allRepresentativeIds.length === 0 ? <div className="state-box"><h3>{m.emptyTitle}</h3><p>{m.emptyDescription}</p></div>
      : representativeIds.length === 0 ? <div className="state-box completed-chains-empty"><h3>{m.completedTitle}</h3><p>{m.completedDescription({ count: completedCount })}</p><button className="button" type="button" onClick={() => { checkbox.current!.focus(); onShowCompletedChange(true); }}>{m.showCompleted}</button></div>
        : <ul className="root-list">{representativeIds.map((rootId) => <ChainRow key={rootId} index={index} rootId={rootId} open={openChainId === rootId} onOpenChain={openChain} />)}</ul>}
    {openChainId !== null && <TaskChainDialog index={index} rootId={openChainId} onOpenTask={onOpenTask} onClose={onCloseChain} onRestoreFocus={restoreFocus} />}
  </section>;
};
