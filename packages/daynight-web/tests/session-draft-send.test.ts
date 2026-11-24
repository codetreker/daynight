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
  it.each(['image_session_unavailable', 'image_capability_changed', 'image_command_unavailable'])('reports %s only after the winning claim restores the whole draft', async issue => {
    const { store, saved } = await savedText();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const claim = store.claimDispatch.bind(store);
    vi.spyOn(store, 'claimDispatch').mockImplementationOnce(async (...args) => { const result = await claim(...args); entered.resolve(); await release.promise; return result; });
    let admission: string | null = null, nextCommand = command;
    const dispatch = vi.fn(async () => operation('provider_accepted')), changed = vi.fn();
    const sender = new DraftSender({ store, locks: null, isCurrent: () => true, admit: () => admission, command: () => nextCommand, dispatch, query: vi.fn(), changed });
    const sending = sender.send(saved.owner);
    const rejected = expect(sending).rejects.toThrow(issue);
    try {
      await entered.promise; admission = issue;
      expect(await store.read(saved.owner)).toMatchObject({ editable: null, submission: { state: 'dispatch_claimed' } });
      release.resolve(); await rejected;
      const restored = await store.read(saved.owner);
      expect(restored).toMatchObject({ editable: { text: 'a', draftId: saved.editable!.draftId }, submission: null, executionBlocked: false });
      expect(changed).toHaveBeenLastCalledWith(restored); expect(dispatch).not.toHaveBeenCalled();
      admission = null; nextCommand = { ...command, operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }; expect(dispatch).not.toHaveBeenCalled();
      dispatch.mockImplementationOnce(async () => ({ ...operation('provider_accepted'), operationId: nextCommand.operationId }));
      await sender.send(saved.owner); expect(dispatch).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledWith(nextCommand);
    } finally { release.resolve(); await rejected; }
  });
  it.each(['claim', 'restore'] as const)('preserves the original responsibility and storage error when %s confirmation fails', async phase => {
    const { store, saved } = await savedText(), fault = new Error('storage confirmation lost');
    let admission: string | null = null;
    const claim = store.claimDispatch.bind(store);
    vi.spyOn(store, 'claimDispatch').mockImplementationOnce(async (...args) => {
      const result = await claim(...args); admission = 'image_session_unavailable';
      if (phase === 'claim') throw fault;
      return result;
    });
    if (phase === 'restore') vi.spyOn(store, 'refuseClaimed').mockRejectedValueOnce(fault);
    const dispatch = vi.fn(), changed = vi.fn(), query = vi.fn(async () => operation('unknown'));
    const sender = new DraftSender({ store, locks: null, isCurrent: () => true, admit: () => admission, command: () => command, dispatch, query, changed });
    await expect(sender.send(saved.owner)).rejects.toBe(fault);
    expect(await store.read(saved.owner)).toMatchObject({ editable: null, frozen: { text: 'a' }, submission: { operationId: command.operationId, state: 'dispatch_claimed' }, executionBlocked: true });
    expect(dispatch).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledOnce();
    admission = null; await sender.send(saved.owner);
    expect(query).toHaveBeenCalledWith({ sessionId: command.sessionId, claimId: command.claimId, executionGeneration: command.executionGeneration }, command.operationId, undefined);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(['claim', 'restore', 'publish'] as const)('does not publish an old refusal after ownership changes during %s', async phase => {
    const { store, saved } = await savedText();
    let current = true, admission: string | null = null;
    const claim = store.claimDispatch.bind(store), restore = store.refuseClaimed.bind(store);
    vi.spyOn(store, 'claimDispatch').mockImplementationOnce(async (...args) => { const result = await claim(...args); admission = 'image_session_unavailable'; if (phase === 'claim') current = false; return result; });
    vi.spyOn(store, 'refuseClaimed').mockImplementationOnce(async (...args) => { const result = await restore(...args); if (phase === 'restore') current = false; return result; });
    const dispatch = vi.fn(), changed = vi.fn(snapshot => { if (!snapshot.submission && phase === 'publish') current = false; });
    const sender = new DraftSender({ store, locks: null, isCurrent: () => current, admit: () => admission, command: () => command, dispatch, query: vi.fn(), changed });
    await expect(sender.send(saved.owner)).resolves.toBeUndefined();
    expect(await store.read(saved.owner)).toMatchObject({ editable: { text: 'a' }, submission: null });
    expect(changed).toHaveBeenCalledTimes(phase === 'publish' ? 2 : 1); expect(dispatch).not.toHaveBeenCalled();
  });
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
