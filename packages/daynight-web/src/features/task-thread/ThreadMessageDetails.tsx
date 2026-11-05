import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { dialogFocusables } from '../task-detail/focus';
import type { ThreadMessage } from './contract';
import { authorLabel, providerLabel, ThreadIcon, type DiscussionMessages } from './presentation';
import { useDraftNavigationDecision } from '../task-detail/TaskDraftNavigation';

type MessageDetailsProps = { readonly message: ThreadMessage; readonly messages: DiscussionMessages; readonly owner: RefObject<HTMLElement | null>; readonly fallbackFocus: RefObject<HTMLElement | null>; readonly onClose: () => void; readonly onOpenChange: (open: boolean) => void; readonly canRestoreFocus: () => boolean };

export const ThreadMessageDetails = (props: MessageDetailsProps) => {
  const decision = useDraftNavigationDecision();
  useLayoutEffect(() => { if (decision !== null) props.onClose(); }, [decision, props.onClose]);
  // A native top-layer dialog would make the application leave choice inert.
  return decision === null ? <MessageDetails {...props} /> : null;
};

const MessageDetails = ({ message, messages, owner, fallbackFocus, onClose, onOpenChange, canRestoreFocus }: MessageDetailsProps) => {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const callbacks = useRef({ onClose, onOpenChange, canRestoreFocus }); callbacks.current = { onClose, onOpenChange, canRestoreFocus };
  useLayoutEffect(() => {
    const parent = owner.current;
    if (parent === null) throw new Error('The task owner is required for message details.');
    const opener = document.activeElement, wasInert = parent.hasAttribute('inert');
    callbacks.current.onOpenChange(true);
    parent.setAttribute('inert', '');
    const element = dialog.current!;
    element.showModal(); close.current!.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); }
      else if (event.key === 'Tab') {
        event.stopPropagation();
        const items = dialogFocusables(element), first = items[0]!, last = items[items.length - 1]!;
        if (!element.contains(document.activeElement) || !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (element.open) element.close();
      if (!wasInert) parent.removeAttribute('inert');
      callbacks.current.onOpenChange(false);
      if (!callbacks.current.canRestoreFocus()) return;
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert], [hidden]') && !opener.matches(':disabled')) opener.focus({ preventScroll: true });
      else fallbackFocus.current?.focus({ preventScroll: true });
    };
  }, [owner, fallbackFocus]);
  const fields: readonly [string, string][] = [
    [messages.messageId, message.id], [messages.author, authorLabel(message, messages)], [messages.accountId, message.author.userId],
    [messages.source, message.author.Agent ? `${messages.agent}${message.author.execution === undefined ? '' : ` · ${providerLabel[message.author.execution.provider]}`}` : messages.human],
    [messages.agent, String(message.author.Agent)], [messages.createdAt, message.createdAt],
    ...(message.replyTo === undefined ? [] : [[messages.replyTo, message.replyTo] as [string, string]]),
    ...(message.author.execution === undefined ? [] : [[messages.claimId, message.author.execution.claimId], [messages.workerId, message.author.execution.workerId]] as [string, string][]),
  ];
  return createPortal(<dialog className="thread-metadata-dialog" ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); }}>
    <header className="thread-metadata-header"><h2 id={titleId}>{messages.messageDetails}</h2><button className="thread-icon-button" ref={close} type="button" aria-label={messages.closeDetails} onClick={onClose}><ThreadIcon name="close" size={14} /></button></header>
    <div className="thread-metadata-body"><dl>{fields.map(([label, value]) => <div className="thread-metadata-field" key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl><div className="thread-metadata-message" aria-label={messages.body}>{message.body}</div></div>
  </dialog>, document.body);
};
