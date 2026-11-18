import { createRoot } from 'react-dom/client';
import { ProjectGitHubConsumption } from '../../src/features/github-integration/ProjectGitHubConsumption';
import { useProjectManagementGuard } from '../../src/features/management/ProjectManagementGuard';
import { ProjectAccessBoundary } from '../../src/features/projects/ProjectAccess';
import { createTaskCacheScope, TaskCacheProvider } from '../../src/features/task-cache/TaskCacheProvider';
import { TeamGitHubApps } from '../../src/features/teams/TeamGitHubApps';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import '../../src/styles/app.css';

const userId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000101';
const teamId = '00000000-0000-4000-8000-000000000011';
const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => {} });
window.addEventListener('pagehide', () => scope.dispose(), { once: true });
const Subject = () => {
  const guard = useProjectManagementGuard();
  return <><TeamGitHubApps teamId={teamId} admission={scope} onIdentityMismatch={scope.principalMismatch} /><ProjectAccessBoundary projectId={projectId} initialRead><ProjectGitHubConsumption projectId={projectId} userId={userId} repoUrl="https://github.com/example/project" active onRoute guard={guard} /></ProjectAccessBoundary></>;
};
const locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale, issue: null }}><TaskCacheProvider scope={scope}><Subject /></TaskCacheProvider></LocaleProvider>);
