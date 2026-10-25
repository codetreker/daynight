import { useCallback, useEffect, useRef, useState } from "react";
import { decideDeviceAuthorization, inspectDeviceAuthorization } from "../../api/auth";
import { normalizeDeviceUserCode } from "../../api/auth-parse";
import type { CurrentUser, DeviceAuthorizationInspection } from "../../api/auth-types";
import { ApiError, isAbortError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";

export type DeviceAuthorizationApi = {
  readonly inspect: typeof inspectDeviceAuthorization;
  readonly decide: typeof decideDeviceAuthorization;
};
const api: DeviceAuthorizationApi = { inspect: inspectDeviceAuthorization, decide: decideDeviceAuthorization };
type State =
  | { readonly kind: "entry"; readonly invalid: boolean }
  | { readonly kind: "loading"; readonly userCode: string }
  | { readonly kind: "error"; readonly userCode: string; readonly error: unknown }
  | { readonly kind: "ready"; readonly inspection: DeviceAuthorizationInspection; readonly reconciled: boolean }
  | { readonly kind: "sending"; readonly inspection: DeviceAuthorizationInspection }
  | { readonly kind: "uncertain"; readonly inspection: DeviceAuthorizationInspection; readonly checking: boolean; readonly error: unknown };

export const DeviceAuthorizationPage = ({ user, initialCode, onSwitchAccount, onIdentityMismatch, transport = api }: {
  readonly user: CurrentUser;
  readonly initialCode: string | null;
  readonly onSwitchAccount: () => void;
  readonly onIdentityMismatch: () => void;
  readonly transport?: DeviceAuthorizationApi;
}) => {
  const { format, messages: { auth: { device: m, shell }, workspace: { app } } } = useI18n();
  const [input, setInput] = useState(initialCode ?? "");
  const [state, setState] = useState<State>({ kind: "entry", invalid: false });
  const [matches, setMatches] = useState(false);
  const active = useRef<AbortController | null>(null);
  const inspect = useCallback((userCode: string, previous?: DeviceAuthorizationInspection) => {
    if (active.current !== null) return;
    const controller = new AbortController(); active.current = controller;
    setMatches(false);
    setState(previous === undefined ? { kind: "loading", userCode } : { kind: "uncertain", inspection: previous, checking: true, error: null });
    void Promise.resolve().then(() => transport.inspect(userCode, user.id, controller.signal, onIdentityMismatch)).then((inspection) => {
      if (!controller.signal.aborted) setState({ kind: "ready", inspection, reconciled: previous !== undefined });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState(previous === undefined ? { kind: "error", userCode, error } : { kind: "uncertain", inspection: previous, checking: false, error });
    }).finally(() => { if (active.current === controller) active.current = null; });
  }, [user.id, onIdentityMismatch, transport]);
  useEffect(() => {
    setInput(initialCode ?? ""); setMatches(false);
    const code = initialCode === null ? null : normalizeDeviceUserCode(initialCode);
    if (code === null) setState({ kind: "entry", invalid: initialCode !== null });
    else inspect(code);
    return () => { active.current?.abort(); active.current = null; };
  }, [initialCode, user.id, inspect]);
  useEffect(() => {
    if (state.kind !== "ready" || state.inspection.status !== "pending") return;
    const inspection = state.inspection;
    const timer = setTimeout(() => setState({ kind: "ready", inspection: { ...inspection, status: "expired" }, reconciled: false }), Math.max(0, Date.parse(inspection.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  const decide = (decision: "approve" | "deny") => {
    if (active.current !== null || state.kind !== "ready" || state.inspection.status !== "pending" || decision === "approve" && !matches) return;
    const inspection = state.inspection;
    const controller = new AbortController(); active.current = controller;
    setState({ kind: "sending", inspection });
    void Promise.resolve().then(() => transport.decide(inspection.userCode, decision, user.id, controller.signal, onIdentityMismatch)).then(() => {
      if (!controller.signal.aborted) setState({ kind: "ready", inspection: { ...inspection, status: decision === "approve" ? "approved" : "denied" }, reconciled: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbortError(error)) setState({ kind: "uncertain", inspection, checking: false, error });
    }).finally(() => { if (active.current === controller) active.current = null; });
  };
  const restart = () => { setState({ kind: "entry", invalid: false }); setInput(""); setMatches(false); };
  const inspection = "inspection" in state ? state.inspection : null;
  const terminal = state.kind === "ready" && state.inspection.status !== "pending" ? state.inspection.status : null;
  const completed = terminal === "approved" || terminal === "consumed";
  const busy = state.kind === "sending" || state.kind === "loading" || state.kind === "uncertain" && state.checking;
  const unavailable = state.kind === "error" && state.error instanceof ApiError && state.error.status === 404;
  const errorMessage = (error: unknown) => error instanceof ApiError && error.status === 429 ? m.rateLimited : m.loadError;
  const requestId = "error" in state && state.error instanceof ApiError ? state.error.requestId : null;
  return <div className="invite-page device-page">
    <a className="brand" href="/" aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a>
    <main className="invite-card device-card"><LanguageSelector /><p className="eyebrow">{m.eyebrow}</p>
      <h1>{terminal === null ? unavailable ? m.unavailable : m.title : completed ? m.approved : terminal === "denied" ? m.denied : m.expired}</h1>
      {state.kind === "entry" && <><p className="subtitle">{m.subtitle}</p><form className="device-code-form" onSubmit={(event) => {
        event.preventDefault();
        const userCode = normalizeDeviceUserCode(input);
        if (userCode === null) { setState({ kind: "entry", invalid: true }); return; }
        inspect(userCode);
      }}><div className="field"><label htmlFor="device-user-code">{m.codeLabel}</label><input id="device-user-code" value={input} onChange={(event) => setInput(event.currentTarget.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} aria-invalid={state.invalid} aria-describedby="device-code-hint" /><p className={`hint${state.invalid ? " error" : ""}`} id="device-code-hint">{state.invalid ? m.invalidCode : m.codeHint}</p></div><button className="button primary" type="submit">{m.inspect}</button></form></>}
      {state.kind === "loading" && <div className="device-loading" role="status"><span className="spinner" aria-hidden="true" /><p>{m.loading}</p></div>}
      {state.kind === "error" && <div className="device-result" role="alert"><p>{unavailable ? m.unavailableDetail : errorMessage(state.error)}</p>{requestId !== null && <p className="request-id">requestId: {requestId}</p>}<button className="button" type="button" onClick={unavailable ? restart : () => inspect(state.userCode)}>{unavailable ? m.restart : m.retry}</button></div>}
      {terminal !== null && <div className="device-result" role="status"><div className={`device-result-mark ${completed ? "success" : ""}`} aria-hidden="true">{completed ? "✓" : terminal === "denied" ? "×" : "⌛"}</div><p>{completed ? m.approvedDetail : terminal === "denied" ? m.deniedDetail : m.expiredDetail}</p>{completed && <a className="button" href="/account">{m.accountSettings}</a>}{!completed && <button className="button" type="button" onClick={restart}>{m.restart}</button>}</div>}
      {inspection !== null && terminal === null && <><p className="subtitle">{m.compare}</p><div className="device-code"><span>{m.codeLabel}</span><code>{inspection.userCode}</code></div><div className="device-permissions"><p>{m.permission}</p><p>{m.lifetime}</p></div><p className="device-expiry">{m.expiresAt({ date: format.dateTime(inspection.expiresAt) })}</p>
        <div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? shell.currentAccount}</p>{user.email !== null && <p className="person-meta">{user.email}</p>}</div></div><button className="inline-link" type="button" disabled={busy || state.kind === "uncertain"} onClick={onSwitchAccount}>{m.switchAccount}</button></div>
          {state.kind === "uncertain" ? <div className="notice warning" role="alert"><p><strong>{m.uncertain}</strong></p><p>{m.uncertainDetail}</p>{state.error !== null && <p>{errorMessage(state.error)}</p>}{requestId !== null && <p className="request-id">requestId: {requestId}</p>}<button className="button" type="button" disabled={state.checking} onClick={() => inspect(inspection.userCode, inspection)}>{state.checking ? m.reconciling : m.reconcile}</button></div> : <>{state.kind === "ready" && state.reconciled && <p className="notice" role="status">{m.reconciled}</p>}<label className="device-match"><input type="checkbox" checked={matches} disabled={busy} onChange={(event) => setMatches(event.currentTarget.checked)} /><span>{m.confirmMatch}</span></label><div className="device-actions"><button className="button primary" type="button" disabled={busy || !matches} onClick={() => decide("approve")}>{busy ? m.submitting : m.approve}</button><button className="button danger" type="button" disabled={busy} onClick={() => decide("deny")}>{m.deny}</button></div></>}
        </div></>}
      {!busy && state.kind !== "uncertain" && <div className="device-home"><a className="inline-link" href="/">{m.returnToProjects}</a></div>}
    </main>
  </div>;
};
