import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CurrentUser } from '../../api/auth-types';
import { ApiError } from '../../api/client';
import { acceptGitHubAppAdminInvitation, inspectGitHubAppAdminInvitation, type GitHubAppAdminInvitationInspection } from '../../api/github-app-admin';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { OperationPublicationError, useOperation } from '../teams/TeamManagement';
import { useTeamForeground } from '../teams/useTeamForeground';
import { adminMessages } from './messages';
import './github-app-administration.css';

export type GitHubInvitationActivity = 'pending' | 'confirmed-pending' | 'confirmed' | 'rejected' | 'unknown' | null;
type Props = { readonly preserveConfirmed?: boolean; readonly onActivity?: (activity: GitHubInvitationActivity) => void; readonly token: string | null; readonly user: CurrentUser; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly onIdentityMismatch: () => void; readonly onAccepted: (appId: string) => void; readonly onUnavailable: () => void };
const auth = (admission: TaskCacheScope, mismatch: () => void, dispatched?: () => void) => ({ userId: admission.userId, onPrincipalMismatch: mismatch, ...(dispatched ? { onDispatch: dispatched } : {}) });
const unavailable = (error: unknown) => error instanceof ApiError && error.kind === 'server' && (error.status === 404 || error.status === 410) && error.code === 'invitation_unavailable';

// Token and displayed identity belong to this exact account and admission lifetime.
export const GitHubAppInvitation = (props: Props) => {
  const owner = useRef({ admission: props.admission, userId: props.user.id, token: props.token, revision: 0 });
  if (owner.current.admission !== props.admission || owner.current.userId !== props.user.id || owner.current.token !== props.token && !(props.preserveConfirmed && props.token === null)) owner.current = { admission: props.admission, userId: props.user.id, token: props.token, revision: owner.current.revision + 1 };
  else if (props.preserveConfirmed && props.token === null) owner.current.token = null;
  return <Invitation key={owner.current.revision} {...props} />;
};

const Invitation = ({ token, user, active, admission, admissionBlocked, onIdentityMismatch, onAccepted, onUnavailable, onActivity }: Props) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = adminMessages(zh);
  const [inspection, setInspection] = useState<GitHubAppAdminInvitationInspection | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [missing, setMissing] = useState(token === null), [observed, setObserved] = useState(false), [success, setSuccess] = useState<string | null>(null);
  const read = useRef<AbortController | null>(null), entry = useRef(false), wasActive = useRef(false), fresh = useRef(false), activeRef = useRef(active), secret = useRef(token), op = useOperation(admission);
  const operation = useRef(op); operation.current = op;
  const callbacks = useRef({ onAccepted, onUnavailable, onIdentityMismatch, onActivity }); callbacks.current = { onAccepted, onUnavailable, onIdentityMismatch, onActivity }; activeRef.current = active;
  if (!active) wasActive.current = false; else if (!wasActive.current) { wasActive.current = true; entry.current = false; }
  if (active && (secret.current === null || success !== null)) entry.current = true;
  if (!active || admissionBlocked) fresh.current = false;
  const load = useCallback(async (checkingUnknown = false) => {
    if (!active || admissionBlocked || admission.isInvalidated || user.id !== admission.userId || secret.current === null) return;
    fresh.current = false; read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); if (!entry.current || !inspection) setLoading(true);
    try {
      await admission.ready(signal); const result = await inspectGitHubAppAdminInvitation(secret.current, signal, auth(admission, () => callbacks.current.onIdentityMismatch())); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return;
      setInspection(result); setError(null); setMissing(false); fresh.current = true; entry.current = true; if (checkingUnknown) setObserved(true);
    } catch (failure) {
      if (!signal.aborted && !admission.isInvalidated) { try { await admission.ready(signal); } catch { return; } if (!signal.aborted && !admission.isInvalidated) {
        if (unavailable(failure)) { setInspection(null); setMissing(true); entry.current = true; if (checkingUnknown || operation.current.result?.kind === 'unknown') setObserved(true); else if (!operation.current.pending && !operation.current.publicationPending) { secret.current = null; callbacks.current.onUnavailable(); } }
        else setError(failure);
      } }
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [active, admissionBlocked, admission, user.id, inspection]);
  useEffect(() => { if (!active || admissionBlocked || success) return; void load(); return () => { read.current?.abort(); read.current = null; }; }, [active, admissionBlocked, admission, user.id, success]);
  useTeamForeground(active && !admissionBlocked && success === null, () => { void load(op.result?.kind === 'unknown'); });
  const accept = () => {
    if (!active || admissionBlocked || !fresh.current || !inspection || !secret.current || op.guarded() || user.id !== admission.userId) return;
    const target = inspection.app.id, value = secret.current;
    void op.run((signal, dispatched) => acceptGitHubAppAdminInvitation(value, target, signal, auth(admission, () => callbacks.current.onIdentityMismatch(), () => { callbacks.current.onActivity?.('pending'); dispatched(); })), receipt => {
      secret.current = null; setSuccess(receipt.appId); setInspection(null); setError(null); setMissing(false); entry.current = true;
    }, failure => { if (unavailable(failure)) { secret.current = null; setInspection(null); setMissing(true); } });
  };
  const unknown = op.result?.kind === 'unknown';
  const activity: GitHubInvitationActivity = success !== null ? 'confirmed' : op.outcome === 'confirmed' ? 'confirmed-pending' : unknown ? 'unknown' : op.pending || op.publicationPending ? 'pending' : op.result?.kind === 'rejected' ? 'rejected' : null;
  useLayoutEffect(() => { if (activity === 'confirmed-pending' || activity === 'confirmed' || activity === 'rejected') secret.current = null; callbacks.current.onActivity?.(activity); }, [activity]);
  const visible = entry.current && active && !admission.isInvalidated && user.id === admission.userId;
  return <main className="github-app-admin-invitation"><section className="panel"><div className="panel-body">
    <div className="eyebrow">GITHUB APP INVITATION</div><h1>{m.invitationHeading}</h1>
    {!visible && loading && <p role="status">{m.loading}</p>}
    {visible && success && <><p role="status">{m.accepted}</p><button className="button primary" type="button" onClick={() => callbacks.current.onAccepted(success)}>{m.openApp}</button><button className="button" type="button" onClick={() => callbacks.current.onUnavailable()}>{m.close}</button></>}
    {visible && !success && missing && <p className="notice warning" role="alert">{m.unavailableInvite}</p>}
    {error !== null && <div className="notice error" role="alert">{m.inspectFailed} <button type="button" className="button" disabled={admissionBlocked} onClick={() => void load(unknown)}>{m.retry}</button></div>}
    {visible && !success && inspection && <><p>{m.invitationIntro}</p><p><strong>{inspection.app.name}</strong><br />App ID {inspection.app.githubAppId} · {inspection.app.githubSlug}</p><p>{m.invitationRights}</p><p>{m.accepting}: {user.name || user.email || user.id}{user.name && user.email ? ` · ${user.email}` : ''}</p><p>{m.expires}{new Date(inspection.expiresAt).toLocaleString(locale)}</p>{inspection.membership && <p>{m.already}</p>}</>}
    {unknown && <div className="notice warning" role="alert"><p>{m.invitationUnknown}</p>{observed && <><p>{m.checked}</p><button type="button" className="button" onClick={() => { op.clear(); setObserved(false); secret.current = null; callbacks.current.onUnavailable(); }}>{m.dismiss}</button></>}<button type="button" className="button" disabled={admissionBlocked || op.pending} onClick={() => void load(true)}>{m.check}</button></div>}
    {op.result && !unknown && <div className="notice error" role="alert">{m.rejected} <button type="button" className="button" onClick={() => { op.clear(); callbacks.current.onUnavailable(); }}>{m.close}</button></div>}<OperationPublicationError operation={op} zh={zh} />
    {visible && inspection && !op.result && op.outcome !== 'confirmed' && (inspection.membership ? <button className="button primary" type="button" onClick={() => callbacks.current.onAccepted(inspection.app.id)}>{m.openApp}</button> : <button className="button primary" type="button" disabled={op.pending || op.publicationPending || admissionBlocked || !fresh.current} onClick={accept}>{op.pending ? m.submitting : m.accept}</button>)}
  </div></section></main>;
};

export const GitHubInvitationHost = ({ token, user, active, admission, admissionBlocked, onIdentityMismatch, onRetentionChange, onTokenConsumed, onDiscard, onAccepted, onReturn }: {
  readonly token: string | null; readonly user: CurrentUser; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean;
  readonly onIdentityMismatch: () => void; readonly onRetentionChange: (activity: GitHubInvitationActivity) => void; readonly onTokenConsumed: () => void; readonly onDiscard: () => void; readonly onAccepted: (appId: string) => void; readonly onReturn: () => void;
}) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN';
  const [activity, setActivity] = useState<GitHubInvitationActivity>(null), [revision, setRevision] = useState(0);
  const current = useRef<GitHubInvitationActivity>(null), activeRef = useRef(active), callbacks = useRef({ onRetentionChange, onTokenConsumed, onDiscard, onAccepted, onReturn });
  activeRef.current = active; callbacks.current = { onRetentionChange, onTokenConsumed, onDiscard, onAccepted, onReturn };
  const discard = () => { current.current = null; setActivity(null); callbacks.current.onRetentionChange(null); callbacks.current.onDiscard(); setRevision(value => value + 1); };
  const publish = (next: GitHubInvitationActivity) => {
    const prior = current.current; current.current = next; setActivity(next); callbacks.current.onRetentionChange(next);
    if ((next === 'confirmed-pending' || next === 'confirmed' || next === 'rejected') && prior !== 'confirmed-pending' && prior !== 'confirmed' && prior !== 'rejected') callbacks.current.onTokenConsumed();
    if (next === null && prior !== null && !activeRef.current) discard();
  };
  return <>
    {!active && activity !== null && <div className="notice" role={activity === 'unknown' ? 'alert' : 'status'}>
      <p>{activity === 'pending' ? (zh ? '正在接受 App 管理员邀请。' : 'Accepting the App administrator invitation.') : activity === 'confirmed-pending' ? (zh ? '邀请已接受，请返回完成结果显示。' : 'The invitation was accepted. Return to finish displaying the result.') : activity === 'confirmed' ? (zh ? 'App 管理员邀请已接受。' : 'The App administrator invitation was accepted.') : activity === 'rejected' ? (zh ? 'App 管理员邀请未被接受。' : 'The App administrator invitation was not accepted.') : (zh ? '邀请接受结果未知。请返回核对，勿重复提交。' : 'The invitation acceptance outcome is unknown. Return to review it before deciding again.')}</p>
      <button className="button" type="button" onClick={() => callbacks.current.onReturn()}>{zh ? '返回邀请' : 'Return to invitation'}</button>{(activity === 'confirmed' || activity === 'rejected') && <button className="button" type="button" onClick={discard}>{zh ? '关闭' : 'Dismiss'}</button>}
    </div>}
    <div hidden={!active} inert={!active}><GitHubAppInvitation key={revision} token={token} user={user} active={active} admission={admission} admissionBlocked={admissionBlocked} preserveConfirmed={activity === 'confirmed-pending' || activity === 'confirmed' || activity === 'rejected'} onActivity={publish} onIdentityMismatch={onIdentityMismatch} onUnavailable={discard} onAccepted={appId => { discard(); callbacks.current.onAccepted(appId); }} /></div>
  </>;
};
