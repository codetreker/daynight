import { useEffect, useState } from "react";
import { getAuthConfig } from "../../api/auth";
import type { AuthProvider } from "../../api/auth-types";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { isAbortError } from "../../api/client";

const providerLabels: Readonly<Record<AuthProvider, string>> = { microsoft: "Microsoft", google: "Google", github: "GitHub" };
const providerMarks: Readonly<Record<AuthProvider, string>> = { microsoft: "⊞", google: "G", github: "◉" };

export type LoginPageProps = {
  readonly invitation?: boolean;
  readonly device?: boolean;
  readonly notice?: string;
  readonly onLogin: (provider: AuthProvider) => void;
};

export const LoginPage = ({ invitation = false, device = false, notice, onLogin }: LoginPageProps) => {
  const { messages: { auth: { login: m }, workspace: { app, projects } } } = useI18n();
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; providers: readonly AuthProvider[] }>({ status: "loading", providers: [] });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<AuthProvider | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", providers: [] });
    void getAuthConfig(controller.signal).then((config) => {
      if (!controller.signal.aborted) setState({ status: "ready", providers: config.providers });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbortError(error)) setState({ status: "error", providers: [] });
    });
    return () => controller.abort();
  }, [attempt]);
  return <div className="auth-page">
    <aside className="auth-aside"><a className="brand" href="/" aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a>
      <div className="auth-copy"><h2>{m.heroTitleFirst}<br />{m.heroTitleSecond}</h2><p>{m.heroDetail}</p><div className="auth-visual" aria-hidden="true">{m.milestones.map((milestone) => <span key={milestone}>{milestone}</span>)}</div></div><p className="auth-caption">{m.heroCaption}</p></aside>
    <main className="auth-main"><section className="auth-card"><LanguageSelector /><p className="eyebrow">{m.welcome}</p><h1>{m.title}</h1><p className="subtitle">{invitation ? m.inviteSubtitle : device ? m.deviceSubtitle : m.subtitle}</p>
      {notice !== undefined && <div className="notice warning" role="status"><p>{notice}</p></div>}
      {state.status === "loading" && <p role="status"><span className="spinner" aria-hidden="true" />{m.providersLoading}</p>}
      {state.status === "error" && <div className="notice error" role="alert"><p>{m.providersError}</p><button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button></div>}
      {state.status === "ready" && state.providers.length === 0 && <div className="notice error" role="alert"><p>{m.providersEmpty}</p></div>}
      <div className="provider-list">{state.providers.map((provider) => <button key={provider} className="provider-button" type="button" disabled={selected !== null} onClick={() => { setSelected(provider); onLogin(provider); }}><span className="provider-icon" aria-hidden="true">{selected === provider ? <span className="spinner" /> : providerMarks[provider]}</span><span>{selected === provider ? m.redirecting : m.providerButton({ provider: providerLabels[provider] })}</span></button>)}</div>
      <p className="auth-note">{m.noteFirst}<br />{m.noteSecond}</p>{selected !== null && <p className="invite-status" role="status">{m.redirectStatus}</p>}
    </section></main>
  </div>;
};
