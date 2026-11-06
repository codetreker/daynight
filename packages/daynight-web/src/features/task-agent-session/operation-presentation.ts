import type { SessionOperation } from '../../../../daynight/src/session/protocol';

export type SessionOperationProgress = ReadonlyMap<string, 'sending' | 'waiting'>;

/** Page-local progress cannot prove the outcome of an operation restored from storage. */
export function operationPresentation(operation: SessionOperation, progress: SessionOperationProgress): SessionOperation['state'] | 'sending' | 'waiting' {
  const pending = ['unknown', 'accepted', 'offered', 'dispatching'].includes(operation.state)
    || operation.state === 'provider_accepted' && !['send_message', 'execute_command'].includes(operation.kind);
  if (!pending) return operation.state;
  const current = progress.get(operation.operationId);
  if (!current) return 'unknown';
  if (current === 'waiting') return 'waiting';
  return operation.state === 'unknown' ? 'sending' : operation.state;
}
