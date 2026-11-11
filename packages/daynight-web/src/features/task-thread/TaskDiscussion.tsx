import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import { authRequestsPaused } from '../../api/client';
import { useCurrentAccount } from '../../app/CurrentAccountContext';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { createThreadController } from './controller';
import { DiscussionComposer } from './DiscussionComposer';
import { DiscussionTimeline } from './DiscussionTimeline';
import { ThreadMessageDetails } from './ThreadMessageDetails';
import { useDirtyTaskDraft } from '../task-detail/TaskDraftNavigation';
import type { ThreadController } from './controller';
import '../../styles/task-discussion.css';

const DiscussionDraft = ({ controller }: { readonly controller: ThreadController }) => {
  useDirtyTaskDraft({ isDirty: () => { const view = controller.snapshot(); return view.draft !== '' || view.replyTo !== null; }, discard: () => { controller.setDraft(''); controller.setReply(null); } });
  return null;
};

export const TaskDiscussion = ({ projectId, taskId, active, owner, onDetailsOpenChange, parentUnavailable = false, trackDraft = false }: { readonly projectId: string; readonly taskId: string; readonly active: boolean; readonly owner: RefObject<HTMLElement | null>; readonly onDetailsOpenChange: (open: boolean) => void; readonly parentUnavailable?: boolean; readonly trackDraft?: boolean }) => {
  const account = useCurrentAccount(), cacheScope = useTaskCacheScope();
  const { messages: { inspection: { discussion: messages } } } = useI18n();
  const controller = useMemo(() => createThreadController({ scope: { userId: account.user.id, projectId, taskId }, lifetime: cacheScope.signal, ready: (signal) => cacheScope.ready(signal), principalMismatch: cacheScope.principalMismatch }), [account.user.id, projectId, taskId, cacheScope]);
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const timeline = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const current = useRef({ active, account, view }); current.current = { active, account, view };
  useLayoutEffect(() => { if (parentUnavailable) { controller.retire(); return; } controller.setAdmissionBlocked(account.admissionBlocked || authRequestsPaused()); controller.setDocumentVisible(document.visibilityState === 'visible'); controller.setActive(active); }, [controller, active, account.admissionBlocked, parentUnavailable]);
  useEffect(() => {
    const synchronize = () => { controller.setDocumentVisible(document.visibilityState === 'visible'); controller.setAdmissionBlocked(current.current.account.admissionBlocked || authRequestsPaused()); };
    const afterIdentityEvent = () => { synchronize(); queueMicrotask(synchronize); };
    document.addEventListener('visibilitychange', afterIdentityEvent); window.addEventListener('focus', afterIdentityEvent); window.addEventListener('blur', afterIdentityEvent);
    const unsubscribe = cacheScope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) controller.retire(); });
    return () => { unsubscribe(); controller.retire(); document.removeEventListener('visibilitychange', afterIdentityEvent); window.removeEventListener('focus', afterIdentityEvent); window.removeEventListener('blur', afterIdentityEvent); };
  }, [controller, cacheScope, projectId]);
  return <section className="task-discussion" aria-label={messages.title}>
    {trackDraft && <DiscussionDraft controller={controller} />}
    <DiscussionTimeline controller={controller} view={view} active={active} identity={`${account.user.id}/${projectId}/${taskId}`} timelineRef={timeline} inputRef={input} messages={messages} />
    {!view.retired && <DiscussionComposer controller={controller} view={view} account={account} active={active} inputRef={input} messages={messages} />}
    {view.detailsMessage !== null && active && <ThreadMessageDetails message={view.detailsMessage} messages={messages} owner={owner} fallbackFocus={timeline} onClose={controller.closeDetails} onOpenChange={onDetailsOpenChange} canRestoreFocus={() => current.current.active && !current.current.account.admissionBlocked && !controller.snapshot().retired && !current.current.view.authPaused && document.visibilityState === 'visible'} />}
  </section>;
};
