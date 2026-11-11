import { TaskPauseCount, usePausedTaskIds } from "../task-pause/TaskPause";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { tabbable } from 'tabbable';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../../app/overlay';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphIndex } from './model';
import type { TaskSummary } from '../../api/types';
import { TaskGraph } from './TaskGraph';
import { useGraphDirection } from '../projects/useProjectViewPreferences';
import '../../styles/graph.css';

type TaskChainDialogProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly rootId: string;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly onRootChange?: (element: HTMLElement | null) => void;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
};

export const TaskChainDialog = ({ projectId, index, summaries, rootId, onOpenTask, onNavigateExternalTask, onClose, onRestoreFocus, renderNested, onRootChange }: TaskChainDialogProps) => {
  const { messages: { graph: m, common } } = useI18n();
  const { direction, onDirectionChange, issue } = useGraphDirection(projectId, rootId);
  const task = index.nodes.get(rootId)!;
  const component = index.components.get(rootId)!;
  const progress = component.progress;
  const pausedTaskIds = usePausedTaskIds();
  const pausedCount = pausedSummaryTaskIds([...component.memberIds].map((id) => index.nodes.get(id)!), pausedTaskIds).size;
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const setDialog = useCallback((element: HTMLElement | null) => { dialog.current = element; onRootChange?.(element); }, [onRootChange]);
  const close = useRef<HTMLButtonElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(onRestoreFocus);
  restoreFocus.current = onRestoreFocus;
  const titleId = useId();
  const backdropPressed = useRef(false);
  const focusedControl = useRef<HTMLElement | null>(null);
  const parentOverlay = useContext(OverlayOwnerContext);
  useBodyScrollLock(true);

  useLayoutEffect(() => {
    const parent = parentOverlay?.current ?? document.getElementById('root');
    const release = registerOverlay(dialog.current!, parent);
    close.current!.focus({ preventScroll: true });
    return release;
  }, [parentOverlay]);

  useLayoutEffect(() => {
    if (focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body) close.current!.focus({ preventScroll: true });
  }, [index, rootId]);

  useEffect(() => () => { restoreFocus.current(); }, []);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((active) => !active);
    fullscreenButton.current?.focus({ preventScroll: true });
  }, []);
  const fullscreenControl = useMemo(() => ({ active: fullscreen, onToggle: toggleFullscreen, buttonRef: fullscreenButton }), [fullscreen, toggleFullscreen]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !isTopOverlay(dialog.current!)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (fullscreen) toggleFullscreen();
      else onClose();
    } else if (event.key === 'Tab') {
      const controls = tabbable(dialog.current!);
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (!dialog.current!.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault();
        last.focus();
      }
    }
  };

  return createPortal(<OverlayOwnerContext value={dialog}><div className={`task-chain-backdrop${parentOverlay === null ? "" : " task-chain-backdrop-nested"}`} onPointerDown={(event) => { backdropPressed.current = event.target === event.currentTarget; }} onClick={(event) => { if (backdropPressed.current && event.target === event.currentTarget && isTopOverlay(dialog.current!)) onClose(); backdropPressed.current = false; }}>
    <section className={`task-chain-dialog${fullscreen ? ' task-chain-dialog-fullscreen' : ''}`} id={`task-graph-${rootId}`}
      role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={setDialog} onKeyDown={onKeyDown} onFocusCapture={(event) => { focusedControl.current = event.target as HTMLElement; }}>
      <header className="task-chain-header">
        <span className="task-chain-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></span>
        <div className="task-chain-heading">
          <p className="task-chain-eyebrow">{m.chainTitle}</p>
          <h2 id={titleId}>{task.titlePreview}{task.titleTruncated ? '…' : ''}</h2>
          <p className="task-chain-meta"><span>{m.rootSummary({ total: progress.total, remaining: progress.total - progress.ended })}</span><span>{m.progress({ done: progress.done, cancelled: progress.cancelled, total: progress.total })}</span><TaskPauseCount count={pausedCount} /><span className={`graph-status graph-status-${progress.status}`}>{common.status[progress.status]}</span></p>
        </div>
        <button className="task-chain-close" type="button" ref={close} aria-label={m.closeDialog} title={m.closeDialog} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </header>
      <TaskGraph direction={direction} onDirectionChange={onDirectionChange} directionIssue={issue?.kind} index={index} {...(summaries === undefined ? {} : { summaries })} rootId={rootId} onOpenTask={onOpenTask} {...(onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask })} fullscreen={fullscreenControl} />
    </section>
  </div>{renderNested?.(dialog)}</OverlayOwnerContext>, document.body);
};
