import { ApiError } from '../src/api/client';
import { sessionBinding, sessionFence, sessionFenceKey } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { createSessionApi, type SessionApi, type SessionChannel } from '../src/api/sessions';
import { sessionImageBytes } from './helpers/sessionImages';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation, SessionSnapshot, TimelineEntry } from '../src/api/types';
const snapshot = (): TaskSessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' });
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.forEach((c) => c.close()); clients.length = 0; vi.useRealTimers(); });
function fixture(storage: Storage | null = null, principal = userId, ownerUserId = userId, overrides: Partial<TaskSessionSnapshot> = {}, isPaused = () => false) {
  const s = { ...snapshot(), ...overrides }; let receive!: (message: BrowserMessage) => void; let close!: () => void;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const channel: SessionChannel = { close: vi.fn() }, onPrincipalMismatch = vi.fn();
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/resource', channel: vi.fn((_id, _after, onMessage, onClose) => { receive = onMessage; close = onClose; return channel; }) };
  const client = new TaskSessionClient({ api, userId: principal, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, ownerUserId, isCurrent: () => true, isPaused, onPrincipalMismatch, storage });
  client.setCurrentReadVisible(true); clients.push(client);
  return { s, api, client, channel, onPrincipalMismatch, receive: (message: BrowserMessage) => receive(message), disconnect: () => close() };
}
async function ready(f: ReturnType<typeof fixture>) { await f.client.start(); f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: f.s, cursor: 'zero' }); await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true)); }
describe('task session transport lifecycle', () => {
  it('keeps current-tab legacy input distinct from the first and later durable projections', async () => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage), store = new SessionDraftStore();
    try {
      await ready(f); f.client.setDraft('Local input');
      const key = Object.keys(storage).find(key => storage.getItem(key)?.includes('Local input'))!;
      const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
      const initial = await store.openOwner(identity);
      await store.saveDraft(initial.owner, { draftId: initial.editable!.draftId, expectedStoreVersion: initial.editable!.storeVersion, text: 'Saved input', items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'missing.png', blobId: null, validation: 'bytes_missing', error: 'bytes_missing', uploadId: null }], rejectedCandidates: [], overflowRejectedCount: 0 });
      const projected: string[] = []; f.client.subscribe(() => projected.push(f.client.snapshot().draft.text));
      f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe('Local input'); expect(projected).not.toContain('Saved input');
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ conflict: true, items: [] }); expect(storage.getItem(key)).toContain('Local input');
      await f.client.imageDrafts.resolveConflict('saved'); expect(storage.getItem(key)).toBeNull();
      const latest = (await store.readExisting(identity))!;
      await store.saveDraft(latest.owner, { draftId: latest.editable!.draftId, expectedStoreVersion: latest.editable!.storeVersion, text: 'Later saved input', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      await f.client.imageDrafts.refreshForSend().catch(() => {});
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ text: 'Later saved input', conflict: false, items: [] }); expect(f.api.command).not.toHaveBeenCalled();
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('does not rebind unprojected legacy text to a new native owner on refresh or reopen', async () => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage);
    try {
      await ready(f); f.client.setDraft('Original native text');
      const key = Object.keys(storage).find(key => storage.getItem(key)?.includes('Original native text'))!, bytes = storage.getItem(key);
      const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'another-native' } };
      f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'next' });
      f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe(''); expect(storage.getItem(key)).toBe(bytes);
      f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: String(BigInt(next.sessionRevision) + 1n) }, cursor: 'original' });
      await f.client.imageDrafts.sync(); expect(f.client.snapshot().draft.text).toBe('Original native text');
      const reopened = fixture(storage, userId, userId, next); await ready(reopened); reopened.client.setImageDraftAdmission(true, true); await reopened.client.imageDrafts.sync();
      expect(reopened.client.snapshot().draft.text).toBe(''); expect(reopened.api.command).not.toHaveBeenCalled();
      reopened.client.close(); await reopened.client.imageDrafts.close();
    } finally { f.client.close(); await f.client.imageDrafts.close(); }
  });
  it.each([null, 'native-original'].flatMap(native => ['bytes_missing', 'bytes_invalid', 'rejected'].map(validation => ({ native, validation }))))('switches image text with its native owner atomically ($native, $validation)', async ({ native, validation }) => {
    const f = fixture(null, userId, userId, { identity: { ...snapshot().identity, nativeSessionId: native } });
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: native }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore();
    try {
      const owner = await store.openOwner(identity);
      await store.saveDraft(owner.owner, { draftId: owner.editable!.draftId, expectedStoreVersion: owner.editable!.storeVersion, text: 'Keep with the original image', items: validation === 'rejected' ? [] : [{ draftImageId: 'original-image', imageId: 'image', byteRevision: '1', label: 'original.png', blobId: null, validation: validation as 'bytes_missing' | 'bytes_invalid', error: validation, uploadId: null }], rejectedCandidates: validation === 'rejected' ? [{ candidateId: 'rejected-image', label: 'original.png', reason: 'image_type_unsupported' }] : [], overflowRejectedCount: 0 });
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe('Keep with the original image');
      if (validation !== 'rejected') expect(f.client.imageDrafts.getSnapshot().items[0]?.validation).toBe(validation);
      const projected: string[] = [];
      const unsubscribe = f.client.subscribe(() => { if (f.client.snapshot().state.snapshot?.identity.nativeSessionId === 'native-new') projected.push(f.client.snapshot().draft.text); });
      const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-new' } };
      f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'next' });
      expect(f.client.snapshot().draft.text).toBe('');
      await f.client.imageDrafts.sync();
      expect(projected.length).toBeGreaterThan(0); expect(projected.every(text => text === '')).toBe(true);
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ active: true, text: '', items: [], rejectedCandidates: [], canSend: false, detachedDrafts: [{ draft: { text: 'Keep with the original image' } }] });
      await f.client.send(f.client.snapshot().draft.text);
      expect(f.api.command).not.toHaveBeenCalled();
      expect((await store.readExisting(identity))?.editable?.text).toBe('Keep with the original image');
      const reopened = fixture(null, userId, userId, next); await ready(reopened); reopened.client.setImageDraftAdmission(true, true); await reopened.client.imageDrafts.sync();
      expect(reopened.client.snapshot().draft.text).toBe('');
      reopened.client.close(); await reopened.client.imageDrafts.close();
      unsubscribe();
      f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: String(BigInt(next.sessionRevision) + 1n) }, cursor: 'original' });
      await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe('Keep with the original image');
      expect(validation === 'rejected' ? f.client.imageDrafts.getSnapshot().rejectedCandidates : f.client.imageDrafts.getSnapshot().items).toHaveLength(1);
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('does not republish a late original-owner read into an empty replacement owner', async () => {
    const f = fixture();
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore();
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let pending: Promise<unknown> | null = null;
    try {
      const owner = await store.openOwner(identity);
      await store.saveDraft(owner.owner, { draftId: owner.editable!.draftId, expectedStoreVersion: owner.editable!.storeVersion, text: 'Original image text', items: [{ draftImageId: 'original-image', imageId: 'image', byteRevision: '1', label: 'missing.png', blobId: null, validation: 'bytes_missing', error: 'bytes_missing', uploadId: null }], rejectedCandidates: [], overflowRejectedCount: 0 });
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      const reconcile = SessionDraftStore.prototype.reconcileAuthorizedOwner;
      const read = vi.spyOn(SessionDraftStore.prototype, 'reconcileAuthorizedOwner').mockImplementationOnce(async function (this: SessionDraftStore, ...args) {
        const result = await reconcile.apply(this, args); entered.resolve(); await held.promise; return result;
      });
      pending = f.client.imageDrafts.refreshForSend().catch((error: unknown) => error);
      await entered.promise; expect(read).toHaveBeenCalledWith(identity, expect.any(Function));
      const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-new' } };
      f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'next' });
      expect(f.client.snapshot().draft.text).toBe('');
      held.resolve(); await expect(pending).resolves.toMatchObject({ message: 'image_access_unavailable' }); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe('');
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ active: true, text: '', items: [], detachedDrafts: [{ draft: { text: 'Original image text' } }] });
      expect(f.api.command).not.toHaveBeenCalled();
    } finally { held.resolve(); await pending; f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('does not import the old text again after its image draft changes native owners', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage), store = new SessionDraftStore();
    try {
      await ready(f); f.client.setDraft('Import this text once');
      const legacyKey = Object.keys(storage).find(key => storage.getItem(key)?.includes('Import this text once'))!;
      f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      await f.client.imageDrafts.addFiles([new File([], 'empty.png', { type: 'image/png' })], f.client.snapshot().draft.text);
      expect(storage.getItem(legacyKey)).toBeNull();
      expect(f.client.imageDrafts.getSnapshot().items[0]?.validation).toBe('bytes_invalid');
      const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-new' } };
      f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'next' });
      await f.client.imageDrafts.sync();
      await f.client.imageDrafts.addFiles([new File([], 'next-empty.png', { type: 'image/png' })], f.client.snapshot().draft.text);
      const original = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
      expect((await store.readExisting(original))?.editable?.text).toBe('Import this text once');
      expect((await store.readExisting({ ...original, target: { ...original.target, expectedNativeSessionId: next.identity.nativeSessionId } }))?.editable?.text).toBe('');
      expect(f.client.snapshot().draft.text).toBe('');
      expect(f.api.command).not.toHaveBeenCalled();
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('keeps recovery loading read-only through the public draft setter and resumes edits after restoration', async () => {
    const f = fixture(window.sessionStorage), store = new SessionDraftStore();
    const original = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: 'native-earlier' }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let restoring: Promise<void> | undefined;
    try {
      await store.importLegacy(original, { text: 'Earlier draft', revision: 'earlier', submission: null });
      await ready(f); f.client.setDraft('Text before restoration');
      const read = SessionDraftStore.prototype.readDetachedDrafts;
      vi.spyOn(SessionDraftStore.prototype, 'readDetachedDrafts').mockImplementationOnce(async function (this: SessionDraftStore, ...args) { const result = await read.apply(this, args); entered.resolve(); await release.promise; return result; });
      f.client.setImageDraftAdmission(true, true); restoring = f.client.imageDrafts.sync(); await entered.promise;
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ loading: true, active: false });
      f.client.setDraft('Late suggestion during restoration');
      expect(f.client.snapshot().draft.text).toBe('Text before restoration');
      release.resolve(); await restoring;
      expect(f.client.snapshot().draft.text).toBe('Text before restoration');
      f.client.setDraft('Editable after restoration'); await f.client.imageDrafts.flush();
      const current = { ...original, target: { ...original.target, expectedNativeSessionId: f.s.identity.nativeSessionId } };
      expect((await store.readExisting(current))?.editable?.text).toBe('Editable after restoration');
      expect((await store.readExisting(original))?.editable?.text).toBe('Earlier draft');
      expect(f.api.command).not.toHaveBeenCalled();
    } finally { release.resolve(); await restoring; f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it.each(['prepared', 'unknown', 'rejected'].flatMap(state => [false, true].flatMap(otherNative => [undefined, '/compact'].map(draftText => ({ state, otherNative, draftText })))) )('blocks commands behind a durable $state operation without session receipt storage (otherNative=$otherNative, draftText=$draftText)', async ({ state, otherNative, draftText }) => {
    const f = fixture(null, userId, userId, { controls: { revision: '1', settings: [], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: otherNative ? 'native-original' : f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore();
    try {
      let saved = await store.openOwner(identity);
      saved = await store.saveDraft(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, text: 'Original message', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      const command = { protocol: f.s.protocol, ...sessionFence(f.s), requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message' as const, payload: { content: [{ type: 'text' as const, text: 'Original message' }], expectedTurnId: null } };
      saved = await store.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command });
      if (state !== 'prepared') {
        await store.claimDispatch(saved.owner, command.operationId);
        await store.observeSubmission(saved.owner, command.operationId, { protocol: f.s.protocol, ...sessionFence(f.s), operationId: command.operationId, kind: 'send_message', state: 'unknown', providerResult: null, error: null });
      }
      saved = await store.startSuccessor(saved.owner, command.operationId);
      saved = await store.saveDraft(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, text: 'Successor text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      const operation = { protocol: f.s.protocol, ...sessionFence(f.s), operationId: command.operationId, kind: 'send_message' as const, state: 'rejected' as const, providerResult: null, error: null };
      if (state === 'rejected') await store.settleSubmission(saved.owner, { operationId: command.operationId, outcome: 'rejected', operation });
      if (otherNative) {
        const current = await store.openOwner({ ...identity, target: { ...identity.target, expectedNativeSessionId: f.s.identity.nativeSessionId } });
        await store.saveDraft(current.owner, { draftId: current.editable!.draftId, expectedStoreVersion: current.editable!.storeVersion, text: 'Current native text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      }
      vi.mocked(f.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
      vi.mocked(f.api.command).mockImplementation(async (_id, sent) => ({ protocol: sent.protocol, ...sessionFence(sent), operationId: sent.operationId, kind: sent.kind, state: 'confirmed', providerResult: null, error: null }));
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().state.operations.size).toBe(0);
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ active: true, readOnly: false, items: [], canSend: false });
      await expect(f.client.executeCommand('compact', '', '1', draftText)).rejects.toThrow('Resolve the saved image draft before executing a command.');
      expect(f.api.command).not.toHaveBeenCalled();
      if (state === 'rejected') await f.client.imageDrafts.resolveFailure(f.client.imageDrafts.getSnapshot().recoveries.find(recovery => recovery.ref.operationId === command.operationId)!.ref, 'current');
      else await store.settleSubmission(saved.owner, { operationId: command.operationId, outcome: 'accepted', operation: { ...operation, state: 'provider_accepted' } });
      await f.client.imageDrafts.refreshForSend();
      if (draftText !== undefined) { f.client.setDraft(draftText); await f.client.imageDrafts.flush(); }
      await f.client.executeCommand('compact', '', '1', draftText);
      expect(f.api.command).toHaveBeenCalledOnce();
      expect(f.client.snapshot().draft.text).toBe(draftText === undefined ? otherNative ? 'Current native text' : 'Successor text' : '');
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('keeps historical recovery out of the current native command gate and operation ledger', async () => {
    const f = fixture(null, userId, userId, { executionGeneration: '2', controls: { revision: '1', settings: [], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
    const original = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: { ...sessionFence(f.s), executionGeneration: '1' }, expectedNativeSessionId: 'native-original' }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore();
    try {
      const operationId = crypto.randomUUID();
      await store.importLegacy(original, { text: 'Previous execution', revision: 'legacy', submission: { operationId, revision: 'legacy', kind: 'send_message' } });
      vi.mocked(f.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
      vi.mocked(f.api.command).mockImplementation(async (_id, sent) => ({ protocol: sent.protocol, ...sessionFence(sent), operationId: sent.operationId, kind: sent.kind, state: 'confirmed', providerResult: null, error: null }));
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ executionBlocked: false, recoveries: [{ currentExecution: false, ref: { operationId } }] });
      expect(f.client.snapshot().state.operations.size).toBe(0);
      await f.client.executeCommand('compact', '', '1');
      expect(f.api.command).toHaveBeenCalledOnce();
      expect(f.client.snapshot().state.operations.has(operationId)).toBe(false);
      expect((await store.readExisting(original))?.submission?.state).toBe('unknown');
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it('keeps approval, form and interruption independent of a durable image send barrier', async () => {
    const f = fixture(null, userId, userId, { activity: 'waiting_input', currentTurnId: 'native-turn', operations: { canSend: false, canCancel: true, canRespond: true } });
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore();
    const approval = { interactionId: 'approval', revision: '1', state: 'pending' as const, kind: 'approval' as const, title: 'Approve', detail: 'Run', actions: ['allow_once' as const] };
    const form = { interactionId: 'form', revision: '1', state: 'pending' as const, kind: 'form' as const, title: 'Answer', canDismiss: false, fields: [{ fieldId: 'name', label: 'Name', type: 'text' as const, required: true, sensitive: false }] };
    try {
      const operationId = crypto.randomUUID();
      await store.importLegacy(identity, { text: 'Original unresolved input', revision: 'legacy', submission: { operationId, revision: 'legacy', kind: 'send_message' } });
      vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [approval, form].map((interaction, index) => ({ entryId: interaction.interactionId, entrySeq: String(index + 1), revision: '1', kind: 'interaction', interaction })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
      vi.mocked(f.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
      vi.mocked(f.api.command).mockImplementation(async (_id, sent) => ({ protocol: sent.protocol, ...sessionFence(sent), operationId: sent.operationId, kind: sent.kind, state: 'confirmed', providerResult: null, error: null }));
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.imageDrafts.getSnapshot().executionBlocked).toBe(true);
      await f.client.respond(approval, { kind: 'approval', action: 'allow_once' });
      await f.client.respond(form, { kind: 'form', values: [{ fieldId: 'name', value: 'answer' }] });
      await f.client.cancel();
      expect(vi.mocked(f.api.command).mock.calls.map(([, sent]) => sent.kind)).toEqual(['interaction_response', 'interaction_response', 'cancel']);
      expect(f.client.snapshot().draft.text).toBe('Original unresolved input');
      expect((await store.readExisting(identity))?.submission).toMatchObject({ operationId, state: 'unknown' });
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it.each(['send', 'command'].flatMap(action => ['read', 'resume'].map(phase => ({ action, phase }))))('rejects a pending $action click when its native owner changes during $phase', async ({ action, phase }) => {
    const f = fixture(null, userId, userId, { controls: { revision: '1', settings: [], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    const store = new SessionDraftStore(), held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let sending: Promise<unknown> | undefined;
    try {
      const owner = await store.openOwner(identity);
      await store.saveDraft(owner.owner, { draftId: owner.editable!.draftId, expectedStoreVersion: owner.editable!.storeVersion, text: 'Original target text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      expect(f.client.snapshot().draft.text).toBe('Original target text');
      const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-new' } };
      const nextIdentity = { ...identity, target: { ...identity.target, expectedNativeSessionId: 'native-new' } };
      const nextOwner = await store.openOwner(nextIdentity);
      await store.saveDraft(nextOwner.owner, { draftId: nextOwner.editable!.draftId, expectedStoreVersion: nextOwner.editable!.storeVersion, text: 'New target text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
      vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, ...sessionFence(command), operationId: command.operationId, kind: command.kind, state: 'provider_accepted', providerResult: null, error: null }));
      const reconcile = SessionDraftStore.prototype.reconcileAuthorizedOwner;
      const read = phase === 'read' ? vi.spyOn(SessionDraftStore.prototype, 'reconcileAuthorizedOwner').mockImplementationOnce(async function (this: SessionDraftStore, ...args) {
        const result = await reconcile.apply(this, args); entered.resolve(); await held.promise; return result;
      }) : null;
      const replace = () => f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'next' });
      if (phase === 'resume') {
        const refresh = f.client.imageDrafts.refreshForSend;
        vi.spyOn(f.client.imageDrafts, 'refreshForSend').mockImplementationOnce(async () => {
          await refresh();
          // A real snapshot arrives after the preparation helper checks, before
          // the public action resumes from awaiting that helper.
          queueMicrotask(() => queueMicrotask(replace));
        });
      }
      sending = (action === 'send' ? f.client.send('Original target text') : f.client.executeCommand('compact', '', '1', 'Original target text')).catch((error: unknown) => error);
      if (read) {
        await entered.promise; expect(read).toHaveBeenCalledWith(identity, expect.any(Function)); replace();
        await f.client.imageDrafts.sync(); expect(f.client.snapshot().draft.text).toBe('New target text'); held.resolve();
      }
      await expect(sending).resolves.toMatchObject({ message: 'image_access_unavailable' });
      await f.client.imageDrafts.sync();
      expect(f.api.command).not.toHaveBeenCalled();
      expect((await store.readExisting(nextIdentity))?.editable?.text).toBe('New target text');
    } finally { held.resolve(); await sending; f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });
  it.each(['send_message', 'execute_command'] as const)('restores draft operation ownership for %s and applies a later original acceptance to the current gate', async kind => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage);
    const operation: SessionOperation = { protocol: f.s.protocol, ...sessionBinding(f.s), sessionId: f.s.sessionId, executionGeneration: f.s.executionGeneration, operationId: '00000012-1111-4111-8111-111111111111', kind, state: 'unknown', providerResult: null, error: null };
    storage.setItem(`daynight:session-operations:${userId}:${f.s.sessionId}:${f.s.claimId}:${f.s.executionGeneration}`, JSON.stringify([{ operation, imageDraft: true }]));
    const check = vi.spyOn(f.client.imageDrafts, 'checkStatus').mockResolvedValue();
    await ready(f);
    expect(f.api.operation).not.toHaveBeenCalled();
    await f.client.checkOperation(operation.operationId);
    expect(check).toHaveBeenCalledOnce();
    vi.mocked(f.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
    await f.client.observeImageOperation(f.s, operation.operationId);
    expect(f.client.snapshot().state.operations.get(operation.operationId)?.state).toBe('provider_accepted');
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it('queries an original image operation without erasing its draft on a missing receipt', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('preserve unknown');
    vi.mocked(f.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    await expect(f.client.observeImageOperation(f.s, '00000012-1111-4111-8111-111111111111')).rejects.toThrow();
    expect(f.client.snapshot().draft.text).toBe('preserve unknown');
    expect(f.client.snapshot().status).toBe('ready');
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it('reads the original image operation fence independently from a newer generation', async () => {
    const f = fixture(); await ready(f);
    const original = { ...f.s, executionGeneration: '2' };
    const operation: SessionOperation = { protocol: f.s.protocol, ...sessionBinding(original), sessionId: original.sessionId, executionGeneration: original.executionGeneration, operationId: '00000012-1111-4111-8111-111111111111', kind: 'send_message', state: 'provider_accepted', providerResult: null, error: null };
    vi.mocked(f.api.operation).mockResolvedValue(operation);
    await expect(f.client.observeImageOperation(original, operation.operationId)).resolves.toEqual(operation);
    expect(f.client.snapshot().state.operations.has(operation.operationId)).toBe(false);
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it('keeps an image moved into retained Markdown and revokes it when its known entry removes the reference', async () => {
    const f = fixture(), resource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'saved.png', status: 'available' as const, mediaType: 'image/png', byteLength: '68', sha256: 'a'.repeat(64), error: null };
    const part = { type: 'image' as const, imageId: '00000013-1111-4111-8111-111111111111', resourceId: resource.resourceId, label: resource.name };
    const entry: TimelineEntry = { entryId: '00000014-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [part] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [entry], resources: [resource], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    const scope = f.client.imageScope()!, asset = scope.asset(resource)!;
    const update = (payload: TimelineEntry, eventSeq: string) => f.receive({ protocol: f.s.protocol, type: 'event', cursor: eventSeq, event: { protocol: f.s.protocol, ...sessionBinding(f.s), sessionId: f.s.sessionId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq, kind: 'timeline_upsert', payload } });
    update({ ...entry, revision: '2', content: [{ type: 'markdown', text: '', partId: '00000015-1111-4111-8111-111111111111', revision: '2', textSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', complete: true, truncated: false, bindings: [], retainedImages: [{ imageId: part.imageId, start: 0, end: 4, part, sourceRevision: '1', sourceTextSha256: 'b'.repeat(64), linkHref: null }] }] }, '1');
    expect(asset.canRead()).toBe(true); expect(f.client.imageScope()).toBe(scope);
    update({ ...entry, revision: '3', content: [{ type: 'text', text: 'Image removed.' }] }, '2');
    expect(scope.valid).toBe(true); expect(asset.canRead()).toBe(false);
  });
  it.each([
    { completeBefore: false, originalSeq: '1', through: '50', valid: true },
    { completeBefore: true, originalSeq: '1', through: '50', valid: false },
    { completeBefore: true, originalSeq: '100', through: '50', valid: true },
    { completeBefore: false, originalSeq: '75', through: '100', valid: false },
  ])('reconciles absent image rows only inside authoritative coverage: %j', async ({ completeBefore, originalSeq, through, valid }) => {
    const f = fixture(), resource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'saved.png', status: 'available' as const, mediaType: 'image/png', byteLength: '68', sha256: 'a'.repeat(64), error: null };
    const entry: TimelineEntry = { entryId: '00000014-1111-4111-8111-111111111111', entrySeq: originalSeq, revision: '1', kind: 'assistant_message', content: [{ type: 'resource', resourceId: resource.resourceId, label: resource.name }] };
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [entry], resources: [resource], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    const scope = f.client.imageScope()!, asset = scope.asset(resource)!;
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, connectionEpoch: '2' }, cursor: 'reconnected' });
    expect(f.client.imageScope()).toBe(scope); expect(asset.canRead()).toBe(true);
    const replacement = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), connectionEpoch: '2', historyEpoch: 'next-history', lastTimelineSeq: through };
    const tail: TimelineEntry[] = [{ ...entry, entryId: '00000016-1111-4111-8111-111111111111', entrySeq: '50', content: [{ type: 'text', text: 'New tail.' }] }];
    if (through !== '50') tail.push({ ...tail[0]!, entryId: '00000017-1111-4111-8111-111111111111', entrySeq: through });
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ sessionId: f.s.sessionId, historyEpoch: replacement.historyEpoch, items: tail, resources: [], beforeCursor: completeBefore ? null : 'older', afterCursor: null, hasMoreBefore: !completeBefore, hasMoreAfter: false, lastEventSeq: '0' });
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: replacement, cursor: 'new-history' });
    await vi.waitFor(() => expect(f.client.snapshot().historySettled).toBe(true));
    expect(f.client.snapshot().state.entries.map(item => item.entryId)).toEqual(tail.map(item => item.entryId));
    expect(f.client.imageScope()).toBe(scope); expect(asset.canRead()).toBe(valid);
  });
  it.each([401, 403, 404, 410])('revokes existing image scopes when a resource read returns %s', async status => {
    const f = fixture();
    const resource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'saved.png', status: 'available' as const, mediaType: 'image/png', byteLength: '68', sha256: 'a'.repeat(64), error: null };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [], resources: [resource], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    const scope = f.client.imageScope()!, invalidated = vi.fn(), asset = scope.asset(resource)!;
    scope.subscribeInvalidation(invalidated);
    expect(asset.canDownload()).toBe(true);
    vi.mocked(f.api.resource).mockRejectedValue(new ApiError('server', status, status === 410 ? 'task_deleted' : 'permission_denied'));
    await expect(f.client.resource(resource.resourceId, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
    expect(scope.valid).toBe(false); expect(asset.canDownload()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce(); expect(f.client.imageScope()).toBeNull();
  });
  it('keeps one image scope across renders and reconnects, and revokes it on close', async () => {
    const f = fixture(); await ready(f);
    const scope = f.client.imageScope();
    expect(scope?.identity.actorUserId).toBe(userId);
    expect(scope?.canRead()).toBe(true);
    expect(f.client.imageScope()).toBe(scope);
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, connectionEpoch: '2' }, cursor: 'next' });
    expect(f.client.imageScope()).toBe(scope);
    f.client.close();
    expect(scope?.valid).toBe(false);
    expect(scope?.canRead()).toBe(false);
    expect(f.client.imageScope()).toBeNull();
  });
  it('keeps a non-owner live reader connected while refusing messages, cancellation and responses', async () => {
    const f = fixture(null, userId, '00000010-1111-4111-8111-111111111111', { operations: { canSend: true, canCancel: true, canRespond: true }, currentTurnId: 'working-turn', activity: 'working' });
    const interaction = { interactionId: 'approval', revision: '1', state: 'pending' as const, kind: 'approval' as const, title: 'Approve Write', detail: 'notes/review.txt', actions: ['allow_once' as const, 'reject' as const] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [
      { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Shared live output' }] },
      { kind: 'interaction', entryId: 'request', entrySeq: '2', revision: '1', interaction }
    ], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    f.client.setDraft('unauthorized draft');
    await expect(f.client.send('hello')).rejects.toThrow();
    await expect(f.client.cancel()).rejects.toThrow();
    await expect(f.client.respond(interaction, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
    expect(f.api.command).not.toHaveBeenCalled();
    expect(f.client.snapshot()).toMatchObject({ status: 'ready', connected: true, draft: { text: '' } });
    expect(f.client.snapshot().state.entries.map(entry => entry.entryId)).toEqual(['message', 'request']);
    expect(f.api.channel).toHaveBeenCalledOnce();
  });

  it('discovers a later native registration without bypassing the wait or rebuilding its channel', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.api.current).mockResolvedValue({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
    f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 11; i++) { f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(250); }
    expect(f.api.current).toHaveBeenCalledOnce();
    expect(f.client.snapshot().status).toBe('not_registered');
    vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: f.s, startupReport: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.api.current).toHaveBeenCalledTimes(2);
    expect(f.client.snapshot()).toMatchObject({ status: 'ready', startupReport: null });
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: f.s, cursor: 'zero' });
    await vi.advanceTimersByTimeAsync(0);
    f.client.setDraft('preserve this draft');
    for (let i = 0; i < 16; i++) { f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(250); }
    expect(f.api.current).toHaveBeenCalledTimes(3);
    expect(f.api.channel).toHaveBeenCalledOnce();
    expect(f.client.snapshot()).toMatchObject({ status: 'ready', connected: true, startupReport: null, draft: { text: 'preserve this draft' } });
  });
  it('keeps a slow native discovery serial across availability checks', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: { status: 'not_registered'; claimId: string; agentControlMode: 'web' }) => void;
    vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.client.syncAvailability();
    for (let i = 0; i < 20; i++) { f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(250); }
    expect(f.api.current).toHaveBeenCalledOnce();
    resolve({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.snapshot().status).toBe('not_registered');
    await vi.advanceTimersByTimeAsync(2999); expect(f.api.current).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.api.current).toHaveBeenCalledTimes(2);
  });
  it('keeps a native not-applicable state stable until an explicit refresh', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.api.current).mockResolvedValue({ status: 'not_applicable', claimId: null, agentControlMode: null });
    f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 32; i++) { f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(250); }
    expect(f.api.current).toHaveBeenCalledOnce();
    expect(f.client.snapshot().status).toBe('unavailable');
    vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: f.s, startupReport: null });
    f.client.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(f.api.current).toHaveBeenCalledTimes(2);
    expect(f.api.channel).toHaveBeenCalledOnce();
  });
  it('keeps registered sessions and durable history readable when the channel cannot open', async () => {
    const f = fixture(); await f.client.start(); f.disconnect();
    await vi.waitFor(() => expect(f.api.timeline).toHaveBeenCalledOnce());
    expect(f.client.snapshot().status).toBe('ready');
    expect(f.client.snapshot().state.snapshot?.sessionId).toBe(f.s.sessionId);
    expect(f.client.snapshot().connected).toBe(false);
  });
  it('hydrates history then applies live revisions without launching or sending an agent input', async () => {
    const f = fixture(); await ready(f);
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'live' }] } } });
    expect(f.client.snapshot().state.entries).toHaveLength(1);
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it('queries the same operation after an unknown HTTP result and never posts again', async () => {
    const f = fixture(); await ready(f);
    let id = '';
    vi.mocked(f.api.command).mockImplementation(async (_session, command) => { id = command.operationId; throw new Error('lost acknowledgement'); });
    await expect(f.client.send('hello')).rejects.toThrow();
    expect(f.client.snapshot().state.operations.get(id)?.state).toBe('unknown');
    const receipt: SessionOperation = { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: id, kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null };
    vi.mocked(f.api.operation).mockResolvedValue(receipt);
    await f.client.checkOperation(id);
    expect(f.client.snapshot().state.operations.get(id)?.state).toBe('provider_accepted');
    expect(f.api.command).toHaveBeenCalledTimes(1);
  });
  it('keeps sending disabled until replay reaches the authenticated snapshot watermark', async () => {
    const f = fixture(); await ready(f);
    f.disconnect(); await f.client.start();
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, lastEventSeq: '1' }, cursor: 'zero' });
    expect(f.client.snapshot().connected).toBe(false);
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'live' }] } } });
    expect(f.client.snapshot().connected).toBe(true);
  });
  it('rejects a different browser principal without discarding the current snapshot', async () => {
    const f = fixture(); await f.client.start();
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId: '00000010-1111-4111-8111-111111111111', snapshot: { ...f.s, sessionRevision: '999' }, cursor: 'zero' });
    expect(f.client.snapshot().connected).toBe(false);
    expect(f.client.snapshot().authPaused).toBe(true);
    expect(f.client.snapshot().state.snapshot).toEqual(f.s);
  });
});


describe('task session operation and recovery contracts', () => {
  it('distinguishes a server acknowledgement from provider acceptance', async () => {
    const f = fixture(); await ready(f);
    let pending!: SessionOperation;
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => pending = { protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'accepted', providerResult: null, error: null });
    vi.mocked(f.api.operation).mockImplementation(async () => ({ ...pending, state: 'provider_accepted', providerResult: 'started' }));
    let finished = false;
    const send = f.client.send('hello').then(() => { finished = true; });
    await vi.waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(f.client.snapshot().state.operations.get(pending.operationId)?.state).toBe('accepted');
    await send;
    expect(finished).toBe(true);
    expect(f.api.command).toHaveBeenCalledOnce();
  });
  it('uses the exact active turn for cancellation and rejects stale interactions', async () => {
    const f = fixture();
    Object.assign(f.s, { currentTurnId: 'native-turn', activity: 'working', operations: { canSend: true, canCancel: true, canRespond: true } });
    await ready(f);
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }));
    await f.client.cancel();
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'cancel', payload: { expectedTurnId: 'native-turn' } });
    await expect(f.client.respond({ interactionId: 'old', revision: '1', state: 'pending', title: 'old', kind: 'approval', detail: 'old', actions: ['reject'] }, { kind: 'approval', action: 'reject' })).rejects.toThrow('changed');
  });
  it('responds to initialization approval without treating it as initial input acceptance', async () => {
    const f = fixture(); Object.assign(f.s, { initialInputState: 'dispatching', activity: 'waiting_input', operations: { canSend: false, canCancel: false, canRespond: true } });
    const interaction = { interactionId: 'approval', revision: '2', state: 'pending' as const, title: 'Run', kind: 'approval' as const, detail: 'Run tool', actions: ['allow_once' as const] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [{ entryId: 'approval', entrySeq: '1', revision: '2', kind: 'interaction', interaction }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }));
    await f.client.respond(interaction, { kind: 'approval', action: 'allow_once' });
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'interaction_response', payload: { interactionId: 'approval', interactionRevision: '2' } });
    expect(f.client.snapshot().state.snapshot?.initialInputState).toBe('dispatching');
    await expect(f.client.send('too early')).rejects.toThrow('not currently allowed');
  });
  it('loads earlier entries while preserving a newer streamed revision', async () => {
    const f = fixture();
    const recent = { entryId: 'recent', entrySeq: '2', revision: '2', kind: 'assistant_message' as const, content: [{ type: 'text' as const, text: 'recent' }] };
    const first = { sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [recent], resources: [], beforeCursor: 'before', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false, lastEventSeq: '0' };
    vi.mocked(f.api.timeline).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, beforeCursor: null, hasMoreBefore: false, items: [{ ...recent, entryId: 'earlier', entrySeq: '1' }, { ...recent, revision: '1' }] });
    await ready(f); await f.client.loadOlder();
    expect(f.client.snapshot().state.entries.map((entry) => [entry.entryId, entry.revision])).toEqual([['earlier', '2'], ['recent', '2']]);
    expect(f.client.snapshot().hasOlder).toBe(false);
    expect(f.api.timeline).toHaveBeenLastCalledWith(f.s.sessionId, 'before', 'before', expect.any(AbortSignal));
  });
  it('shows a real not-registered state and rejects a replaced claim', async () => {
    const f = fixture(); vi.mocked(f.api.current).mockResolvedValue({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
    await f.client.start(); expect(f.client.snapshot().status).toBe('not_registered'); expect(f.api.channel).not.toHaveBeenCalled();
    vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: { ...f.s, claimId: 'other' } });
    await f.client.start(); expect(f.client.snapshot().status).toBe('unavailable');
  });
  it('clears permissions and content when the owning scope closes', async () => {
    const f = fixture(); await ready(f); f.client.close();
    expect(f.client.snapshot().connected).toBe(false); expect(f.client.snapshot().state.snapshot).toBeNull();
    await expect(f.client.send('late')).rejects.toThrow();
  });
});

describe('independent native interaction responses', () => {
  it.each(['unknown', 'dispatching'] as const)('allows a new form while an earlier approval is %s without replaying that approval', async state => {
    const f = fixture(); Object.assign(f.s, { activity: 'waiting_input', operations: { ...f.s.operations, canRespond: true } });
    const approval = { interactionId: 'tool-approval', revision: '1', state: 'pending' as const, title: 'Run MCP tool', kind: 'approval' as const, detail: 'Start tool', actions: ['allow_once' as const] };
    const form = { interactionId: 'tool-form', revision: '1', state: 'pending' as const, title: 'MCP form', kind: 'form' as const, canDismiss: false, fields: [{ fieldId: 'name', label: 'Name', type: 'text' as const, required: true, sensitive: false }] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [approval, form].map((interaction, index) => ({ entryId: interaction.interactionId, entrySeq: String(index + 1), revision: '1', kind: 'interaction', interaction })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    let pending!: SessionOperation;
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => {
      const receipt: SessionOperation = { protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: command.kind === 'interaction_response' && command.payload.interactionId === approval.interactionId ? state : 'confirmed', providerResult: null, error: null };
      if (receipt.state !== 'confirmed') pending = receipt;
      return receipt;
    });
    const first = f.client.respond(approval, { kind: 'approval', action: 'allow_once' }).catch(error => error);
    await vi.waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    await expect(f.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
    await f.client.respond(form, { kind: 'form', values: [{ fieldId: 'name', value: 'answer' }] });
    expect(f.api.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.command).mock.calls[1]?.[1]).toMatchObject({ kind: 'interaction_response', payload: { interactionId: form.interactionId, interactionRevision: '1' } });
    vi.mocked(f.api.operation).mockResolvedValue({ ...pending, state: 'confirmed', providerResult: 'handled' });
    await first;
  });
});


it('restores response targets without storing answers and does not lock a different interaction', async () => {
  const storage = window.localStorage, f = fixture(storage);
  const approval = { interactionId: 'original-approval', revision: '1', state: 'pending' as const, title: 'Run', kind: 'approval' as const, detail: 'Start', actions: ['allow_once' as const] };
  const form = { interactionId: 'followup-form', revision: '1', state: 'pending' as const, title: 'Answer', kind: 'form' as const, canDismiss: false, fields: [{ fieldId: 'label', label: 'Label', type: 'text' as const, required: true, sensitive: true }] };
  const prepare = async (target: ReturnType<typeof fixture>) => {
    Object.assign(target.s, { activity: 'waiting_input', operations: { ...target.s.operations, canRespond: true } });
    vi.mocked(target.api.timeline).mockResolvedValue({ sessionId: target.s.sessionId, historyEpoch: target.s.historyEpoch, items: [approval, form].map((interaction, index) => ({ entryId: interaction.interactionId, entrySeq: String(index + 1), revision: '1', kind: 'interaction', interaction })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(target);
  };
  await prepare(f); vi.mocked(f.api.command).mockRejectedValue(new Error('Lost acknowledgement'));
  await expect(f.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow('Lost acknowledgement');
  f.client.close();
  const restored = fixture(storage); await prepare(restored);
  await expect(restored.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
  vi.mocked(restored.api.command).mockRejectedValue(new Error('Lost form acknowledgement'));
  await expect(restored.client.respond(form, { kind: 'form', values: [{ fieldId: 'label', value: 'sensitive-form-answer' }] })).rejects.toThrow('Lost form acknowledgement');
  expect(restored.api.command).toHaveBeenCalledOnce();
  const stored = storage.getItem(storage.key(0)!); expect(stored).toContain('followup-form'); expect(stored).not.toContain('sensitive-form-answer');
});

describe('session text draft ownership', () => {
  it.each([false, true])('keeps independent legacy native slots and their original submission correlation (unknown=%s)', async unknown => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage); await ready(f); f.client.setDraft('Native A');
    if (unknown) { vi.mocked(f.api.command).mockRejectedValue(new Error('response lost')); await expect(f.client.send('Native A')).rejects.toThrow(); }
    const original = f.client.snapshot().draft, key = Object.keys(storage).find(key => storage.getItem(key)?.includes('Native A'))!;
    const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-B' } };
    f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'B' }); f.client.setDraft('Native B');
    expect(JSON.parse(storage.getItem(key)!)).toMatchObject(original);
    if (unknown) {
      await vi.waitFor(() => expect(f.client.snapshot().checking.has(original.submission!.operationId)).toBe(false));
      vi.mocked(f.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
      await expect(f.client.checkOperation(original.submission!.operationId)).rejects.toMatchObject({ status: 404 });
      expect(f.client.snapshot().draft.text).toBe('Native B'); expect(storage.getItem(key)).not.toBeNull();
    }
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: String(BigInt(next.sessionRevision) + 1n) }, cursor: 'A' });
    expect(f.client.snapshot().draft).toEqual(original);
    f.client.close(); await f.client.imageDrafts.close();
    for (const [native, text] of [[f.s, 'Native A'], [next, 'Native B']] as const) {
      const reopened = fixture(storage, userId, userId, native); vi.mocked(reopened.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found')); await ready(reopened);
      expect(reopened.client.snapshot().draft.text).toBe(text); expect(reopened.api.command).not.toHaveBeenCalled(); reopened.client.close(); await reopened.client.imageDrafts.close();
    }
  });
  it.each([false, true])('preserves a fence-only legacy source and attributes it before native edits (marked=%s)', async marked => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage);
    const base = `daynight:session-draft:${userId}:task:${f.s.identity.projectId}:${f.s.identity.taskId}:${sessionFenceKey(f.s)}`;
    const ownerKey = JSON.stringify(['daynight-draft-owner', 1, window.location.origin, userId, 'task', f.s.identity.projectId, f.s.identity.taskId, f.s.sessionId, 'claim', f.s.claimId, f.s.executionGeneration, f.s.identity.nativeSessionId]);
    const source = { text: 'Old A', revision: 'original', submission: null, ...(marked ? { ownerKey } : {}) }; storage.setItem(base, JSON.stringify(source));
    await ready(f); expect(f.client.snapshot().draft.text).toBe('Old A'); expect(JSON.parse(storage.getItem(base)!)).toMatchObject({ ...source, ownerKey });
    const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-B' } };
    f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'B' }); expect(f.client.snapshot().draft.text).toBe(''); f.client.setDraft('B input');
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: String(BigInt(next.sessionRevision) + 1n) }, cursor: 'A' }); f.client.setDraft('New A');
    f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync(); await f.client.imageDrafts.addFiles([new File([], 'empty.png', { type: 'image/png' })], 'New A');
    expect(storage.getItem(base)).toBeNull();
    const reopened = fixture(storage, userId, userId, next); await ready(reopened); expect(reopened.client.snapshot().draft.text).toBe('B input'); reopened.client.close(); await reopened.client.imageDrafts.close();
    f.client.close(); await f.client.imageDrafts.close();
  });
  it('retains the newer in-memory legacy input when its exact-slot write fails', async () => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage); await ready(f); f.client.setDraft('Saved A');
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (value.includes('Unsaved A')) throw new DOMException('quota', 'QuotaExceededError'); original.call(this, key, value); });
    f.client.setDraft('Unsaved A');
    const next = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), identity: { ...f.s.identity, nativeSessionId: 'native-B' } };
    f.receive({ protocol: next.protocol, type: 'snapshot', userId, snapshot: next, cursor: 'B' }); f.client.setDraft('B');
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: String(BigInt(next.sessionRevision) + 1n) }, cursor: 'A' });
    expect(f.client.snapshot().draft.text).toBe('Unsaved A'); vi.restoreAllMocks(); f.client.close(); await f.client.imageDrafts.close();
  });
  it('retains a durable first-owner copy when stamping an unmarked legacy source fails', async () => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage);
    const base = `daynight:session-draft:${userId}:task:${f.s.identity.projectId}:${f.s.identity.taskId}:${sessionFenceKey(f.s)}`;
    const raw = JSON.stringify({ text: 'Original A', revision: 'original', submission: null }); storage.setItem(base, raw);
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === base) throw new DOMException('quota', 'QuotaExceededError'); set.call(this, key, value); });
    await ready(f); expect(storage.getItem(base)).toBe(raw); expect(f.client.snapshot().draft.text).toBe('Original A');
    const next = { ...f.s, identity: { ...f.s.identity, nativeSessionId: 'native-B' } };
    const other = fixture(storage, userId, userId, next); await ready(other); expect(other.client.snapshot().draft.text).toBe(''); other.client.setDraft('B input');
    expect(storage.getItem(base)).toBe(raw); vi.restoreAllMocks();
    f.client.close(); await f.client.imageDrafts.close(); other.client.close(); await other.client.imageDrafts.close();
    const reopened = fixture(storage); await ready(reopened); expect(reopened.client.snapshot().draft.text).toBe('Original A'); reopened.client.close(); await reopened.client.imageDrafts.close();
  });
  it.each(['provider_accepted', 'failed'] as const)('does not revive a fence-only legacy submission after a %s receipt and reopen', async state => {
    const storage = window.sessionStorage; storage.clear(); const f = fixture(storage), operationId = crypto.randomUUID();
    const base = `daynight:session-draft:${userId}:task:${f.s.identity.projectId}:${f.s.identity.taskId}:${sessionFenceKey(f.s)}`;
    storage.setItem(base, JSON.stringify({ text: 'Original A', revision: 'original', submission: { operationId, revision: 'original', kind: 'send_message' } }));
    vi.mocked(f.api.operation).mockResolvedValue({ protocol: f.s.protocol, ...sessionFence(f.s), operationId, kind: 'send_message', state, providerResult: null, error: state === 'failed' ? { code: 'failed', message: 'Rejected' } : null });
    await ready(f); await vi.waitFor(() => expect(f.client.snapshot().draft.submission).toBeNull());
    expect(f.client.snapshot().draft.text).toBe(state === 'failed' ? 'Original A' : '');
    f.client.close(); await f.client.imageDrafts.close();
    const reopened = fixture(storage); await ready(reopened);
    expect(reopened.client.snapshot().draft).toMatchObject({ text: state === 'failed' ? 'Original A' : '', submission: null }); expect(reopened.api.command).not.toHaveBeenCalled();
    expect(reopened.api.operation).not.toHaveBeenCalled(); reopened.client.close(); await reopened.client.imageDrafts.close();
  });
  it('restores a same-tab draft after reopening without dispatching input', async () => {
    const storage = window.sessionStorage; storage.clear();
    const first = fixture(storage); await ready(first);
    first.client.setDraft('not sent\n中文'); first.client.close();
    const reopened = fixture(storage); await ready(reopened);
    expect(reopened.client.snapshot().draft.text).toBe('not sent\n中文');
    expect(reopened.api.command).not.toHaveBeenCalled();
    reopened.client.pause(); reopened.client.setDraft('offline edit');
    expect(reopened.client.snapshot().draft.text).toBe('offline edit');
    reopened.client.invalidate();
    const revoked = fixture(storage); await ready(revoked);
    expect(revoked.client.snapshot().draft.text).toBe('');
  });
  it('isolates a replaced execution and does not restore its predecessor draft', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage); await ready(f); f.client.setDraft('old execution');
    const originalKey = [...Array(storage.length)].map((_, i) => storage.key(i)!).find(key => storage.getItem(key)?.includes('old execution'))!;
    const originalBytes = storage.getItem(originalKey);
    const replacement = { ...f.s, executionGeneration: '2' };
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: replacement, cursor: 'zero' });
    await vi.waitFor(() => expect(f.client.snapshot().state.snapshot?.executionGeneration).toBe('2'));
    expect(f.client.snapshot().draft.text).toBe('');
    expect(storage.getItem(originalKey)).toBe(originalBytes);
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it.each([false, true])('reconciles an exact restored send without clearing a later edit (edited=%s)', async (edited) => {
    const storage = window.sessionStorage; storage.clear();
    const first = fixture(storage); await ready(first); first.client.setDraft('sent once');
    vi.mocked(first.api.command).mockRejectedValue(new Error('lost acknowledgement'));
    await expect(first.client.send('sent once')).rejects.toThrow();
    const operation = [...first.client.snapshot().state.operations.values()][0]!;
    if (edited) { first.client.setDraft('different'); first.client.setDraft('sent once'); }
    first.client.close();
    const restored = fixture(storage);
    vi.mocked(restored.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
    await ready(restored);
    await vi.waitFor(() => expect(restored.client.snapshot().state.operations.get(operation.operationId)?.state).toBe('provider_accepted'));
    expect(restored.client.snapshot().draft.text).toBe(edited ? 'sent once' : '');
    expect(restored.api.command).not.toHaveBeenCalled();
  });
  it('does not clear its pending draft for another browser send receipt', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('my input');
    vi.mocked(f.api.command).mockRejectedValue(new Error('lost acknowledgement'));
    await expect(f.client.send('my input')).rejects.toThrow();
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'operation', payload: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: '00000012-1111-4111-8111-111111111111', kind: 'send_message', state: 'confirmed', providerResult: 'started', error: null } } });
    expect(f.client.snapshot().draft.text).toBe('my input');
  });
  it('stops before reporting a principal mismatch and retains the original display', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage); await ready(f); f.client.setDraft('private text');
    const scope = f.client.imageScope()!, state = f.client.snapshot().state;
    f.onPrincipalMismatch.mockImplementation(() => {
      expect(f.channel.close).toHaveBeenCalledOnce();
      expect(f.client.snapshot().authPaused).toBe(true);
      expect(f.client.snapshot().state).toBe(state);
    });
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId: '00000010-1111-4111-8111-111111111111', snapshot: { ...f.s, sessionRevision: '999' }, cursor: 'other' });
    expect(f.onPrincipalMismatch).toHaveBeenCalledOnce();
    expect(f.client.snapshot().state).toBe(state);
    expect(f.client.imageScope()).toBe(scope); expect(scope.valid).toBe(true);
    expect(scope.canRead()).toBe(false);
    f.client.setDraft('offline edit');
    expect(f.client.snapshot().draft.text).toBe('offline edit');
  });

  it('closes the real media reader while preserving an already decoded image lease', async () => {
    const bytes = sessionImageBytes('png'), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const first = { resourceId: '00000012-1111-4111-8111-111111111111', revision: '1', name: 'saved.png', status: 'available' as const, mediaType: 'image/png', byteLength: String(bytes.length), sha256, width: 3, height: 2, frameCount: 1, error: null };
    const second = { ...first, resourceId: '00000013-1111-4111-8111-111111111111' }, f = fixture();
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [{ kind: 'assistant_message', entryId: 'image', entrySeq: '1', revision: '1', content: [{ type: 'resource', resourceId: first.resourceId, label: first.name }, { type: 'resource', resourceId: second.resourceId, label: second.name }] }], resources: [first, second], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    const realApi = createSessionApi(f.s.identity.projectId, f.s.identity.taskId, userId, vi.fn());
    let close!: ReturnType<typeof vi.spyOn>, transportSignal!: AbortSignal, cancel!: ReturnType<typeof vi.spyOn>;
    f.api.resources = (fence, isCurrent) => { const client = realApi.resources(fence, isCurrent); close = vi.spyOn(client, 'close'); return client; };
    const progress = vi.fn();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(first.resourceId)) return Response.json({ resourceId: first.resourceId, byteLength: first.byteLength, sha256, offset: '0', data: Buffer.from(bytes).toString('base64'), eof: true }, { headers: { 'Daynight-User-ID': userId } });
      transportSignal = init!.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); transportSignal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true }); } });
      const getReader = body.getReader.bind(body);
      vi.spyOn(body, 'getReader').mockImplementation(() => { const reader = getReader(); cancel = vi.spyOn(reader, 'cancel'); return reader; });
      return new Response(body, { headers: { 'Daynight-User-ID': userId } });
    });
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:account-retained'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      await ready(f);
      const scope = f.client.imageScope()!, lease = await scope.asset(first)!.acquire(new AbortController().signal), decoded = await lease.decode(new AbortController().signal);
      const pending = f.client.resource(second.resourceId, new AbortController().signal, progress).catch(error => error);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
      f.client.suspendForAccountRefresh();
      expect(close).toHaveBeenCalledOnce(); expect(transportSignal.aborted).toBe(true);
      expect(f.client.imageScope()).toBe(scope); expect(scope.valid && lease.valid && decoded.valid).toBe(true);
      expect(decoded.url).toBe('blob:account-retained'); expect(revoke).not.toHaveBeenCalled();
      expect(await pending).toMatchObject({ name: 'AbortError' }); expect(cancel).toHaveBeenCalledOnce();
      decoded.release(); lease.release(); expect(revoke).toHaveBeenCalledWith('blob:account-retained');
    } finally { f.client.close(); vi.unstubAllGlobals(); create.mockRestore(); revoke.mockRestore(); }
  });

  it('settles checking locally and ignores a late denial while externally paused', async () => {
    let paused = false, reject!: (error: Error) => void;
    const f = fixture(null, userId, userId, {}, () => paused); await ready(f);
    f.client.setDraft('editable'); const state = f.client.snapshot().state;
    vi.mocked(f.api.operation).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const checking = f.client.checkOperation('pending').catch(error => error);
    expect(f.client.snapshot().checking.has('pending')).toBe(true);
    paused = true; f.client.suspendForAccountRefresh();
    expect(f.client.snapshot().checking.size).toBe(0);
    reject(new ApiError('server', 403, 'forbidden')); expect(await checking).toBeInstanceOf(Error);
    expect(f.client.snapshot().state).toBe(state); expect(f.client.snapshot().authPaused).toBe(true);
    f.client.setDraft('still editable'); expect(f.client.snapshot().draft.text).toBe('still editable');
  });

  it('retains the complete durable draft and local editing after account refresh stops remote work', async () => {
    const f = fixture(), store = new SessionDraftStore();
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    try {
      const owner = await store.openOwner(identity);
      await store.saveDraft(owner.owner, { draftId: owner.editable!.draftId, expectedStoreVersion: owner.editable!.storeVersion, text: 'Retained image draft', items: [{ draftImageId: 'original', imageId: 'wire-image', byteRevision: '1', label: 'missing.png', blobId: null, validation: 'bytes_missing', error: 'bytes_missing', uploadId: null }], rejectedCandidates: [{ candidateId: 'rejected', label: 'unsupported.svg', reason: 'image_type_unsupported' }], overflowRejectedCount: 0 });
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      const projected: string[] = []; f.client.subscribe(() => projected.push(f.client.snapshot().draft.text));
      f.client.suspendForAccountRefresh(); await f.client.imageDrafts.sync();
      expect(f.client.imageDrafts.getSnapshot()).toMatchObject({ active: true, text: 'Retained image draft', readOnly: false, canSend: false, items: [{ draftImageId: 'original' }], rejectedCandidates: [{ id: 'rejected' }] });
      expect(projected).not.toContain('');
      f.client.setDraft('Edited while waiting for refresh'); await f.client.imageDrafts.flush();
      expect(f.client.snapshot().draft.text).toBe('Edited while waiting for refresh');
      const saved = await store.readExisting(identity);
      expect(saved?.editable).toMatchObject({ text: 'Edited while waiting for refresh', items: [{ draftImageId: 'original' }], rejectedCandidates: [{ candidateId: 'rejected' }] });
      expect(f.api.command).not.toHaveBeenCalled(); expect(f.api.operation).not.toHaveBeenCalled();
    } finally { f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });

  it.each(['accepted', 'refused'] as const)('aborts a frozen draft dispatch and ignores late %s results after account suspension', async result => {
    const f = fixture(), store = new SessionDraftStore(), pending = Promise.withResolvers<SessionOperation>();
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
    let sending: Promise<void> | undefined;
    try {
      await store.importLegacy(identity, { text: 'Send once', revision: 'original', submission: null });
      await ready(f); f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
      f.client.setDraft('Send once'); await f.client.imageDrafts.flush();
      vi.mocked(f.api.command).mockReturnValueOnce(pending.promise);
      sending = f.client.send('Send once');
      await vi.waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
      const [, command, signal] = vi.mocked(f.api.command).mock.lastCall!;
      expect((await store.readExisting(identity))?.submission).toMatchObject({ operationId: command.operationId, state: 'dispatch_claimed' });
      f.client.suspendForAccountRefresh(); expect(signal.aborted).toBe(true);
      const state = f.client.snapshot().state;
      await f.client.imageDrafts.continueEditing();
      f.client.setDraft('Later local input'); await f.client.imageDrafts.flush();
      if (result === 'accepted') pending.resolve({ protocol: command.protocol, ...sessionFence(command), operationId: command.operationId, kind: command.kind, state: 'provider_accepted', providerResult: 'started', error: null });
      else pending.reject(new ApiError('server', 409, 'capability_changed'));
      await sending;
      expect(f.client.snapshot().state).toBe(state);
      expect(f.client.snapshot().draft.text).toBe('Later local input');
      const saved = await store.readExisting(identity);
      expect(saved?.editable?.text).toBe('Later local input');
      expect(saved?.submission).toMatchObject({ operationId: command.operationId, state: result === 'accepted' ? 'dispatch_claimed' : 'local_not_dispatched' });
      expect(f.api.command).toHaveBeenCalledOnce(); expect(f.api.operation).not.toHaveBeenCalled();
    } finally { pending.reject(new Error('Test finished')); await sending?.catch(() => {}); f.client.close(); await f.client.imageDrafts.close(); store.close(); }
  });

  it('aborts an original image receipt read on account suspension and rejects its late acceptance', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('Original input');
    const operationId = crypto.randomUUID(), pending = Promise.withResolvers<SessionOperation>();
    vi.mocked(f.api.operation).mockReturnValueOnce(pending.promise);
    const reading = f.client.observeImageOperation(f.s, operationId).catch(error => error);
    const signal = vi.mocked(f.api.operation).mock.lastCall![2]!;
    f.client.suspendForAccountRefresh(); expect(signal.aborted).toBe(true);
    pending.resolve({ protocol: f.s.protocol, ...sessionFence(f.s), operationId, kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null });
    expect(await reading).toMatchObject({ name: 'AbortError' });
    expect(f.client.snapshot().draft.text).toBe('Original input');
    await expect(f.client.observeImageOperation(f.s, operationId)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.api.operation).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
  });

  it('aborts in-flight work and cannot restart after account refresh suspension', async () => {
    const f = fixture(), resource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'saved.png', status: 'available' as const, mediaType: 'image/png', byteLength: '68', sha256: 'a'.repeat(64), error: null };
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [], resources: [resource], beforeCursor: 'older', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f); f.client.setDraft('retain me');
    let olderResolve!: (page: TimelinePage) => void, resourceResolve!: (value: Blob) => void, commandResolve!: (value: SessionOperation) => void;
    vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(resolve => { olderResolve = resolve; }));
    vi.mocked(f.api.resource).mockImplementationOnce(() => new Promise(resolve => { resourceResolve = resolve; }));
    vi.mocked(f.api.command).mockImplementationOnce(() => new Promise(resolve => { commandResolve = resolve; }));
    const older = f.client.loadOlder(), resourceRead = f.client.resource(resource.resourceId, new AbortController().signal).catch(error => error), sending = f.client.send('retain me').catch(error => error);
    const olderSignal = vi.mocked(f.api.timeline).mock.lastCall![3], resourceSignal = vi.mocked(f.api.resource).mock.lastCall![2], commandSignal = vi.mocked(f.api.command).mock.lastCall![2], command = vi.mocked(f.api.command).mock.lastCall![1];
    const state = f.client.snapshot().state, scope = f.client.imageScope();
    vi.useFakeTimers(); f.client.suspendForAccountRefresh(); f.client.suspendForAccountRefresh();
    expect(olderSignal.aborted && resourceSignal.aborted && commandSignal.aborted).toBe(true);
    expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.client.snapshot().authPaused).toBe(true);
    olderResolve({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [{ kind: 'assistant_message', entryId: 'late', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'late' }] }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    resourceResolve(new Blob(['late']));
    commandResolve({ protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'provider_accepted', providerResult: 'started', error: null });
    await older; expect(await resourceRead).toBeInstanceOf(Error); expect(await sending).toBeInstanceOf(Error);
    expect(f.client.snapshot().state).toBe(state); expect(f.client.imageScope()).toBe(scope); expect(f.client.snapshot().draft.text).toBe('retain me');
    const calls = vi.mocked(f.api.current).mock.calls.length;
    f.client.setCurrentReadVisible(false); f.client.setCurrentReadVisible(true); f.client.syncAvailability(); f.client.pause(); f.client.refresh(); await f.client.start();
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, sessionRevision: '999' }, cursor: 'late' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.api.current).toHaveBeenCalledTimes(calls); expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.client.snapshot().authPaused).toBe(true); expect(f.client.snapshot().state).toBe(state);
  });
});

it('removes a closed task draft when reopening is denied before receiving a snapshot', async () => {
  const storage = window.sessionStorage; storage.clear();
  const old = fixture(storage); await ready(old); old.client.setDraft('revoked private text'); old.client.close();
  const denied = fixture(storage); vi.mocked(denied.api.current).mockRejectedValue(new ApiError('server', 403, 'forbidden'));
  await denied.client.start();
  expect(denied.client.snapshot().draft.text).toBe('');
  expect([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i)!)).join('')).not.toContain('revoked private text');
});

it('never loads another principal draft and preserves editing when browser storage fails', async () => {
  const storage = window.sessionStorage; storage.clear();
  const owner = fixture(storage); await ready(owner); owner.client.setDraft('owner only'); owner.client.close();
  const other = fixture(storage, '00000010-1111-4111-8111-111111111111'); await other.client.start();
  expect(other.client.snapshot().draft.text).toBe('');
  const unavailable = fixture({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); }, length: 0, key: () => null, clear: () => {} });
  await ready(unavailable); unavailable.client.setDraft('in memory'); unavailable.client.pause();
  expect(unavailable.client.snapshot().draft.text).toBe('in memory');
});

it('reconciles a saved draft submission even if its separate receipt storage was lost', async () => {
  const storage = window.sessionStorage; storage.clear();
  const first = fixture(storage); await ready(first); first.client.setDraft('only once');
  vi.mocked(first.api.command).mockRejectedValue(new Error('lost acknowledgement'));
  await expect(first.client.send('only once')).rejects.toThrow();
  const operation = [...first.client.snapshot().state.operations.values()][0]!; first.client.close();
  for (const key of Object.keys(storage)) if (key.startsWith('daynight:session-operations:')) storage.removeItem(key);
  const restored = fixture(storage); vi.mocked(restored.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
  await ready(restored);
  await vi.waitFor(() => expect(restored.client.snapshot().draft.text).toBe(''));
  expect(restored.api.command).not.toHaveBeenCalled();
});

it('retains the loaded offline view until the same execution can load its new local history', async () => {
  const f = fixture(); await ready(f);
  const entry = { kind: 'reasoning' as const, entryId: 'local-entry', entrySeq: '1', revision: '1', text: 'Visible before relay restart' };
  f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, ...sessionBinding(f.s), sessionId: f.s.sessionId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: entry } });
  const reconnected = { ...f.s, historyEpoch: 'new-local-view', connectionEpoch: '2', connectionState: 'disconnected' as const, synchronized: false };
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: reconnected });
  vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
  await f.client.start();
  f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: reconnected, cursor: 'new-zero' });
  expect(f.client.snapshot().status).toBe('ready');
  expect(f.api.timeline).toHaveBeenCalledOnce();
  expect(f.client.snapshot().connected).toBe(false);
  expect(f.client.snapshot().state.entries).toEqual([entry]);
  await expect(f.client.send('cannot send offline')).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
});


describe('page-local operation progress', () => {
  it.each(['execute_command', 'update_setting', 'interaction_response'] as const)('tracks %s until its own acceptance contract completes', async kind => {
    const f = fixture();
    const interaction = { interactionId: 'approval', revision: '1', state: 'pending' as const, title: 'Run', kind: 'approval' as const, detail: 'Run tool', actions: ['allow_once' as const] };
    Object.assign(f.s, { controls: { revision: '1', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
    Object.assign(f.s, { operations: { ...f.s.operations, canRespond: true } });
    const page = await f.api.timeline(f.s.sessionId, 'tail', null, new AbortController().signal);
    vi.mocked(f.api.timeline).mockResolvedValue({ ...page, items: [{ entryId: 'approval', entrySeq: '1', revision: '1', kind: 'interaction', interaction }] });
    await ready(f); vi.useFakeTimers();
    let receipt!: SessionOperation;
    vi.mocked(f.api.command).mockImplementation(async (_id, c) => receipt = { protocol: c.protocol, ...sessionBinding(c), sessionId: c.sessionId, executionGeneration: c.executionGeneration, operationId: c.operationId, kind: c.kind, state: 'accepted', providerResult: null, error: null });
    vi.mocked(f.api.operation).mockImplementation(async () => receipt);
    const work = kind === 'execute_command' ? f.client.executeCommand('compact', '', '1') : kind === 'update_setting' ? f.client.updateSetting('model', 'b', '1') : f.client.respond(interaction, { kind: 'approval', action: 'allow_once' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.snapshot().operationProgress.get(receipt.operationId)).toBe('sending');
    receipt = { ...receipt, state: 'provider_accepted', providerResult: 'handled' };
    await vi.advanceTimersByTimeAsync(750);
    if (kind === 'execute_command') expect(f.client.snapshot().operationProgress.size).toBe(0);
    else {
      expect(f.client.snapshot().operationProgress.get(receipt.operationId)).toBe('sending');
      await vi.advanceTimersByTimeAsync(9250);
      expect(f.client.snapshot().operationProgress.get(receipt.operationId)).toBe('waiting');
      receipt = { ...receipt, state: 'confirmed' };
      await vi.advanceTimersByTimeAsync(750);
      expect(f.client.snapshot().operationProgress.size).toBe(0);
    }
    await work;
    expect(f.api.command).toHaveBeenCalledOnce();
  });

  it('times an unanswered POST without changing the ledger, draft, or sending again', async () => {
    const f = fixture(); await ready(f); vi.useFakeTimers();
    f.client.setDraft('keep this');
    vi.mocked(f.api.command).mockImplementation(() => new Promise(() => {}));
    void f.client.send('keep this');
    const id = vi.mocked(f.api.command).mock.calls[0]![1].operationId;
    expect(f.client.snapshot().operationProgress.get(id)).toBe('sending');
    expect(f.client.snapshot().state.operations.get(id)?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.client.snapshot().operationProgress.get(id)).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.client.snapshot().operationProgress.get(id)).toBe('waiting');
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.client.snapshot().operationProgress.has(id)).toBe(false);
    expect(f.client.snapshot().draft.text).toBe('keep this');
    await expect(f.client.send('keep this')).rejects.toThrow();
    expect(f.api.command).toHaveBeenCalledOnce();
  });

  it.each(['disconnect', 'refresh', 'pause'] as const)('does not revive progress after %s or a late relay receipt', async action => {
    const f = fixture(); await ready(f); vi.useFakeTimers();
    let reply!: (operation: SessionOperation) => void;
    vi.mocked(f.api.command).mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    void f.client.send('hello').catch(() => {});
    const command = vi.mocked(f.api.command).mock.calls[0]![1];
    expect(f.client.snapshot().operationProgress.has(command.operationId)).toBe(true);
    if (action === 'disconnect') f.disconnect(); else f.client[action]();
    expect(f.client.snapshot().operationProgress.size).toBe(0);
    reply({ protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'accepted', providerResult: null, error: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.client.snapshot().operationProgress.size).toBe(0);
    expect(f.api.command).toHaveBeenCalledOnce();
  });

  it('ends progress on a real unknown receipt and never restores it from storage', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage); await ready(f);
    vi.mocked(f.api.command).mockImplementation(async (_id, c) => ({ protocol: c.protocol, ...sessionBinding(c), sessionId: c.sessionId, executionGeneration: c.executionGeneration, operationId: c.operationId, kind: c.kind, state: 'unknown', providerResult: null, error: null }));
    await expect(f.client.send('hello')).rejects.toThrow('unknown');
    expect(f.client.snapshot().operationProgress.size).toBe(0);
    f.client.close();
    const restored = fixture(storage); await ready(restored);
    expect(restored.client.snapshot().state.operations.size).toBe(1);
    expect(restored.client.snapshot().operationProgress.size).toBe(0);
    expect(restored.api.command).not.toHaveBeenCalled();
  });

  it('clears progress on streamed acceptance even before the POST returns', async () => {
    const f = fixture(); await ready(f);
    let reject!: (error: Error) => void;
    vi.mocked(f.api.command).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const sending = f.client.send('hello').catch(() => {});
    const c = vi.mocked(f.api.command).mock.calls[0]![1];
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'operation', payload: { protocol: c.protocol, ...sessionBinding(c), sessionId: c.sessionId, executionGeneration: c.executionGeneration, operationId: c.operationId, kind: c.kind, state: 'provider_accepted', providerResult: 'started', error: null } } });
    expect(f.client.snapshot().operationProgress.size).toBe(0);
    reject(new Error('late lost response')); await sending;
    expect(f.client.snapshot().state.operations.get(c.operationId)?.state).toBe('provider_accepted');
    expect(f.client.snapshot().operationProgress.size).toBe(0);
  });
});
