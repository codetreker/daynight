import { useCallback, useEffect, useRef, useState } from 'react';
import { createTeamInvitation, listTeamInvitations, revokeTeamInvitation, type TeamInvitation } from '../../api/auth';
import { ApiError, authRequestsPaused } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { OperationPublicationError, useOperation } from '../teams/TeamManagement';
import { InvitationList } from './InvitationList';
import { ManagementDialog } from './ManagementDialog';
import { ManagementError, SecretDialog } from './feedback';

type ReadReason = 'initial' | 'background' | 'reconcile';
type Action = { readonly kind: 'create' } | { readonly kind: 'revoke'; readonly invitation: TeamInvitation };

export const TeamInvitations = ({ teamId, teamName, active, admissionBlocked = false, permissionReady = true, onRoute, editable, actorRole, unavailable, admission, onIdentityMismatch, onPermissionChange, onGuardChange }: {
  readonly teamId: string; readonly teamName: string; readonly active: boolean; readonly admissionBlocked?: boolean; readonly permissionReady?: boolean; readonly onRoute: boolean; readonly editable: boolean; readonly actorRole: 'admin' | 'member' | null; readonly unavailable: boolean;
  readonly admission: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onPermissionChange: () => void; readonly onGuardChange: (retain: boolean, lock: boolean) => void;
}) => {
  const { locale, messages: { auth: { management: { members: m, common } }, common: globalCommon } } = useI18n();
  const zh = locale === 'zh-CN';
  const [items, setItems] = useState<readonly TeamInvitation[] | null>(null);
  // A retained invitation list does not authorize writes while either read is pending.
  const loaded = useRef(false), fresh = useRef(false);
  const canRead = active && !unavailable && actorRole === 'admin';
  if (!canRead || admissionBlocked) fresh.current = false;
  const [reconciling, setReconciling] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [needsRefresh, setNeedsRefresh] = useState(false);
  const permissionRef = useRef(false); permissionRef.current = permissionReady && !admissionBlocked;
  const [action, setActionState] = useState<Action | null>(null), [observed, setObserved] = useState(false);
  const actionRef = useRef<Action | null>(null);
  const setAction = (next: Action | null) => { actionRef.current = next; setActionState(next); };
  // Receipts outlive their submitting dialog; a later dialog must not replace them.
  const [secrets, setSecrets] = useState<readonly { action: Action; link: string }[]>([]);
  const secret = secrets[0] ?? null;
  const [completedAction, setCompletedAction] = useState<Action | null>(null);
  const route = useRef({ onRoute, active, revision: 0 });
  if (route.current.onRoute !== onRoute || route.current.active !== active) route.current = { onRoute, active, revision: route.current.revision + 1 };
  const [issue, setIssue] = useState<unknown>(null), [receipt, setReceipt] = useState<'revoked' | 'already' | null>(null);
  // Metadata reads cannot settle dispatched revokes; their IDs retain the owner for this identity scope.
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(() => new Set());
  const read = useRef<AbortController | null>(null);
  const permissionNotified = useRef(false);
  const op = useOperation(admission), operation = useRef(op); operation.current = op;
  const permission = useRef(onPermissionChange); permission.current = onPermissionChange;
  const guard = useRef(onGuardChange); guard.current = onGuardChange;
  const unknown = op.result?.kind === 'unknown';
  const memberWithoutManagement = actorRole === 'member';
  useEffect(() => { guard.current(op.pending || op.publicationPending || unknown || op.publicationError !== null || issue !== null || uncertain.size > 0 || secret !== null, op.pending || op.publicationError !== null || unknown && !memberWithoutManagement); }, [op.pending, op.publicationPending, unknown, op.publicationError, issue, uncertain.size, secret, memberWithoutManagement]);
  useEffect(() => {
    if (memberWithoutManagement) { loaded.current = false; fresh.current = false; setItems(null); if (unknown) setAction(null); }
  }, [unknown, memberWithoutManagement]);
  useEffect(() => () => { read.current?.abort(); guard.current(false, false); }, []);
  useEffect(() => { if (!onRoute && !operation.current.guarded()) setAction(null); }, [onRoute]);
  const load = useCallback(async (reason: ReadReason = 'reconcile') => {
    if (!canRead) return false;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); fresh.current = false;
    setReconciling(reason === 'reconcile');
    if (!loaded.current) setLoading(true);
    setError(null);
    try {
      await admission.ready(signal);
      const invitations = await listTeamInvitations(teamId, signal, { userId: admission.userId, onPrincipalMismatch: onIdentityMismatch });
      await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return false;
      if (!permissionRef.current || authRequestsPaused()) { setNeedsRefresh(true); return false; }
      permissionNotified.current = false; loaded.current = true; fresh.current = true; setItems(invitations); return true;
    } catch (failure) {
      if (signal.aborted || admission.isInvalidated) return false;
      try { await admission.ready(signal); } catch { return false; }
      if (signal.aborted || admission.isInvalidated) return false;
      loaded.current = false; setItems(null); setError(failure);
      if (failure instanceof ApiError && failure.kind === 'server' && (failure.status === 403 || failure.status === 404) && !permissionNotified.current) { permissionNotified.current = true; permission.current(); }
      return false;
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) { setLoading(false); setReconciling(false); } } }
  }, [canRead, admission, teamId, onIdentityMismatch]);
  useEffect(() => {
    if (canRead && !admissionBlocked) void load(loaded.current ? 'background' : 'initial');
    return () => read.current?.abort();
  }, [canRead, admissionBlocked, load]);
  useEffect(() => {
    if (!needsRefresh || !canRead || admissionBlocked || !permissionReady || authRequestsPaused()) return;
    setNeedsRefresh(false); void load('background');
  }, [needsRefresh, canRead, admissionBlocked, permissionReady, load]);
  const check = () => { void load().then((ok) => { if (ok && operation.current.result?.kind === 'unknown') { setIssue(operation.current.result.error); setObserved(true); operation.current.clear(); setAction(null); } }); };
  const open = (next: Action) => {
    if (!active || !editable || loading || reconciling || op.pending || unknown || op.publicationError !== null || secret !== null || error !== null) return;
    operation.current.clear(); setCompletedAction(null); setAction(next); setReceipt(null);
  };
  const submit = () => {
    if (!action || action === completedAction || secret !== null || !active || !editable || authRequestsPaused() || !permissionReady || !fresh.current || loading || reconciling || op.pending || op.publicationPending && op.outcome === 'confirmed' || unknown || op.publicationError !== null || error !== null) return;
    if (action.kind === 'revoke' && uncertain.has(action.invitation.id)) return;
    guard.current(true, true);
    const submitted = action, routeRevision = route.current.revision;
    const ownsPresentation = () => actionRef.current === submitted && route.current.revision === routeRevision;
    const rejected = (failure: unknown) => { if (failure instanceof ApiError && failure.kind === 'server' && (failure.status === 403 || failure.status === 404)) permission.current(); };
    if (action.kind === 'create') void op.run((signal, dispatched) => createTeamInvitation(teamId, admission.userId, signal, onIdentityMismatch, dispatched), (created) => {
      if (actionRef.current === submitted) setCompletedAction(submitted);
      setSecrets(previous => [...previous, { action: submitted, link: created.link }]); setNeedsRefresh(true);
      if (ownsPresentation()) { setAction(null); setIssue(null); setObserved(false); }
    }, rejected);
    else void op.run((signal, dispatched) => revokeTeamInvitation(teamId, action.invitation.id, admission.userId, signal, onIdentityMismatch, dispatched), (result) => {
      setItems((previous) => previous?.filter((invitation) => invitation.id !== result.invitationId) ?? null);
      if (actionRef.current === submitted) setCompletedAction(submitted);
      setReceipt(result.changed ? 'revoked' : 'already');
      if (ownsPresentation()) { setAction(null); setIssue(null); setObserved(false); }
      if (active) void load();
    }, rejected);
  };
  useEffect(() => {
    if (!unknown || action?.kind !== 'revoke') return;
    setUncertain(previous => previous.has(action.invitation.id) ? previous : new Set([...previous, action.invitation.id]));
  }, [unknown, action]);
  const isVisible = canRead;
  const currentIssue = unknown ? op.result?.error : issue;
  return <>
    {action === null && <OperationPublicationError operation={op} zh={zh} />}
    {active && !isVisible && op.pending && <div role="status">{common.submitPending}</div>}
    {active && !isVisible && currentIssue !== null && currentIssue !== undefined && <div className="notice warning" role="alert"><p>{unavailable ? zh ? "邀请变更结果仍未确认；此 Team 不可用或你已无权访问。" : "The invitation change is still unconfirmed; this Team is unavailable or you no longer have access." : memberWithoutManagement ? zh ? "邀请变更结果仍未确认；你已无权读取此 Team 的邀请。" : "The invitation change is still unconfirmed; you no longer have permission to read this Team’s invitations." : observed && !unknown ? m.invitationObserved : m.invitationUnknown}</p>{currentIssue instanceof ApiError && currentIssue.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{currentIssue.requestId}</code></p>}</div>}
    {isVisible && <>
      {loading && <div className="empty-inline" role="status">{m.loading}</div>}
      {error !== null && (error instanceof ApiError && error.kind === 'server' && (error.status === 403 || error.status === 404) ? <div className="notice error" role="alert"><p>{zh ? '无法读取此 Team 的邀请，请检查权限后重试。' : 'Unable to read invitations for this Team. Check your permissions and retry.'}</p>{error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{error.requestId}</code></p>}<button className="button" type="button" onClick={() => { permissionNotified.current = false; void load(); }}>{common.retry}</button></div> : <ManagementError error={error} retry={() => { permissionNotified.current = false; void load(); }} />)}
      {currentIssue !== null && currentIssue !== undefined && <div className="notice warning" role="alert"><p>{observed && !unknown ? m.invitationObserved : m.invitationUnknown}</p>{currentIssue instanceof ApiError && currentIssue.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{currentIssue.requestId}</code></p>}{unknown && <button className="button" type="button" disabled={loading || reconciling || op.pending} onClick={check}>{m.readCurrentInvitations}</button>}</div>}
      {receipt && <div className="notice" role="status">{receipt === 'revoked' ? zh ? '邀请已撤销。' : 'Invitation revoked.' : zh ? '邀请已经撤销。' : 'Invitation was already revoked.'}</div>}
      <InvitationList invitations={items} disabled={!editable || loading || reconciling || op.pending || unknown || op.publicationError !== null || secret !== null || error !== null} canRevoke={(invitation) => !uncertain.has(invitation.id)} onRevoke={(invitation) => open({ kind: 'revoke', invitation })} action={<button className="button primary" type="button" disabled={!editable || loading || reconciling || op.pending || unknown || op.publicationError !== null || secret !== null || error !== null} onClick={() => open({ kind: 'create' })}>{m.invite}</button>} />
    </>}
    {secret !== null && (action === null || action === secret.action || !isVisible) && <SecretDialog key={secret.link} kind="invitation" secret={secret.link} suspended={!active} onClose={() => { setSecrets(previous => previous.slice(1)); if (action === secret.action) setAction(null); }} />}
    {action !== null && <ManagementDialog title={action.kind === 'create' ? zh ? '创建 Team 邀请链接' : 'Create Team invitation' : m.revokeTitle} busy={op.pending} suspended={!isVisible || secret !== null && action === secret.action} onClose={() => setAction(null)} footer={<><button className="button" type="button" disabled={op.pending} onClick={() => setAction(null)}>{common.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading || reconciling} onClick={check}>{m.readCurrentInvitations}</button> : <button className={`button ${action.kind === 'create' ? 'primary' : 'danger'}`} type="button" disabled={!editable || loading || reconciling || op.pending || op.publicationPending && op.outcome === 'confirmed' || op.publicationError !== null || action === completedAction || secret !== null || error !== null} onClick={submit}>{op.pending ? common.submitPending : action.kind === 'create' ? m.createInvite : m.revokeConfirm}</button>}</>}>
      <OperationPublicationError operation={op} zh={zh} />
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>{teamName}</strong></p>
      {action.kind === 'create' ? <><p>{zh ? '创建单次使用的链接，供受邀者登录并确认后加入 Team。' : 'Create a single-use link for someone to join this Team after signing in and confirming.'}</p><div className="notice">{m.inviteTerms}</div></> : <><p>{m.revokeBody}</p><code>{action.invitation.id}</code></>}
      {op.result !== null && <>{unknown ? <div className="notice warning" role="alert">{m.invitationUnknown}</div> : <ManagementError error={op.result.error} />}</>}
      {error !== null && <ManagementError error={error} />}
    </ManagementDialog>}
  </>;
};
