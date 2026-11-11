import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type FocusEvent } from 'react';
import { browserNavigation, type WorkerConfigurationDraftScope } from '../../../app/navigation';
import { parseAuthRoute } from '../../../app/router';
import { useI18n } from '../../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { TaskConfirmation } from '../../task-detail/TaskConfirmation';
import { dialogFocusables } from '../../task-detail/focus';

type Editor = 'configuration' | 'prompt';

/** Both editors share one navigation scope, even when either panel is hidden. */
export const useWorkerConfigurationNavigation = ({ workerId, configurationDirty, promptDirty, unavailable, discard, section, onContinueEditing }: {
  readonly workerId: string;
  readonly configurationDirty: boolean;
  readonly promptDirty: boolean;
  readonly unavailable: boolean;
  readonly discard: () => void;
  readonly section: 'overview' | Editor;
  readonly onContinueEditing: (editor: Editor) => void;
}) => {
  const identity = useTaskCacheScope(), navigation = browserNavigation();
  const scope = useMemo<WorkerConfigurationDraftScope>(() => ({ kind: 'worker-configuration', identity, workerId }), [identity, workerId]);
  const current = useRef({ configurationDirty, promptDirty, unavailable, discard }); current.current = { configurationDirty, promptDirty, unavailable, discard };
  const owner = useRef<HTMLDivElement>(null), fallback = useRef<HTMLElement>(null);
  const editors = useRef<Partial<Record<Editor, HTMLElement>>>({});
  const lastEdited = useRef<Editor>('configuration'), restoreFocus = useRef<Editor | null>(null);
  useLayoutEffect(() => {
    if (unavailable) return;
    const unregister = navigation.register({ scope, signal: identity.signal,
      isDirty: () => !identity.isInvalidated && !current.current.unavailable && (current.current.configurationDirty || current.current.promptDirty),
      discard: () => current.current.discard(),
      survives: url => { const route = parseAuthRoute(url.pathname, url.search); return route.kind === 'worker' && route.workerId === workerId; },
    });
    return () => {
      if (current.current.unavailable) navigation.retireScope(scope);
      unregister();
    };
  }, [scope, identity, workerId, unavailable, navigation]);
  const decision = useSyncExternalStore(navigation.subscribeDecision, navigation.decision);
  const confirming = decision?.drafts.some(draft => draft.scope === scope) === true;
  useLayoutEffect(() => {
    const targetSection = restoreFocus.current;
    if (targetSection === null || confirming || section !== targetSection) return;
    restoreFocus.current = null;
    if (unavailable || identity.isInvalidated) return;
    const panel = owner.current?.querySelector<HTMLElement>(`[data-worker-panel="${targetSection}"]`);
    const fields = panel == null ? [] : dialogFocusables(panel).filter(element => element.matches('input, textarea, select'));
    const target = fields.find(element => element === editors.current[targetSection]) ?? fields[0];
    target?.focus();
  }, [confirming, section, unavailable, identity]);
  const rememberFocus = (editor: Editor, event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select')) editors.current[editor] = event.target;
  };
  const destination = () => configurationDirty && !promptDirty ? 'configuration' : promptDirty && !configurationDirty ? 'prompt' : lastEdited.current;
  const { messages: { workers: { configuration: m }, inspection: { draftNavigation: shared } } } = useI18n();
  const confirmation = !confirming ? null : <TaskConfirmation title={shared.title} question={m.leaveQuestion} explanation={m.leaveExplanation}
    taskTitle={workerId} confirmLabel={shared.discard} cancelLabel={shared.keep} closeLabel={shared.close} destructive
    owner={owner} fallbackFocus={fallback} onRestoreFocus={() => { restoreFocus.current = destination(); }}
    onCancel={() => { const target = destination(); navigation.cancelAndRestore(() => onContinueEditing(target)); }} onConfirm={navigation.confirm} />;
  return { owner, rememberFocus, markEdited: (editor: Editor) => { lastEdited.current = editor; }, confirming, confirmation };
};
