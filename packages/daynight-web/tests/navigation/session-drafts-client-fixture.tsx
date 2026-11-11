import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { createSessionApi, createTestSessionApi } from '../../src/api/sessions';
import { TaskSessionClient } from '../../src/features/task-agent-session/client';
import { SessionView } from '../../src/features/task-agent-session/SessionView';
import { sessionFence } from '../../../daynight/src/session/protocol';
import { createDraftStorageProbe } from './session-drafts-storage-probe';
import '../../src/styles/app.css';

const userId = '00000071-1111-4111-8111-111111111111';
const projectId = '00000001-1111-4111-8111-111111111111', taskId = '00000002-1111-4111-8111-111111111111', claimId = '00000003-1111-4111-8111-111111111111';
const errors: string[] = [], onPrincipalMismatch = () => { errors.push('principal mismatch'); };
const pendingNotifications: (() => void)[] = [];
let notificationsHeld = false;
if (new URLSearchParams(location.search).has('hold-draft-notifications')) {
  const nativeMessage = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage')!;
  // Keep the native channel and its real events; delay only the application's
  // notification callback so send must independently read committed IndexedDB.
  Object.defineProperty(BroadcastChannel.prototype, 'onmessage', { ...nativeMessage, set(this: BroadcastChannel, handler: BroadcastChannel['onmessage']) {
    nativeMessage.set!.call(this, handler ? (event: MessageEvent) => {
      const deliver = () => handler.call(this, event);
      if (this.name === 'daynight-session-drafts' && notificationsHeld) pendingNotifications.push(deliver); else deliver();
    } : null);
  } });
}
const notifications = {
  hold: () => { notificationsHeld = true; },
  pending: () => pendingNotifications.length,
  release: () => { notificationsHeld = false; pendingNotifications.splice(0).forEach(deliver => deliver()); },
};
const testSessionId = new URLSearchParams(location.search).has('test-session') ? '00000006-1111-4111-8111-111111111111' : null;
const client = new TaskSessionClient({ ...(testSessionId ? { api: createTestSessionApi(testSessionId, userId, onPrincipalMismatch), testSessionId } : { api: createSessionApi(projectId, taskId, userId, onPrincipalMismatch), projectId, taskId, claimId, ownerUserId: userId }), userId, isCurrent: () => true, onPrincipalMismatch, storage: sessionStorage });
window.sessionDraftClient = { client, errors, notifications, storage: createDraftStorageProbe(() => {
  const snapshot = client.snapshot().state.snapshot; if (!snapshot) throw new Error('The Session snapshot is not ready.');
  return { target: { serverOrigin: location.origin, actorUserId: userId, fence: sessionFence(snapshot), expectedNativeSessionId: snapshot.identity.nativeSessionId }, resolver: snapshot.testExecutionId ? { kind: 'session', sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId } : { kind: 'task', projectId, taskId } };
}) };
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><SessionView client={client} userId={userId} active current /></LocaleProvider>);
client.setCurrentReadVisible(true);
void client.start();
declare global { interface Window { sessionDraftClient: { readonly client: TaskSessionClient; readonly errors: string[]; readonly notifications: typeof notifications; readonly storage: ReturnType<typeof createDraftStorageProbe> } } }
