import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import type { BotObservationRead } from './useBotObservations';
import { useBotObservationMessages } from './observation-messages';
import { useWorkerNames } from '../worker-names/useWorkerNames';

export function BotStatus({ bot, observation, showWorkerName = true, compact = false }: {
  readonly bot: BotDefinition; readonly observation?: BotObservationRead | undefined;
  readonly worker?: BotWorkerDefaults | undefined; readonly stale?: boolean;
  readonly showWorkerName?: boolean; readonly compact?: boolean;
}) {
  const m = useBotObservationMessages();
  const value = observation?.value?.botId === bot.id ? observation.value : null;
  const names = useWorkerNames(value && showWorkerName ? [{ userId: bot.ownerUserId, workerId: value.workerId }] : []);
  const state = value && !observation?.stale ? value.state : 'unknown';
  return <span className={`bot-status bot-observation-${state}${compact ? ' bot-status-compact' : ''}`}>
    <span>{value && observation?.stale ? m.expired : m.states[state]}</span>
    {showWorkerName && <bdi className="bot-observation-machine">{value ? names.name(bot.ownerUserId, value.workerId, value.machine?.name ?? m.machineUnknown, true) : m.machineUnknown}</bdi>}
    {value && observation?.stale && <time dateTime={value.observedAt}>{m.observed}: {new Date(value.observedAt).toLocaleString()}</time>}
  </span>;
}
