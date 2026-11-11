import { describe, expect, it } from 'vitest';
import { SESSION_PROTOCOL, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { draftOperationOutcome, assertDraftOperation } from '../src/features/task-agent-session/drafts/draft-send';

const command: SessionCommand = { protocol: SESSION_PROTOCOL, sessionId: '00000001-1111-4111-8111-111111111111', claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', requestId: '00000003-1111-4111-8111-111111111111', operationId: '00000004-1111-4111-8111-111111111111', kind: 'send_message', payload: { content: [{ type: 'text', text: 'a' }], expectedTurnId: null } };
const operation = (state: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, sessionId: command.sessionId, claimId: command.claimId!, executionGeneration: '1', operationId: command.operationId, kind: 'send_message', state, providerResult: null, error: null });
describe('original image submission observations', () => {
  it('only clears a frozen draft after an exact native acceptance receipt', () => {
    for (const state of ['accepted', 'offered', 'dispatching', 'unknown'] as const) expect(draftOperationOutcome(operation(state))).toBe('pending');
    for (const state of ['provider_accepted', 'confirmed'] as const) expect(draftOperationOutcome(operation(state))).toBe('accepted');
    for (const state of ['rejected', 'failed', 'expired'] as const) expect(draftOperationOutcome(operation(state))).toBe('rejected');
  });
  it('refuses another operation, kind or original fence', () => {
    expect(() => assertDraftOperation(command, operation('confirmed'))).not.toThrow();
    for (const other of [
      { ...operation('confirmed'), operationId: command.requestId },
      { ...operation('confirmed'), kind: 'cancel' as const },
      { ...operation('confirmed'), executionGeneration: '2' },
    ]) expect(() => assertDraftOperation(command, other)).toThrow();
  });
});
