import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { BotStatus } from './BotStatus';
import { useBotMessages } from './messages';

export function BotListItem({ bot, selected, disabled, worker, stale, follow, onDelete }: {
  readonly bot: BotDefinition; readonly selected: boolean; readonly disabled: boolean;
  readonly worker: BotWorkerDefaults | undefined; readonly stale: boolean;
  readonly follow: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly onDelete: (bot: BotDefinition, opener: HTMLButtonElement) => void;
}) {
  const m = useBotMessages(), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const node = menu.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect(), box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      node.style.top = `${anchor.bottom + box.height + 8 < window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    };
    const toggle = (event: ToggleEvent) => { if (event.newState === 'closed') setOpen(false); };
    node.addEventListener('toggle', toggle); node.showPopover(); position();
    node.querySelector<HTMLButtonElement>('button')!.focus();
    window.addEventListener('resize', position); document.addEventListener('scroll', position, true);
    return () => { node.removeEventListener('toggle', toggle); node.hidePopover(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); };
  }, [open]);
  return <li className="bot-list-item" onContextMenu={event => { if (!disabled) { event.preventDefault(); setOpen(true); } }} onKeyDown={event => {
    if (!disabled && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) { event.preventDefault(); setOpen(true); }
  }}>
    <a href={`/bots/${bot.id}`} onClick={follow} aria-current={selected ? 'page' : undefined}>
      <span className="bot-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" /><path d="M8 9h9M8 13h6" /></svg></span>
      <span className="bot-list-label"><strong title={bot.name}>{bot.name}</strong><BotStatus bot={bot} worker={worker} stale={stale} compact /></span>
      {bot.attentionCount > 0 ? <span className="bot-attention-count" aria-label={m.attentionCount.replace('{count}', String(bot.attentionCount))}>{bot.attentionCount}</span> : null}
    </a>
    <button type="button" className="button quiet bot-more" ref={trigger} disabled={disabled} aria-label={m.actionsFor.replace('{name}', bot.name)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>···</button>
    {open && <div id={id} role="menu" aria-label={m.actionsFor.replace('{name}', bot.name)} className="bot-action-menu" ref={menu} popover="auto" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    }}><button type="button" role="menuitem" onClick={() => { close(); onDelete(bot, trigger.current!); }}>{m.delete}</button></div>}
  </li>;
}
