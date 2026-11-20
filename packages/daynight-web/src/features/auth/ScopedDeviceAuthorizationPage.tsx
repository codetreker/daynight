import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeDeviceUserCode } from '../../api/auth-parse';
import type { CurrentUser, DeviceAuthorizationInspection } from '../../api/auth-types';
import { ApiError, isAbortError } from '../../api/client';
import { readCredentialScopeCatalog, type ScopeCatalog } from '../../api/credential-scope';
import { decideScopedDeviceAuthorization, inspectScopedDeviceAuthorization } from '../../api/scoped-authorization';
import { useI18n } from '../../i18n/LocaleProvider';
import { LanguageSelector } from '../../i18n/LanguageSelector';
import { BrandMark } from '../../ui/BrandMark';
import { CredentialScopeSelector, hasCredentialScopeLabels } from './CredentialScopeSelector';

type Inspection = DeviceAuthorizationInspection & { readonly catalogRevision?: string };
export type ScopedDeviceAuthorizationApi = {
  inspect: typeof inspectScopedDeviceAuthorization;
  decide: typeof decideScopedDeviceAuthorization;
  catalog: typeof readCredentialScopeCatalog;
};
const api: ScopedDeviceAuthorizationApi = { inspect: inspectScopedDeviceAuthorization, decide: decideScopedDeviceAuthorization, catalog: readCredentialScopeCatalog };
type State =
  | { kind: 'entry'; invalid: boolean }
  | { kind: 'loading'; code: string }
  | { kind: 'error'; code: string; error: unknown }
  | { kind: 'ready'; inspection: Inspection; catalog: ScopeCatalog | null; catalogError: boolean; reconciled: boolean }
  | { kind: 'sending'; inspection: Inspection; catalog: ScopeCatalog | null }
  | { kind: 'uncertain'; inspection: Inspection; checking: boolean; error: unknown };

export const ScopedDeviceAuthorizationPage = ({ user, initialCode, onSwitchAccount, onIdentityMismatch, transport = api }: {
  user: CurrentUser; initialCode: string | null; onSwitchAccount: () => void; onIdentityMismatch: () => void; transport?: ScopedDeviceAuthorizationApi;
}) => {
  const { locale, format, messages: { auth: { device: m, shell }, workspace: { app } } } = useI18n();
  const copy = locale === 'zh-CN' ? {
    permissions: '选择 CLI 可以使用的权限', summary: 'CLI 将以你的身份操作，权限不会超出你已有的权限。',
    catalogError: '无法读取当前权限目录，请重新读取。', reload: '重新读取权限', mismatch: '权限目录已变更，请重新读取并核对选择。',
    missing: '当前页面缺少权限说明，请刷新页面后重试。', empty: '请至少选择一项权限。', storage: '无法保存授权状态，请检查浏览器存储设置。'
  } : {
    permissions: 'Choose the permissions available to the CLI', summary: 'The CLI acts as you, within the permissions you already have.',
    catalogError: 'The current permission catalog could not be read. Read it again.', reload: 'Read permissions again', mismatch: 'The permission catalog changed. Read it again and review your selection.',
    missing: 'This page is missing permission descriptions. Refresh the page and try again.', empty: 'Select at least one permission.', storage: 'Unable to save the authorization state. Check browser storage settings.'
  };
  const [input, setInput] = useState(initialCode ?? '');
  const [state, setState] = useState<State>({ kind: 'entry', invalid: false });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [matches, setMatches] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [decisionError, setDecisionError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  const draft = useRef<readonly string[] | null>(null);
  const dispatch = useRef<{ code: string; sent: boolean } | null>(null);
  const marker = (code: string) => `daynight.device.decision.${user.id}.${code}`;
  const clearMarker = (code: string) => { try { sessionStorage.removeItem(marker(code)); } catch { /* Terminal state remains authoritative. */ } };
  const inspect = useCallback((code: string, previous?: Inspection, preserve = false) => {
    if (active.current !== null) return;
    const controller = new AbortController(); active.current = controller;
    setMatches(false); setStorageError(false);
    if (preserve && !previous) setReviewRequired(true);
    if (previous) setState({ kind: 'uncertain', inspection: previous, checking: true, error: null });
    else setState({ kind: 'loading', code });
    void (async () => {
      const inspection = await transport.inspect(code, user.id, controller.signal, onIdentityMismatch);
      if (controller.signal.aborted) return;
      if (inspection.status !== 'pending') {
        clearMarker(code); setState({ kind: 'ready', inspection, catalog: null, catalogError: false, reconciled: false }); return;
      }
      if (previous) { setState({ kind: 'uncertain', inspection, checking: false, error: null }); return; }
      if (!preserve) {
        try {
          if (sessionStorage.getItem(marker(code)) === 'pending') { setState({ kind: 'uncertain', inspection, checking: false, error: null }); return; }
        } catch { setStorageError(true); }
      }
      let catalog: ScopeCatalog | null = null;
      try { catalog = (await transport.catalog(user.id, controller.signal, onIdentityMismatch)).pat; }
      catch (error) { if (controller.signal.aborted || isAbortError(error)) return; }
      if (controller.signal.aborted) return;
      if (catalog) {
        const next = preserve && draft.current !== null ? draft.current : catalog.defaultScopes;
        draft.current = next; setSelected(next);
      }
      setState({ kind: 'ready', inspection, catalog, catalogError: catalog === null, reconciled: Boolean(previous) || preserve });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState(previous ? { kind: 'uncertain', inspection: previous, checking: false, error } : { kind: 'error', code, error });
    }).finally(() => { if (active.current === controller) active.current = null; });
  }, [user.id, onIdentityMismatch, transport]);
  useEffect(() => {
    setInput(initialCode ?? ''); setMatches(false); setSelected([]); setReviewRequired(false); draft.current = null;
    const code = initialCode === null ? null : normalizeDeviceUserCode(initialCode);
    if (code === null) setState({ kind: 'entry', invalid: initialCode !== null }); else inspect(code);
    return () => { if (dispatch.current && !dispatch.current.sent) clearMarker(dispatch.current.code); active.current?.abort(); active.current = null; dispatch.current = null; };
  }, [initialCode, user.id, inspect]);
  useEffect(() => {
    if (state.kind !== 'ready' || state.inspection.status !== 'pending') return;
    const inspection = state.inspection;
    const timer = setTimeout(() => setState({ ...state, inspection: { ...inspection, status: 'expired' } }), Math.max(0, Date.parse(inspection.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  const readyCatalog = state.kind === 'ready' ? state.catalog : null;
  const available = new Set(readyCatalog?.groups.flatMap(group => group.scopeIds) ?? []);
  const unavailableScopes = selected.filter(id => !available.has(id));
  const canApprove = state.kind === 'ready' && state.inspection.status === 'pending' && readyCatalog !== null && readyCatalog.catalogRevision === state.inspection.catalogRevision && hasCredentialScopeLabels(readyCatalog, locale) && selected.length > 0 && unavailableScopes.length === 0 && matches && !reviewRequired && !storageError;
  const decide = (decision: 'approve' | 'deny') => {
    if (active.current !== null || state.kind !== 'ready' || state.inspection.status !== 'pending' || decision === 'approve' && !canApprove) return;
    const inspection = state.inspection, catalog = state.catalog;
    setDecisionError(null);
    try { sessionStorage.setItem(marker(inspection.userCode), 'pending'); } catch { setStorageError(true); return; }
    const controller = new AbortController(); active.current = controller;
    dispatch.current = { code: inspection.userCode, sent: false };
    setState({ kind: 'sending', inspection, catalog });
    void transport.decide(inspection.userCode, decision, user.id, decision === 'approve' && catalog ? { catalogRevision: catalog.catalogRevision, scopes: selected } : undefined, controller.signal, onIdentityMismatch, () => { if (dispatch.current) dispatch.current.sent = true; }).then(() => {
      if (!controller.signal.aborted) { clearMarker(inspection.userCode); setState({ kind: 'ready', inspection: { ...inspection, status: decision === 'approve' ? 'approved' : 'denied' }, catalog: null, catalogError: false, reconciled: false }); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) { if (dispatch.current && !dispatch.current.sent) clearMarker(inspection.userCode); return; }
      if (error instanceof ApiError && error.kind === 'server' && error.status === 409 && error.code === 'version_conflict') {
        clearMarker(inspection.userCode); active.current = null; inspect(inspection.userCode, undefined, true);
      } else if (error instanceof ApiError && error.kind === 'server' && error.status === 429 && error.code === 'rate_limited') {
        clearMarker(inspection.userCode); setDecisionError(error); setState({ kind: 'ready', inspection, catalog, catalogError: catalog === null, reconciled: false });
      } else setState({ kind: 'uncertain', inspection, checking: false, error });
    }).finally(() => { if (active.current === controller) { active.current = null; dispatch.current = null; } });
  };
  const restart = () => { draft.current = null; setSelected([]); setState({ kind: 'entry', invalid: false }); setInput(''); setMatches(false); };
  const inspection = 'inspection' in state ? state.inspection : null;
  const terminal = state.kind === 'ready' && inspection && inspection.status !== 'pending' ? inspection.status : null;
  const completed = terminal === 'approved' || terminal === 'consumed';
  const busy = state.kind === 'sending' || state.kind === 'loading' || state.kind === 'uncertain' && state.checking;
  const unavailable = state.kind === 'error' && state.error instanceof ApiError && state.error.status === 404;
  const errorMessage = (error: unknown) => error instanceof ApiError && error.status === 429 ? m.rateLimited : m.loadError;
  const requestId = 'error' in state && state.error instanceof ApiError ? state.error.requestId : null;
  return <div className="invite-page device-page"><a className="brand" href="/projects" aria-label={app.projectHome}><BrandMark className="brand-mark" surface="light" />daynight</a><main className="invite-card device-card"><LanguageSelector /><p className="eyebrow">{m.eyebrow}</p>
    <h1>{terminal === null ? unavailable ? m.unavailable : m.title : completed ? m.approved : terminal === 'denied' ? m.denied : m.expired}</h1>
    {state.kind === 'entry' && <><p className="subtitle">{m.subtitle}</p><form className="device-code-form" onSubmit={event => { event.preventDefault(); const code = normalizeDeviceUserCode(input); if (code === null) setState({ kind: 'entry', invalid: true }); else inspect(code); }}><div className="field"><label htmlFor="scoped-device-code">{m.codeLabel}</label><input id="scoped-device-code" value={input} onChange={event => setInput(event.currentTarget.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} aria-invalid={state.invalid} aria-describedby="scoped-device-hint" /><p className={`hint${state.invalid ? ' error' : ''}`} id="scoped-device-hint">{state.invalid ? m.invalidCode : m.codeHint}</p></div><button className="button primary" type="submit">{m.inspect}</button></form></>}
    {state.kind === 'loading' && <div className="device-loading" role="status"><span className="spinner" aria-hidden="true" /><p>{m.loading}</p></div>}
    {state.kind === 'error' && <div className="device-result" role="alert"><p>{unavailable ? m.unavailableDetail : errorMessage(state.error)}</p>{requestId !== null && <p className="request-id">requestId: {requestId}</p>}<button className="button" type="button" onClick={unavailable ? restart : () => inspect(state.code, undefined, draft.current !== null)}>{unavailable ? m.restart : m.retry}</button></div>}
    {terminal !== null && <div className="device-result" role="status"><div className={`device-result-mark ${completed ? 'success' : ''}`} aria-hidden="true">{completed ? '✓' : terminal === 'denied' ? '×' : '⌛'}</div><p>{completed ? m.approvedDetail : terminal === 'denied' ? m.deniedDetail : m.expiredDetail}</p>{completed ? <a className="button" href="/account?tab=tokens">{m.accountSettings}</a> : <button className="button" type="button" onClick={restart}>{m.restart}</button>}</div>}
    {inspection !== null && terminal === null && <><p className="subtitle">{m.compare}</p><div className="device-code"><span>{m.codeLabel}</span><code>{inspection.userCode}</code></div><p>{copy.summary}</p><h2>{copy.permissions}</h2>
      {(state.kind === 'ready' || state.kind === 'sending') && state.catalog && <CredentialScopeSelector catalog={state.catalog} selected={selected} onChange={value => { draft.current = value; setSelected(value); }} disabled={busy} />}
      {state.kind === 'ready' && (state.catalogError || state.catalog?.catalogRevision !== inspection.catalogRevision) && <div className="notice warning" role="alert"><p>{state.catalogError ? copy.catalogError : copy.mismatch}</p><button className="button" type="button" onClick={() => inspect(inspection.userCode, undefined, true)}>{copy.reload}</button></div>}
      {state.kind === 'ready' && state.catalog && !hasCredentialScopeLabels(state.catalog, locale) && <p className="notice warning" role="alert">{copy.missing}</p>}
      {state.kind === 'ready' && state.catalog && unavailableScopes.length > 0 && <div className="notice warning" role="alert"><p>{locale === 'zh-CN' ? '已选权限目前不可用，请核对并移除后再批准。' : 'Selected permissions are no longer available. Review and remove them before approving.'}</p><ul>{unavailableScopes.map(id => <li key={id}><code>{id}</code> <button className="inline-link" type="button" onClick={() => { const next = selected.filter(item => item !== id); draft.current = next; setSelected(next); }}>{locale === 'zh-CN' ? `移除 ${id}` : `Remove ${id}`}</button></li>)}</ul></div>}
      {state.kind === 'ready' && state.catalog && reviewRequired && <div className="notice warning" role="alert"><p>{locale === 'zh-CN' ? '权限目录已变更，请核对当前选择。' : 'The permissions catalog changed. Review your selection.'}</p><button className="button" type="button" onClick={() => setReviewRequired(false)}>{locale === 'zh-CN' ? '已核对权限' : 'I reviewed the permissions'}</button></div>}
      {state.kind === 'ready' && state.catalog && selected.length === 0 && <p className="hint">{copy.empty}</p>}
      <p className="device-expiry">{m.expiresAt({ date: format.dateTime(inspection.expiresAt) })}</p><p>{m.lifetime}</p><div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? shell.currentAccount}</p>{user.email !== null && <p className="person-meta">{user.email}</p>}</div></div><button className="inline-link" type="button" disabled={busy || state.kind === 'uncertain'} onClick={onSwitchAccount}>{m.switchAccount}</button></div>
      {state.kind === 'uncertain' ? <div className="notice warning" role="alert"><p><strong>{m.uncertain}</strong></p><p>{m.uncertainDetail}</p>{state.error !== null && <p>{errorMessage(state.error)}</p>}{requestId !== null && <p className="request-id">requestId: {requestId}</p>}<button className="button" type="button" disabled={state.checking} onClick={() => inspect(inspection.userCode, inspection, true)}>{state.checking ? m.reconciling : m.reconcile}</button></div> : <>{state.kind === 'ready' && state.reconciled && <p className="notice" role="status">{m.reconciled}</p>}{storageError && <p role="alert">{copy.storage}</p>}{decisionError !== null && <p role="alert">{errorMessage(decisionError)}</p>}<label className="device-match"><input type="checkbox" checked={matches} disabled={busy} onChange={event => setMatches(event.currentTarget.checked)} /><span>{m.confirmMatch}</span></label><div className="device-actions"><button className="button primary" type="button" disabled={!canApprove} onClick={() => decide('approve')}>{busy ? m.submitting : m.approve}</button><button className="button danger" type="button" disabled={busy} onClick={() => decide('deny')}>{m.deny}</button></div></>}
      </div></>}
    {!busy && state.kind !== 'uncertain' && <div className="device-home"><a className="inline-link" href="/projects">{m.returnToProjects}</a></div>}
  </main></div>;
};
