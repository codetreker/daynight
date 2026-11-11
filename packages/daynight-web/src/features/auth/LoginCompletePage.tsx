import { useEffect, useRef } from "react";
import { AccountSessionProvider, useAccountSession } from "../../app/AccountSessionProvider";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { AccountChangeBanner } from "./AccountChangeBanner";
import { parseLoginCompletionTarget } from "./login-completion";

const replaceLocation = (target: string) => window.location.replace(target);

function Completion({ target, replace }: { readonly target: string; readonly replace: (target: string) => void }) {
  const { session, sync, requiresRefresh, retryInitialization, retryPublication } = useAccountSession();
  const { messages: { auth: { completion: m, shell } } } = useI18n();
  const navigated = useRef(false);
  useEffect(() => {
    if (!navigated.current && !requiresRefresh && session.status === "authenticated" && sync.status === "complete") {
      navigated.current = true;
      replace(target);
    }
  }, [requiresRefresh, session.status, sync.status, replace, target]);

  return <div className="invite-page device-page">
    <header className="topbar"><a className="brand" href="/" aria-label="Daynight"><span className="brand-mark" aria-hidden="true" />daynight</a><AccountChangeBanner active={requiresRefresh} onReload={() => window.location.reload()} /></header>
    <main className="invite-card device-card" aria-labelledby="completion-title"><LanguageSelector /><h1 id="completion-title">{m.title}</h1>
      {requiresRefresh ? <p>{m.refreshRequired}</p> : session.status === "error" ? <div className="notice error" role="alert"><p>{shell.identityError}</p><button className="button" type="button" onClick={retryInitialization}>{shell.networkRetry}</button></div>
        : session.status === "anonymous" ? <div className="notice warning" role="status"><p>{shell.notice.expired}</p><a className="button" href="/login">{shell.startFreshLogin}</a></div>
        : session.status === "authenticated" && sync.status === "error" ? <div className="notice error" role="alert"><p>{m.syncError}</p><button className="button" type="button" onClick={retryPublication}>{m.retrySync}</button></div>
        : <p role="status"><span className="spinner" aria-hidden="true" />{m.loading}</p>}
    </main>
  </div>;
}

export function LoginCompletePage({ replace = replaceLocation }: { readonly replace?: (target: string) => void }) {
  const target = parseLoginCompletionTarget(window.location.search, window.location.href.includes("#") ? "#" : "");
  const { messages: { auth: { shell } } } = useI18n();
  if (target === null) return <div className="invite-page"><main className="invite-card"><LanguageSelector /><h1>{shell.invalidLoginTarget}</h1><p>{shell.invalidLoginTargetDetail}</p><a className="button" href="/login">{shell.startFreshLogin}</a></main></div>;
  return <AccountSessionProvider><Completion target={target} replace={replace} /></AccountSessionProvider>;
}
