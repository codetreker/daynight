import { useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { SessionComposer } from '../../src/features/task-agent-session/SessionComposer';
import { hydrateSession, emptySessionState } from '../../src/features/task-agent-session/state';
import { SessionImageScope } from '../../src/features/task-agent-session/images/SessionImageScope';
import { pageImageStore } from '../../src/features/task-agent-session/images/image-store';
import { ImageDraftController, type ImageDraftContext } from '../../src/features/task-agent-session/drafts/image-draft-controller';
import { SessionDraftStore, draftOwnerKey } from '../../src/features/task-agent-session/drafts/draft-store';
import { createSessionResourceClient } from '../../../daynight/src/session/resource-client';
import { sessionFence, type ImageCapabilities, type SessionOperation, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import snapshotJson from '../../../daynight/test/session/fixtures/snapshot.json';
import { createDraftStorageProbe } from './session-drafts-storage-probe';
import '../../src/styles/app.css';

export const draftBrowserUser = new URLSearchParams(location.search).get('actor') ?? '00000071-1111-4111-8111-111111111111';
const capabilities: ImageCapabilities = { revision: '2', providerRevision: '1', expectedNativeSessionId: 'native-thread-1', modelId: 'vision', controlsRevision: '3', send: 'supported', steer: 'unsupported', reasonCode: null, inputMediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImageBytes: '10485760', maxMessageImageBytes: '20971520', maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 256 }, ...window.sessionDraftOptions?.capabilities };
const snapshot = { ...snapshotJson, controls: { revision: '3', settings: [], commands: [{ id: 'review', name: 'review', description: 'Review changes', argumentHint: null, available: true }], settingsError: null, commandsError: null }, turnStartedAt: null } as SessionSnapshot;
const target = { serverOrigin: location.origin, actorUserId: draftBrowserUser, fence: sessionFence(snapshot), expectedNativeSessionId: snapshot.identity.nativeSessionId };
const identity = { target, resolver: { kind: 'task' as const, projectId: '00000001-1111-4111-8111-111111111111', taskId: '00000002-1111-4111-8111-111111111111' } };
const ownerKey = draftOwnerKey(identity), store = new SessionDraftStore();
let live = true;
const scope = pageImageStore.createScope({ identity: { serverOrigin: location.origin, actorUserId: draftBrowserUser, authorizationGeneration: '1', owner: { kind: 'session', fence: target.fence, nativeSessionId: target.expectedNativeSessionId } }, canRead: () => live, canDownload: () => live, read: async () => { throw new Error('Local originals do not use saved resource reads.'); } });
const resources = createSessionResourceClient({ scope: { serverOrigin: location.origin, actorUserId: draftBrowserUser, fence: target.fence, authorizationGeneration: '1' }, baseUrl: `${location.origin}/draft-fixture-api/session`, isCurrent: () => live, transport: (url, signal, init) => fetch(url, { ...init, signal }) });
let context: ImageDraftContext = { identity, target, resources, capabilities, active: true, canEdit: true, canSend: true, mode: 'send', expectedTurnId: null, authorizationGeneration: '1' };
const controller = new ImageDraftController({ store, getContext: () => context,
  createAsset: (blob, id, revision, metadata) => pageImageStore.createLocalAsset(scope, { key: JSON.stringify([id, revision]), blob, ...(metadata ? { metadata } : {}) }),
  dispatch: async command => { const response = await fetch('/draft-fixture-api/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<SessionOperation>; },
  query: async (fence, operationId) => { const response = await fetch(`/draft-fixture-api/operation/${operationId}`); if (!response.ok) return { protocol: snapshot.protocol, ...fence, operationId, kind: 'send_message', state: 'unknown', providerResult: null, error: null }; return response.json() as Promise<SessionOperation>; },
});

// Barriers delay entry into the real store operation; its actual IndexedDB
// transaction, completion and CAS checks remain untouched.
const save = store.saveDraft.bind(store), writeReleases: (() => void)[] = [];
let writesHeld = false, writesArrived = 0;
store.saveDraft = async (...args) => { if (writesHeld) { writesArrived++; await new Promise<void>(resolve => writeReleases.push(resolve)); } return save(...args); };
let releaseNativeLock: (() => void) | null = null;
const lockName = async (purpose: string) => `daynight:session-draft:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerKey)))].map(byte => byte.toString(16).padStart(2, '0')).join('')}:${purpose}`;

window.sessionDraftHarness = {
  controller, ownerKey, storage: createDraftStorageProbe(() => identity),
  read: () => store.readExisting(identity),
  originals: async () => {
    const saved = await store.readExisting(identity);
    return Promise.all([...(saved?.editable?.items ?? []), ...(saved?.frozen?.items ?? [])].map(async item => {
      const original = item.blobId && saved ? await store.readBlob(saved.owner, item.blobId) : null;
      return { id: item.draftImageId, label: item.label, size: original?.blob.size ?? null, mediaType: original?.blob.type ?? null, sha256: original ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await original.blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null };
    }));
  },
  setCapabilities: async value => { context = { ...context, capabilities: { ...capabilities, ...value } }; await controller.sync(); },
  holdWrites: () => { writesHeld = true; writesArrived = 0; }, writesArrived: () => writesArrived,
  releaseWrites: () => { writesHeld = false; writeReleases.splice(0).forEach(resolve => resolve()); },
  holdLock: async purpose => new Promise<void>(async started => { const hold = new Promise<void>(release => { releaseNativeLock = release; }); void navigator.locks.request(await lockName(purpose), async () => { started(); await hold; }); }),
  releaseLock: () => { releaseNativeLock?.(); releaseNativeLock = null; }, lockName,
  pageErrors: [], plainCommands: [] as string[], plainMessages: [] as string[],
  usage: () => pageImageStore.usage(),
};
window.addEventListener('error', event => window.sessionDraftHarness.pageErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.sessionDraftHarness.pageErrors.push(String(event.reason)));

function Host() {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot), root = useRef<HTMLElement>(null);
  const [text, setText] = useState(''), [previewOpen, setPreviewOpen] = useState(false);
  const binding = { view, addFiles: controller.addFiles, remove: controller.remove, discardRejected: controller.discardRejected, retrySave: controller.retrySave, retryUpload: controller.retryUpload, checkStatus: controller.checkStatus, continueEditing: controller.continueEditing, resolveConflict: controller.resolveConflict, resolveFailure: controller.resolveFailure };
  return <section ref={root} className="task-agent-session" style={{ width: '100%', maxWidth: 850, margin: '0 auto', minWidth: 0 }}>
    <SessionImageScope scope={scope} rootRef={root} active onPreviewChange={setPreviewOpen}>
      <div className="session-timeline" tabIndex={0} style={{ minHeight: 80 }}>Session draft browser acceptance</div>
      <SessionComposer state={hydrateSession(emptySessionState(), snapshot, [])} connected active suppressKeyboardHint={previewOpen} attachments={binding}
        draft={{ text: view.active ? view.text : text, revision: view.revision, submission: null }}
        onDraftChange={value => { setText(value); controller.setText(value); }}
        onSend={async value => { if (view.active) await controller.send(); else window.sessionDraftHarness.plainMessages.push(value); }} onCancel={async () => {}}
        onExecuteCommand={async id => { window.sessionDraftHarness.plainCommands.push(id); }} />
    </SessionImageScope>
  </section>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Host /></LocaleProvider>);
void controller.sync();

declare global {
  interface Window {
    sessionDraftOptions?: { capabilities?: Partial<ImageCapabilities> };
    sessionDraftHarness: {
      controller: ImageDraftController; ownerKey: string; storage: ReturnType<typeof createDraftStorageProbe>; read(): ReturnType<SessionDraftStore['readExisting']>;
      originals(): Promise<{ id: string; label: string; size: number | null; mediaType: string | null; sha256: string | null }[]>;
      setCapabilities(value: Partial<ImageCapabilities>): Promise<void>; holdWrites(): void; writesArrived(): number; releaseWrites(): void;
      holdLock(purpose: string): Promise<void>; releaseLock(): void; lockName(purpose: string): Promise<string>;
      pageErrors: string[]; plainCommands: string[]; plainMessages: string[]; usage(): ReturnType<typeof pageImageStore.usage>;
    };
  }
}
