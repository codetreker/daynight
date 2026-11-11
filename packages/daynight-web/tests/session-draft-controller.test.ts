import { File } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type ImageCapabilities, type ImageTarget, type ImageUploadReceipt, type ImageUploadSpec, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import type { SessionResourceClient } from '../../daynight/src/session/resource-client';
import { ApiError } from '../src/api/client';
import { imageCommandNotDispatched } from '../src/features/task-agent-session/operation-error';
import { DraftStoreError, SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import { ImageDraftController, type ImageDraftContext } from '../src/features/task-agent-session/drafts/image-draft-controller';
import { SessionImageStore, type LocalImageAssetAdapter } from '../src/features/task-agent-session/images/image-store';
import { sessionImageBytes } from './helpers/sessionImages';

const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: '00000001-1111-4111-8111-111111111111', fence: { sessionId: '00000002-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1' }, expectedNativeSessionId: null };
const capability: ImageCapabilities = { revision: '2', providerRevision: '1', expectedNativeSessionId: null, modelId: 'vision', controlsRevision: '1', send: 'supported', steer: 'unsupported', reasonCode: null, inputMediaTypes: ['image/png'], maxImageBytes: '10485760', maxMessageImageBytes: '20971520', maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 256 } };
const identity = { target, resolver: { kind: 'task' as const, projectId: 'p', taskId: 't' } };
const file = (name = 'a.png', type = 'image/png') => new File(['image'], name, { type }) as unknown as globalThis.File;
const locks = (): LockManager => {
  const held = new Set<string>();
  return { request: async (name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) => { if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name, mode: 'exclusive' }); } finally { held.delete(name); } } } as LockManager;
};
const active: ImageDraftController[] = [], stores: SessionDraftStore[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(controller => controller.close())); stores.splice(0).forEach(store => store.close()); });
function fixture(lockManager: LockManager | null = locks()) {
  const store = new SessionDraftStore(); stores.push(store);
  const uploads = new Map<string, ImageUploadReceipt>(), mutations: string[] = [], commands: SessionCommand[] = [];
  const receipt = (spec: ImageUploadSpec): ImageUploadReceipt => ({ uploadId: spec.uploadId, imageId: spec.imageId, target: spec.target, state: 'receiving', acceptedOffset: '0', spec: { name: spec.name, mediaType: spec.mediaType, byteLength: spec.byteLength, sha256: spec.sha256 }, resource: null, expiresAt: '2026-11-12T00:00:00Z', error: null });
  const resources = {
    capabilities: vi.fn(async () => ({ contentRevision: 2, capabilities: capability, budget: { revision: '1', maxBytes: '1073741824', committedBytes: '0', reservedBytes: '0', maxResources: 1000, committedResources: 0, reservedResources: 0 } })),
    prepareUpload: vi.fn(async (spec: ImageUploadSpec) => { const saved = await store.readExisting(identity); expect(saved?.uploads.find(upload => upload.uploadId === spec.uploadId)?.pendingAction?.kind).toBe('prepare'); mutations.push('prepare'); const r = receipt(spec); uploads.set(spec.uploadId, r); return r; }),
    writeUploadChunk: vi.fn(async (id: string, offset: string, bytes: Uint8Array) => { mutations.push('chunk'); const r = { ...uploads.get(id)!, acceptedOffset: String(Number(offset) + bytes.length) }; uploads.set(id, r); return r; }),
    completeUpload: vi.fn(async (id: string) => { mutations.push('complete'); const before = uploads.get(id)!; const r: ImageUploadReceipt = { ...before, state: 'complete', resource: { resourceId: crypto.randomUUID(), revision: '1', name: before.spec.name, status: 'available', mediaType: before.spec.mediaType, byteLength: before.spec.byteLength, sha256: before.spec.sha256, width: 1, height: 1, frameCount: 1, error: null } }; uploads.set(id, r); return r; }),
    getUpload: vi.fn(async (id: string) => { const r = uploads.get(id); if (!r) throw new Error('HTTP 404'); return r; }),
    releaseUpload: vi.fn(async (id: string) => { const r: ImageUploadReceipt = { ...uploads.get(id)!, state: 'released', resource: null }; uploads.set(id, r); return r; }),
  } as unknown as SessionResourceClient;
  let context: ImageDraftContext | null = { identity, target, resources, capabilities: capability, active: true, canEdit: true, canSend: true, mode: 'send', expectedTurnId: null, authorizationGeneration: '1' };
  const operation = (command: SessionCommand, state: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...target.fence, operationId: command.operationId, kind: command.kind, state, providerResult: null, error: null });
  const dispatch = vi.fn(async (command: SessionCommand) => { commands.push(command); const persisted = await store.readExisting(identity); expect(persisted?.submission?.state).toBe('dispatch_claimed'); return operation(command, 'accepted'); });
  const query = vi.fn(async (_fence: unknown, id: string) => operation(commands.find(command => command.operationId === id)!, 'accepted'));
  const createAsset = (_blob: Blob, id: string) => ({ key: id, resource: null, release() {}, validate: async () => { if (_blob.type === 'image/bad') throw new Error('invalid image'); return { byteLength: _blob.size, mediaType: 'image/png' as const, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await _blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join(''), width: 1, height: 1, frameCount: 1 }; } }) as unknown as LocalImageAssetAdapter;
  const create = (overrides: Partial<ConstructorParameters<typeof ImageDraftController>[0]> = {}) => { const controller = new ImageDraftController({ store, locks: lockManager, getContext: () => context, dispatch, query, createAsset, ...overrides }); active.push(controller); return controller; };
  return { store, create, resources, uploads, mutations, commands, dispatch, query, context: () => context!, setContext: (next: ImageDraftContext | null) => { context = next; }, operation };
}

describe('durable Session image coordination', () => {
  it('explicitly moves a detached old-native draft into an empty current owner with fresh image identities', async () => {
    const f = fixture(null), controller = f.create(); await controller.addFiles([file()], 'old native text'); const original = (await f.store.readExisting(identity))!;
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }, nextIdentity = { ...identity, target: nativeTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nativeTarget }); await controller.sync();
    expect(controller.getSnapshot().text).toBe('');
    const detached = controller.getSnapshot().detachedDrafts[0]!; expect(detached).toMatchObject({ draft: { text: 'old native text' }, canRestore: true, disabledReason: null });
    await controller.restoreDetached(detached.ref);
    const next = (await f.store.readExisting(nextIdentity))!;
    expect(controller.getSnapshot()).toMatchObject({ text: 'old native text', detachedDrafts: [] });
    expect(next.editable?.draftId).not.toBe(original.editable?.draftId);
    const item = next.editable!.items[0]!, old = original.editable!.items[0]!;
    expect(item).toMatchObject({ validation: 'valid', uploadId: null }); expect(item.imageId).not.toBe(old.imageId); expect(item.blobId).not.toBe(old.blobId);
    expect(await (await f.store.readBlob(next.owner, item.blobId!))!.blob.text()).toBe('image');
    expect((await f.store.readExisting(identity))?.editable?.text).toBe(''); expect(f.commands).toHaveLength(0);
  });
  it('rejects a detached confirmation after the empty target is edited and cleared again', async () => {
    const f = fixture(null), controller = f.create(); await f.store.importLegacy(identity, { text: 'old text', revision: '1', submission: null }); await controller.sync();
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }; f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget }); await controller.sync();
    const ref = controller.getSnapshot().detachedDrafts[0]!.ref;
    controller.setText('temporary edit'); await controller.flush(); controller.setText(''); await controller.flush();
    await expect(controller.restoreDetached(ref)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('old text'); expect(controller.getSnapshot().text).toBe('');
  });
  it('retains a new local edit as a conflict while a confirmed detached move finishes', async () => {
    const f = fixture(null), controller = f.create(); await f.store.importLegacy(identity, { text: 'old text', revision: '1', submission: null }); await controller.sync();
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }, nextIdentity = { ...identity, target: nativeTarget }; f.setContext({ ...f.context(), identity: nextIdentity, target: nativeTarget }); await controller.sync();
    const ref = controller.getSnapshot().detachedDrafts[0]!.ref, restore = f.store.restoreDetachedDraft.bind(f.store);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.store, 'restoreDetachedDraft').mockImplementationOnce(async (...args) => { const result = await restore(...args); entered(); await waiting; return result; });
    const moving = controller.restoreDetached(ref); await started; controller.setText('new local text'); release(); await moving;
    expect(controller.getSnapshot()).toMatchObject({ text: 'new local text', conflict: true, error: 'image_draft_conflict' });
    await expect(controller.flush()).rejects.toThrow('image_draft_conflict');
    expect((await f.store.readExisting(nextIdentity))?.editable?.text).toBe('old text');
    await controller.resolveConflict('saved'); expect(controller.getSnapshot().text).toBe('old text');
  });
  it.each(['accepted', 'provider_accepted', 'rejected'] as const)('does not rebase unsaved successor content onto another window during %s observation', async state => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'original message', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing();
    controller.setText('unsaved in this window');
    const other = new SessionDraftStore(); stores.push(other);
    const before = (await other.readExisting(identity))!;
    await other.saveDraft(before.owner, { draftId: before.editable!.draftId, expectedStoreVersion: before.editable!.storeVersion, text: 'saved in another window', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    f.query.mockResolvedValue(f.operation(f.commands[0]!, state));
    await controller.checkStatus();
    expect(controller.getSnapshot()).toMatchObject({ text: 'unsaved in this window', conflict: true, error: 'image_draft_conflict' });
    await expect(controller.flush()).rejects.toThrow('image_draft_conflict');
    expect((await other.readExisting(identity))?.editable?.text).toBe('saved in another window');
  });
  it.each(['current', 'failed'] as const)('resolves an old native failure using its own %s draft without changing the new owner', async choice => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'old frozen message', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing();
    controller.setText('old successor message'); await controller.flush();
    const operationId = f.commands[0]!.operationId;
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected'));
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
    const nativeIdentity = { ...identity, target: nativeTarget };
    f.setContext({ ...f.context(), identity: nativeIdentity, target: nativeTarget }); await controller.sync();
    controller.setText('new owner message'); await controller.flush();
    const recovery = controller.getSnapshot().recoveries?.find(entry => entry.ref.operationId === operationId);
    expect(recovery).toMatchObject({ currentOwner: false, currentExecution: true, state: 'rejected', canResolveFailure: true, frozen: { text: 'old frozen message' }, successor: { text: 'old successor message' } });
    await controller.resolveFailure(recovery!.ref, choice);
    expect(controller.getSnapshot()).toMatchObject({ text: 'new owner message', submission: null, executionBlocked: false, canSend: true });
    const original = await f.store.readExisting(identity);
    expect(original?.editable?.text).toBe(choice === 'current' ? 'old successor message' : 'old frozen message');
    expect(original?.submission).toBeNull();
    expect((await f.store.readExisting(nativeIdentity))?.editable?.text).toBe('new owner message');
    expect(f.commands).toHaveLength(1);
  });
  it('requires a new failure choice when another window changes the displayed successor', async () => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'frozen message', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing();
    controller.setText('seen successor'); await controller.flush();
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected')); await controller.checkStatus();
    const recovery = controller.getSnapshot().recoveries?.[0]; expect(recovery?.canResolveFailure).toBe(true);
    const other = new SessionDraftStore(); stores.push(other); const before = (await other.readExisting(identity))!;
    await other.saveDraft(before.owner, { draftId: before.editable!.draftId, expectedStoreVersion: before.editable!.storeVersion, text: 'unseen successor edit', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    await expect(controller.resolveFailure(recovery!.ref, 'failed')).rejects.toMatchObject({ code: 'conflict' });
    const after = await other.readExisting(identity);
    expect(after?.editable?.text).toBe('unseen successor edit'); expect(after?.frozen?.text).toBe('frozen message'); expect(after?.executionBlocked).toBe(true);
  });
  it('recovers a prior generation operation using its original fence without blocking or importing into the current draft', async () => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'generation one message', revision: '1', submission: null });
    await controller.sync(); await controller.send();
    const originalCommand = f.commands[0]!;
    const nextTarget = { ...target, fence: { ...target.fence, executionGeneration: '2' } };
    const nextIdentity = { ...identity, target: nextTarget };
    await f.store.importLegacy(nextIdentity, { text: 'generation two draft', revision: '1', submission: null });
    f.query.mockClear(); f.query.mockResolvedValue(f.operation(originalCommand, 'accepted'));
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget }); await controller.sync();
    expect(f.query).toHaveBeenCalledWith(target.fence, originalCommand.operationId, expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({ text: 'generation two draft', submission: null, executionBlocked: false, canSend: true });
    const recovery = controller.getSnapshot().recoveries?.find(entry => entry.ref.operationId === originalCommand.operationId);
    expect(recovery).toMatchObject({ currentOwner: false, currentExecution: false, canCheck: true, frozen: { text: 'generation one message' } });
    f.query.mockResolvedValue(f.operation(originalCommand, 'provider_accepted')); await controller.checkStatus(recovery!.ref);
    expect((await f.store.readExisting(identity))?.submission).toBeNull();
    expect(controller.getSnapshot().text).toBe('generation two draft'); expect(controller.getSnapshot().recoveries).toEqual([]); expect(f.commands).toHaveLength(1);
  });
  it.each(['access', 'generation'] as const)('does not settle an old-generation query after the current %s admission changes', async change => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'original pending', revision: '1', submission: null });
    await controller.sync(); await controller.send();
    const nextTarget = { ...target, fence: { ...target.fence, executionGeneration: '2' } }, nextIdentity = { ...identity, target: nextTarget };
    await f.store.importLegacy(nextIdentity, { text: 'current private draft', revision: '1', submission: null });
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<SessionOperation>();
    f.query.mockImplementationOnce(async () => { entered.resolve(); return held.promise; });
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    const restoring = controller.sync(); await entered.promise;
    if (change === 'access') f.setContext({ ...f.context(), canEdit: false });
    else {
      const newerTarget = { ...nextTarget, fence: { ...nextTarget.fence, executionGeneration: '3' } };
      f.setContext({ ...f.context(), identity: { ...identity, target: newerTarget }, target: newerTarget, active: false });
    }
    const changed = controller.sync();
    held.resolve(f.operation(f.commands[0]!, 'provider_accepted')); await Promise.all([restoring, changed]);
    expect((await f.store.readExisting(identity))?.submission?.operationId).toBe(f.commands[0]!.operationId);
    expect(controller.getSnapshot().recoveries.every(entry => !entry.canCheck && !entry.canResolveFailure && !entry.canCancelPrepared)).toBe(true);
    expect(f.commands).toHaveLength(1);
  });
  it('rejects a displayed recovery after the authenticated actor changes', async () => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'original failed', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing(); controller.setText('original successor'); await controller.flush();
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected')); await controller.checkStatus(); const ref = controller.getSnapshot().recoveries[0]!.ref;
    const otherTarget = { ...target, actorUserId: '00000009-1111-4111-8111-111111111111' };
    f.setContext({ ...f.context(), identity: { ...identity, target: otherTarget }, target: otherTarget }); await controller.sync();
    await expect(controller.resolveFailure(ref, 'failed')).rejects.toMatchObject({ code: 'conflict' });
    const original = await f.store.readExisting(identity); expect(original?.editable?.text).toBe('original successor'); expect(original?.frozen?.text).toBe('original failed');
    expect(controller.getSnapshot().recoveries).toEqual([]); expect(controller.getSnapshot().text).toBe('');
  });
  it('keeps recovery content visible while same-owner permission verification disables its actions', async () => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'failed summary', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing(); controller.setText('successor summary'); await controller.flush();
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected')); await controller.checkStatus(); const before = controller.getSnapshot().recoveries[0]!;
    f.setContext({ ...f.context(), canEdit: false }); await controller.sync();
    expect(controller.getSnapshot().recoveries).toEqual([{ ...before, canCheck: false, canCancelPrepared: false, canResolveFailure: false }]);
    f.setContext({ ...f.context(), canEdit: true }); await controller.sync();
    expect(controller.getSnapshot().recoveries[0]?.canResolveFailure).toBe(true);
    await controller.revoke(); expect(controller.getSnapshot().recoveries).toEqual([]);
  });
  it('shows an old-owner recovery write failure without marking the current draft conflicted', async () => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'old failed', revision: '1', submission: null });
    await controller.sync(); await controller.send(); await controller.continueEditing(); controller.setText('old successor'); await controller.flush();
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected'));
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
    f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget }); await controller.sync();
    controller.setText('current owner'); await controller.flush(); const ref = controller.getSnapshot().recoveries[0]!.ref;
    vi.spyOn(f.store, 'resolveFailure').mockRejectedValueOnce(new DraftStoreError('quota', 'Storage is full.'));
    await expect(controller.resolveFailure(ref, 'failed')).rejects.toMatchObject({ code: 'quota' });
    expect(controller.getSnapshot().recoveries[0]?.error).toBe('image_draft_quota');
    expect(controller.getSnapshot()).toMatchObject({ text: 'current owner', error: null, conflict: false, executionBlocked: true });
    await controller.resolveFailure(controller.getSnapshot().recoveries[0]!.ref, 'current');
    expect(controller.getSnapshot().recoveries).toEqual([]); expect(controller.getSnapshot().text).toBe('current owner');
  });
  it.each([
    ['failure', 'access'], ['failure', 'authorization'], ['failure', 'owner'],
    ['prepared', 'access'], ['prepared', 'authorization'], ['prepared', 'owner'],
  ] as const)('does not perform a %s recovery when %s changes after its asynchronous read', async (action, change) => {
    const f = fixture(null), controller = f.create();
    await f.store.importLegacy(identity, { text: 'original frozen', revision: '1', submission: null }); await controller.sync();
    if (action === 'prepared') vi.spyOn(f.store, 'claimDispatch').mockRejectedValueOnce(new Error('ended before claim'));
    await controller.send();
    if (action === 'failure') {
      await controller.continueEditing(); controller.setText('later edit'); await controller.flush();
      f.query.mockResolvedValue(f.operation(f.commands[0]!, 'rejected')); await controller.checkStatus();
    } else {
      const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
      f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget }); await controller.sync();
    }
    const ref = controller.getSnapshot().recoveries[0]!.ref, before = await f.store.readExisting(identity);
    const resolve = vi.spyOn(f.store, 'resolveFailure'), cancel = vi.spyOn(f.store, 'refusePrepared');
    const read = f.store.readRecoverableSubmissions.bind(f.store), admitted = f.context();
    vi.spyOn(f.store, 'readRecoverableSubmissions').mockImplementationOnce(async (...args) => {
      const entries = await read(...args);
      queueMicrotask(() => queueMicrotask(() => {
        if (change === 'access') f.setContext({ ...admitted, canEdit: false });
        else if (change === 'authorization') f.setContext({ ...admitted, authorizationGeneration: '2' });
        else {
          const otherTarget = { ...admitted.target, expectedNativeSessionId: 'another-native' };
          f.setContext({ ...admitted, identity: { ...identity, target: otherTarget }, target: otherTarget });
        }
      }));
      return entries;
    });
    await (action === 'failure' ? controller.resolveFailure(ref, 'failed') : controller.cancelPrepared(ref)).catch(() => {});
    expect(resolve).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    const after = await f.store.readExisting(identity);
    expect(after?.submission?.operationId).toBe(before?.submission?.operationId);
    expect(after?.editable).toEqual(before?.editable); expect(after?.frozen).toEqual(before?.frozen);
  });
  it('allocates each upload once when concurrent selections resume the same validation', async () => {
    const f = fixture(), controller = f.create(), first = file('first.png');
    const held = Promise.withResolvers<ArrayBuffer>(), entered = Promise.withResolvers<void>();
    const original = await first.arrayBuffer();
    vi.spyOn(first, 'arrayBuffer').mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const createUpload = vi.spyOn(f.store, 'createUpload');
    const firstSelection = controller.addFiles([first], 'ordered selection'); await entered.promise;
    const secondSelection = controller.addFiles([file('second.png')], 'ordered selection');
    held.resolve(original); await Promise.all([firstSelection, secondSelection]);
    expect(controller.getSnapshot().items.map(item => item.label)).toEqual(['first.png', 'second.png']);
    expect(controller.getSnapshot()).toMatchObject({ error: null, conflict: false, canSend: true });
    const saved = await f.store.readExisting(identity);
    expect(saved?.uploads).toHaveLength(2); expect(createUpload).toHaveBeenCalledTimes(2);
    expect(new Set(saved?.editable?.items.map(item => item.uploadId)).size).toBe(2);
    expect(f.resources.prepareUpload).toHaveBeenCalledTimes(2); expect(f.commands).toEqual([]);
  });
  it.each([1, 2])('resumes %i image uploads after text is saved during allocation', async count => {
    const f = fixture(), controller = f.create(), committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createUpload = f.store.createUpload.bind(f.store);
    vi.spyOn(f.store, 'createUpload').mockImplementationOnce(async (...args) => { const upload = await createUpload(...args); committed.resolve(); await release.promise; return upload; });
    const adding = controller.addFiles(Array.from({ length: count }, (_, index) => file(`${index + 1}.png`)), 'before allocation'); await committed.promise;
    controller.setText('edited while allocating'); const saved = controller.flush();
    release.resolve(); await Promise.allSettled([adding, saved]);
    expect(controller.getSnapshot()).toMatchObject({ error: null, conflict: false, text: 'edited while allocating', saving: false });
    await vi.waitFor(() => expect(controller.getSnapshot().canSend).toBe(true));
    const persisted = await f.store.readExisting(identity);
    expect(persisted?.editable?.text).toBe('edited while allocating');
    expect(persisted?.uploads).toHaveLength(count);
    expect(persisted?.editable?.items.every(item => persisted.uploads.some(upload => upload.uploadId === item.uploadId && upload.receipt?.state === 'complete'))).toBe(true);
    expect(f.resources.prepareUpload).toHaveBeenCalledTimes(count); expect(f.resources.completeUpload).toHaveBeenCalledTimes(count);
    expect(f.commands).toEqual([]);
  });
  it('saves text while the upload network request is still held', async () => {
    const f = fixture(), controller = f.create(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const prepare = vi.mocked(f.resources.prepareUpload).getMockImplementation()!;
    vi.mocked(f.resources.prepareUpload).mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return prepare(...args); });
    const adding = controller.addFiles([file()], 'before network'); await entered.promise;
    try {
      controller.setText('saved while network held'); let flushed = false;
      const saving = controller.flush().then(() => { flushed = true; });
      await vi.waitFor(() => expect(flushed).toBe(true)); await saving;
      expect((await f.store.readExisting(identity))?.editable?.text).toBe('saved while network held');
      expect(f.resources.completeUpload).not.toHaveBeenCalled();
    } finally { release.resolve(); await adding; }
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ canSend: true, conflict: false, error: null }));
    expect(f.resources.prepareUpload).toHaveBeenCalledOnce(); expect(f.resources.completeUpload).toHaveBeenCalledOnce();
    expect(f.commands).toEqual([]);
  });
  it('orders earlier upload readback after a later allocation and its queued text save', async () => {
    const f = fixture(), controller = f.create();
    const firstNetwork = Promise.withResolvers<void>(), releaseNetwork = Promise.withResolvers<void>();
    const allocated = Promise.withResolvers<void>(), releaseAllocation = Promise.withResolvers<void>(), receiptCommitted = Promise.withResolvers<void>();
    const prepare = vi.mocked(f.resources.prepareUpload).getMockImplementation()!;
    vi.mocked(f.resources.prepareUpload).mockImplementationOnce(async (...args) => { firstNetwork.resolve(); await releaseNetwork.promise; return prepare(...args); });
    const observeUpload = f.store.observeUpload.bind(f.store);
    vi.spyOn(f.store, 'observeUpload').mockImplementationOnce(async (...args) => { const upload = await observeUpload(...args); receiptCommitted.resolve(); return upload; });
    let sawConflict = false; const unsubscribe = controller.subscribe(() => { sawConflict ||= controller.getSnapshot().conflict; });
    const first = controller.addFiles([file('first.png')], 'before network'); await firstNetwork.promise;
    const createUpload = f.store.createUpload.bind(f.store);
    vi.spyOn(f.store, 'createUpload').mockImplementationOnce(async (...args) => { const upload = await createUpload(...args); allocated.resolve(); await releaseAllocation.promise; return upload; });
    const second = controller.addFiles([file('second.png')], 'before network'); await allocated.promise;
    controller.setText('edited across network readback'); const saving = controller.flush();
    try { releaseNetwork.resolve(); await receiptCommitted.promise; }
    finally { releaseAllocation.resolve(); await Promise.allSettled([first, second, saving]); unsubscribe(); }
    expect(sawConflict).toBe(false);
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ canSend: true, conflict: false, error: null }));
    const stored = await f.store.readExisting(identity);
    expect(stored?.editable?.text).toBe('edited across network readback');
    expect(stored?.editable?.items.map(item => item.label)).toEqual(['first.png', 'second.png']);
    expect(f.resources.prepareUpload).toHaveBeenCalledTimes(2); expect(f.resources.completeUpload).toHaveBeenCalledTimes(2);
    expect(f.commands).toEqual([]);
  });
  it('does not adopt an old upload allocation while another native owner queues its first save', async () => {
    const f = fixture(null), controller = f.create({ locks: locks() }), committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createUpload = f.store.createUpload.bind(f.store);
    vi.spyOn(f.store, 'createUpload').mockImplementationOnce(async (...args) => { const upload = await createUpload(...args); committed.resolve(); await release.promise; return upload; });
    const oldSelection = controller.addFiles([file('old.png')], 'old owner'); await committed.promise;
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }, nextIdentity = { ...identity, target: nextTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget, capabilities: { ...capability, expectedNativeSessionId: 'native-next' }, active: false });
    await controller.sync();
    const admittedWrite = Promise.withResolvers<void>();
    const unsubscribe = controller.subscribe(() => { const draft = controller.getSnapshot(); if (draft.draftId && draft.saving && draft.text === 'new owner' && draft.items.some(item => item.label === 'new.png')) admittedWrite.resolve(); });
    controller.setText('new owner');
    const newSelection = controller.addFiles([file('new.png')], 'new owner');
    await admittedWrite.promise; unsubscribe();
    release.resolve(); await Promise.all([oldSelection, newSelection]);
    expect(controller.getSnapshot()).toMatchObject({ text: 'new owner', error: null, conflict: false });
    expect(controller.getSnapshot().items.map(item => item.label)).toEqual(['new.png']);
    const next = await f.store.readExisting(nextIdentity);
    expect(next?.editable?.text).toBe('new owner'); expect(next?.uploads).toEqual([]);
    expect((await f.store.readExisting(identity))?.uploads).toHaveLength(1);
    expect(f.mutations).toEqual([]);
  });
  it('drains an upload allocation on close without publishing or starting its network work', async () => {
    const f = fixture(), controller = f.create(), committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createUpload = f.store.createUpload.bind(f.store);
    vi.spyOn(f.store, 'createUpload').mockImplementationOnce(async (...args) => { const upload = await createUpload(...args); committed.resolve(); await release.promise; return upload; });
    const adding = controller.addFiles([file()], 'closing draft'); await committed.promise;
    const published = controller.getSnapshot(); let closed = false;
    const closing = controller.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await Promise.all([adding, closing]);
    expect(controller.getSnapshot()).toBe(published); expect(f.mutations).toEqual([]);
    const saved = await f.store.readExisting(identity);
    expect(saved?.editable?.text).toBe('closing draft'); expect(saved?.uploads).toHaveLength(1);
    expect(saved?.uploads[0]?.receipt).toBeNull();
  });
  it('discards an old execution original read before changing the current submission state', async () => {
    const f = fixture(null), first = await f.store.openOwner(identity);
    const saved = await f.store.saveDraft(first.owner, { draftId: first.editable!.draftId, expectedStoreVersion: first.editable!.storeVersion, text: 'Old frozen text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: 'Old frozen text' }], expectedTurnId: null } };
    await f.store.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command });
    const currentTarget = { ...target, expectedNativeSessionId: 'native-current' }, currentIdentity = { ...identity, target: currentTarget };
    await f.store.openOwner(currentIdentity);
    f.setContext({ ...f.context(), identity: currentIdentity, target: currentTarget, capabilities: { ...capability, expectedNativeSessionId: 'native-current' } });
    const controller = f.create(), held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const read = f.store.readRecoverableSubmissions.bind(f.store);
    vi.spyOn(f.store, 'readRecoverableSubmissions').mockImplementationOnce(async (...args) => { const originals = await read(...args); entered.resolve(); await held.promise; return originals; });
    const restoring = controller.sync(); await entered.promise;
    const nextTarget = { ...currentTarget, fence: { ...currentTarget.fence, executionGeneration: '2' } }, nextIdentity = { ...identity, target: nextTarget };
    await f.store.openOwner(nextIdentity); f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    await controller.sync(); expect(controller.getSnapshot().submission).toBeNull();
    held.resolve(); await restoring; controller.setText('New execution text');
    expect(controller.getSnapshot().submission).toBeNull();
    await controller.flush(); expect(controller.getSnapshot().canSend).toBe(true); expect(f.commands).toEqual([]);
  });
  it('does not attach a pending selection to another native owner restored during activation', async () => {
    const f = fixture(null), controller = f.create(); await controller.sync();
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const open = f.store.openOwner.bind(f.store);
    vi.spyOn(f.store, 'openOwner').mockImplementationOnce(async (...args) => { const saved = await open(...args); entered.resolve(); await held.promise; return saved; });
    const adding = controller.addFiles([file('original-target.png')], 'Original target text'); await entered.promise;
    const nextTarget = { ...target, expectedNativeSessionId: 'native-new' }, nextIdentity = { ...identity, target: nextTarget };
    const next = await open(nextIdentity);
    await f.store.saveDraft(next.owner, { draftId: next.editable!.draftId, expectedStoreVersion: next.editable!.storeVersion, text: 'New target text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget, capabilities: { ...capability, expectedNativeSessionId: 'native-new' } });
    await controller.sync(); expect(controller.getSnapshot().text).toBe('New target text');
    held.resolve(); await adding;
    expect(controller.getSnapshot().items).toHaveLength(0);
    expect((await f.store.readExisting(nextIdentity))?.editable?.items).toHaveLength(0);
    expect(f.mutations).toEqual([]);
  });
  it.each(['authorization generation', 'temporary context loss'])('restarts unfinished restoration after %s without losing its submission barrier', async change => {
    const f = fixture(null), first = await f.store.openOwner(identity);
    const saved = await f.store.saveDraft(first.owner, { draftId: first.editable!.draftId, expectedStoreVersion: first.editable!.storeVersion, text: 'already submitted', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: 'already submitted' }], expectedTurnId: null } };
    const frozen = await f.store.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command });
    let release!: (value: typeof frozen) => void;
    const delayed = new Promise<typeof frozen>(resolve => { release = resolve; });
    const read = vi.spyOn(f.store, 'readExisting').mockReturnValueOnce(delayed), controller = f.create(), initial = controller.sync();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const admitted = f.context();
    if (change === 'temporary context loss') { f.setContext(null); await controller.sync(); }
    f.setContext({ ...admitted, authorizationGeneration: change === 'authorization generation' ? '2' : '1' });
    try {
      await controller.sync();
      expect(controller.getSnapshot().active).toBe(true);
      expect(controller.getSnapshot().submission?.operationId).toBe(command.operationId);
      expect(controller.getSnapshot().canSend).toBe(false);
    } finally { release(frozen); await initial; }
    expect(controller.getSnapshot().submission?.operationId).toBe(command.operationId);
  });
  it('refreshes permission projection even when an unobserved short pause leaves the admission fingerprint unchanged', async () => {
    const f = fixture(null), saved = await f.store.openOwner(identity), controller = f.create();
    let release!: (value: typeof saved) => void;
    const delayed = new Promise<typeof saved>(resolve => { release = resolve; });
    const read = vi.spyOn(f.store, 'readExisting').mockReturnValueOnce(delayed), initial = controller.sync();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    f.setContext({ ...f.context(), canEdit: false, active: false }); release(saved); await initial;
    expect(controller.getSnapshot().readOnly).toBe(true);
    f.setContext({ ...f.context(), canEdit: true, active: true }); await controller.sync();
    expect(controller.getSnapshot().readOnly).toBe(false);
  });
  it('reports a shared load failure without rejecting repeated host sync calls', async () => {
    const f = fixture(), controller = f.create(); let reject!: (error: Error) => void;
    const loading = new Promise<null>((_resolve, fail) => { reject = fail; });
    vi.spyOn(f.store, 'readExisting').mockReturnValueOnce(loading);
    const first = controller.sync(), second = controller.sync();
    const results = Promise.allSettled([first, second]); reject(new Error('database closed while loading'));
    expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(controller.getSnapshot().error).not.toBeNull(); expect(controller.getSnapshot().active).toBe(true); expect(controller.getSnapshot().readOnly).toBe(true); expect(controller.getSnapshot().canSend).toBe(false);
    await controller.retrySave(); expect(controller.getSnapshot().active).toBe(false);
  });
  it('drains a pending load when closed and never resumes storage work after losing its owner', async () => {
    const f = fixture(), controller = f.create(); let resolve!: (value: null) => void;
    const loading = new Promise<null>(done => { resolve = done; });
    vi.spyOn(f.store, 'readExisting').mockReturnValueOnce(loading); const readOriginals = vi.spyOn(f.store, 'readRecoverableSubmissions');
    const opened = controller.sync(); let finished = false;
    const closed = controller.close().then(() => { finished = true; }); f.setContext(null);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); resolve(null); await Promise.all([opened, closed]);
    expect(readOriginals).not.toHaveBeenCalled(); expect(finished).toBe(true);
  });
  it('persists the last admitted edit when the host closes and immediately drops its context', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'saved');
    controller.setText('last keystroke'); const closed = controller.close(); f.setContext(null); await closed;
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('last keystroke');
  });
  it('persists a new edit after explicitly adopting another window saved conflict resolution', async () => {
    const f = fixture(null), controller = f.create(); await controller.addFiles([file()], 'initial');
    const other = new SessionDraftStore(); stores.push(other); const remote = await other.readExisting(identity);
    await other.saveDraft(remote!.owner, { draftId: remote!.editable!.draftId, expectedStoreVersion: remote!.editable!.storeVersion, text: 'remote winner', items: remote!.editable!.items, rejectedCandidates: [], overflowRejectedCount: 0 });
    controller.setText('competing local'); await controller.flush().catch(() => {}); expect(controller.getSnapshot().conflict).toBe(true);
    await controller.resolveConflict('saved'); expect(controller.getSnapshot().text).toBe('remote winner');
    controller.setText('new edit after resolving conflict'); await controller.close();
    expect((await other.readExisting(identity))?.editable?.text).toBe('new edit after resolving conflict');
  });
  it('flushes a newly created successor without comparing it to the frozen draft content revision', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'original'); await controller.send(); await controller.continueEditing();
    controller.setText('successor last keystroke'); const closed = controller.close(); f.setContext(null); await closed;
    const saved = await f.store.readExisting(identity); expect(saved?.editable?.text).toBe('successor last keystroke'); expect(saved?.frozen?.text).toBe('original');
  });
  it('flushes the admitted old-owner content before changing native targets', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'saved'); controller.setText('old owner last keystroke');
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }; f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    await controller.sync(); expect((await f.store.readExisting(identity))?.editable?.text).toBe('old owner last keystroke'); expect(controller.getSnapshot().text).toBe('');
  });
  it('keeps independent text available in browsers without IndexedDB', async () => {
    const f = fixture(), controller = f.create(); vi.stubGlobal('indexedDB', undefined); const read = vi.spyOn(f.store, 'readExisting');
    await controller.sync(); expect(controller.getSnapshot().active).toBe(false); expect(controller.getSnapshot().readOnly).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it('pauses document-hidden network work while saving local text and resumes on visibilitychange', async () => {
    const f = fixture(), controller = f.create(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await controller.addFiles([file()], 'hidden'); expect(f.mutations).toEqual([]); controller.setText('saved while hidden'); await controller.flush(); expect((await f.store.readExisting(identity))?.editable?.text).toBe('saved while hidden');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(controller.getSnapshot().canSend).toBe(true)); expect(f.mutations).toEqual(['prepare', 'chunk', 'complete']);
  });
  it('aborts an in-flight upload on visibilitychange and observes its original identity when visible again', async () => {
    const f = fixture(), controller = f.create(), prepare = vi.mocked(f.resources.prepareUpload).getMockImplementation()!;
    let finish!: () => void, entered!: () => void, signal: AbortSignal | undefined;
    const waiting = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.resources.prepareUpload).mockImplementationOnce(async (spec, requestSignal) => { signal = requestSignal; const receipt = await prepare(spec, requestSignal); entered(); await waiting; return receipt; });
    const added = controller.addFiles([file()], ''); await started;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); expect(signal?.aborted).toBe(true); finish(); await added;
    expect(controller.getSnapshot().items[0]?.status).toBe('unknown'); await controller.checkStatus(); expect(f.resources.getUpload).not.toHaveBeenCalled();
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(controller.getSnapshot().canSend).toBe(true)); expect(f.resources.prepareUpload).toHaveBeenCalledOnce(); expect(f.resources.getUpload).toHaveBeenCalledOnce();
  });
  it('retains dirty text while permission review pauses writes and saves it when readmission returns', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'saved'); controller.setText('pending review');
    f.setContext({ ...f.context(), canEdit: false, active: false }); await controller.sync(); await controller.flush();
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('saved'); expect(controller.getSnapshot().text).toBe('pending review'); expect(controller.getSnapshot().error).toBeNull();
    f.setContext({ ...f.context(), canEdit: true, active: true }); await controller.sync(); expect((await f.store.readExisting(identity))?.editable?.text).toBe('pending review');
  });
  it.each(['selection', 'restoration'])('resumes the original bytes after permission checking interrupts image %s', async mode => {
    const f = fixture(null), images = new SessionImageStore();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
    const scope = images.createScope({ identity: { serverOrigin: target.serverOrigin, actorUserId: target.actorUserId, authorizationGeneration: '1', owner: { kind: 'session', fence: target.fence, nativeSessionId: null } }, read: async () => { throw new Error('unexpected network'); }, canRead: () => f.context().canEdit, canDownload: () => f.context().canEdit });
    const createAsset = (blob: Blob, id: string) => images.createLocalAsset(scope, { key: id, blob });
    const original = new File([sessionImageBytes('png')], 'good.png', { type: 'image/png' }) as unknown as globalThis.File;
    let controller = f.create({ createAsset }), release!: (bytes: ArrayBuffer) => void, entered!: () => void;
    const pending = new Promise<ArrayBuffer>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let bytes = await original.arrayBuffer();
    if (mode === 'restoration') {
      await controller.addFiles([original], 'keep this original'); await controller.close(); controller = f.create({ createAsset });
      const read = f.store.readBlob.bind(f.store);
      vi.spyOn(f.store, 'readBlob').mockImplementationOnce(async (...args) => { const stored = await read(...args); bytes = await stored!.blob.arrayBuffer(); vi.spyOn(stored!.blob, 'arrayBuffer').mockImplementationOnce(() => { entered(); return pending; }); return stored; });
    } else vi.spyOn(original, 'arrayBuffer').mockImplementationOnce(() => { entered(); return pending; });
    const work = mode === 'restoration' ? controller.sync() : controller.addFiles([original], 'keep this original');
    try {
      await started; f.setContext({ ...f.context(), canEdit: false, active: false }); await controller.sync(); release(bytes); await work;
      expect(controller.getSnapshot().items[0]?.validation).not.toBe('bytes_invalid');
      f.setContext({ ...f.context(), canEdit: true, active: true }); await controller.sync(); await controller.retrySave();
      expect(controller.getSnapshot().items[0]?.validation).toBe('valid'); expect(controller.getSnapshot().items[0]?.blobId).not.toBeNull();
      const saved = await f.store.readExisting(identity); expect(saved?.editable?.items[0]?.validation).toBe('valid');
      expect(await (await f.store.readBlob(saved!.owner, saved!.editable!.items[0]!.blobId!))!.blob.arrayBuffer()).toEqual(bytes);
    } finally { release(bytes); await work; await controller.close(); await images.close(); }
  });
  it('leaves untouched text drafts outside IndexedDB until an image is added', async () => {
    const f = fixture(), controller = f.create(); await controller.sync();
    expect(controller.getSnapshot().active).toBe(false); expect(controller.getSnapshot().readOnly).toBe(false); expect(await f.store.readExisting(identity)).toBeNull();
    await controller.addFiles([file()], 'original text');
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('original text');
    expect(controller.getSnapshot().canSend).toBe(true);
  });
  it('discovers another window submission before sending from a previously empty owner', async () => {
    const f = fixture(null), controller = f.create(); await controller.sync(); expect(controller.getSnapshot().active).toBe(false);
    const other = new SessionDraftStore(); stores.push(other); const first = await other.openOwner(identity);
    const saved = await other.saveDraft(first.owner, { draftId: first.editable!.draftId, expectedStoreVersion: first.editable!.storeVersion, text: 'other window draft', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: 'other window draft' }], expectedTurnId: null } };
    await other.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command });
    await controller.refreshForSend();
    expect(controller.getSnapshot().active).toBe(true); expect(controller.getSnapshot().text).toBe('other window draft');
    expect(controller.getSnapshot().submission?.operationId).toBe(command.operationId); expect(controller.getSnapshot().canSend).toBe(false); expect(f.commands).toHaveLength(0);
  });
  it('refuses the current send click after discovering another window changed the content revision', async () => {
    const f = fixture(null), controller = f.create(); await controller.addFiles([file()], 'visible text');
    const other = new SessionDraftStore(); stores.push(other); const saved = await other.readExisting(identity);
    await other.saveDraft(saved!.owner, { draftId: saved!.editable!.draftId, expectedStoreVersion: saved!.editable!.storeVersion, text: 'other window text', items: saved!.editable!.items, rejectedCandidates: [], overflowRejectedCount: 0 });
    await expect(controller.refreshForSend()).rejects.toThrow('image_draft_restored');
    expect(controller.getSnapshot().text).toBe('other window text'); expect(f.commands).toHaveLength(0);
    await controller.refreshForSend(); expect(controller.getSnapshot().text).toBe('other window text');
  });
  it('keeps the original content CAS baseline when another edit and window write race a send preflight read', async () => {
    const f = fixture(null), controller = f.create(); await f.store.importLegacy(identity, { text: 'initial', revision: '1', submission: null }); await controller.sync();
    const other = new SessionDraftStore(); stores.push(other);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const read = f.store.readExisting.bind(f.store);
    vi.spyOn(f.store, 'readExisting').mockImplementationOnce(async (...args) => { entered(); await waiting; return read(...args); });
    const refreshing = controller.refreshForSend().catch(error => error); await started;
    controller.setText('new local edit');
    const remote = (await other.readExisting(identity))!;
    await other.saveDraft(remote.owner, { draftId: remote.editable!.draftId, expectedStoreVersion: remote.editable!.storeVersion, text: 'other window winner', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    release(); await refreshing;
    expect(controller.getSnapshot()).toMatchObject({ text: 'new local edit', conflict: true, error: 'image_draft_conflict' });
    await expect(controller.flush()).rejects.toThrow('image_draft_conflict');
    expect((await other.readExisting(identity))?.editable?.text).toBe('other window winner'); expect(f.commands).toHaveLength(0);
  });
  it.each(['native', 'authorization'] as const)('starts a new %s persistence queue without abandoning the superseded read during close', async change => {
    const f = fixture(null), controller = f.create(); await f.store.importLegacy(identity, { text: 'original text', revision: '1', submission: null }); await controller.sync();
    const read = f.store.readExisting.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'readExisting').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
    const original = controller.refreshForSend().catch(error => error); await entered.promise;
    const nextTarget = change === 'native' ? { ...target, expectedNativeSessionId: 'native-next' } : target;
    f.setContext({ ...f.context(), identity: { ...identity, target: nextTarget }, target: nextTarget, authorizationGeneration: '2' });
    let restored = false, closed = false; const restoring = controller.sync().then(() => { restored = true; });
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(restored).toBe(true));
      expect(controller.getSnapshot().text).toBe(change === 'native' ? '' : 'original text');
      closing = controller.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    } finally { release.resolve(); await Promise.all([original, restoring, closing]); }
    expect(await original).toBeInstanceOf(Error); expect(closed).toBe(true); expect(f.commands).toHaveLength(0);
  });
  it('keeps a retiring local draft visible and refuses to move its older saved content until the final write finishes', async () => {
    const f = fixture(null), controller = f.create(); await f.store.importLegacy(identity, { text: 'saved text', revision: '1', submission: null }); await controller.sync();
    const read = f.store.readExisting.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'readExisting').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
    const preflight = controller.refreshForSend().catch(error => error); await entered.promise; controller.setText('latest retiring text');
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }; f.setContext({ ...f.context(), identity: { ...identity, target: nextTarget }, target: nextTarget });
    let restored = false; const restoring = controller.sync().then(() => { restored = true; });
    try {
      await vi.waitFor(() => expect(restored).toBe(true));
      const pending = controller.getSnapshot().detachedDrafts[0]!;
      expect(pending).toMatchObject({ draft: { text: 'latest retiring text' }, canRestore: false, disabledReason: 'image_draft_unsaved' });
      await expect(controller.restoreDetached(pending.ref)).rejects.toThrow('image_draft_unsaved');
      expect((await f.store.readExisting(identity))?.editable?.text).toBe('saved text');
    } finally { release.resolve(); await Promise.all([preflight, restoring]); }
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ draft: { text: 'latest retiring text' }, canRestore: true }));
    await controller.restoreDetached(controller.getSnapshot().detachedDrafts[0]!.ref);
    expect(controller.getSnapshot().text).toBe('latest retiring text'); expect(f.commands).toHaveLength(0);
  });
  it.each(['committed', 'failed'] as const)('shows a %s retiring draft before the new owner has any durable content', async outcome => {
    const f = fixture(null), controller = f.create(); await f.store.openOwner(identity); await controller.sync();
    controller.setText('unsaved original owner text');
    const read = f.store.read.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
    if (outcome === 'failed') vi.spyOn(f.store, 'saveDraft').mockRejectedValueOnce(new DraftStoreError('quota', 'Storage is full.'));
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }, nextIdentity = { ...identity, target: nextTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    const restoring = controller.sync(); await entered.promise;
    try {
      await restoring;
      expect(controller.getSnapshot()).toMatchObject({ text: '', detachedDrafts: [{ draft: { text: 'unsaved original owner text' }, canRestore: false, canRetrySave: false, disabledReason: 'image_draft_unsaved' }] });
    } finally { release.resolve(); await restoring; }
    if (outcome === 'failed') {
      await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ error: 'image_draft_quota', canRestore: false, canRetrySave: true }));
      await controller.retryDetachedSave(controller.getSnapshot().detachedDrafts[0]!.ref);
      expect((await f.store.readExisting(identity))?.editable?.text).toBe('unsaved original owner text');
      expect((await f.store.readExisting(nextIdentity))?.editable?.text).toBe('');
    }
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ draft: { text: 'unsaved original owner text' }, canRestore: true, canRetrySave: false, error: null }));
    expect(controller.getSnapshot().text).toBe('');
    await controller.restoreDetached(controller.getSnapshot().detachedDrafts[0]!.ref);
    expect(controller.getSnapshot().text).toBe('unsaved original owner text'); expect(f.commands).toHaveLength(0);
  });
  it.each(['saved', 'local'] as const)('retains the conflicted old-native content and missing persisted Blob until explicit %s choice', async choice => {
    const f = fixture(null), controller = f.create();
    await controller.addFiles([file('local-original.png')], 'original shared baseline');
    const baseline = (await f.store.readExisting(identity))!;
    const blobId = baseline.editable!.items[0]!.blobId!;
    controller.setText('unresolved private local text');
    const peer = new SessionDraftStore(); stores.push(peer);
    const remote = await peer.saveDraft(baseline.owner, { draftId: baseline.editable!.draftId, expectedStoreVersion: baseline.editable!.storeVersion, text: 'other tab saved text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    expect(await peer.readBlob(remote.owner, blobId)).toBeNull();
    await controller.flush().catch(() => {});
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, text: 'unresolved private local text' });
    const nativeTarget = { ...target, expectedNativeSessionId: 'native-new' }, nativeIdentity = { ...identity, target: nativeTarget };
    await f.store.openOwner(nativeIdentity); f.setContext({ ...f.context(), identity: nativeIdentity, target: nativeTarget }); await controller.sync();
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ draft: { text: 'unresolved private local text', items: [{ label: 'local-original.png' }] }, savedDraft: { text: 'other tab saved text', items: [] }, canResolveConflict: true, canRestore: false }));
    expect((await peer.readExisting(identity))!.editable).toEqual(remote.editable);
    const ref = controller.getSnapshot().detachedDrafts[0]!.ref;
    await controller.resolveDetachedConflict(ref, choice);
    const resolved = (await peer.readExisting(identity))!;
    expect(resolved.editable?.text).toBe(choice === 'local' ? 'unresolved private local text' : 'other tab saved text');
    if (choice === 'local') {
      expect(resolved.editable!.items[0]!.label).toBe('local-original.png');
      expect(await (await peer.readBlob(resolved.owner, resolved.editable!.items[0]!.blobId!))!.blob.text()).toBe('image');
    } else expect(resolved.editable?.items).toEqual([]);
    expect(controller.getSnapshot().text).toBe('');
    expect((await peer.readExisting(nativeIdentity))!.editable?.text).toBe('');
    expect(f.commands).toEqual([]);
  });
  it.each(['saved', 'local'] as const)('explicitly keeps the %s original-owner draft after a retiring write conflicts', async choice => {
    const f = fixture(null), controller = f.create(); const original = await f.store.openOwner(identity); await controller.sync();
    controller.setText('local original text');
    const read = f.store.read.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }, nextIdentity = { ...identity, target: nextTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    const restoring = controller.sync(); await entered.promise;
    try {
      await restoring;
      await f.store.saveDraft(original.owner, { draftId: original.editable!.draftId, expectedStoreVersion: original.editable!.storeVersion, text: 'remote original text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    } finally { release.resolve(); await restoring; }
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ draft: { text: 'local original text' }, savedDraft: { text: 'remote original text' }, canRetrySave: false, canResolveConflict: true, error: 'image_draft_conflict' }));
    const stale = controller.getSnapshot().detachedDrafts[0]!.ref, newer = (await f.store.readExisting(identity))!;
    await f.store.saveDraft(newer.owner, { draftId: newer.editable!.draftId, expectedStoreVersion: newer.editable!.storeVersion, text: 'newer remote text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
    await expect(controller.resolveDetachedConflict(stale, choice)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('newer remote text');
    const current = controller.getSnapshot().detachedDrafts[0]!;
    expect(current).toMatchObject({ draft: { text: 'local original text' }, savedDraft: { text: 'newer remote text' }, canResolveConflict: true });
    await controller.resolveDetachedConflict(current.ref, choice);
    const expected = choice === 'local' ? 'local original text' : 'newer remote text';
    expect((await f.store.readExisting(identity))?.editable?.text).toBe(expected);
    expect((await f.store.readExisting(nextIdentity))?.editable?.text).toBe('');
    expect(controller.getSnapshot()).toMatchObject({ text: '', detachedDrafts: [{ draft: { text: expected }, canRestore: true, canResolveConflict: false, error: null }] });
    expect(f.commands).toHaveLength(0);
  });
  it('preserves current-owner legacy text and later edits while the original owner finishes saving', async () => {
    const f = fixture(null), imported = vi.fn();
    const controller = f.create({ legacy: () => f.context().target.expectedNativeSessionId ? { text: 'current legacy text', revision: 'legacy-current', submission: null, onImported: imported } : null });
    await f.store.openOwner(identity); await controller.sync(); controller.setText('original owner text');
    const read = f.store.read.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }, nextIdentity = { ...identity, target: nextTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    const restoring = controller.sync(); await entered.promise;
    try {
      await restoring;
      expect(controller.getSnapshot().text).toBe('current legacy text'); expect(imported).toHaveBeenCalledOnce();
      controller.setText('later current owner text'); await controller.flush();
    } finally { release.resolve(); await restoring; }
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]).toMatchObject({ draft: { text: 'original owner text' }, disabledReason: 'image_restore_requires_empty' }));
    expect(controller.getSnapshot().text).toBe('later current owner text');
    expect((await f.store.readExisting(nextIdentity))?.editable?.text).toBe('later current owner text');
  });
  it.each(['access', 'authorization', 'owner'] as const)('stops an explicit original-owner save retry after its %s admission changes', async change => {
    const f = fixture(null), controller = f.create(); await f.store.openOwner(identity); await controller.sync(); controller.setText('retained text');
    vi.spyOn(f.store, 'saveDraft').mockRejectedValueOnce(new DraftStoreError('quota', 'Storage is full.'));
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' };
    f.setContext({ ...f.context(), identity: { ...identity, target: nextTarget }, target: nextTarget }); await controller.sync();
    await vi.waitFor(() => expect(controller.getSnapshot().detachedDrafts[0]?.canRetrySave).toBe(true));
    const read = f.store.read.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => { const result = await read(...args); entered.resolve(); await release.promise; return result; });
    const retrying = controller.retryDetachedSave(controller.getSnapshot().detachedDrafts[0]!.ref); await entered.promise;
    try {
      const current = f.context();
      if (change === 'access') f.setContext({ ...current, canEdit: false });
      else if (change === 'authorization') f.setContext({ ...current, authorizationGeneration: '2' });
      else { const laterTarget = { ...nextTarget, expectedNativeSessionId: 'native-later' }; f.setContext({ ...current, target: laterTarget, identity: { ...identity, target: laterTarget } }); }
      await controller.sync();
    } finally { release.resolve(); await retrying; }
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('');
    expect(controller.getSnapshot().text).toBe(''); expect(f.commands).toHaveLength(0);
  });
  it('does not refresh the new owner from an old upload unknown callback', async () => {
    const f = fixture(), controller = f.create(); vi.mocked(f.resources.prepareUpload).mockRejectedValueOnce(new Error('Lost upload response.'));
    const mark = f.store.markUploadUnknown.bind(f.store), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.store, 'markUploadUnknown').mockImplementationOnce(async (...args) => { const result = await mark(...args); entered.resolve(); await release.promise; return result; });
    const selecting = controller.addFiles([file()], 'original owner text');
    try {
      await entered.promise;
      const nextTarget = { ...target, expectedNativeSessionId: 'native-next' };
      f.setContext({ ...f.context(), identity: { ...identity, target: nextTarget }, target: nextTarget, capabilities: { ...capability, expectedNativeSessionId: 'native-next' }, active: false });
      await controller.sync(); const read = vi.spyOn(f.store, 'read');
      release.resolve(); await selecting;
      expect(read).not.toHaveBeenCalled(); expect(controller.getSnapshot().text).toBe('');
    } finally { release.resolve(); await selecting; }
  });
  it('imports text edited after an inactive durable draft lookup when images activate it', async () => {
    const f = fixture(null); let text = '';
    const controller = f.create({ legacy: () => ({ text, revision: 'legacy', submission: null, onImported() {} }) });
    await controller.sync(); text = 'typed after passive lookup';
    await controller.addFiles([file()], text);
    expect(controller.getSnapshot().text).toBe('typed after passive lookup');
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('typed after passive lookup');
  });
  it.each([false, true])('defers recovery target initialization when its discovery read loses access and resumes it later (legacy=%s)', async legacy => {
    const f = fixture(null), imported = vi.fn(); await f.store.importLegacy(identity, { text: 'saved original text', revision: 'old', submission: null });
    const nextTarget = { ...target, expectedNativeSessionId: 'native-next' }, nextIdentity = { ...identity, target: nextTarget };
    f.setContext({ ...f.context(), identity: nextIdentity, target: nextTarget });
    const controller = f.create({ legacy: () => legacy ? { text: 'current legacy text', revision: 'current', submission: null, onImported: imported } : null });
    const read = f.store.readDetachedDrafts.bind(f.store);
    vi.spyOn(f.store, 'readDetachedDrafts').mockImplementationOnce(async (...args) => { const result = await read(...args); f.setContext({ ...f.context(), canEdit: false }); return result; });
    await controller.sync();
    expect(await f.store.readExisting(nextIdentity)).toBeNull(); expect(imported).not.toHaveBeenCalled();
    f.setContext({ ...f.context(), canEdit: true }); await controller.sync();
    expect((await f.store.readExisting(nextIdentity))?.editable?.text).toBe(legacy ? 'current legacy text' : '');
    expect(controller.getSnapshot().detachedDrafts[0]?.draft.text).toBe('saved original text');
    expect(imported).toHaveBeenCalledTimes(legacy ? 1 : 0); expect(f.commands).toHaveLength(0);
  });
  it('retains the complete ordered candidate set and does not upload a valid subset', async () => {
    const f = fixture(), controller = f.create(); await controller.sync();
    await controller.addFiles([file('first.png'), file('bad.png', 'image/bad'), file('last.png')], 'keep');
    expect(controller.getSnapshot().items.map(item => item.label)).toEqual(['first.png', 'bad.png', 'last.png']);
    expect(controller.getSnapshot().items[1]?.error).not.toBeNull();
    expect(f.mutations).toEqual([]); expect(controller.getSnapshot().canSend).toBe(false);
  });
  it('keeps excess candidates explicit across reopening until the user discards them', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles(Array.from({ length: 10 }, (_, i) => file(`${i}.png`)), '');
    expect(controller.getSnapshot().items).toHaveLength(8); expect(controller.getSnapshot().rejectedCandidates).toHaveLength(2); expect(f.mutations).toEqual([]);
    await controller.close(); const reopened = f.create(); await reopened.sync();
    expect(reopened.getSnapshot().rejectedCandidates).toHaveLength(2); expect(reopened.getSnapshot().canSend).toBe(false);
    await reopened.discardRejected(); expect(reopened.getSnapshot().canSend).toBe(true);
  });
  it('persists and freezes exact ordered content once, then preserves successor text on late acceptance', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file('a.png'), file('b.png')], ' exact text ');
    await controller.send(); await controller.send(); expect(f.commands).toHaveLength(1);
    const command = f.commands[0]!; expect(command.kind).toBe('send_message'); if (command.kind !== 'send_message') throw new Error('wrong command');
    expect(command.payload.content.map(part => part.type)).toEqual(['text', 'image', 'image']); expect(command.payload.expectedImageCapabilityRevision).toBe('2');
    await controller.continueEditing(); controller.setText('successor'); await controller.flush();
    f.query.mockResolvedValue(f.operation(command, 'confirmed'));
    await controller.checkStatus(); expect(controller.getSnapshot().text).toBe('successor'); expect(controller.getSnapshot().submission).toBeNull();
  });
  it('retains unknown dispatch identity and only queries after reopening', async () => {
    const f = fixture(), controller = f.create(); f.dispatch.mockImplementation(async command => { f.commands.push(command); throw new Error('response lost'); });
    await controller.addFiles([file()], ''); await controller.send(); const id = f.commands[0]!.operationId;
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'confirmed'));
    await controller.close(); const reopened = f.create(); await reopened.sync();
    expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledWith(target.fence, id, expect.any(AbortSignal));
    expect(reopened.getSnapshot().submission).toBeNull();
  });
  it('keeps local originals when Web Locks are unavailable and sends no network mutations', async () => {
    const f = fixture(null), controller = f.create(); await controller.addFiles([file()], 'local');
    expect(controller.getSnapshot().text).toBe('local'); expect(controller.getSnapshot().items).toHaveLength(1); expect(controller.getSnapshot().canSend).toBe(false); expect(f.mutations).toEqual([]);
  });
  it('keeps the original query reachable after native initialization creates another owner', async () => {
    const f = fixture(), controller = f.create(); f.dispatch.mockImplementation(async command => { f.commands.push(command); throw new Error('lost'); });
    await controller.addFiles([file()], 'first'); await controller.send();
    f.query.mockRejectedValue(new Error('HTTP 404'));
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
    f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    await controller.sync();
    expect(controller.getSnapshot().active).toBe(true); expect(controller.getSnapshot().submission).toBeNull(); expect(controller.getSnapshot().recoveries[0]?.ref.operationId).toBe(f.commands[0]!.operationId); expect(controller.getSnapshot().executionBlocked).toBe(true); expect(controller.getSnapshot().canSend).toBe(false);
    f.query.mockResolvedValue(f.operation(f.commands[0]!, 'confirmed')); await controller.checkStatus();
    expect(controller.getSnapshot().submission).toBeNull(); expect(f.commands).toHaveLength(1);
  });
  it('retains and validates the selected original in memory when saving initially aborts', async () => {
    const f = fixture(), controller = f.create(); await controller.sync();
    const save = vi.spyOn(f.store, 'saveDraft').mockRejectedValue(new Error('storage unavailable'));
    await controller.addFiles([file()], '');
    expect(controller.getSnapshot().items).toHaveLength(1); expect(controller.getSnapshot().items[0]?.asset).not.toBeNull(); expect(controller.getSnapshot().error).not.toBeNull(); expect(f.mutations).toEqual([]);
    save.mockRestore(); await controller.retrySave(); expect(controller.getSnapshot().canSend).toBe(true);
  });
  it('queries a lost upload response using its original identity before continuing', async () => {
    const f = fixture(), controller = f.create(); const prepare = f.resources.prepareUpload;
    vi.spyOn(f.resources, 'prepareUpload').mockImplementationOnce(async (spec, signal) => { await prepare(spec, signal); throw new Error('response lost'); });
    await controller.addFiles([file()], ''); const original = [...f.uploads.keys()][0]!;
    expect(controller.getSnapshot().items[0]?.status).toBe('unknown'); expect(f.mutations).toEqual(['prepare']);
    await controller.checkStatus(); expect(f.resources.getUpload).toHaveBeenCalledWith(original, expect.any(AbortSignal)); expect(controller.getSnapshot().canSend).toBe(true); expect([...f.uploads.keys()]).toEqual([original]);
  });
  it('keeps new selection and text in memory while IndexedDB cannot be opened', async () => {
    const f = fixture(), controller = f.create(); const open = vi.spyOn(f.store, 'openOwner').mockRejectedValue(new Error('database unavailable'));
    await controller.addFiles([file()], 'retain me'); expect(controller.getSnapshot().text).toBe('retain me'); expect(controller.getSnapshot().items).toHaveLength(1); expect(controller.getSnapshot().items[0]?.asset).not.toBeNull();
    open.mockRestore(); await controller.retrySave(); expect(controller.getSnapshot().canSend).toBe(true); expect((await f.store.readExisting(identity))?.editable?.text).toBe('retain me');
  });
  it('can send a text successor after every image is explicitly removed without Web Locks', async () => {
    const f = fixture(null), controller = f.create(); await controller.addFiles([file()], 'text only'); await controller.remove(controller.getSnapshot().items[0]!.draftImageId); await controller.send();
    expect(f.commands).toHaveLength(1); expect(f.commands[0]?.kind === 'send_message' && f.commands[0].payload.content).toEqual([{ type: 'text', text: 'text only' }]);
  });
  it('does not silently send content saved in another window after this window last displayed it', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const f = fixture(), first = f.create(); await first.addFiles([file()], 'first');
    const second = f.create(); await second.sync(); second.setText('another window'); await second.flush();
    await first.send(); expect(f.commands).toEqual([]); expect(first.getSnapshot().text).toBe('first'); expect(first.getSnapshot().error).not.toBeNull();
  });
  it('retries a lost original prepare explicitly without allocating another upload identity', async () => {
    const f = fixture(), controller = f.create(), original = vi.mocked(f.resources.prepareUpload).getMockImplementation()!;
    let firstSpec: ImageUploadSpec | null = null;
    vi.spyOn(f.resources, 'prepareUpload').mockImplementationOnce(async spec => { firstSpec = spec; throw new Error('connection lost'); }).mockImplementation(original);
    await controller.addFiles([file()], ''); expect(controller.getSnapshot().items[0]?.status).toBe('unknown');
    await controller.checkStatus(); expect(f.resources.prepareUpload).toHaveBeenCalledTimes(1);
    await controller.retryUpload(controller.getSnapshot().items[0]!.draftImageId);
    expect(f.resources.prepareUpload).toHaveBeenCalledTimes(2); expect([...f.uploads.keys()]).toEqual([firstSpec!.uploadId]); expect(controller.getSnapshot().canSend).toBe(true);
  });
  it('does not publish an old successor after the native target changed during its transaction', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'old'); await controller.send();
    const start = f.store.startSuccessor.bind(f.store); let finish!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.store, 'startSuccessor').mockImplementation(async (...args) => { const result = await start(...args); entered(); await waiting; return result; });
    const edit = controller.continueEditing(); await started;
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }; f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    await controller.sync(); const newId = controller.getSnapshot().draftId; finish(); await edit;
    expect(controller.getSnapshot().draftId).toBe(newId); expect(controller.getSnapshot().text).toBe('');
  });
  it('keeps unsaved text during a same-owner authorization refresh and hides it when the owner disappears', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'saved'); const asset = controller.getSnapshot().items[0]!.asset;
    controller.setText('unsaved'); f.setContext({ ...f.context(), authorizationGeneration: '2' }); await controller.sync();
    expect(controller.getSnapshot().text).toBe('unsaved'); expect(controller.getSnapshot().items[0]!.asset).toBe(asset); await controller.flush();
    f.setContext(null); await controller.sync(); expect(controller.getSnapshot().active).toBe(false); expect(controller.getSnapshot().text).toBe(''); expect(controller.getSnapshot().items).toEqual([]);
  });
  it('refuses a capability changed during the final refresh even when the model identifier is unchanged', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], '');
    const caps = vi.mocked(f.resources.capabilities).getMockImplementation()!;
    vi.mocked(f.resources.capabilities).mockImplementation(async signal => { const result = await caps(signal); f.setContext({ ...f.context(), capabilities: { ...capability, revision: '3', send: 'unsupported' } }); return result; });
    await controller.send(); expect(f.commands).toEqual([]); expect(controller.getSnapshot().canSend).toBe(false);
  });
  it('uses the service effective capability revision when the snapshot has the same model profile', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], '');
    const caps = vi.mocked(f.resources.capabilities).getMockImplementation()!;
    vi.mocked(f.resources.capabilities).mockImplementation(async signal => ({ ...await caps(signal), capabilities: { ...capability, revision: '3' } }));
    await controller.send(); const command = f.commands[0]!; expect(command?.kind === 'send_message' && command.payload.expectedImageCapabilityRevision).toBe('3');
  });
  it('restores a prepared intent without dispatching until the user explicitly resumes that same intent', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'original');
    vi.spyOn(f.store, 'claimDispatch').mockRejectedValueOnce(new Error('page ended before claim'));
    await controller.send(); const saved = await f.store.readExisting(identity), operationId = saved!.submission!.operationId;
    expect(saved!.submission!.state).toBe('prepared'); expect(f.commands).toEqual([]);
    await controller.close(); const reopened = f.create(); await reopened.sync(); expect(f.commands).toEqual([]); expect(reopened.getSnapshot().canResumePrepared).toBe(true);
    await reopened.resumePrepared(); expect(f.commands).toHaveLength(1); expect(f.commands[0]!.operationId).toBe(operationId);
  });
  it('explicitly cancels an unclaimed old-native submission while preserving its original editable content', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'old native draft');
    vi.spyOn(f.store, 'claimDispatch').mockRejectedValueOnce(new Error('page ended before claim')); await controller.send();
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' }; f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    await controller.sync(); expect(controller.getSnapshot().canCancelPrepared).toBe(true); await controller.cancelPrepared(controller.getSnapshot().recoveries.find(entry => entry.canCancelPrepared)!.ref);
    expect(controller.getSnapshot().canCancelPrepared).toBe(false); expect(controller.getSnapshot().submission).toBeNull();
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('old native draft'); expect(f.commands).toEqual([]); expect(controller.getSnapshot().text).toBe('');
  });
  it('uses the winning dispatch authority to preserve the original when admission changes before the claim returns', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'keep original');
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const claim = f.store.claimDispatch.bind(f.store);
    vi.spyOn(f.store, 'claimDispatch').mockImplementationOnce(async (...args) => { const result = await claim(...args); entered(); await barrier; return result; });
    const sending = controller.send(); await started;
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
    f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    try { await controller.sync(); } finally { release(); await sending; }
    await controller.checkStatus();
    expect(f.commands).toHaveLength(0);
    expect((await f.store.readExisting(identity))?.editable?.text).toBe('keep original');
    expect((await f.store.readExisting({ ...identity, target: nativeTarget }))?.executionBlocked).toBe(false);
  });
  it.each([true, false])('settles only a trusted late refusal after native initialization (definitive=%s)', async definitive => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.query.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    const controller = f.create({ dispatch: async command => { f.commands.push(command); entered(); await barrier; throw definitive ? new ApiError('server', 409, 'capability_changed') : new Error('response lost'); }, isDefinitiveNotDispatched: imageCommandNotDispatched });
    await controller.addFiles([file()], 'keep original'); const sending = controller.send(); await started;
    const nativeTarget = { ...target, expectedNativeSessionId: 'native' };
    f.setContext({ ...f.context(), identity: { ...identity, target: nativeTarget }, target: nativeTarget, capabilities: { ...capability, expectedNativeSessionId: 'native' } });
    try { await controller.sync(); } finally { release(); await sending; }
    await controller.checkStatus(); const original = await f.store.readExisting(identity);
    expect(f.commands).toHaveLength(1);
    expect(original?.editable?.text).toBe(definitive ? 'keep original' : undefined);
    expect((await f.store.readExisting({ ...identity, target: nativeTarget }))?.executionBlocked).toBe(!definitive);
    expect(controller.getSnapshot().text).not.toBe('keep original');
  });
  it('does not turn edits during the freeze transaction into an implicit successor', async () => {
    const f = fixture(), controller = f.create(); await controller.addFiles([file()], 'original');
    const freeze = f.store.freeze.bind(f.store); let finish!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.store, 'freeze').mockImplementation(async (...args) => { const result = await freeze(...args); entered(); await waiting; return result; });
    const send = controller.send(); await started;
    expect(controller.getSnapshot().readOnly).toBe(true); controller.setText('implicit successor'); finish(); await send;
    expect(controller.getSnapshot().text).toBe('original'); expect(controller.getSnapshot().readOnly).toBe(true);
    await controller.continueEditing(); controller.setText('explicit successor'); await controller.flush(); expect(controller.getSnapshot().text).toBe('explicit successor');
  });
  it('imports legacy text before removing its storage key and saving image originals', async () => {
    const f = fixture(), removed = vi.fn(), controller = f.create({ legacy: () => ({ text: 'legacy text', revision: 'old-uuid', submission: null, onImported: removed }) });
    await controller.addFiles([file()], 'legacy text');
    expect(controller.getSnapshot().text).toBe('legacy text'); expect(controller.getSnapshot().canSend).toBe(true); expect(removed).toHaveBeenCalledOnce();
    expect((await f.store.readExisting(identity))?.owner.legacyImported).toBe(true);
  });
  it('retries the original atomic legacy migration after storage failure and retains its unknown barrier', async () => {
    const f = fixture(), oldId = crypto.randomUUID(), removed = vi.fn();
    let legacy = { text: 'edited legacy', revision: 'new-revision', submission: { operationId: oldId, revision: 'old-revision' } as { operationId: string; revision: string } | null };
    const controller = f.create({ legacy: () => ({ ...legacy, onImported: removed }) });
    controller.subscribe(() => { const view = controller.getSnapshot(); if (view.active) legacy = { text: view.text, revision: view.revision, submission: null }; });
    vi.spyOn(f.store, 'importLegacy').mockRejectedValueOnce(new Error('database unavailable'));
    await controller.addFiles([file()], 'edited legacy'); await controller.retrySave();
    const saved = await f.store.readExisting(identity);
    expect(saved?.submission?.operationId).toBe(oldId); expect(saved?.executionBlocked).toBe(true); expect(removed).toHaveBeenCalledOnce(); expect(controller.getSnapshot().canSend).toBe(false);
  });
  it('keeps unsaved selection in conflict recovery when retrying migration restores an immutable legacy submission', async () => {
    const f = fixture(), oldId = crypto.randomUUID(); const controller = f.create({ legacy: () => ({ text: 'submitted legacy', revision: 'old', submission: { operationId: oldId, revision: 'old' }, onImported() {} }) });
    vi.spyOn(f.store, 'importLegacy').mockRejectedValueOnce(new Error('database unavailable'));
    await controller.addFiles([file()], 'submitted legacy'); await controller.retrySave();
    expect(controller.getSnapshot().conflict).toBe(true); expect(controller.getSnapshot().items).toHaveLength(1); expect(controller.getSnapshot().submission?.operationId).toBe(oldId);
    await controller.resolveConflict('saved'); expect(controller.getSnapshot().frozen).toBe(true); expect(controller.getSnapshot().text).toBe('submitted legacy');
  });
});
