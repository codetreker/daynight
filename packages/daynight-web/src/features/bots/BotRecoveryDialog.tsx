import { useId, useLayoutEffect, useRef, useState } from 'react';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useBotMessages } from './messages';

export function BotRecoveryDialog({ botId, workerId, workerName, opener, enabled, onClose, onConfirm }: {
  readonly botId: string; readonly workerId: string; readonly workerName?: string | undefined; readonly opener: HTMLElement; readonly enabled: boolean;
  readonly onClose: () => void; readonly onConfirm: (reason: string) => void;
}) {
  const m = useBotMessages(), title = useId(), dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false);
  const invalidReason = [...reason].length > 1000 || !reason.isWellFormed() || reason.includes('\0');
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const node = dialog.current!; node.showModal(); cancel.current?.focus();
    return () => { node.close(); if (opener.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  return <dialog ref={dialog} className="auth-dialog bot-delete-dialog bot-recovery-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id={title}>{m.recoveryTitle}</h2><AccountRefreshNotice /><button className="close-button" type="button" aria-label={m.close} onClick={onClose}>×</button></header>
    <div className="dialog-body">
      <p>{m.recoveryDescription}</p>
      <p><strong>{m.worker}</strong><br />{workerName ? <>{workerName}<br /></> : null}<code>{workerId}</code></p>
      <p>{m.recoveryInspect}<br /><code>daynight bot deletion inspect {botId}</code></p>
      <div className="notice warning"><p>{m.recoveryWarning}</p></div>
      <label>{m.recoveryReason}<textarea value={reason} aria-invalid={invalidReason} onChange={event => setReason(event.target.value)} placeholder={m.recoveryReasonPlaceholder} /></label>
      {invalidReason ? <p role="alert">{m.recoveryReasonInvalid}</p> : null}
      <label className="bot-recovery-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{m.recoveryAcknowledgement}</span></label>
    </div>
    <footer className="dialog-footer"><button ref={cancel} type="button" className="button" onClick={onClose}>{m.cancel}</button><button type="button" className="button danger" disabled={!enabled || !acknowledged || !reason.trim() || invalidReason} onClick={() => onConfirm(reason)}>{m.recoveryConfirm}</button></footer>
  </dialog>;
}
