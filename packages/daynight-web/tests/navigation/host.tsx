import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useBrowserLocation } from '../../src/app/browser-location';
import { browserNavigation } from '../../src/app/navigation';
import { navigate, parseRoute, replaceRoute, taskDetailUrl } from '../../src/app/router';
import { DraftNavigationConfirmation } from '../../src/features/task-detail/TaskDraftNavigation';
import { AttachmentDeleteDialog, type AttachmentActionTarget } from '../../src/features/task-detail/attachments/AttachmentActions';
import { ThreadMessageDetails } from '../../src/features/task-thread/ThreadMessageDetails';
import type { ThreadMessage } from '../../src/features/task-thread/contract';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import '../../src/styles/app.css';
import '../../src/styles/task-detail.css';
import '../../src/styles/task-discussion.css';
import '../../src/styles/attachments.css';

const projectId = 'a0000000-0000-0000-0000-000000000001';
const firstId = 'b0000000-0000-0000-0000-000000000001';
const secondId = 'b0000000-0000-0000-0000-000000000002';
const first = taskDetailUrl(projectId, firstId, { tab: 'overview', path: null });
const second = taskDetailUrl(projectId, secondId, { tab: 'overview', path: null });
const owner = browserNavigation();
const counters = { discards: 0, unmounts: 0, actions: 0 };
const message: ThreadMessage = {
  id: 'c0000000-0000-0000-0000-000000000001',
  author: { userId: 'd0000000-0000-0000-0000-000000000001', displayName: 'Browser editor', Agent: false },
  body: 'Message metadata fixture', createdAt: '2026-11-04T00:00:00.000000Z',
};

declare global {
  interface Window {
    navigationHost: {
      readonly counters: typeof counters;
      retire(): void;
      navigate(url: string): void;
      replace(url: string): void;
      confirm(): void;
      cancel(): void;
      pending(): boolean;
    };
  }
}

type Identity = { readonly token: object; readonly lifetime: AbortController };

// The host supplies only an editor and its lifetime. Routing, admission,
// confirmation and history restoration are imported from production modules.
const Draft = ({ taskId, identity, page, close, relation }: {
  readonly taskId: string;
  readonly identity: Identity;
  readonly page: boolean;
  readonly close: () => void;
  readonly relation: () => void;
}) => {
  const { messages: { inspection: { discussion } } } = useI18n();
  const [value, setValue] = useState('');
  const current = useRef(value);
  current.current = value;
  const container = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [metadata, setMetadata] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentActionTarget | null>(null);
  const metadataOpen = useRef(false);
  const scope = useMemo(() => ({ identity: identity.token, projectId, taskId }), [identity, taskId]);

  useLayoutEffect(() => {
    const unregister = owner.register({
      scope,
      isDirty: () => current.current !== '',
      discard: () => { counters.discards++; current.current = ''; setValue(''); },
      survives: (url) => {
        if (!page) return false;
        const destination = parseRoute(url.pathname, url.search);
        return (destination.kind === 'task' || destination.kind === 'attachment') && destination.projectId === projectId && destination.taskId === taskId;
      },
      signal: identity.lifetime.signal,
    });
    return () => { counters.unmounts++; unregister(); };
  }, [scope, identity, page, taskId]);

  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || metadataOpen.current || owner.decision() !== null || event.key !== 'Escape') return;
      event.preventDefault();
      if (fullscreen) setFullscreen(false);
      else owner.requestAction(close);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [fullscreen, close]);

  return <>
    <section ref={container} data-testid="surface" style={{ padding: 16, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <h1 data-testid="task-id" tabIndex={-1}>{taskId}</h1>
      <label>Draft<textarea aria-label="Draft" ref={editor} value={value} onChange={(event) => setValue(event.target.value)} style={{ display: 'block', width: '100%', minHeight: 100 }} /></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="button" onClick={() => navigate(second)}>Program navigation</button>
        <button type="button" className="button" onClick={() => replaceRoute(second)}>Replace navigation</button>
        <button type="button" className="button" onClick={() => owner.requestAction(relation)}>Relation</button>
        <button type="button" className="button" onClick={() => owner.requestAction(close)}>Close</button>
        <button type="button" className="button" onClick={() => navigate(`${first}?tab=discussion`)}>Same Task tab</button>
        <button type="button" className="button" onClick={() => navigate(`${first}/attachments/readme.md`)}>Same Task attachment</button>
        <button type="button" className="button" onClick={() => setFullscreen(true)}>Fullscreen</button>
        <button type="button" className="button" onClick={() => setMetadata(true)}>Message details</button>
        <button type="button" className="button" onClick={(event) => setAttachment({ path: 'readme.md', trigger: event.currentTarget })}>Delete attachment</button>
        <a href="/outside">Document departure</a>
      </div>
      <output data-testid="fullscreen">{String(fullscreen)}</output>
      <LanguageSelector />
    </section>
    {metadata && <ThreadMessageDetails message={message} messages={discussion} owner={container} fallbackFocus={editor}
      onClose={() => setMetadata(false)} onOpenChange={(open) => { metadataOpen.current = open; }}
      canRestoreFocus={() => !identity.lifetime.signal.aborted} />}
    {attachment !== null && <AttachmentDeleteDialog target={attachment} busy={false} error={null} fallback={editor}
      onConfirm={() => { counters.actions++; }} onDismiss={() => setAttachment(null)} />}
    <DraftNavigationConfirmation owner={container} fallbackFocus={editor} taskTitle="Task with an unsaved draft · 未保存的任务草稿" />
  </>;
};

const Host = () => {
  const location = useBrowserLocation();
  const route = parseRoute(location.pathname, location.search);
  const [identity, setIdentity] = useState<Identity>(() => ({ token: {}, lifetime: new AbortController() }));
  const [modalTask, setModalTask] = useState<string | null>(null);
  const [retired, setRetired] = useState(false);
  const taskId = route.kind === 'task' || route.kind === 'attachment' ? route.taskId : modalTask;
  window.navigationHost = {
    counters,
    retire: () => { identity.lifetime.abort(); setRetired(true); },
    navigate,
    replace: replaceRoute,
    confirm: () => owner.confirm(),
    cancel: () => owner.cancel(),
    pending: () => owner.decision() !== null,
  };
  const close = () => { counters.actions++; if (modalTask !== null) setModalTask(null); else navigate(`/projects/${projectId}`); };
  const relation = () => { counters.actions++; if (modalTask !== null) setModalTask(secondId); else navigate(second); };
  return <>
    <output data-testid="accepted">{location.pathname}{location.search}{location.hash}</output>
    <output data-testid="retired">{String(retired)}</output>
    {!retired && taskId !== null ? <Draft key={`${taskId}/${String(modalTask !== null)}`} taskId={taskId} identity={identity} page={modalTask === null} close={close} relation={relation} /> : <>
      <button type="button" onClick={() => navigate(first)}>Open first Task</button>
      <button type="button" onClick={() => setModalTask(firstId)}>Open modal Task</button>
      <button type="button" onClick={() => { setRetired(false); setIdentity({ token: {}, lifetime: new AbortController() }); }}>New identity</button>
    </>}
  </>;
};

createRoot(document.getElementById('root')!).render(<LocaleProvider initial={resolveInitialLocale()}><Host /></LocaleProvider>);
