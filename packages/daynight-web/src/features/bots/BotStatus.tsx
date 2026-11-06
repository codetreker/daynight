import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { useBotMessages } from './messages';

export function BotStatus({ bot, worker, stale, showWorkerName = true, compact = false }: { readonly bot: BotDefinition; readonly worker: BotWorkerDefaults | undefined; readonly stale: boolean; readonly showWorkerName?: boolean; readonly compact?: boolean }) {
  const m = useBotMessages();
  if (compact) return <span className="bot-status bot-status-compact">
    <span className={`bot-startup-${bot.startupResult.state}`}>{m[bot.startupResult.state]}</span>
    {stale || worker === undefined ? <span>{m.workerUnknown}</span> : worker.state !== 'available' ? <span>{m.workerStates[worker.state]}</span> : null}
  </span>;
  return <span className={`bot-status bot-status-${bot.startupResult.state}`}>
    <span>{m[bot.startupResult.state]}</span>
    {bot.startupResult.code !== null ? <span>{m.reason(bot.startupResult.code)}</span> : null}
    <span>{stale || worker === undefined ? m.unavailable : worker.state === 'available' ? showWorkerName ? worker.machine.name : m.workerOnline : m.reason(worker.reason ?? worker.state)}</span>
  </span>;
}
