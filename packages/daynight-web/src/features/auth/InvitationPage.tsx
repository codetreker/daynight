import { useEffect, useRef, useState } from "react";
import { acceptInvitation, inspectInvitation } from "../../api/auth";
import type { CurrentUser, InvitationInspection } from "../../api/auth-types";
import { ApiError, isAbortError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import type { PendingInvitation } from "./invitation";

type InspectionState = { readonly status: "loading" } | { readonly status: "error"; readonly error: unknown } | { readonly status: "ready"; readonly inspection: InvitationInspection };

export const InvitationPage = ({ invitation, lifetime, user, onComplete, onCancel, onSwitchAccount, onUnavailable }: {
  readonly invitation: PendingInvitation;
  readonly lifetime: AbortSignal;
  readonly user: CurrentUser;
  readonly onComplete: (projectId: string) => void;
  readonly onCancel: () => void;
  readonly onSwitchAccount: () => void;
  readonly onUnavailable: () => void;
}) => {
  const { messages: { auth: { invitation: m, shell }, workspace: { app, projects } } } = useI18n();
  const [state, setState] = useState<InspectionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (invitation.token === null) { setState({ status: "error", error: null }); return; }
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    setState({ status: "loading" });
    const token = invitation.token;
    void Promise.resolve().then(() => inspectInvitation(token, signal)).then((inspection) => {
      if (!signal.aborted) setState({ status: "ready", inspection });
    }).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return;
      setState({ status: "error", error });
      if (error instanceof ApiError && (error.status === 410 || error.status === 404)) onUnavailable();
    });
    return () => controller.abort();
  }, [invitation.token, lifetime, user.id, attempt, onUnavailable]);
  useEffect(() => () => active.current?.abort(), []);
  const accept = () => {
    if (invitation.token === null || active.current !== null || state.status !== "ready") return;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([lifetime, controller.signal]);
    setAccepting(true); setAcceptError(null);
    const token = invitation.token;
    void Promise.resolve().then(() => acceptInvitation(token, signal)).then((member) => {
      if (!signal.aborted) onComplete(member.projectId);
    }).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return;
      if (error instanceof ApiError && (error.status === 410 || error.status === 404)) { setState({ status: "error", error }); onUnavailable(); }
      else setAcceptError(error);
      setAccepting(false);
    }).finally(() => { if (active.current === controller) active.current = null; });
  };
  const unavailable = state.status === "error" && (state.error === null || state.error instanceof ApiError && (state.error.status === 410 || state.error.status === 404));
  return <div className="invite-page"><a className="brand" href="/projects" onClick={(event) => { event.preventDefault(); onCancel(); }} aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a><main className="invite-card"><LanguageSelector />
    {state.status === "loading" && <div role="status"><span className="spinner" aria-hidden="true" /><h1>{m.loading}</h1></div>}
    {state.status === "error" && <><h1>{unavailable ? m.unavailable : m.loadError}</h1><p className="subtitle">{unavailable ? m.unavailableDetail : m.loadErrorDetail}</p>{!unavailable && <button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button>}<div className="invite-footer"><button className="button" type="button" onClick={onCancel}>{m.returnToProjects}</button></div></>}
    {state.status === "ready" && <><h1>{state.inspection.member === undefined ? m.invited : m.alreadyMember}</h1><p className="subtitle">{state.inspection.member === undefined ? m.invitedDetail : m.alreadyMemberDetail}</p><section className="invited-project"><h2>{state.inspection.projectName}</h2><p>{m.memberRole}</p><ul className="permission-list">{m.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul></section>
      <div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? shell.currentAccount}</p><p className="person-meta">{user.email ?? m.noEmail}</p></div></div><button className="inline-link" type="button" disabled={accepting} onClick={onSwitchAccount}>{m.switchAccount}</button></div>
        {acceptError !== null && <div className="notice error" role="alert"><p>{m.acceptError}</p></div>}
        <button className="button primary" type="button" disabled={accepting} onClick={state.inspection.member === undefined ? accept : () => onComplete(state.inspection.projectId)}>{accepting ? m.accepting : state.inspection.member === undefined ? m.accept : m.open}</button><button className="inline-link" type="button" disabled={accepting} onClick={onCancel}>{m.cancel}</button>
      </div></>}
  </main></div>;
};
