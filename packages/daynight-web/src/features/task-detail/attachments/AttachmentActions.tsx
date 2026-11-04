import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ApiError } from '../../../api/client';
import { LanguageSelector } from '../../../i18n/LanguageSelector';
import { useI18n } from '../../../i18n/LocaleProvider';
import { dialogFocusables } from '../focus';
import { useDraftNavigationDecision } from '../TaskDraftNavigation';
import '../../../styles/auth.css';

export type AttachmentActionTarget = { readonly path: string; readonly trigger: HTMLButtonElement };

export const AttachmentActionMenu = ({ target, onDelete, onDismiss }: {
  readonly target: AttachmentActionTarget;
  readonly onDelete: () => void;
  readonly onDismiss: (restoreFocus: boolean) => void;
}) => {
  const { messages } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onDismiss });
  callbacks.current = { onDismiss };
  useLayoutEffect(() => {
    const element = menu.current!;
    const position = () => {
      const anchor = target.trigger.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      element.style.top = `${anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    };
    const toggled = (event: ToggleEvent) => {
      if (event.newState === 'closed') callbacks.current.onDismiss(false);
    };
    element.addEventListener('toggle', toggled);
    element.showPopover();
    item.current!.focus();
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      element.hidePopover();
    };
  }, [target]);
  return <div ref={menu} popover="auto" role="menu" className="attachment-action-menu" aria-label={messages.inspection.attachments.fileActions({ path: target.path })} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      item.current!.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss(true);
    }
  }}>
    <button ref={item} type="button" role="menuitem" className="attachment-menu-delete" onClick={onDelete}>{messages.inspection.attachments.delete}</button>
  </div>;
};

type AttachmentDeleteProps = {
  readonly target: AttachmentActionTarget;
  readonly busy: boolean;
  readonly error: unknown;
  readonly fallback: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
};

export const AttachmentDeleteDialog = (props: AttachmentDeleteProps) => {
  const decision = useDraftNavigationDecision();
  useLayoutEffect(() => { if (decision !== null) props.onDismiss(); }, [decision, props.onDismiss]);
  return decision === null ? <DeleteDialog {...props} /> : null;
};

const DeleteDialog = ({ target, busy, error, fallback, onConfirm, onDismiss }: AttachmentDeleteProps) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [attempted, setAttempted] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current!.focus();
    return () => element.close();
  }, []);
  useLayoutEffect(() => {
    if (busy) dialog.current!.focus();
  }, [busy]);
  useEffect(() => () => {
    const opener = target.trigger.isConnected ? target.trigger : fallback.current;
    if (opener !== null && opener.closest('[hidden], [inert]') === null) opener.focus();
  }, [target, fallback]);
  return <dialog ref={dialog} className="auth-dialog attachment-delete-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-copy ${id}-path`} aria-busy={busy} tabIndex={-1} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const items = dialogFocusables(event.currentTarget);
    if (items.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (!items.some((item) => item === active) || active === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }} onCancel={(event) => {
    event.preventDefault();
    if (!busy) onDismiss();
  }} onClick={(event) => {
    if (event.target !== event.currentTarget || busy) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onDismiss();
  }}>
    <header className="dialog-header"><h2 id={`${id}-title`}>{m.deleteTitle}</h2><LanguageSelector /></header>
    <div className="dialog-body attachment-delete-body" tabIndex={0} role="group" aria-labelledby={`${id}-title`}>
      <p id={`${id}-copy`}>{m.deleteConfirmation}</p>
      <p id={`${id}-path`} className="attachment-delete-path">{target.path}</p>
      {busy && <p role="status">{m.deleting}</p>}
      {attempted && !busy && error !== null && <div className="attachment-error" role="alert"><p>{m.writeError}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{messages.common.requestId}{' '}<code>{error.requestId}</code></p>}</div>}
    </div>
    <footer className="dialog-footer"><button className="button" ref={cancel} type="button" disabled={busy} onClick={onDismiss}>{m.cancelDelete}</button><button className="button danger" type="button" disabled={busy} onClick={() => { setAttempted(true); onConfirm(); }}>{busy ? m.deleting : m.confirmDelete}</button></footer>
  </dialog>;
};
