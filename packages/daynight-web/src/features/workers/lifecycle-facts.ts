import type { LifecycleResource } from '../../api/worker-lifecycle';

export const lifecycleFacts = (resource: LifecycleResource | null, now: number | null, stale: boolean) => {
  const envelope = resource?.observation ?? null, observation = envelope?.observation ?? null;
  const current = resource !== null && envelope !== null && resource.instance !== null
    && envelope.instanceId === resource.instance.instanceId && envelope.instanceEpoch === resource.instance.instanceEpoch
    && envelope.intentVersion === resource.intentVersion && envelope.operationId === resource.operationId;
  const fresh = current && !stale && now !== null && observation !== null
    && now >= Date.parse(observation.receivedAt) && now < Date.parse(observation.freshUntil);
  const stopped = fresh && resource?.capability === 'supported' && observation !== null && observation.inventoryComplete && observation.stop === 'confirmed'
    && observation.save === 'durable' && observation.resourceCount !== null && observation.stoppedCount === observation.resourceCount
    && observation.pendingCount === 0 && observation.blockedCount === 0;
  const resumeEligible = stopped && resource?.admission === 'closed' && observation?.phase === 'disabled';
  const disabled = resumeEligible && resource?.desired === 'disabled';
  const interrupted = resumeEligible && resource?.desired === 'enabled';
  const accepting = fresh && resource?.desired === 'enabled' && resource.admission === 'open' && observation?.phase === 'accepting';
  const phase = disabled ? 'disabled' : accepting ? 'accepting' : interrupted || fresh && observation?.phase === 'blocked' ? 'blocked'
    : fresh && observation?.phase === 'disabling' ? 'disabling' : resource?.desired === 'enabled' && resource.admission === 'closed' && resource.operationId !== null ? 'resuming' : 'awaiting';
  return { current, fresh, stopped, resumeEligible, disabled, accepting, phase } as const;
};
