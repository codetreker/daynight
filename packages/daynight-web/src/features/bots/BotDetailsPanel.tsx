import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { dialogFocusables } from '../task-detail/focus';
import { BotStatus } from './BotStatus';
import { useBotMessages } from './messages';
import './details-panel.css';

/** A responsive information panel; the Session stays in its original sibling. */
export function BotDetailsPanel({ id, bot, worker, stale, opener, onClose }: {
  readonly id: string;
  readonly bot: BotDefinition | null;
  readonly worker: BotWorkerDefaults | undefined;
  readonly stale: boolean;
  readonly opener: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const m = useBotMessages(), dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 1000);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth <= 1000);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useBodyScrollLock(narrow);
  useLayoutEffect(() => {
    const panel = dialog.current!;
    if (narrow) panel.showModal(); else panel.setAttribute('open', '');
    close.current?.focus({ preventScroll: true });
    return () => {
      panel.close();
      const target = opener.current;
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
    };
  }, [narrow, opener]);
  return <dialog id={id} ref={dialog} className={`bot-details-panel${narrow ? ' bot-details-drawer' : ''}`} role={narrow ? 'dialog' : 'complementary'} aria-label={m.details} aria-modal={narrow ? true : undefined}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      // Keep Tab in the drawer, including its single-control case, before the
      // outer fullscreen boundary sees it. Native modality owns background inertness.
      else if (narrow && event.key === 'Tab') {
        const controls = dialogFocusables(event.currentTarget), first = controls[0], last = controls[controls.length - 1];
        if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
        event.stopPropagation();
      }
    }}>
    <header><h2>{m.details}</h2><button ref={close} className="button quiet" type="button" aria-label={m.closeDetails} onClick={onClose}>×</button></header>
    {bot === null ? <p role="status">{m.loading}</p> : <dl>
      <div><dt>{m.name}</dt><dd>{bot.name}</dd></div>
      <div><dt>{m.status}</dt><dd><BotStatus bot={bot} worker={worker} stale={stale} showWorkerName={false} /></dd></div>
      <div><dt>{m.worker}</dt><dd>{worker?.machine.name ?? bot.workerId}</dd></div>
      <div><dt>{m.cwd}</dt><dd><code>{bot.resolvedConfiguration.cwd}</code></dd></div>
      <div><dt>{m.agent}</dt><dd>{bot.resolvedConfiguration.provider === 'claude' ? 'Claude Code' : bot.resolvedConfiguration.provider === 'copilot' ? 'GitHub Copilot' : 'Codex'}</dd></div>
    </dl>}
  </dialog>;
}
