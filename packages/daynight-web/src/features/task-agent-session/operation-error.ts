import type { SessionOperation } from '../../../../daynight/src/session/protocol';

/** Associates a local request failure with its original receipt without changing the ledger. */
export class OperationRequestError extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The operation failed.', { cause });
    this.name = 'OperationRequestError';
  }
}

export function operationErrorText(message: string, fallback: string): string {
  return message.split('\n').filter(line => !/^\s+at\s.+(?:\(|:\d+:\d+)/u.test(line)).join('\n').trim() || fallback;
}

export function operationErrorMessage(error: string | Error | null, operations: ReadonlyMap<string, SessionOperation>, fallback: string): string | null {
  if (error === null) return null;
  const operation = error instanceof OperationRequestError ? operations.get(error.operationId) : undefined;
  if (operation && operation.error === null && (operation.state === 'confirmed' || operation.state === 'provider_accepted' && ['send_message', 'execute_command'].includes(operation.kind))) return null;
  return operationErrorText(error instanceof Error ? error.message : error, fallback);
}
