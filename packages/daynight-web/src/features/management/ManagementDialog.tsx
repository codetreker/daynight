import { isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useI18n } from '../../i18n/LocaleProvider';
import { dialogFocusables } from '../task-detail/focus';

export const ManagementDialog = ({ title, children, footer, onClose, busy = false, suspended = false, initialFocus = 'input', closeOnBackdrop = false, preserveFocus = false }: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly suspended?: boolean;
  readonly initialFocus?: 'input' | 'cancel';
  readonly closeOnBackdrop?: boolean;
  readonly preserveFocus?: boolean;
}) => {
  const { messages: { auth: { management: { common } } } } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const remembered = useRef<HTMLElement | null>(null);
  const originalOpener = useRef<HTMLElement | null>(null);
  const selection = useRef<{ start: number | null; end: number | null } | null>(null);
  const callbacks = useRef({ onClose, busy });
  callbacks.current = { onClose, busy };
  useBodyScrollLock(!suspended);
  useLayoutEffect(() => {
    if (suspended) return;
    const activeElement = document.activeElement;
    if (!preserveFocus || originalOpener.current === null) originalOpener.current = activeElement instanceof HTMLElement ? activeElement : null;
    const opener = originalOpener.current;
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert');
    root?.setAttribute('inert', '');
    const first = dialog.current!.querySelector<HTMLElement>(initialFocus === 'cancel' ? '[data-dialog-cancel]' : '.dialog-body input, .dialog-body textarea, .dialog-body select');
    const available = dialogFocusables(dialog.current!);
    const target = !preserveFocus ? first ?? close.current! : remembered.current !== null && available.includes(remembered.current) ? remembered.current : first !== null && available.includes(first) ? first : available[0] ?? dialog.current!;
    target.focus();
    if (preserveFocus && target === remembered.current && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && selection.current?.start != null && selection.current.end != null) target.setSelectionRange(selection.current.start, selection.current.end);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        if (isNativeSelectPopupOpen(event.target)) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        if (!callbacks.current.busy) callbacks.current.onClose();
      }
      if (event.key === 'Tab') {
        const items = dialogFocusables(dialog.current!);
        if (items.length === 0) { event.preventDefault(); dialog.current!.focus(); return; }
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (!items.some((item) => item === document.activeElement) || (!event.shiftKey && document.activeElement === lastItem)) {
          event.preventDefault(); firstItem.focus();
        } else if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault(); lastItem.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      if (preserveFocus && (remembered.current instanceof HTMLInputElement || remembered.current instanceof HTMLTextAreaElement)) selection.current = { start: remembered.current.selectionStart, end: remembered.current.selectionEnd };
      document.removeEventListener('keydown', keydown);
      if (!wasInert) root?.removeAttribute('inert');
      if (opener?.isConnected && (!preserveFocus || opener.closest('[hidden], [inert]') === null)) opener.focus();
    };
  }, [suspended, initialFocus, preserveFocus]);
  return createPortal(<div className="auth-modal-backdrop" hidden={suspended} inert={suspended} onClick={(event) => { if (closeOnBackdrop && !busy && event.target === event.currentTarget) onClose(); }}>
    <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1} ref={dialog} onFocusCapture={event => { if (preserveFocus && event.target instanceof HTMLElement) remembered.current = event.target; }}>
      <header className="dialog-header"><h2 id={titleId}>{title}</h2><AccountRefreshNotice /><button className="close-button" type="button" ref={close} aria-label={common.closeDialog} disabled={busy} onClick={onClose}>×</button></header>
      <div className="dialog-body">{children}</div>
      <footer className="dialog-footer">{footer}</footer>
    </section>
  </div>, document.body);
};
