import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { TaskCacheProvider, createTaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { MyTasksPage } from '../../src/features/my-tasks/MyTasksPage';
import '../../src/styles/app.css';
import '../../src/styles/auth.css';

const scope = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000011', onIdentityMismatch: () => { throw new Error('Unexpected account'); } });
window.addEventListener('pagehide', () => scope.dispose(), { once: true });
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TaskCacheProvider scope={scope}><main style={{ padding: 16 }}><LanguageSelector /><MyTasksPage /></main></TaskCacheProvider></LocaleProvider>);
