import { useLayoutEffect, useState } from "react";
import { clearInvitation } from "../features/auth/invitation";
import { LoginCompletePage } from "../features/auth/LoginCompletePage";
import { OAuthStartErrorPage } from "../features/auth/OAuthStartErrorPage";
import { LandingPage } from "../features/landing/LandingPage";
import { SetupGuideShell } from "../features/setup/SetupGuideShell";
import { useI18n } from "../i18n/LocaleProvider";
import { AuthenticatedApp } from "./AuthenticatedApp";
import { AccountSessionProvider } from "./AccountSessionProvider";
import { useBrowserLocation } from "./browser-location";

const ApplicationRoutes = (props: { readonly navigateToLogin?: (url: string) => void }) => {
  const { pathname } = useBrowserLocation();
  const { messages: { auth: { shell: m } } } = useI18n();
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const publicPage = pathname === "/" || pathname === "/setup";
  useLayoutEffect(() => {
    if (publicPage) setCleanupFailed(!clearInvitation());
  }, [pathname, publicPage]);
  return <>{publicPage && cleanupFailed && <div className="notice warning" role="alert">{m.invitationCleanupError}</div>}{pathname === "/" ? <LandingPage /> : pathname === "/setup" ? <SetupGuideShell /> : pathname === "/oauth/authorize" ? <OAuthStartErrorPage /> : pathname === "/auth/complete" ? <LoginCompletePage /> : <AuthenticatedApp {...props} />}</>;
};

export const Application = (props: { readonly navigateToLogin?: (url: string) => void }) => <AccountSessionProvider><ApplicationRoutes {...props} /></AccountSessionProvider>;
