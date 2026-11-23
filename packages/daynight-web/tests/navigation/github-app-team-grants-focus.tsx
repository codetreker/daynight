import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GitHubAppGrants } from '../../src/features/github-app-grants/GitHubAppGrants';
import { createTaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import '../../src/styles/app.css';

const userId = '00000000-0000-4000-8000-000000000001';
const appId = '00000000-0000-4000-8000-000000000021';
const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => {} });
const ready = scope.ready.bind(scope);
let publicationGate: Promise<void> | null = null, releasePublication: (() => void) | null = null;
scope.ready = async signal => {
  await ready(signal);
  if (publicationGate !== null) await publicationGate;
  signal.throwIfAborted();
};
const FocusFixture = () => {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const update = (event: Event) => setBlocked((event as CustomEvent<boolean>).detail);
    const publication = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail) publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
      else { releasePublication?.(); releasePublication = null; publicationGate = null; }
    };
    window.addEventListener('test-admission-blocked', update);
    window.addEventListener('test-publication-blocked', publication);
    return () => { window.removeEventListener('test-admission-blocked', update); window.removeEventListener('test-publication-blocked', publication); releasePublication?.(); };
  }, []);
  return <GitHubAppGrants appId={appId} active admission={scope} admissionBlocked={blocked} accessDenied={false} onIdentityMismatch={() => {}} onUnavailable={() => {}} />;
};
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><FocusFixture /></LocaleProvider>);
