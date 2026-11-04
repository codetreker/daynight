import { useEffect, useRef, useState } from "react";
import { acceptInvitation, getProjectAccess, inspectInvitation } from "../../api/auth";
import type { CurrentUser, InvitationInspection } from "../../api/auth-types";
import { ApiError, isAbortError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import type { PendingInvitation } from "./invitation";

const invitationUnavailable = (error: unknown): boolean => error instanceof ApiError && error.kind === "server" && error.code === "invitation_unavailable" && (error.status === 404 || error.status === 410);

type InspectionState = { readonly status: "loading" } | { readonly status: "error"; readonly error: unknown } | { readonly status: "ready"; readonly inspection: InvitationInspection };

export const InvitationPage = ({ invitation, lifetime, user, onComplete, onCancel, onSwitchAccount, onUnavailable, onIdentityMismatch }: {
  readonly invitation: PendingInvitation;
  readonly lifetime: AbortSignal;
  readonly user: CurrentUser;
  readonly onComplete: (projectId: string) => void;
  readonly onCancel: () => void;
  readonly onSwitchAccount: () => void;
  readonly onUnavailable: () => void;
  readonly onIdentityMismatch: () => void;
}) => {
  const { messages: { auth: { invitation: m, shell, roles }, workspace: { app, projects } } } = useI18n();
  const [state, setState] = useState<InspectionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false);
  const [observedUnavailable, setObservedUnavailable] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (invitation.token === null) { setState({ status: "error", error: null }); return; }
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    setState({ status: "loading" });
    const token = invitation.token;
    void Promise.resolve().then(() => inspectInvitation(token, user.id, signal, onIdentityMismatch)).then((inspection) => {
      if (!signal.aborted) setState({ status: "ready", inspection });
    }).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return;
      setState({ status: "error", error });
      if (invitationUnavailable(error)) onUnavailable();
    });
    return () => controller.abort();
  }, [invitation.token, lifetime, user.id, attempt, onUnavailable, onIdentityMismatch]);
  useEffect(() => () => active.current?.abort(), []);
  const accept = () => {
    if (invitation.token === null || active.current !== null || state.status !== "ready" || uncertain) return;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([lifetime, controller.signal]);
    setAccepting(true); setAcceptError(null);
    const token = invitation.token;
    void Promise.resolve().then(() => acceptInvitation(token, state.inspection.projectId, user.id, signal, onIdentityMismatch)).then((member) => {
      if (!signal.aborted) onComplete(member.projectId);
    }).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return;
      if (invitationUnavailable(error)) { setState({ status: "error", error }); onUnavailable(); }
      else {
        setAcceptError(error);
        if (!(error instanceof ApiError) || error.kind !== "server" || error.status === null || error.status >= 500 || error.code === "write_outcome_unknown") setUncertain(true);
      }
      setAccepting(false);
    }).finally(() => { if (active.current === controller) active.current = null; });
  };
  const checkAccess = () => {
    if (active.current !== null || state.status !== "ready" || invitation.token === null) return;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([lifetime, controller.signal]);
    const inspection = state.inspection, token = invitation.token;
    setAccepting(true);
    void (async () => {
      let access;
      try { access = await getProjectAccess(inspection.projectId, signal, { userId: user.id, onPrincipalMismatch: onIdentityMismatch }); }
      catch (error) { if (!(error instanceof ApiError) || error.kind !== "server" || error.status !== 404 || error.code !== "not_found") throw error; access = null; }
      if (access?.directGrant !== null && access?.directGrant !== undefined) {
        return { ...inspection, directGrant: access.directGrant, access };
      }
      return inspectInvitation(token, user.id, signal, onIdentityMismatch);
    })().then((current) => {
      if (!signal.aborted) { setState({ status: "ready", inspection: current }); }
    }).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return;
      if (invitationUnavailable(error)) setObservedUnavailable(true);
      else setAcceptError(error);
    }).finally(() => { if (active.current === controller) active.current = null; if (!signal.aborted) setAccepting(false); });
  };
  const unavailable = state.status === "error" && (state.error === null || invitationUnavailable(state.error));
  return <div className="invite-page"><a className="brand" href="/projects" onClick={(event) => { event.preventDefault(); onCancel(); }} aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a><main className="invite-card"><LanguageSelector />
    {state.status === "loading" && <div role="status"><span className="spinner" aria-hidden="true" /><h1>{m.loading}</h1></div>}
    {state.status === "error" && <><h1>{unavailable ? m.unavailable : m.loadError}</h1><p className="subtitle">{unavailable ? m.unavailableDetail : m.loadErrorDetail}</p>{!unavailable && <button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button>}<div className="invite-footer"><button className="button" type="button" onClick={onCancel}>{m.returnToProjects}</button></div></>}
    {state.status === "ready" && <><h1>{state.inspection.directGrant === null ? m.invited : m.alreadyMember}</h1><p className="subtitle">{state.inspection.directGrant === null ? m.invitedDetail : m.alreadyMemberDetail}</p><section className="invited-project"><h2>{state.inspection.projectName}</h2><p>{state.inspection.directGrant === null ? m.memberRole : `${m.currentDirectRole}: ${roles[state.inspection.directGrant.role]}`}</p>{state.inspection.directGrant !== null && <p>{m.preserveDirect}</p>}{state.inspection.directGrant === null && state.inspection.access?.teamRole === "admin" && <p>{m.inheritedAdmin}</p>}<ul className="permission-list">{m.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul></section>
      <div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? shell.currentAccount}</p><p className="person-meta">{user.email ?? m.noEmail}</p></div></div><button className="inline-link" type="button" disabled={accepting} onClick={onSwitchAccount}>{m.switchAccount}</button></div>
        {acceptError !== null && <div className="notice error" role="alert"><p>{uncertain ? m.acceptUnknown : m.acceptError}</p>{uncertain && observedUnavailable && <p>{m.currentlyUnavailable}</p>}{uncertain && <button className="button" type="button" disabled={accepting} onClick={checkAccess}>{m.checkAccess}</button>}</div>}
        <button className="button primary" type="button" disabled={accepting || uncertain && state.inspection.directGrant === null} onClick={state.inspection.directGrant === null ? accept : () => onComplete(state.inspection.projectId)}>{accepting ? m.accepting : state.inspection.directGrant === null ? m.accept : m.open}</button><button className="inline-link" type="button" disabled={accepting} onClick={onCancel}>{m.cancel}</button>
      </div></>}
  </main></div>;
};
