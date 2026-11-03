import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { ChatMarkdown } from '../../ui/ChatMarkdown';
import { useTimelineScroll } from '../../ui/useTimelineScroll';
import type { ThreadController, ThreadView } from './controller';
import { authorLabel, excerpt, providerLabel, ThreadAvatar, ThreadFailure, ThreadIcon, type DiscussionMessages } from './presentation';

export const DiscussionTimeline = ({ controller, view, active, identity, timelineRef, inputRef, messages }: { readonly controller: ThreadController; readonly view: ThreadView; readonly active: boolean; readonly identity: string; readonly timelineRef: RefObject<HTMLDivElement | null>; readonly inputRef: RefObject<HTMLTextAreaElement | null>; readonly messages: DiscussionMessages }) => {
  const { locale, format } = useI18n();
  const scroll = useTimelineScroll(identity, active, view.revision, (following, anchor) => { controller.setFollowing(following); controller.setReadingAnchor(anchor); });
  const [targetId, setTargetId] = useState<string | null>(null), [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dayFormat = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' });
  const shortTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  useLayoutEffect(() => {
    timelineRef.current = scroll.viewport.current;
    return () => { timelineRef.current = null; if (flashTimer.current !== null) clearTimeout(flashTimer.current); };
  }, [timelineRef, scroll.viewport]);
  useLayoutEffect(() => {
    if (targetId === null || !active) return;
    const entry = scroll.viewport.current?.querySelector<HTMLElement>(`[data-entry-key="${targetId}"]`);
    if (entry === null || entry === undefined) return;
    scroll.pause(); entry.scrollIntoView?.({ block: 'center' }); scroll.capture();
    setFlashId(targetId); setTargetId(null);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => { setFlashId(null); flashTimer.current = null; }, 1_100);
  }, [targetId, active, view.revision]);
  const reference = (id: string) => { scroll.pause(); setTargetId(id); void controller.showReference(id); };
  const reveal = () => { controller.revealIncoming(); scroll.latest(); };
  const participants = [...new Map(view.visible.map(message => [message.author.userId, message.author])).values()].slice(0, 3);
  return <div className="thread-panel">
    {!view.retired && <header className="thread-bar"><div className="thread-summary">{view.visible.length > 0 && !view.loading && <><div className="thread-participants" role="img" aria-label={`${messages.participants}: ${participants.map(author => author.displayName !== null && author.displayName.trim() !== '' ? author.displayName : messages.accountName(author.userId)).join(', ')}`}>{participants.map(author => <ThreadAvatar key={author.userId} id={author.userId} name={author.displayName} participant />)}</div><span>{messages.loadedCount(format.number(view.visible.length))}</span></>}</div><button className="thread-icon-button" type="button" aria-label={messages.refresh} disabled={view.refreshing || view.loading || view.authPaused} onClick={() => { void controller.refresh(); }}><ThreadIcon name="refresh" size={14} spinning={view.refreshing || view.loading} /></button></header>}
    {view.readError !== null && <ThreadFailure error={view.readError} label={messages.readFailed} messages={messages} retry={() => { void controller.refresh(); }} />}
    {view.historyError !== null && <ThreadFailure error={view.historyError} label={messages.historyFailed} messages={messages} />}
    {view.referenceError !== null && <ThreadFailure error={view.referenceError} label={messages.referenceFailed} messages={messages} />}
    <div className="thread-timeline" ref={scroll.viewport} tabIndex={0} aria-label={messages.timeline} {...{ onScroll: scroll.onScroll, onKeyDown: scroll.onKeyDown, onFocus: scroll.onFocus, onWheel: scroll.onWheel, onPointerDown: scroll.onPointerDown, onTouchStart: scroll.onTouchStart, onTouchMove: scroll.onTouchMove }}>
      <div className={`thread-timeline-content${view.visible.length === 0 || view.retired ? ' thread-timeline-empty' : ''}`} ref={scroll.content}>
        {view.retired ? <div className="thread-empty denied"><div className="thread-empty-symbol"><ThreadIcon name="shield" size={25} /></div><h2>{messages.denied}</h2><p>{messages.deniedExplanation}</p></div>
          : view.loading ? <div aria-label={messages.loading} role="status">{Array.from({ length: 4 }, (_, index) => <div className="thread-skeleton-message" key={index}><div className="thread-skeleton-avatar" /><div className="thread-skeleton-lines"><div className="thread-skeleton-line title" /><div className="thread-skeleton-line" /><div className="thread-skeleton-line short" /></div></div>)}</div>
          : view.visible.length === 0 ? <div className="thread-empty"><div className="thread-empty-symbol"><ThreadIcon name="bubble" size={24} /></div><h2>{messages.empty}</h2></div>
          : <>
            {view.hasMoreBefore && <div className="thread-load-older"><button className="thread-quiet-button" type="button" disabled={view.loadingOlder || view.authPaused} onClick={() => { scroll.pause(); scroll.capture(); void controller.loadOlder(); }}><ThreadIcon name={view.loadingOlder ? 'refresh' : 'up'} size={12} spinning={view.loadingOlder} />{messages.loadOlder}</button></div>}
            {view.visible.map((message, index) => {
              const author = authorLabel(message, messages), parent = message.replyTo === undefined ? null : controller.getMessage(message.replyTo);
              const day = format.date(message.createdAt), previous = view.visible[index - 1];
              return <div key={message.id}>{(previous === undefined || format.date(previous.createdAt) !== day) && <div className="thread-day-divider">{dayFormat.format(new Date(message.createdAt))}</div>}
                <article className={`thread-message${flashId === message.id ? ' flash' : ''}`} data-entry-key={message.id}>
                  <ThreadAvatar id={message.author.userId} name={message.author.displayName} agent={message.author.Agent} />
                  <div className="thread-message-main"><div className="thread-message-header"><span className="thread-author">{author}</span>{message.author.execution !== undefined && <span className="thread-agent-badge"><ThreadIcon name="code" size={10} />{providerLabel[message.author.execution.provider]}</span>}<button className="thread-message-time" type="button" title={message.createdAt} aria-label={messages.messageAt(author, message.createdAt)} onClick={() => { void controller.openDetails(message.id); }}>{shortTime.format(new Date(message.createdAt))}</button><div className="thread-message-actions"><button className="thread-icon-button" type="button" aria-label={messages.reply(author)} onClick={() => { controller.setReply(message.id); inputRef.current?.focus(); }}><ThreadIcon name="reply" size={13} /></button><button className="thread-icon-button" type="button" aria-label={messages.messageDetails} onClick={() => { void controller.openDetails(message.id); }}><ThreadIcon name="more" size={13} /></button></div></div>
                    {message.replyTo !== undefined && <button className="thread-reply-quote" type="button" aria-label={messages.viewReference} aria-busy={view.referenceLoading === message.replyTo} disabled={view.authPaused || view.referenceLoading !== null} onClick={() => reference(message.replyTo!)}>{parent === null ? <><strong>{messages.viewReference}</strong><span>{message.replyTo}</span></> : <><strong>{authorLabel(parent, messages)}</strong><span>{excerpt(parent.body, messages)}</span></>}{view.referenceLoading === message.replyTo && <ThreadIcon name="refresh" size={12} spinning />}</button>}
                    <ChatMarkdown text={message.body} className="thread-message-markdown" resourceUnavailable={messages.imageUnavailable} tableLabel={messages.table} />
                  </div>
                </article></div>;
            })}
            {view.hasMoreAfter && <div className="thread-load-older"><button className="thread-quiet-button" type="button" disabled={view.loadingNewer || view.authPaused} onClick={() => { scroll.pause(); scroll.capture(); void controller.loadWindowNewer(); }}><ThreadIcon name={view.loadingNewer ? 'refresh' : 'down'} size={12} spinning={view.loadingNewer} />{messages.loadNewer}</button></div>}
          </>}
      </div>
    </div>
    {!view.retired && (view.incomingCount > 0 || view.catchupPaused || scroll.showLatest) && <button className="thread-new-jump" type="button" onClick={reveal}><ThreadIcon name="down" size={12} /><span aria-live="polite">{view.incomingCount > 0 ? messages.newCount(format.number(view.incomingCount)) : messages.viewLatest}</span></button>}
  </div>;
};
