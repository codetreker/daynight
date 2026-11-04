import { useEffect, useRef, useState } from "react";
import { acceptTeamInvitation, inspectTeamInvitation } from "../../api/auth";
import type { CurrentUser, TeamInvitationAcceptance, TeamInvitationInspection } from "../../api/auth-types";
import { ApiError, isAbortError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import type { PendingInvitation } from "./invitation";

const unavailable = (error: unknown): boolean => error instanceof ApiError && error.kind === "server" && error.code === "invitation_unavailable" && (error.status === 404 || error.status === 410);
type State = { readonly kind: "loading" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "ready"; readonly inspection: TeamInvitationInspection } | { readonly kind: "success"; readonly receipt: TeamInvitationAcceptance };

export const TeamInvitationPage = ({ invitation, lifetime, user, onAccepted, onCancel, onSwitchAccount, onUnavailable, onIdentityMismatch }: {
  readonly invitation: PendingInvitation; readonly lifetime: AbortSignal; readonly user: CurrentUser;
  readonly onAccepted: () => void; readonly onCancel: () => void; readonly onSwitchAccount: () => void;
  readonly onUnavailable: () => void; readonly onIdentityMismatch: () => void;
}) => {
  const { messages: { auth: { invitation: m, teamInvitation: team, shell, roles }, workspace: { app, projects } } } = useI18n();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false);
  const [observedUnavailable, setObservedUnavailable] = useState(false);
  const active = useRef<AbortController | null>(null);
  const completed = useRef(false);
  useEffect(() => {
    if (completed.current) return;
    if (invitation.token === null) { setState({ kind: "error", error: null }); return; }
    const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
    setState({ kind: "loading" });
    void inspectTeamInvitation(invitation.token, user.id, signal, onIdentityMismatch).then((inspection) => {
      if (!signal.aborted) setState({ kind: "ready", inspection });
    }).catch((failure: unknown) => {
      if (signal.aborted || isAbortError(failure)) return;
      setState({ kind: "error", error: failure });
      if (unavailable(failure)) onUnavailable();
    });
    return () => controller.abort();
  }, [invitation.token, lifetime, user.id, attempt, onUnavailable, onIdentityMismatch]);
  useEffect(() => () => active.current?.abort(), []);
  const accept = () => {
    if (state.kind !== "ready" || invitation.token === null || active.current !== null || uncertain) return;
    const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
    active.current = controller; setBusy(true); setError(null);
    void acceptTeamInvitation(invitation.token, state.inspection.team.id, user.id, signal, onIdentityMismatch).then((receipt) => {
      if (signal.aborted) return;
      completed.current = true;
      setBusy(false);
      setState({ kind: "success", receipt });
      onAccepted();
    }).catch((failure: unknown) => {
      if (signal.aborted || isAbortError(failure)) return;
      if (unavailable(failure)) { setState({ kind: "error", error: failure }); onUnavailable(); }
      else {
        setError(failure);
        if (!(failure instanceof ApiError) || failure.kind !== "server" || failure.status === null || failure.status >= 500 || failure.code === "write_outcome_unknown") setUncertain(true);
      }
    }).finally(() => { if (active.current === controller) active.current = null; if (!signal.aborted) setBusy(false); });
  };
  const check = () => {
    if (state.kind !== "ready" || invitation.token === null || active.current !== null) return;
    const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
    active.current = controller; setBusy(true);
    void inspectTeamInvitation(invitation.token, user.id, signal, onIdentityMismatch).then((inspection) => {
      if (!signal.aborted) setState({ kind: "ready", inspection });
    }).catch((failure: unknown) => {
      if (signal.aborted || isAbortError(failure)) return;
      if (unavailable(failure)) setObservedUnavailable(true);
      else setError(failure);
    }).finally(() => { if (active.current === controller) active.current = null; if (!signal.aborted) setBusy(false); });
  };
  const isUnavailable = state.kind === "error" && (state.error === null || unavailable(state.error));
  return <div className="invite-page"><a className="brand" href="/projects" onClick={(event) => { event.preventDefault(); if (!busy) onCancel(); }} aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a><main className="invite-card"><LanguageSelector />
    {state.kind === "loading" && <div role="status"><span className="spinner" aria-hidden="true" /><h1>{team.loading}</h1></div>}
    {state.kind === "error" && <><h1>{isUnavailable ? m.unavailable : m.loadError}</h1><p className="subtitle">{isUnavailable ? team.unavailableDetail : m.loadErrorDetail}</p>{!isUnavailable && <button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button>}<div className="invite-footer"><button className="button" type="button" onClick={onCancel}>{m.returnToProjects}</button></div></>}
    {state.kind === "success" && <><h1>{state.receipt.joined ? team.joined : team.alreadyJoined}</h1><section className="invited-project"><h2>{state.receipt.team.name}</h2><p>{team.teamId}: {state.receipt.team.id}</p><p>{team.currentRole}: {roles[state.receipt.membership.role]}</p><p>{user.name ?? shell.currentAccount} · {user.email ?? m.noEmail}</p></section><div className="invite-footer"><button className="button primary" type="button" onClick={onCancel}>{m.returnToProjects}</button></div></>}
    {state.kind === "ready" && <><h1>{state.inspection.membership === null ? team.invited : team.alreadyMember}</h1><p className="subtitle">{state.inspection.membership === null ? team.invitedDetail : team.alreadyMemberDetail}</p><section className="invited-project"><h2>{state.inspection.team.name}</h2><p>{team.teamId}: {state.inspection.team.id}</p><p>{state.inspection.membership === null ? team.memberRole : `${team.currentRole}: ${roles[state.inspection.membership.role]}`}</p></section>
      <div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? shell.currentAccount}</p><p className="person-meta">{user.email ?? m.noEmail}</p></div></div><button className="inline-link" type="button" disabled={busy} onClick={onSwitchAccount}>{m.switchAccount}</button></div>
        {error !== null && <div className="notice error" role="alert"><p>{uncertain ? team.acceptUnknown : m.acceptError}</p>{uncertain && observedUnavailable && <p>{m.currentlyUnavailable}</p>}{uncertain && <button className="button" type="button" disabled={busy} onClick={check}>{team.checkInvitation}</button>}</div>}
        <button className="button primary" type="button" disabled={busy || uncertain} onClick={accept}>{busy ? m.accepting : m.accept}</button><button className="inline-link" type="button" disabled={busy} onClick={onCancel}>{m.cancel}</button>
      </div></>}
  </main></div>;
};
