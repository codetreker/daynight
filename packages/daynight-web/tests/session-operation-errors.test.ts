import { expect, it } from 'vitest';
import type { SessionOperation } from '../../daynight/src/session/protocol';
import { OperationRequestError, operationErrorMessage, operationErrorText } from '../src/features/task-agent-session/operation-error';

const operation = (kind: SessionOperation['kind'], state: SessionOperation['state'], error: SessionOperation['error'] = null): SessionOperation => ({ protocol: 'daynight.session.v1', sessionId: 'session', claimId: 'claim', executionGeneration: '1', operationId: 'original', kind, state, providerResult: null, error });

it('preserves the original failure and hides it only when its own error-free acceptance contract succeeds', () => {
  const cause = new Error('Connection interrupted');
  const error = new OperationRequestError('original', cause);
  expect(error.cause).toBe(cause);
  expect(error.message).toBe(cause.message);
  const unrelated = { ...operation('send_message', 'confirmed'), operationId: 'other' };
  expect(operationErrorMessage(error, new Map([['other', unrelated]]), 'Fallback')).toBe('Connection interrupted');
  for (const kind of ['send_message', 'execute_command', 'cancel', 'update_setting', 'refresh_controls', 'interaction_response'] as const) {
    const accepted = operation(kind, 'provider_accepted');
    expect(operationErrorMessage(error, new Map([['original', accepted]]), 'Fallback')).toBe(['send_message', 'execute_command'].includes(kind) ? null : 'Connection interrupted');
    expect(operationErrorMessage(error, new Map([['original', operation(kind, 'confirmed')]]), 'Fallback')).toBeNull();
    expect(operationErrorMessage(error, new Map([['original', operation(kind, 'confirmed', { code: 'failure', message: 'Native failure' })]]), 'Fallback')).toBe('Connection interrupted');
  }
});

it('retains multiline user-facing details and falls back when only stack frames remain', () => {
  expect(operationErrorText('Permission revoked\nAsk the owner to restore access.\n    at request (/app/send.js:8:4)', 'Fallback')).toBe('Permission revoked\nAsk the owner to restore access.');
  expect(operationErrorText('    at run (/app/run.js:8:4)', 'Fallback')).toBe('Fallback');
  expect(operationErrorMessage(null, new Map(), 'Fallback')).toBeNull();
  expect(operationErrorMessage('Readable failure', new Map(), 'Fallback')).toBe('Readable failure');
  expect(new OperationRequestError('original', null)).toMatchObject({ message: 'The operation failed.', cause: null });
});
