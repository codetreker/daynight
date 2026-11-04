import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { LanguageSelector } from '../../i18n/LanguageSelector';
import { useI18n } from '../../i18n/LocaleProvider';
import { dialogFocusables } from '../task-detail/focus';

export const ManagementDialog = ({ title, children, footer, onClose, busy = false, suspended = false }: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly suspended?: boolean;
}) => {
  const { messages: { auth: { management: { common } } } } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, busy });
  callbacks.current = { onClose, busy };
  useBodyScrollLock(!suspended);
  useLayoutEffect(() => {
    if (suspended) return;
    const opener = document.activeElement;
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert');
    root?.setAttribute('inert', '');
    const first = dialog.current!.querySelector<HTMLElement>('.dialog-body input, .dialog-body textarea, .dialog-body select');
    (first ?? close.current!).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
      document.removeEventListener('keydown', keydown);
      if (!wasInert) root?.removeAttribute('inert');
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [suspended]);
  return createPortal(<div className="auth-modal-backdrop" hidden={suspended} inert={suspended}>
    <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1} ref={dialog}>
      <header className="dialog-header"><h2 id={titleId}>{title}</h2><LanguageSelector /><button className="close-button" type="button" ref={close} aria-label={common.closeDialog} disabled={busy} onClick={onClose}>×</button></header>
      <div className="dialog-body">{children}</div>
      <footer className="dialog-footer">{footer}</footer>
    </section>
  </div>, document.body);
};
