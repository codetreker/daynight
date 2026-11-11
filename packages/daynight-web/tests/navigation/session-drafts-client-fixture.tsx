import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { createSessionApi } from '../../src/api/sessions';
import { TaskSessionClient } from '../../src/features/task-agent-session/client';
import { SessionView } from '../../src/features/task-agent-session/SessionView';
import { sessionFence } from '../../../daynight/src/session/protocol';
import { createDraftStorageProbe } from './session-drafts-storage-probe';
import '../../src/styles/app.css';

const userId = '00000071-1111-4111-8111-111111111111';
const projectId = '00000001-1111-4111-8111-111111111111', taskId = '00000002-1111-4111-8111-111111111111', claimId = '00000003-1111-4111-8111-111111111111';
const errors: string[] = [], onPrincipalMismatch = () => { errors.push('principal mismatch'); };
const client = new TaskSessionClient({ api: createSessionApi(projectId, taskId, userId, onPrincipalMismatch), projectId, taskId, claimId, ownerUserId: userId, userId, isCurrent: () => true, onPrincipalMismatch, storage: sessionStorage });
window.sessionDraftClient = { client, errors, storage: createDraftStorageProbe(() => {
  const snapshot = client.snapshot().state.snapshot; if (!snapshot) throw new Error('The Session snapshot is not ready.');
  return { target: { serverOrigin: location.origin, actorUserId: userId, fence: sessionFence(snapshot), expectedNativeSessionId: snapshot.identity.nativeSessionId }, resolver: { kind: 'task', projectId, taskId } };
}) };
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><SessionView client={client} userId={userId} active current /></LocaleProvider>);
client.setCurrentReadVisible(true);
void client.start();
declare global { interface Window { sessionDraftClient: { readonly client: TaskSessionClient; readonly errors: string[]; readonly storage: ReturnType<typeof createDraftStorageProbe> } } }
