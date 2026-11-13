import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { PullRequestDetailDialog } from '../../src/features/pull-request-detail/PullRequestDetailDialog';
import '../../src/styles/app.css';
import '../../src/styles/auth.css';
import '../../src/styles/markdown.css';

const userId = '00000000-0000-4000-8000-000000000011';
const projectId = '00000000-0000-4000-8000-000000000031';

function Host() {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  (window as unknown as { refreshPrDetail: () => void }).refreshPrDetail = () => setRefresh(value => value + 1);
  return <><button type="button" onClick={() => setOpen(true)}>Open PR</button>{open && <PullRequestDetailDialog
    userId={userId} projectId={projectId} number="1248" canRead active refreshKey={refresh}
    onPrincipalMismatch={() => { throw new Error('Unexpected principal'); }} onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Host /></LocaleProvider>);
