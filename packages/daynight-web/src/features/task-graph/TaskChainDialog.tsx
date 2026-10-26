import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { tabbable } from 'tabbable';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useI18n } from '../../i18n/LocaleProvider';
import { LanguageSelector } from '../../i18n/LanguageSelector';
import type { GraphIndex } from './model';
import { TaskGraph } from './TaskGraph';
import '../../styles/graph.css';

type TaskChainDialogProps = {
  readonly index: GraphIndex;
  readonly rootId: string;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
};

export const TaskChainDialog = ({ index, rootId, onOpenTask, onClose, onRestoreFocus }: TaskChainDialogProps) => {
  const { messages: { graph: m, common } } = useI18n();
  const task = index.nodes.get(rootId)!;
  const progress = index.components.get(rootId)!.progress;
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(onRestoreFocus);
  restoreFocus.current = onRestoreFocus;
  const titleId = useId();
  const backdropPressed = useRef(false);
  const focusedControl = useRef<HTMLElement | null>(null);
  useBodyScrollLock(true);

  useLayoutEffect(() => {
    const background: { element: Element; inert: string | null }[] = [];
    // Body portals remain available for task details above the graph dialog.
    let current: Element = dialog.current!;
    while (current.parentElement !== null && current.parentElement !== document.body) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current) continue;
        background.push({ element: sibling, inert: sibling.getAttribute('inert') });
        sibling.setAttribute('inert', '');
      }
      current = current.parentElement;
    }
    close.current!.focus({ preventScroll: true });
    return () => {
      for (const { element, inert } of background) {
        if (inert === null) element.removeAttribute('inert');
        else element.setAttribute('inert', inert);
      }
    };
  }, []);

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
    if (event.defaultPrevented) return;
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

  return <div className="task-chain-backdrop" onPointerDown={(event) => { backdropPressed.current = event.target === event.currentTarget; }} onClick={(event) => { if (backdropPressed.current && event.target === event.currentTarget) onClose(); backdropPressed.current = false; }}>
    <section className={`task-chain-dialog${fullscreen ? ' task-chain-dialog-fullscreen' : ''}`} id={`task-graph-${rootId}`}
      role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} onKeyDown={onKeyDown} onFocusCapture={(event) => { focusedControl.current = event.target as HTMLElement; }}>
      <header className="task-chain-header">
        <span className="task-chain-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></span>
        <div className="task-chain-heading">
          <p className="task-chain-eyebrow">{m.chainTitle}</p>
          <h2 id={titleId}>{task.titlePreview}{task.titleTruncated ? '…' : ''}</h2>
          <p className="task-chain-meta"><span>{m.rootSummary({ total: progress.total, remaining: progress.total - progress.done })}</span><span>{m.progress({ done: progress.done, total: progress.total })}</span><span className={`graph-status graph-status-${progress.status}`}>{common.status[progress.status]}</span></p>
        </div>
        <div className="task-chain-actions"><LanguageSelector /><button className="task-chain-close" type="button" ref={close} aria-label={m.closeDialog} title={m.closeDialog} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
      </header>
      <TaskGraph index={index} rootId={rootId} onOpenTask={onOpenTask} fullscreen={fullscreenControl} />
    </section>
  </div>;
};
