import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type FocusEvent } from 'react';
import { browserNavigation, type WorkerConfigurationDraftScope } from '../../../app/navigation';
import { parseAuthRoute } from '../../../app/router';
import { useI18n } from '../../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { TaskConfirmation } from '../../task-detail/TaskConfirmation';
import { dialogFocusables } from '../../task-detail/focus';

/** The configuration remains a draft owner while its tab is hidden. */
export const useWorkerConfigurationNavigation = ({ workerId, dirty, unavailable, discard, visible, onContinueEditing }: {
  readonly workerId: string;
  readonly dirty: boolean;
  readonly unavailable: boolean;
  readonly discard: () => void;
  readonly visible: boolean;
  readonly onContinueEditing?: () => void;
}) => {
  const identity = useTaskCacheScope(), navigation = browserNavigation();
  const scope = useMemo<WorkerConfigurationDraftScope>(() => ({ kind: 'worker-configuration', identity, workerId }), [identity, workerId]);
  const current = useRef({ dirty, unavailable, discard }); current.current = { dirty, unavailable, discard };
  const owner = useRef<HTMLDivElement>(null), editor = useRef<HTMLElement>(null), restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (unavailable) return;
    const unregister = navigation.register({ scope, signal: identity.signal,
      isDirty: () => !identity.isInvalidated && !current.current.unavailable && current.current.dirty,
      discard: () => current.current.discard(),
      survives: url => { const route = parseAuthRoute(url.pathname, url.search); return route.kind === 'worker' && route.workerId === workerId; },
    });
    return () => {
      // A proven missing resource retires an arrived history choice before
      // unregistering; cleanup alone cannot authorize adopting its destination.
      if (current.current.unavailable) navigation.retireScope(scope);
      unregister();
    };
  }, [scope, identity, workerId, unavailable, navigation]);
  const decision = useSyncExternalStore(navigation.subscribeDecision, navigation.decision);
  const confirming = decision?.drafts.some(draft => draft.scope === scope) === true;
  useLayoutEffect(() => {
    if (!restoreFocus.current || confirming || !visible) return;
    restoreFocus.current = false;
    if (unavailable || identity.isInvalidated) return;
    const fields = owner.current === null ? [] : dialogFocusables(owner.current).filter(element => element.matches('input, textarea, select'));
    const target = fields.find(element => element === editor.current) ?? fields[0];
    target?.focus();
  }, [confirming, visible, unavailable, identity]);
  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select')) editor.current = event.target;
  };
  const { messages: { workers: { configuration: m }, inspection: { draftNavigation: shared } } } = useI18n();
  const confirmation = !confirming ? null : <TaskConfirmation title={shared.title} question={m.leaveQuestion} explanation={m.leaveExplanation}
    taskTitle={workerId} confirmLabel={shared.discard} cancelLabel={shared.keep} closeLabel={shared.close} destructive
    owner={owner} fallbackFocus={editor} onRestoreFocus={() => { restoreFocus.current = true; }}
    onCancel={() => { navigation.cancel(); onContinueEditing?.(); }} onConfirm={navigation.confirm} />;
  return { owner, rememberFocus, confirming, confirmation };
};
