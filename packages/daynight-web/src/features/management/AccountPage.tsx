import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import type { CurrentUser } from "../../api/auth";
import { browserNavigation, type PromptDraftScope } from "../../app/navigation";
import { useAccountHistory } from "../../app/use-page-history";
import { parseAuthRoute } from "../../app/router";
import { useI18n } from "../../i18n/LocaleProvider";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { TaskConfirmation } from "../task-detail/TaskConfirmation";
import { promptMessages } from "../worker-prompts/messages";
import { useWorkerPrompt } from "../worker-prompts/useWorkerPrompt";
import { WorkerPromptEditor } from "../worker-prompts/WorkerPromptEditor";
import { Identity } from "./feedback";
import { TokensPanel } from "./TokensPanel";
import { OwnerGrantsPanel } from "./OwnerGrantsPanel";
import { CredentialClockProvider } from "./CredentialLastUse";

type AccountPageProps = { readonly user: CurrentUser; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly active?: boolean; readonly onRetentionChange?: (retain: boolean) => void };

export const usePromptNavigation = (target: { readonly scope: 'user' } | { readonly scope: 'project'; readonly projectId: string }, state: { readonly dirty: boolean; readonly unavailable: boolean; readonly abandon: () => void }, options: { readonly visible?: boolean; readonly onContinueEditing?: () => void; readonly survives?: (destination: URL) => boolean } = {}) => {
  const identity = useTaskCacheScope(), navigation = browserNavigation();
  const projectId = target.scope === 'project' ? target.projectId : null;
  const scope = useMemo<PromptDraftScope>(() => projectId === null ? { kind: 'user-prompt', identity } : { kind: 'project-prompt', identity, projectId }, [identity, projectId]);
  const current = useRef(state); current.current = state;
  const owner = useRef<HTMLDivElement>(null), editor = useRef<HTMLElement>(null), restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (state.unavailable) return;
    const unregister = navigation.register({ scope, signal: identity.signal,
      isDirty: () => !identity.isInvalidated && !current.current.unavailable && current.current.dirty,
      discard: () => current.current.abandon(),
      survives: url => { if (options.survives) return options.survives(url); const route = parseAuthRoute(url.pathname, url.search); return projectId === null ? route.kind === 'account' : route.kind === 'settings' && route.projectId === projectId; },
    });
    return () => { if (current.current.unavailable) navigation.retireScope(scope); unregister(); };
  }, [scope, identity, navigation, projectId, state.unavailable, options.survives]);
  const decision = useSyncExternalStore(navigation.subscribeDecision, navigation.decision);
  const confirming = decision?.drafts.some(draft => draft.scope === scope) === true;
  useLayoutEffect(() => {
    if (!restoreFocus.current || confirming || options.visible === false) return;
    restoreFocus.current = false;
    if (!identity.isInvalidated && !state.unavailable) editor.current?.focus();
  }, [confirming, options.visible, identity, state.unavailable]);
  const { locale, messages: { inspection: { draftNavigation: shared } } } = useI18n();
  const m = promptMessages(locale);
  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => { if (event.target instanceof HTMLElement && event.target.matches('textarea')) editor.current = event.target; };
  const confirmation = !confirming ? null : <TaskConfirmation title={shared.title} question={m.leaveQuestion} explanation={m.leaveExplanation} taskTitle="" confirmLabel={shared.discard} cancelLabel={shared.keep} closeLabel={shared.close} destructive owner={owner} fallbackFocus={editor} onRestoreFocus={() => { restoreFocus.current = true; }} onCancel={() => navigation.cancelAndRestore(options.onContinueEditing)} onConfirm={navigation.confirm} />;
  return { owner, rememberFocus, confirmation };
};

export const AccountPage = (props: AccountPageProps) => <AccountContent key={props.user.id} {...props} />;

const AccountContent = ({ user, onSignOut, onIdentityMismatch, active = true, onRetentionChange }: AccountPageProps) => {
  const { locale, messages: { auth: { management: { account: m } } } } = useI18n();
  const { tab, select: setTab, error: historyError } = useAccountHistory(user.id, active);
  const [tokensOpened, setTokensOpened] = useState(false);
  const prompt = useWorkerPrompt({ scope: 'user' }, { readEnabled: active });
  const navigation = usePromptNavigation({ scope: 'user' }, prompt, { visible: tab === 'prompt', onContinueEditing: () => setTab('prompt', true) });
  useLayoutEffect(() => { if (tab === "tokens") setTokensOpened(true); }, [tab]);
  useLayoutEffect(() => { onRetentionChange?.(prompt.pending || prompt.confirmed || prompt.uncertain); }, [onRetentionChange, prompt.pending, prompt.confirmed, prompt.uncertain]);
  return <div ref={navigation.owner} onFocusCapture={navigation.rememberFocus}>
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle}</p></div></div>
    {historyError && <div className="notice error" role="alert">{locale === "zh-CN" ? "页面导航状态无效。" : "Invalid page navigation state."}</div>}
    <div hidden={historyError} inert={historyError}><div className="settings-grid"><nav className="settings-nav" aria-label={m.title}>
      <button type="button" className={tab === "profile" ? "active" : ""} aria-current={tab === "profile" ? "page" : undefined} onClick={() => setTab("profile")}>{m.profileTab}</button>
      <button type="button" className={tab === "tokens" ? "active" : ""} aria-current={tab === "tokens" ? "page" : undefined} onClick={() => setTab("tokens")}>{m.tokensTab}</button>
      <button type="button" className={tab === "prompt" ? "active" : ""} aria-current={tab === "prompt" ? "page" : undefined} onClick={() => setTab("prompt")}>{promptMessages(locale).titles.user}</button>
    </nav><div className="settings-main">
      <div hidden={tab !== "profile"} inert={tab !== "profile"}><section className="panel"><div className="panel-body"><div className="profile-info"><Identity user={user} /></div><dl className="info-list"><dt>{m.loginMethod}</dt><dd>{m.viaUniAuth}</dd><dt>{m.profileSource}</dt><dd>{m.profileSourceDescription}</dd></dl></div></section><section className="panel"><div className="panel-heading"><div><h2>{m.sessionTitle}</h2><p>{m.sessionDescription}</p></div><button className="button" type="button" onClick={onSignOut}>{m.signOut}</button></div></section></div>
      {(tokensOpened || tab === "tokens") && <div hidden={tab !== "tokens"} inert={tab !== "tokens"}><CredentialClockProvider visible={active && !historyError && tab === "tokens"}><TokensPanel user={user} onIdentityMismatch={onIdentityMismatch} visible={active && !historyError && tab === "tokens"} /><OwnerGrantsPanel user={user} onIdentityMismatch={onIdentityMismatch} visible={active && !historyError && tab === "tokens"} /></CredentialClockProvider></div>}
      <div hidden={tab !== "prompt"} inert={tab !== "prompt"}><WorkerPromptEditor state={prompt} scope="user" /></div>
    </div></div></div>
    {navigation.confirmation}
  </div>;
};
