import { afterEach, expect, it } from 'vitest';
import { SESSION_PROTOCOL, type SessionCommand } from '../../daynight/src/session/protocol';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity, DraftRecord } from '../src/features/task-agent-session/drafts/draft-types';

const stores: SessionDraftStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
const identity: DraftOwnerIdentity = { target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: 'native' }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } };
const write = (draft: DraftRecord, text: string) => ({ draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text, items: draft.items, rejectedCandidates: draft.rejectedCandidates, overflowRejectedCount: draft.overflowRejectedCount });
const command = (args = '  exact\nargs '): SessionCommand => ({ protocol: SESSION_PROTOCOL, ...identity.target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'execute_command', payload: { commandId: 'command-id', arguments: args, expectedControlsRevision: '7', expectedTurnId: null } });

it('freezes an exact slash command before claiming dispatch and preserves a later successor on acceptance', async () => {
  const db = store(); let state = await db.openOwner(identity); const text = '  /compact   exact\nargs ';
  state = await db.saveDraft(state.owner, write(state.editable!, text)); const exact = command();
  const frozen = await db.freeze(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, command: exact, commandDraft: { text, commandName: 'compact' } });
  expect(frozen.submission).toMatchObject({ kind: 'execute_command', state: 'prepared', command: exact }); expect(frozen.frozen?.text).toBe(text); expect(frozen.executionBlocked).toBe(true);
  const claim = await db.claimDispatch(frozen.owner, exact.operationId); expect(claim?.submission.command).toEqual(exact);
  state = await db.startSuccessor(frozen.owner, exact.operationId); state = await db.saveDraft(state.owner, write(state.editable!, 'later text'));
  db.close(); const reopened = store(); expect((await reopened.openOwner(identity)).submission?.command).toEqual(exact);
  const accepted = await reopened.settleSubmission(frozen.owner, { operationId: exact.operationId, outcome: 'accepted', operation: { protocol: SESSION_PROTOCOL, ...identity.target.fence, operationId: exact.operationId, kind: 'execute_command', state: 'provider_accepted', providerResult: 'handled', error: null } });
  expect(accepted.editable?.text).toBe('later text'); expect(accepted.submission).toBeNull();
});

it.each([
  { text: '/compact args', proof: undefined, args: 'args' },
  { text: '/compact args', proof: { text: '/compact changed', commandName: 'compact' }, args: 'args' },
  { text: '/compact args', proof: { text: '/compact args', commandName: 'other' }, args: 'args' },
  { text: '/compact  args', proof: { text: '/compact  args', commandName: 'compact' }, args: 'args' },
  { text: 'ordinary text', proof: { text: 'ordinary text', commandName: 'compact' }, args: '' },
])('rejects a command whose classification does not consume the exact saved text: $text', async ({ text, proof, args }) => {
  const db = store(); let state = await db.openOwner(identity); state = await db.saveDraft(state.owner, write(state.editable!, text));
  await expect(db.freeze(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, command: command(args), ...(proof ? { commandDraft: proof } : {}) })).rejects.toMatchObject({ code: 'invalid' });
  const unchanged = await db.read(state.owner); expect(unchanged.editable).toEqual(state.editable); expect(unchanged.submission).toBeNull();
});

it.each(['item', 'rejected', 'overflow'] as const)('refuses to consume a slash command while %s image state remains', async kind => {
  const db = store(); let state = await db.openOwner(identity);
  state = await db.saveDraft(state.owner, { ...write(state.editable!, '/compact'), items: kind === 'item' ? [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'file.png', blobId: null, validation: 'pending', error: null, uploadId: null }] : [], rejectedCandidates: kind === 'rejected' ? [{ candidateId: 'candidate', label: 'file.png', reason: 'invalid' }] : [], overflowRejectedCount: kind === 'overflow' ? 1 : 0 });
  await expect(db.freeze(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, command: command(''), commandDraft: { text: '/compact', commandName: 'compact' } })).rejects.toMatchObject({ code: 'invalid' });
});
