import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GitHubAppGrants } from '../../src/features/github-app-grants/GitHubAppGrants';
import { createTaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import '../../src/styles/app.css';

const userId = '00000000-0000-4000-8000-000000000001';
const appId = '00000000-0000-4000-8000-000000000021';
const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => {} });
const FocusFixture = () => {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const update = (event: Event) => setBlocked((event as CustomEvent<boolean>).detail);
    window.addEventListener('test-admission-blocked', update);
    return () => { window.removeEventListener('test-admission-blocked', update); };
  }, []);
  return <GitHubAppGrants appId={appId} active admission={scope} admissionBlocked={blocked} accessDenied={false} onIdentityMismatch={() => {}} onUnavailable={() => {}} />;
};
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><FocusFixture /></LocaleProvider>);
