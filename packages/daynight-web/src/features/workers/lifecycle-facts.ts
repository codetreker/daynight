import type { LifecycleResource } from '../../api/worker-lifecycle';

export const lifecycleFacts = (resource: LifecycleResource | null, now: number | null, stale: boolean) => {
  const envelope = resource?.observation ?? null, observation = envelope?.observation ?? null;
  const current = resource !== null && envelope !== null && resource.instance !== null
    && envelope.instanceId === resource.instance.instanceId
    && envelope.intentVersion === resource.intentVersion && envelope.operationId === resource.operationId;
  const fresh = current && !stale && now !== null && observation !== null
    && now >= Date.parse(observation.receivedAt) && now < Date.parse(observation.freshUntil);
  const stopProof = fresh && resource?.capability === 'supported' && observation !== null && observation.inventoryComplete && observation.stop === 'confirmed'
    && observation.save === 'durable' && observation.resourceCount !== null && observation.stoppedCount === observation.resourceCount
    && observation.pendingCount === 0 && observation.blockedCount === 0;
  const stopped = stopProof && (observation.errorCode === null || observation.errorCode === 'upload_failed');
  const resumeEligible = stopProof && (stopped || observation.errorCode === 'resume_interrupted')
    && resource?.admission === 'closed' && observation?.phase === 'disabled';
  const disabled = stopped && resumeEligible && resource?.desired === 'disabled';
  const interrupted = resumeEligible && resource?.desired === 'enabled';
  const accepting = fresh && resource?.desired === 'enabled' && resource.admission === 'open' && observation?.phase === 'accepting';
  const phase = disabled ? 'disabled' : accepting ? 'accepting' : interrupted || fresh && observation?.phase === 'blocked' ? 'blocked'
    : fresh && observation?.phase === 'disabling' ? 'disabling' : resource?.desired === 'enabled' && resource.admission === 'closed' && resource.operationId !== null ? 'resuming' : 'awaiting';
  return { current, fresh, stopped, resumeEligible, disabled, accepting, phase } as const;
};
