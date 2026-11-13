import { createRoot } from 'react-dom/client';
import { useLayoutEffect } from 'react';
import { useMyTasksHistory } from '../../src/app/use-page-history';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { TaskCacheProvider, createTaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { CurrentAccountProvider } from '../../src/app/CurrentAccountContext';
import { TaskAssigneesProvider } from '../../src/features/task-assignees/TaskAssignees';
import { TaskDetailSessionProvider } from '../../src/features/task-detail/TaskDetailSession';
import { MyTasksPage } from '../../src/features/my-tasks/MyTasksPage';
import '../../src/styles/app.css';
import '../../src/styles/auth.css';
import '../../src/styles/task-detail.css';

declare global { interface Window { selectMyTasksChild: (id: string) => void } }

const scope = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000011', onIdentityMismatch: () => { throw new Error('Unexpected account'); } });
if (location.pathname !== '/my-tasks') history.replaceState(null, '', '/my-tasks');
const ReadingControl = () => {
  const history = useMyTasksHistory(scope.userId, true, scope);
  useLayoutEffect(() => { window.selectMyTasksChild = id => {
    if (history.selection.detail !== null) history.select({ ...history.selection, detail: { ...history.selection.detail, goalChildren: { graphRootId: null, task: { id, navigation: { tab: 'overview', path: null } } } } });
  }; }, [history]);
  return null;
};
window.addEventListener('pagehide', () => scope.dispose(), { once: true });
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><CurrentAccountProvider user={{ id: scope.userId, name: null }} admissionBlocked={false}><TaskCacheProvider scope={scope}><TaskAssigneesProvider><TaskDetailSessionProvider><main style={{ padding: 16 }}><LanguageSelector /><ReadingControl /><MyTasksPage /></main></TaskDetailSessionProvider></TaskAssigneesProvider></TaskCacheProvider></CurrentAccountProvider></LocaleProvider>);
