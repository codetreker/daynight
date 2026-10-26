import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { SetupGuidePage } from "./SetupGuidePage";
import "../../styles/auth.css";

export const SetupGuideShell = () => {
  const { locale, messages: { auth: { shell: m }, workspace: { app }, setup } } = useI18n();
  const content = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.documentTitle.setup;
  }, [locale, m.documentTitle.setup]);
  useLayoutEffect(() => { content.current!.focus(); }, []);
  return <div className="auth-shell">
    <div className="workspace">
      <a className="skip-link" href="#main-content">{app.skipToContent}</a>
      <header className="topbar">
        <nav className="crumb" aria-label={app.breadcrumb}><a href="/projects">{app.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current" aria-current="page">{setup.navigation}</span></nav>
        <div className="account-actions"><LanguageSelector /></div>
      </header>
      <main className="content" id="main-content" ref={content} tabIndex={-1}><SetupGuidePage /></main>
    </div>
  </div>;
};
