import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useId, useLayoutEffect, useRef } from 'react';
import type { BotDefinition } from '../../api/bots';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useBotMessages } from './messages';

export function BotDeleteDialog({ bot, opener, onClose, onConfirm }: {
  readonly bot: BotDefinition; readonly opener: HTMLElement;
  readonly onClose: () => void; readonly onConfirm: () => void;
}) {
  const m = useBotMessages(), id = useId(), dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const node = dialog.current!; node.showModal(); cancel.current?.focus();
    return () => { node.close(); if (opener.isConnected) opener.focus(); };
  }, [opener]);
  return <dialog ref={dialog} className="auth-dialog bot-delete-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id={id}>{m.deleteTitle.replace('{name}', bot.name)}</h2><AccountRefreshNotice /><button className="close-button" type="button" aria-label={m.close} onClick={onClose}>×</button></header>
    <div className="dialog-body"><p>{m.deleteDescription}</p></div>
    <footer className="dialog-footer"><button ref={cancel} type="button" className="button" onClick={onClose}>{m.cancel}</button><button type="button" className="button danger" onClick={onConfirm}>{m.delete}</button></footer>
  </dialog>;
}
