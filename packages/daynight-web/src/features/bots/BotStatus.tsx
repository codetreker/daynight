import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { useBotMessages } from './messages';

export function BotStatus({ bot, worker, stale, showWorkerName = true }: { readonly bot: BotDefinition; readonly worker: BotWorkerDefaults | undefined; readonly stale: boolean; readonly showWorkerName?: boolean }) {
  const m = useBotMessages();
  return <span className={`bot-status bot-status-${bot.startupResult.state}`}>
    <span>{m[bot.startupResult.state]}</span>
    {bot.startupResult.code !== null ? <span>{m.reason(bot.startupResult.code)}</span> : null}
    <span>{stale || worker === undefined ? m.unavailable : worker.state === 'available' ? showWorkerName ? worker.machine.name : m.workerOnline : m.reason(worker.reason ?? worker.state)}</span>
  </span>;
}
