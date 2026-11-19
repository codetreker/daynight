import { useWorkerNames } from '../worker-names/useWorkerNames';
import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { useBotMessages } from './messages';

export function BotStatus({ bot, worker, stale, showWorkerName = true, compact = false }: { readonly bot: BotDefinition; readonly worker: BotWorkerDefaults | undefined; readonly stale: boolean; readonly showWorkerName?: boolean; readonly compact?: boolean }) {
  const m = useBotMessages();
  const names = useWorkerNames(!compact && showWorkerName ? [{ userId: bot.ownerUserId, workerId: bot.workerId }] : []);
  const currentWorker = worker?.workerId === bot.workerId ? worker : undefined;
  if (compact) return <span className="bot-status bot-status-compact">
    <span className={`bot-startup-${bot.startupResult.state}`}>{m[bot.startupResult.state]}</span>
    {stale || currentWorker === undefined ? <span>{m.workerUnknown}</span> : currentWorker.state !== 'available' ? <span>{m.workerStates[currentWorker.state]}</span> : null}
  </span>;
  return <span className={`bot-status bot-status-${bot.startupResult.state}`}>
    <span>{m[bot.startupResult.state]}</span>
    {bot.startupResult.code !== null ? <span>{m.reason(bot.startupResult.code)}</span> : null}
    <span>{stale || currentWorker === undefined ? m.unavailable : currentWorker.state === 'available' ? showWorkerName ? names.name(bot.ownerUserId, bot.workerId, currentWorker.machine.name, true) : m.workerOnline : m.reason(currentWorker.reason ?? currentWorker.state)}</span>
  </span>;
}
