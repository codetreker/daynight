import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { createGitHubAppAdminInvitation, listGitHubAppAdminInvitations, listGitHubAppAdmins, removeGitHubAppAdmin, revokeGitHubAppAdminInvitation, type GitHubAppAdmin, type GitHubAppAdminInvitation } from '../../api/github-app-admin';
import { useI18n } from '../../i18n/LocaleProvider';
import { CopyButton } from '../../ui/copy-button/CopyButton';
import { ManagementDialog } from '../management/ManagementDialog';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { OperationPublicationError, useOperation } from '../teams/TeamManagement';
import { useTeamForeground } from '../teams/useTeamForeground';
import { adminMessages } from './messages';
import './github-app-administration.css';

export type GitHubAppAdminUnknownReview = { readonly state: 'unknown' | 'app-unavailable'; readonly check: () => void; readonly finish: (() => void) | null };
export type GitHubAppAdminConfirmedResult = 'invite' | 'remove' | 'revoke';
type Props = { readonly appId: string; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly accessDenied: boolean; readonly onIdentityMismatch: () => void; readonly onAccessLost: () => void; readonly onSelfRemoved: () => void; readonly onUnknownReviewChange?: (review: GitHubAppAdminUnknownReview | null) => void; readonly onConfirmedResult?: (result: GitHubAppAdminConfirmedResult) => void };
type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null; readonly pages: number };
type Modal = { readonly kind: 'invite' } | { readonly kind: 'link' } | { readonly kind: 'remove'; readonly member: GitHubAppAdmin } | { readonly kind: 'revoke'; readonly invitation: GitHubAppAdminInvitation };
const auth = (admission: TaskCacheScope, mismatch: () => void, dispatched?: () => void) => ({ userId: admission.userId, onPrincipalMismatch: mismatch, ...(dispatched ? { onDispatch: dispatched } : {}) });
const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && (error.status === 403 || error.status === 404);
const conflict = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 409;

// A fresh owner never sees an earlier account's roster, draft, or one-time link.
export const GitHubAppAdministration = (props: Props) => {
  const owner = useRef({ admission: props.admission, appId: props.appId, revision: 0 });
  if (owner.current.admission !== props.admission || owner.current.appId !== props.appId) owner.current = { admission: props.admission, appId: props.appId, revision: owner.current.revision + 1 };
  return <Administration key={owner.current.revision} {...props} />;
};

const Administration = ({ appId, active, admission, admissionBlocked, accessDenied, onIdentityMismatch, onAccessLost, onSelfRemoved, onUnknownReviewChange, onConfirmedResult }: Props) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = adminMessages(zh);
  const [admins, setAdmins] = useState<Page<GitHubAppAdmin> | null>(null), [invites, setInvites] = useState<Page<GitHubAppAdminInvitation> | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [unavailable, setUnavailable] = useState(false), [notice, setNotice] = useState('');
  const [modal, setModal] = useState<Modal | null>(null), [link, setLink] = useState(''), [linkExpiry, setLinkExpiry] = useState(''), [copyStatus, setCopyStatus] = useState(''), [checked, setChecked] = useState(false), [last, setLast] = useState(false);
  const currentAdmins = useRef<Page<GitHubAppAdmin> | null>(null), currentInvites = useRef<Page<GitHubAppAdminInvitation> | null>(null), read = useRef<AbortController | null>(null), epoch = useRef(0), accessEpoch = useRef(0), actorVersion = useRef<string | null>(null), linkIssuer = useRef<string | null>(null), unavailableRef = useRef(false), externalDenied = useRef(false), operationSequence = useRef(0), fresh = useRef(false), entry = useRef(false), activeRef = useRef(active), op = useOperation(admission);
  const previousActive = useRef(active), savedFocus = useRef<{ element: HTMLElement; start: number | null; end: number | null } | null>(null);
  if (previousActive.current && !active && typeof document !== 'undefined') {
    const element = document.activeElement;
    if (modal && element instanceof HTMLElement && element.closest('[role=dialog]')) {
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
      savedFocus.current = { element, start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null };
    }
  }
  previousActive.current = active; activeRef.current = active;
  if (accessDenied && !externalDenied.current) { savedFocus.current = null; externalDenied.current = true; epoch.current++; accessEpoch.current++; fresh.current = false; entry.current = false; unavailableRef.current = true; currentAdmins.current = null; currentInvites.current = null; actorVersion.current = null; linkIssuer.current = null; }
  if (!accessDenied) externalDenied.current = false;
  if (!active || admissionBlocked || accessDenied) fresh.current = false;
  useLayoutEffect(() => { if (!accessDenied) return; read.current?.abort(); setAdmins(null); setInvites(null); setModal(null); setLink(''); setLinkExpiry(''); setCopyStatus(''); setUnavailable(true); }, [accessDenied]);
  const callbacks = useRef({ onAccessLost, onSelfRemoved, onConfirmedResult }); callbacks.current = { onAccessLost, onSelfRemoved, onConfirmedResult };
  const reportHiddenResult = (result: GitHubAppAdminConfirmedResult) => { if (!activeRef.current || unavailableRef.current || externalDenied.current) callbacks.current.onConfirmedResult?.(result); };
  const loseAccess = () => { savedFocus.current = null; unavailableRef.current = true; epoch.current++; accessEpoch.current++; fresh.current = false; entry.current = false; currentAdmins.current = null; currentInvites.current = null; actorVersion.current = null; setAdmins(null); setInvites(null); setModal(null); setLink(''); linkIssuer.current = null; setLinkExpiry(''); setCopyStatus(''); setUnavailable(true); callbacks.current.onAccessLost(); };
  const load = useCallback(async (more: 'admins' | 'invites' | null = null) => {
    if (!active || admissionBlocked || accessDenied || admission.isInvalidated) return false;
    if (more === 'admins' && !currentAdmins.current?.nextCursor || more === 'invites' && !currentInvites.current?.nextCursor) return false;
    fresh.current = false; read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); let revision = accessEpoch.current;
    if (!entry.current || more) setLoading(true);
    try {
      const adminPages = Math.max(1, currentAdmins.current?.pages ?? 1) + (more === 'admins' ? 1 : 0), invitationPages = Math.max(1, currentInvites.current?.pages ?? 1) + (more === 'invites' ? 1 : 0);
      const loadAdmins = async () => { let items: readonly GitHubAppAdmin[] = [], cursor: string | null = null, pages = 0;
        do { await admission.ready(signal); const page = await listGitHubAppAdmins(appId, cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); if (page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError('protocol'); items = [...items, ...page.items]; if (new Set(items.map(item => item.userId)).size !== items.length) throw new ApiError('protocol'); cursor = page.nextCursor; pages++; } while ((pages < adminPages || !items.some(item => item.userId === admission.userId)) && cursor !== null);
        if (signal.aborted || admission.isInvalidated || read.current !== controller || revision !== accessEpoch.current) return { items, nextCursor: cursor, pages };
        const actor = items.find(item => item.userId === admission.userId);
        if (!actor) {
          loseAccess(); setError(new ApiError('server', 404, 'not_found')); setLoading(false); controller.abort();
          throw new ApiError('server', 404, 'not_found');
        }
        if (actorVersion.current !== null && actorVersion.current !== actor.membershipVersion) { epoch.current++; revision = ++accessEpoch.current; }
        actorVersion.current = actor.membershipVersion;
        if (linkIssuer.current !== null && actor.membershipVersion !== linkIssuer.current) { linkIssuer.current = null; setLink(''); setLinkExpiry(''); setModal(null); setNotice(m.linkUnavailable); }
        return { items, nextCursor: cursor, pages }; };
      const loadInvites = async () => { let items: readonly GitHubAppAdminInvitation[] = [], cursor: string | null = null, pages = 0;
        do { await admission.ready(signal); const page = await listGitHubAppAdminInvitations(appId, cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); if (page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError('protocol'); items = [...items, ...page.items]; if (new Set(items.map(item => item.id)).size !== items.length) throw new ApiError('protocol'); cursor = page.nextCursor; pages++; } while (pages < invitationPages && cursor !== null);
        return { items, nextCursor: cursor, pages }; };
      const [nextAdmins, nextInvites] = await Promise.all([loadAdmins(), loadInvites()]);
      if (signal.aborted || admission.isInvalidated || read.current !== controller || revision !== accessEpoch.current) return false;
      currentAdmins.current = nextAdmins; currentInvites.current = nextInvites; entry.current = true; unavailableRef.current = false; fresh.current = true; setAdmins(nextAdmins); setInvites(nextInvites); setUnavailable(false); setError(null); return true;
    } catch (failure) {
      if (!signal.aborted && !admission.isInvalidated && read.current === controller && revision === accessEpoch.current) {
        controller.abort();
        try { await admission.ready(admission.signal); } catch { return false; }
        if (!admission.isInvalidated && !admission.signal.aborted && read.current === controller && revision === accessEpoch.current) { if (denied(failure)) loseAccess(); setError(failure); }
      }
      return false;
    }
    finally { if (read.current === controller) { read.current = null; if (!admission.isInvalidated && !admission.signal.aborted) setLoading(false); } }
  }, [active, admissionBlocked, accessDenied, admission, appId, onIdentityMismatch]);
  useEffect(() => { if (!active || admissionBlocked || accessDenied) return; void load(); return () => { read.current?.abort(); read.current = null; }; }, [active, admissionBlocked, accessDenied, load]);
  useTeamForeground(active && !admissionBlocked && !accessDenied, () => { void load(); });
  const close = () => { epoch.current++; setModal(null); setLink(''); linkIssuer.current = null; setLinkExpiry(''); setCopyStatus(''); setLast(false); if (op.result?.kind !== 'unknown') { op.clear(); setChecked(false); } };
  const open = (value: Modal) => { if (!active || !fresh.current || admissionBlocked || accessDenied || op.guarded()) return; op.clear(); setChecked(false); setLast(false); setNotice(''); setModal(value); };
  const observe = () => { void (async () => { const loaded = await load(); if (loaded || unavailableRef.current) { setChecked(true); if (loaded && op.result?.kind !== 'unknown') { const changed = conflict(op.result?.error); op.clear(); if (changed) { setModal(null); setChecked(false); setNotice(m.conflict); } } } })(); };
  const unknown = op.result?.kind === 'unknown';
  const submit = () => {
    if (!active || admissionBlocked || accessDenied || !fresh.current || !modal || op.guarded() || modal.kind === 'link') return;
    const revision = epoch.current, issuerVersion = actorVersion.current, action = modal; operationSequence.current++;
    if (action.kind === 'invite') void op.run((signal, dispatched) => createGitHubAppAdminInvitation(appId, signal, auth(admission, onIdentityMismatch, dispatched)), result => {
      reportHiddenResult('invite');
      if (revision !== epoch.current || issuerVersion === null || result.issuerMembershipVersion !== issuerVersion || actorVersion.current !== issuerVersion) { setModal(null); setLink(''); linkIssuer.current = null; setNotice(m.linkUnavailable); return; }
      linkIssuer.current = result.issuerMembershipVersion; setLink(result.link); setLinkExpiry(result.expiresAt); setModal({ kind: 'link' }); setNotice(m.created);
      if (activeRef.current) void load();
    }, failure => { if (revision === epoch.current && denied(failure)) { fresh.current = false; if (activeRef.current) void load(); } });
    if (action.kind === 'remove') void op.run((signal, dispatched) => removeGitHubAppAdmin(appId, action.member.userId, action.member.membershipVersion, signal, auth(admission, onIdentityMismatch, dispatched)), receipt => {
      if (!receipt.actorIsAdmin) { epoch.current++; accessEpoch.current++; fresh.current = false; entry.current = false; unavailableRef.current = true; currentAdmins.current = null; currentInvites.current = null; actorVersion.current = null; linkIssuer.current = null; setLink(''); setLinkExpiry(''); setModal(null); setAdmins(null); setInvites(null); setUnavailable(true); callbacks.current.onSelfRemoved(); return; }
      reportHiddenResult('remove');
      if (revision !== epoch.current) { setNotice(m.removed); return; }
      setModal(null); setNotice(m.removed); if (activeRef.current) void load();
    }, failure => { if (revision !== epoch.current) return; if (denied(failure)) { fresh.current = false; if (activeRef.current) void load(); } else if (failure instanceof ApiError && failure.code === 'last_admin') setLast(true); });
    if (action.kind === 'revoke') void op.run((signal, dispatched) => revokeGitHubAppAdminInvitation(appId, action.invitation.id, signal, auth(admission, onIdentityMismatch, dispatched)), () => {
      reportHiddenResult('revoke');
      if (revision !== epoch.current) { setNotice(m.revoked); return; } setModal(null); setNotice(m.revoked); if (activeRef.current) void load();
    }, failure => { if (revision === epoch.current && denied(failure)) { fresh.current = false; if (activeRef.current) void load(); } });
  };
  const copy = () => { if (!link || !active || admissionBlocked || accessDenied || !fresh.current) return; const revision = epoch.current; void navigator.clipboard.writeText(link).then(() => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copied); }, () => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copyFailed); }); };
  const reviewCallbacks = useRef({ onUnknownReviewChange, observe, finish: () => {} });
  const reviewAlive = useRef(true);
  reviewCallbacks.current = { onUnknownReviewChange, observe, finish: () => {
    if (!unknown || (!checked && !accessDenied && !unavailable)) return;
    op.clear(); setChecked(false); setModal(null); setLink(''); linkIssuer.current = null; setLinkExpiry(''); setCopyStatus('');
  } };
  useEffect(() => {
    if (!unknown) { reviewCallbacks.current.onUnknownReviewChange?.(null); return; }
    const sequence = operationSequence.current;
    const owned = () => reviewAlive.current && operationSequence.current === sequence && !admission.isInvalidated && !admission.signal.aborted;
    const canFinish = checked || accessDenied || unavailable;
    reviewCallbacks.current.onUnknownReviewChange?.({ state: accessDenied || unavailable ? 'app-unavailable' : 'unknown', check: () => { if (owned()) reviewCallbacks.current.observe(); }, finish: canFinish ? () => { if (owned()) reviewCallbacks.current.finish(); } : null });
  }, [unknown, checked, accessDenied, unavailable, admission]);
  useEffect(() => { reviewAlive.current = true; return () => { reviewAlive.current = false; reviewCallbacks.current.onUnknownReviewChange?.(null); }; }, []);
  const visible = entry.current && !unavailable && !accessDenied;
  useLayoutEffect(() => {
    if (!active || !visible || savedFocus.current === null) return;
    const saved = savedFocus.current; savedFocus.current = null;
    queueMicrotask(() => {
      if (!activeRef.current || admission.isInvalidated || !saved.element.isConnected) return;
      saved.element.focus();
      if ((saved.element instanceof HTMLInputElement || saved.element instanceof HTMLTextAreaElement) && saved.start !== null && saved.end !== null) saved.element.setSelectionRange(saved.start, saved.end);
    });
  }, [active, visible, admission]);
  const singleAdmin = admins?.nextCursor === null && admins.items.length === 1;
  return <div>
    {!visible && loading && <p role="status">{m.loading}</p>}
    {error !== null && <div className="notice error" role="alert">{unavailable ? m.unavailable : m.failed} <button type="button" className="button" disabled={admissionBlocked} onClick={() => void load()}>{m.retry}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {unknown && !modal && <div className="notice warning" role="alert">{m.unknown} <button type="button" className="button" onClick={observe}>{m.check}</button>{checked && <><p>{m.checked}</p><button type="button" className="button" onClick={() => { op.clear(); setChecked(false); }}>{m.dismiss}</button></>}</div>}
    {visible && <><section className="panel"><header className="panel-heading"><div><h2>{m.title}</h2><p>{m.description}</p></div><button type="button" className="button primary" disabled={!fresh.current || admissionBlocked || op.guarded()} onClick={() => open({ kind: 'invite' })}>{m.invite}</button></header>
      <ul className="github-app-admin-list">{admins?.items.map(member => <li key={member.userId}><div><strong>{member.profile.name || member.profile.email || member.userId}</strong>{member.userId === admission.userId && <> · {m.you}</>}<p>{member.profile.email || member.userId}</p></div><button type="button" className="button" disabled={singleAdmin || !fresh.current || admissionBlocked || op.guarded()} onClick={() => open({ kind: 'remove', member })}>{m.remove}</button></li>)}</ul>
      {admins?.nextCursor && <div className="github-app-admin-more"><button type="button" className="button" disabled={loading || admissionBlocked} onClick={() => void load('admins')}>{m.more}</button></div>}<div className="github-app-admin-hint">{m.adminsHint}</div></section>
      <section className="panel"><header className="panel-heading"><h2>{m.invites}</h2></header>{invites && invites.items.length === 0 ? <p className="github-app-admin-hint">{m.noInvites}</p> : <ul className="github-app-admin-list">{invites?.items.map(invitation => <li key={invitation.id}><div><strong>{m.pending}</strong><p>{m.expires}{new Date(invitation.expiresAt).toLocaleString(locale)}</p><p>{invitation.available ? m.active : m.expired}</p></div>{invitation.available && <button className="button" type="button" disabled={!fresh.current || admissionBlocked || op.guarded()} onClick={() => open({ kind: 'revoke', invitation })}>{m.revoke}</button>}</li>)}</ul>}
      {invites?.nextCursor && <div className="github-app-admin-more"><button type="button" className="button" disabled={loading || admissionBlocked} onClick={() => void load('invites')}>{m.more}</button></div>}</section></>}
    {modal && <ManagementDialog title={modal.kind === 'invite' ? m.inviteTitle : modal.kind === 'link' ? m.createdTitle : modal.kind === 'remove' ? m.removeTitle : m.revokeTitle} busy={op.pending} suspended={!active || !visible} initialFocus={modal.kind === 'remove' || modal.kind === 'revoke' ? 'cancel' : 'input'} onClose={close} footer={<><button className="button" type="button" data-dialog-cancel disabled={op.pending} onClick={close}>{modal.kind === 'link' || unknown || last ? m.close : m.cancel}</button>{modal.kind === 'link' || last || modal.kind === 'remove' && singleAdmin ? null : unknown ? <button className="button" type="button" disabled={admissionBlocked} onClick={observe}>{m.check}</button> : conflict(op.result?.error) ? <button className="button" type="button" disabled={admissionBlocked} onClick={observe}>{m.check}</button> : <button className={`button ${modal.kind === 'invite' ? 'primary' : 'danger'}`} type="button" disabled={op.pending || op.publicationPending || admissionBlocked || !fresh.current} onClick={submit}>{op.pending ? m.submitting : modal.kind === 'invite' ? m.createInvite : modal.kind === 'remove' ? m.confirmRemove : m.confirmRevoke}</button>}</>}>
      {modal.kind === 'invite' && <p>{m.inviteHint}</p>}
      {modal.kind === 'link' && <><p>{m.linkHint}</p><textarea className="github-app-admin-link" readOnly value={link} aria-label={m.copy} /><CopyButton label={m.copy} disabled={admissionBlocked || !fresh.current} onClick={copy}>{m.copy}</CopyButton>{copyStatus && <p role="status">{copyStatus}</p>}<p>{m.expires}{new Date(linkExpiry).toLocaleString(locale)}</p></>}
      {modal.kind === 'remove' && <><p><strong>{modal.member.profile.name || modal.member.profile.email || modal.member.userId}</strong></p><p>{singleAdmin ? m.last : m.removeHint}</p></>}
      {modal.kind === 'revoke' && <p>{m.revokeHint}</p>}
      {op.result && <div className="notice error" role="alert">{unknown ? m.unknown : last ? m.last : conflict(op.result.error) ? m.conflict : m.rejected}</div>}{checked && <><p role="status">{m.checked}</p>{unknown && <button className="button" type="button" onClick={() => { op.clear(); close(); setChecked(false); }}>{m.dismiss}</button>}</>}<OperationPublicationError operation={op} zh={zh} />
    </ManagementDialog>}
  </div>;
};
