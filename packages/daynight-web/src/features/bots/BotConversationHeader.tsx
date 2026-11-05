import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import type { SessionHeaderSlot } from '../task-agent-session/session-presentation-slots';
import { BotStatus } from './BotStatus';
import { useBotMessages } from './messages';

/** The current admitted Bot read; Session state remains owned by the mounted pane. */
export type BotConversationTarget = {
  readonly bot: BotDefinition | null;
  readonly worker: BotWorkerDefaults | undefined;
  readonly stale: boolean;
  readonly name: string;
  readonly detailsId: string;
  readonly detailsOpen: boolean;
  readonly detailsOpener: RefObject<HTMLButtonElement | null>;
  readonly onDetails: () => void;
  readonly follow: (event: MouseEvent<HTMLAnchorElement>) => void;
};

/** Render inside either the shared Session header or the unbound Bot header. */
export function BotConversationHeader({ target, session }: { readonly target: BotConversationTarget; readonly session?: SessionHeaderSlot }) {
  const m = useBotMessages(), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = session === undefined || session.active && session.current;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => { if (!active) setOpen(false); }, [active]);
  useLayoutEffect(() => {
    if (!open || !active) return;
    const node = popover.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect(), box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      node.style.top = `${anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    };
    const toggle = (event: ToggleEvent) => { if (event.newState === 'closed') setOpen(false); };
    node.addEventListener('toggle', toggle); node.showPopover(); position();
    node.querySelector<HTMLElement>('button:not(:disabled), a')?.focus({ preventScroll: true });
    const resize = new ResizeObserver(position); resize.observe(node);
    window.addEventListener('resize', position); document.addEventListener('scroll', position, true);
    return () => { node.removeEventListener('toggle', toggle); node.hidePopover(); resize.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); };
  }, [open, active]);
  return <>
    <div className="bot-header-identity">
      <a className="button quiet bot-header-back" href="/bots" aria-label={m.backToList} title={m.backToList} onClick={target.follow}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m14 6-6 6 6 6" /></svg></a>
      <div className="bot-conversation-title">
        <h2 title={target.name}>{target.name}</h2>
        <div className="bot-header-state">{session ? <>{session.provider}{session.runtimeReady && <span>{m.connected}</span>}{session.activity}</> : target.bot ? <BotStatus bot={target.bot} worker={target.worker} stale={target.stale} showWorkerName={false} /> : null}</div>
      </div>
    </div>
    <div className="bot-header-actions">
      {session?.display}{session?.focus}
      <button ref={active ? target.detailsOpener : undefined} type="button" className="button quiet bot-header-details" disabled={!target.bot} aria-label={m.details} title={m.details} aria-controls={target.detailsOpen ? target.detailsId : undefined} aria-expanded={target.detailsOpen} onClick={target.onDetails}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg></button>
      <div className="bot-header-more" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
        <button ref={trigger} className="button quiet" type="button" aria-label={m.conversationActions} title={m.conversationActions} aria-expanded={open && active} aria-controls={open && active ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>···</button>
        <div ref={popover} id={id} className="bot-header-popover" popover="auto" role="group" aria-label={m.conversationActions} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
          else if (event.key === 'Tab') close(true);
        }}>
          {session?.refresh}
          <a className="button quiet" href="/bots" onClick={event => { target.follow(event); close(); }}>{m.closeChat}</a>
        </div>
      </div>
    </div>
  </>;
}
