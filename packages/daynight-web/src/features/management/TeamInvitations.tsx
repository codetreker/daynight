import { useCallback, useEffect, useRef, useState } from 'react';
import { createTeamInvitation, listTeamInvitations, revokeTeamInvitation, type TeamInvitation } from '../../api/auth';
import { ApiError, authRequestsPaused } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useOperation } from '../teams/TeamManagement';
import { InvitationList } from './InvitationList';
import { ManagementDialog } from './ManagementDialog';
import { ManagementError, SecretDialog } from './feedback';

type Action = { readonly kind: 'create' } | { readonly kind: 'revoke'; readonly invitation: TeamInvitation } | { readonly kind: 'secret'; readonly secret: string };

export const TeamInvitations = ({ teamId, teamName, active, admissionBlocked = false, permissionReady = true, onRoute, editable, actorRole, unavailable, admission, onIdentityMismatch, onPermissionChange, onGuardChange }: {
  readonly teamId: string; readonly teamName: string; readonly active: boolean; readonly admissionBlocked?: boolean; readonly permissionReady?: boolean; readonly onRoute: boolean; readonly editable: boolean; readonly actorRole: 'admin' | 'member' | null; readonly unavailable: boolean;
  readonly admission: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onPermissionChange: () => void; readonly onGuardChange: (retain: boolean, lock: boolean) => void;
}) => {
  const { locale, messages: { auth: { management: { members: m, common } }, common: globalCommon } } = useI18n();
  const zh = locale === 'zh-CN';
  const [items, setItems] = useState<readonly TeamInvitation[] | null>(null);
  // A retained invitation list does not authorize writes while either read is pending.
  const loaded = useRef(false), fresh = useRef(false), backgroundRecheck = useRef(false);
  if (!active || !editable) { fresh.current = false; backgroundRecheck.current = false; }
  else if (admissionBlocked) { fresh.current = false; backgroundRecheck.current = true; }
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [needsRefresh, setNeedsRefresh] = useState(false);
  const permissionRef = useRef(false); permissionRef.current = permissionReady && !admissionBlocked;
  const [action, setAction] = useState<Action | null>(null), [observed, setObserved] = useState(false);
  const [issue, setIssue] = useState<unknown>(null), [receipt, setReceipt] = useState<'revoked' | 'already' | null>(null);
  const uncertain = useRef(new Set<string>()), read = useRef<AbortController | null>(null);
  const permissionNotified = useRef(false);
  const op = useOperation(admission), operation = useRef(op); operation.current = op;
  const permission = useRef(onPermissionChange); permission.current = onPermissionChange;
  const guard = useRef(onGuardChange); guard.current = onGuardChange;
  const unknown = op.result?.kind === 'unknown';
  const memberWithoutManagement = actorRole === 'member';
  useEffect(() => { guard.current(op.pending || unknown || issue !== null || action?.kind === 'secret', op.pending || unknown && !memberWithoutManagement); }, [op.pending, unknown, issue, action?.kind, memberWithoutManagement]);
  useEffect(() => { if (unknown && memberWithoutManagement) setAction(null); }, [unknown, memberWithoutManagement]);
  useEffect(() => () => { read.current?.abort(); guard.current(false, false); }, []);
  useEffect(() => { if (!onRoute && !operation.current.guarded()) setAction((current) => current?.kind === 'secret' ? current : null); }, [onRoute]);
  const load = useCallback(async (background = false) => {
    if (!active || !editable) return false;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); fresh.current = false;
    if (!background || !loaded.current) setLoading(true);
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
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [active, editable, admission, teamId, onIdentityMismatch]);
  useEffect(() => {
    if (active && editable && !admissionBlocked) {
      const background = backgroundRecheck.current && loaded.current;
      backgroundRecheck.current = false;
      void load(background);
    }
    return () => read.current?.abort();
  }, [active, editable, admissionBlocked, load]);
  useEffect(() => {
    if (!needsRefresh || !active || !editable || admissionBlocked || !permissionReady || authRequestsPaused()) return;
    setNeedsRefresh(false); void load(true);
  }, [needsRefresh, active, editable, admissionBlocked, permissionReady, load]);
  const check = () => { void load().then((ok) => { if (ok && operation.current.result?.kind === 'unknown') { setIssue(operation.current.result.error); setObserved(true); operation.current.clear(); setAction(null); } }); };
  const open = (next: Action) => {
    if (!active || !editable || loading || op.pending || unknown || error !== null) return;
    operation.current.clear(); setAction(next); setReceipt(null);
  };
  const submit = () => {
    if (!action || action.kind === 'secret' || !active || !editable || authRequestsPaused() || !permissionReady || !fresh.current || loading || op.pending || unknown || error !== null) return;
    if (action.kind === 'revoke' && uncertain.current.has(action.invitation.id)) return;
    guard.current(true, true);
    const rejected = (failure: unknown) => { if (failure instanceof ApiError && failure.kind === 'server' && (failure.status === 403 || failure.status === 404)) permission.current(); };
    if (action.kind === 'create') void op.run((signal, dispatched) => createTeamInvitation(teamId, admission.userId, signal, onIdentityMismatch, dispatched), (created) => {
      setAction({ kind: 'secret', secret: created.link }); setIssue(null); setObserved(false); setNeedsRefresh(true);
    }, rejected);
    else void op.run((signal, dispatched) => revokeTeamInvitation(teamId, action.invitation.id, admission.userId, signal, onIdentityMismatch, dispatched), (result) => {
      setAction(null); setReceipt(result.changed ? 'revoked' : 'already'); setIssue(null); setObserved(false); if (active) void load();
    }, rejected);
  };
  useEffect(() => { if (unknown && action?.kind === 'revoke') uncertain.current.add(action.invitation.id); }, [unknown, action]);
  const isVisible = editable && active;
  const currentIssue = unknown ? op.result?.error : issue;
  return <>
    {active && !isVisible && currentIssue !== null && currentIssue !== undefined && <div className="notice warning" role="alert"><p>{unavailable ? zh ? "邀请变更结果仍未确认；此 Team 不可用或你已无权访问。" : "The invitation change is still unconfirmed; this Team is unavailable or you no longer have access." : memberWithoutManagement ? zh ? "邀请变更结果仍未确认；你已无权读取此 Team 的邀请。" : "The invitation change is still unconfirmed; you no longer have permission to read this Team’s invitations." : observed && !unknown ? m.invitationObserved : m.invitationUnknown}</p>{currentIssue instanceof ApiError && currentIssue.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{currentIssue.requestId}</code></p>}</div>}
    {isVisible && <>
      {loading && <div className="empty-inline" role="status">{m.loading}</div>}
      {error !== null && (error instanceof ApiError && error.kind === 'server' && (error.status === 403 || error.status === 404) ? <div className="notice error" role="alert"><p>{zh ? '无法读取此 Team 的邀请，请检查权限后重试。' : 'Unable to read invitations for this Team. Check your permissions and retry.'}</p>{error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{error.requestId}</code></p>}<button className="button" type="button" onClick={() => { permissionNotified.current = false; void load(); }}>{common.retry}</button></div> : <ManagementError error={error} retry={() => { permissionNotified.current = false; void load(); }} />)}
      {currentIssue !== null && currentIssue !== undefined && <div className="notice warning" role="alert"><p>{observed && !unknown ? m.invitationObserved : m.invitationUnknown}</p>{currentIssue instanceof ApiError && currentIssue.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{currentIssue.requestId}</code></p>}{unknown && <button className="button" type="button" disabled={loading || op.pending} onClick={check}>{m.readCurrentInvitations}</button>}</div>}
      {receipt && <div className="notice" role="status">{receipt === 'revoked' ? zh ? '邀请已撤销。' : 'Invitation revoked.' : zh ? '邀请已经撤销。' : 'Invitation was already revoked.'}</div>}
      <InvitationList invitations={items} disabled={loading || op.pending || unknown || error !== null} canRevoke={(invitation) => !uncertain.current.has(invitation.id)} onRevoke={(invitation) => open({ kind: 'revoke', invitation })} action={<button className="button primary" type="button" disabled={loading || op.pending || unknown || error !== null} onClick={() => open({ kind: 'create' })}>{m.invite}</button>} />
    </>}
    {action?.kind === 'secret' && <SecretDialog kind="invitation" secret={action.secret} suspended={!active} onClose={() => setAction(null)} />}
    {action !== null && action.kind !== 'secret' && <ManagementDialog title={action.kind === 'create' ? zh ? '创建 Team 邀请链接' : 'Create Team invitation' : m.revokeTitle} busy={op.pending} suspended={!isVisible} onClose={() => setAction(null)} footer={<><button className="button" type="button" disabled={op.pending} onClick={() => setAction(null)}>{common.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading} onClick={check}>{m.readCurrentInvitations}</button> : <button className={`button ${action.kind === 'create' ? 'primary' : 'danger'}`} type="button" disabled={loading || op.pending || error !== null} onClick={submit}>{op.pending ? common.submitPending : action.kind === 'create' ? m.createInvite : m.revokeConfirm}</button>}</>}>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>{teamName}</strong></p>
      {action.kind === 'create' ? <><p>{zh ? '创建单次使用的链接，供受邀者登录并确认后加入 Team。' : 'Create a single-use link for someone to join this Team after signing in and confirming.'}</p><div className="notice">{m.inviteTerms}</div></> : <><p>{m.revokeBody}</p><code>{action.invitation.id}</code></>}
      {op.result !== null && <>{unknown ? <div className="notice warning" role="alert">{m.invitationUnknown}</div> : <ManagementError error={op.result.error} />}</>}
      {error !== null && <ManagementError error={error} />}
    </ManagementDialog>}
  </>;
};
