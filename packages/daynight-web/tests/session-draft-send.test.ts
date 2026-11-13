import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { DraftSender, draftOperationOutcome, assertDraftOperation } from '../src/features/task-agent-session/drafts/draft-send';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';

const command: SessionCommand = { protocol: SESSION_PROTOCOL, sessionId: '00000001-1111-4111-8111-111111111111', claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', requestId: '00000003-1111-4111-8111-111111111111', operationId: '00000004-1111-4111-8111-111111111111', kind: 'send_message', payload: { content: [{ type: 'text', text: 'a' }], expectedTurnId: null } };
const operation = (state: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, sessionId: command.sessionId, claimId: command.claimId!, executionGeneration: '1', operationId: command.operationId, kind: 'send_message', state, providerResult: null, error: null });
const stores: SessionDraftStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
async function savedText() {
  const store = new SessionDraftStore(); stores.push(store);
  const initial = await store.openOwner({ target: { serverOrigin: 'https://daynight.test', actorUserId: '00000005-1111-4111-8111-111111111111', fence: { sessionId: command.sessionId, claimId: command.claimId!, executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'task', projectId: 'p', taskId: 't' } });
  const saved = await store.saveDraft(initial.owner, { draftId: initial.editable!.draftId, expectedStoreVersion: initial.editable!.storeVersion, text: 'a', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
  return { store, saved };
}
describe('original image submission observations', () => {
  it.each([false, true])('rejects malformed local commands before dispatch and preserves the draft (prepared=%s)', async prepared => {
    const { store, saved } = await savedText(), malformed: SessionCommand = { ...command, contentRevision: 2 };
    if (prepared) await store.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command: malformed });
    const dispatch = vi.fn(async () => operation('provider_accepted')), changed = vi.fn();
    const sender = new DraftSender({ store, locks: null, isCurrent: () => true, admit: () => null, command: () => malformed, dispatch, query: vi.fn(), changed });
    await expect(sender.send(saved.owner)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await store.read(saved.owner)).toMatchObject({ editable: { text: 'a' }, submission: null, executionBlocked: false });
  });
  it('keeps post-dispatch parse failures unknown under the original operation identity', async () => {
    const { store, saved } = await savedText(), dispatch = vi.fn(async () => { throw new Error('Invalid Session protocol value.'); });
    const sender = new DraftSender({ store, locks: null, isCurrent: () => true, admit: () => null, command: () => command, dispatch, query: vi.fn(), changed: vi.fn() });
    await sender.send(saved.owner);
    expect(dispatch).toHaveBeenCalledOnce(); expect(await store.read(saved.owner)).toMatchObject({ editable: null, frozen: { text: 'a' }, submission: { operationId: command.operationId, state: 'unknown' }, executionBlocked: true });
  });
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
