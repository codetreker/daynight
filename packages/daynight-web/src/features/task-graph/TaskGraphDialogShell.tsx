import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { tabbable } from 'tabbable';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../../app/overlay';
import '../../styles/graph.css';

type FullscreenControl = {
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
};

type TaskGraphDialogShellProps = {
  readonly dialogId: string;
  readonly labelId: string;
  readonly focusRevision: unknown;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly onRootChange?: (element: HTMLElement | null) => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly header: (closeRef: RefObject<HTMLButtonElement | null>) => ReactNode;
  readonly children: (fullscreen: FullscreenControl) => ReactNode;
};

export const TaskGraphDialogShell = ({ dialogId, labelId, focusRevision, onClose, onRestoreFocus, onRootChange, renderNested, header, children }: TaskGraphDialogShellProps) => {
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const setDialog = useCallback((element: HTMLElement | null) => { dialog.current = element; onRootChange?.(element); }, [onRootChange]);
  const close = useRef<HTMLButtonElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(onRestoreFocus);
  restoreFocus.current = onRestoreFocus;
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
  }, [focusRevision, dialogId]);

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
    <section className={`task-chain-dialog${fullscreen ? ' task-chain-dialog-fullscreen' : ''}`} id={dialogId}
      role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1} ref={setDialog} onKeyDown={onKeyDown} onFocusCapture={(event) => { focusedControl.current = event.target as HTMLElement; }}>
      {header(close)}
      {children(fullscreenControl)}
    </section>
  </div>{renderNested?.(dialog)}</OverlayOwnerContext>, document.body);
};
