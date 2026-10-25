import { useId, useLayoutEffect, useRef, type RefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dialogFocusables } from './focus';
import '../../styles/auth.css';

export const TaskConfirmation = ({ title, question, explanation, content, taskTitle, confirmLabel, cancelLabel, closeLabel, destructive = false, owner, fallbackFocus, onCancel, onConfirm }: {
  readonly title: string;
  readonly question: string;
  readonly explanation: string;
  readonly content?: ReactNode;
  readonly taskTitle: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  readonly destructive?: boolean;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreOpener = useRef(true);
  const callbacks = useRef({ onCancel });
  callbacks.current = { onCancel };
  useLayoutEffect(() => {
    const parent = owner.current!;
    const opener = document.activeElement;
    const wasInert = parent.hasAttribute('inert');
    parent.setAttribute('inert', '');
    cancel.current!.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); callbacks.current.onCancel();
      } else if (event.key === 'Tab') {
        const items = dialogFocusables(dialog.current!);
        const first = items[0]!; const last = items[items.length - 1]!;
        if (!dialog.current!.contains(document.activeElement) || !event.shiftKey && document.activeElement === last) {
          event.preventDefault(); event.stopPropagation(); first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); event.stopPropagation(); last.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (!wasInert) parent.removeAttribute('inert');
      if (restoreOpener.current && (opener instanceof HTMLButtonElement || opener instanceof HTMLSelectElement) && opener.isConnected && !opener.disabled) opener.focus();
      else fallbackFocus.current?.focus();
    };
  }, [owner, fallbackFocus]);
  return createPortal(<div className="auth-modal-backdrop task-confirmation-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="auth-dialog task-confirmation" ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header className="dialog-header"><h2 id={titleId}>{title}</h2><button className="close-button" type="button" aria-label={closeLabel} onClick={onCancel}>×</button></header>
      <div className="dialog-body" id={descriptionId} tabIndex={0}><p>{question}</p><p className="task-confirmation-task">{taskTitle}</p>{content === undefined ? <p>{explanation}</p> : content}</div>
      <footer className="dialog-footer"><button className="button" type="button" ref={cancel} onClick={onCancel}>{cancelLabel}</button><button className={`button ${destructive ? 'danger' : 'primary'}`} type="button" onClick={() => { restoreOpener.current = false; onConfirm(); }}>{confirmLabel}</button></footer>
    </section>
  </div>, document.body);
};
