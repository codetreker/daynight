import { useState, type RefObject } from 'react';
import type { CurrentAccount } from '../../app/CurrentAccountContext';
import type { ThreadController, ThreadView } from './controller';
import { isThreadBody } from './contract';
import { accountLabel, authorLabel, excerpt, ThreadAvatar, ThreadErrorDetails, ThreadFailure, ThreadIcon, type DiscussionMessages } from './presentation';

export const DiscussionComposer = ({ controller, view, account, active, inputRef, messages }: { readonly controller: ThreadController; readonly view: ThreadView; readonly account: CurrentAccount; readonly active: boolean; readonly inputRef: RefObject<HTMLTextAreaElement | null>; readonly messages: DiscussionMessages }) => {
  const [dismissedError, setDismissedError] = useState<Error | null>(null);
  const disabled = !active || view.loading || view.authPaused && !view.initialized || view.retired || view.readError !== null;
  const name = accountLabel(account.user.name, account.user.id, messages);
  const send = () => { if (view.canSend) void controller.send(); };
  return <div className="thread-composer-wrap"><div className="thread-composer-inner">
    <div className={`thread-composer${disabled ? ' disabled' : ''}`}>
      {view.replyTo !== null && <div className="thread-reply-preview"><div className="thread-reply-preview-text"><strong>{messages.reply(view.replyMessage === null ? view.replyTo : authorLabel(view.replyMessage, messages))}</strong>{view.replyMessage !== null && <p>{excerpt(view.replyMessage.body, messages)}</p>}</div><button className="thread-icon-button" type="button" aria-label={messages.cancelReply} onClick={() => { controller.setReply(null); inputRef.current?.focus(); }}><ThreadIcon name="close" size={13} /></button></div>}
      <textarea ref={inputRef} aria-label={messages.composer} placeholder={messages.placeholder} value={view.draft} disabled={disabled} onChange={(event) => controller.setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && view.canSend) { event.preventDefault(); send(); } }} />
      <div className="thread-composer-bottom"><div className="thread-composer-context"><ThreadAvatar id={account.user.id} name={account.user.name} /><span className="thread-composer-name">{name}</span><span>·</span><span>{messages.markdown}</span></div><button className="button primary thread-send-button" type="button" disabled={!view.canSend} onClick={send}><ThreadIcon name={view.sending ? 'refresh' : 'send'} size={12} spinning={view.sending} />{view.postOutcome === 'refused' ? messages.resend : messages.send}</button></div>
    </div>
    {view.postError !== null && view.postOutcome === 'confirmed' && <ThreadFailure error={view.postError} label={messages.readFailed} messages={messages} />}
    {view.postError !== null && view.postOutcome !== 'confirmed' && view.postError !== dismissedError && <div className={`thread-send-feedback${view.postOutcome === 'unknown' ? ' warning' : ''}`} role="alert"><ThreadIcon name={view.postOutcome === 'unknown' ? 'info' : 'alert'} size={13} /><div className="thread-send-feedback-main"><span>{view.postOutcome === 'unknown' ? messages.postUnknown : messages.postFailed}</span><ThreadErrorDetails error={view.postError} messages={messages} /></div><button className="thread-icon-button" type="button" aria-label={messages.dismissFeedback} onClick={() => setDismissedError(view.postError)}><ThreadIcon name="close" size={13} /></button></div>}
    {!disabled && !view.sending && view.draft.trim() !== '' && (!isThreadBody(view.draft) || view.capacityBlocked) && <details className="thread-capacity"><summary>{messages.errorDetails}</summary>{!isThreadBody(view.draft) ? messages.invalidBody : messages.capacity}</details>}
  </div></div>;
};
