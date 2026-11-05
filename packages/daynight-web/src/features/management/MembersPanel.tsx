import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { createInvitation, listInvitations, listMembers, removeProjectGrant, revokeInvitation, setProjectGrant, type CurrentUser, type ProjectInvitation, type ProjectParticipant } from '../../api/auth';
import { useI18n } from '../../i18n/LocaleProvider';
import { ApiError, isAbortError } from '../../api/client';
import { ManagementDialog } from './ManagementDialog';
import { Identity, identityName, ManagementError, SecretDialog } from './feedback';
import { InvitationList } from './InvitationList';

type MemberDialog = { readonly kind: 'role'; readonly member: ProjectParticipant; readonly role: 'admin' | 'member' }
  | { readonly kind: 'remove'; readonly member: ProjectParticipant }
  | { readonly kind: 'invite' }
  | { readonly kind: 'revoke'; readonly invitation: ProjectInvitation }
  | { readonly kind: 'secret'; readonly secret: string };

type MembersPanelProps = {
  readonly projectId: string;
  readonly projectName: string;
  readonly active?: boolean;
  readonly onRoute?: boolean;
  readonly onGuardChange?: (guarded: boolean) => void;
  readonly user: CurrentUser;
  readonly onRemoved: () => void;
  readonly onUnavailable?: () => void;
  readonly onMembershipChange?: () => void;
};

export const MembersPanel = (props: MembersPanelProps) => <ProjectAccessBoundary projectId={props.projectId} initialRead active={props.active ?? true}><MembersContent key={`${props.user.id}:${props.projectId}`} {...props} /></ProjectAccessBoundary>;

const MembersContent = ({ projectId, projectName, user, onRemoved, onUnavailable, onMembershipChange, active = true, onRoute = true, onGuardChange }: MembersPanelProps) => {
  const { messages: { auth: { management: { members: m, common } }, common: globalCommon }, format } = useI18n();
  const access = useProjectAccess(projectId);
  const [members, setMembers] = useState<readonly ProjectParticipant[] | null>(null);
  const [invitations, setInvitations] = useState<readonly ProjectInvitation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'permissionReloaded' | 'conflictReloaded' | 'permissionChecked' | 'identityChanged' | null>(null);
  const [dialog, setDialog] = useState<MemberDialog | null>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ readonly name: string; readonly role: 'admin' | 'member' | null; readonly lostAccess: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [grantIssue, setGrantIssue] = useState<{ readonly error: unknown; readonly observed: boolean } | null>(null);
  const grantIssueRef = useRef(grantIssue); grantIssueRef.current = grantIssue;
  const grantSubmitting = useRef(false);
  const [invitationIssue, setInvitationIssue] = useState<{ readonly error: unknown; readonly observed: boolean; readonly action: 'invite' | 'revoke'; readonly invitationId?: string } | null>(null);
  const invitationIssueRef = useRef(invitationIssue); invitationIssueRef.current = invitationIssue;
  const invitationSubmitting = useRef(false);
  const uncertainRevocations = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const reloadAfterRevocation = useRef(false);
  const generation = useRef(0);
  const unavailableNotified = useRef(false);
  const notifyUnavailable = () => { if (!unavailableNotified.current) { unavailableNotified.current = true; callbacks.current.onUnavailable?.(); } };
  const activeRef = useRef(active); activeRef.current = active;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  useEffect(() => { guardCallback.current?.(pending || grantIssue !== null && !grantIssue.observed || invitationIssue !== null && !invitationIssue.observed); }, [pending, grantIssue, invitationIssue]);
  useEffect(() => { if (!onRoute && !grantSubmitting.current && !invitationSubmitting.current && !(grantIssueRef.current && !grantIssueRef.current.observed) && !(invitationIssueRef.current && !invitationIssueRef.current.observed)) setDialog((current) => current?.kind === 'secret' ? current : null); }, [onRoute]);
  const callbacks = useRef({ onUnavailable, onMembershipChange });
  callbacks.current = { onUnavailable, onMembershipChange };

  const load = async (lifetime: AbortSignal, requireInvitations = false): Promise<boolean | undefined> => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const request = ++generation.current;
    setLoading(true); setError(null); setUnavailable(false);
    try {
      let invitationsLoaded = false;
      await access.session.revalidate();
      if (signal.aborted || request !== generation.current) return;
      const observation = access.session.beginObservation();
      const result = await listMembers(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
      await access.session.scope.ready(signal);
      if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
      if (!access.session.publishSync(observation, result.actorAccess)) {
        if (!access.session.scope.isInvalidated) return load(lifetime, requireInvitations);
        return;
      }
      setMembers(result.items);
      const admitted = access.session.snapshot();
      if (admitted.status === 'ready' && !admitted.refreshing && admitted.access!.effectiveRole === 'admin') {
        try {
          const invitations = await listInvitations(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
          if (!signal.aborted && request === generation.current && access.session.snapshot().status !== 'unavailable') { setInvitations(invitations); invitationsLoaded = true; }
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.status !== 403) throw failure;
          setMembers(null); setInvitations(null);
          await access.session.revalidate();
          if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
          setMembers(result.items);
          callbacks.current.onMembershipChange?.();
          setNotice('permissionReloaded');
        }
      } else setInvitations(null);
      const current = access.session.snapshot();
      return current.status === 'ready' && !current.refreshing && (current.access!.effectiveRole === 'admin' ? invitationsLoaded : !requireInvitations);
    } catch (failure) {
      if (!isAbortError(failure) && !signal.aborted && request === generation.current) {
        setError(failure);
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) {
          setMembers(null); setInvitations(null);
          if (failure.status === 404) { setUnavailable(true); notifyUnavailable(); }
        }
      }
    } finally {
      if (readController.current === read) readController.current = null;
      if (!signal.aborted && request === generation.current) setLoading(false);
    }
  };
  useEffect(() => access.session.scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    ++generation.current; readController.current?.abort();
    reloadAfterRevocation.current = true;
    setMembers(null); setInvitations(null); setUnavailable(true); setLoading(false); setError(null); notifyUnavailable();
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    setMembers(null); setInvitations(null); setDialog(null); setNotice(null);
    return () => { active.abort(); readController.current?.abort(); ++generation.current; guardCallback.current?.(false); };
  }, [projectId, user.id]);
  useEffect(() => {
    if (!active || controller.current === null) return;
    void load(controller.current.signal);
    return () => { readController.current?.abort(); ++generation.current; };
  }, [active, projectId, user.id]);
  useEffect(() => {
    if (!active || !access.ready || controller.current === null) return;
    unavailableNotified.current = false;
    const missingInvitations = access.access!.effectiveRole === 'admin' && members !== null && invitations === null && !loading && error === null;
    if (!reloadAfterRevocation.current && !missingInvitations) return;
    reloadAfterRevocation.current = false;
    void load(controller.current.signal);
  }, [active, access.ready, access.access?.effectiveRole, unavailable, members, invitations, loading, error, access.session]);
  const admin = !access.session.scope.isInvalidated && access.access?.effectiveRole === 'admin';
  const grantBlocked = grantIssue !== null && !grantIssue.observed;
  const participantIdentity = (member: ProjectParticipant) => ({ ...member.profile, userId: member.userId });
  const open = (next: MemberDialog) => { if ((next.kind === 'role' || next.kind === 'remove') && grantIssueRef.current !== null && !grantIssueRef.current.observed) return; setDialogError(null); setDialog(next); void access.session.revalidate(); };

  const submit = async (action: Exclude<MemberDialog, { readonly kind: 'secret' }>) => {
    const admitted = access.session.snapshot();
    if (!active || access.session.scope.isInvalidated || admitted.status !== 'ready' || admitted.refreshing || admitted.access!.effectiveRole !== 'admin') return;
    const grantAction = action.kind === 'role' || action.kind === 'remove';
    const invitationAction = !grantAction;
    if (invitationAction && (invitationSubmitting.current || invitationIssueRef.current !== null && (!invitationIssueRef.current.observed || action.kind === 'revoke' && uncertainRevocations.current.has(action.invitation.id)))) return;
    if (invitationAction) invitationSubmitting.current = true;
    if (grantAction && (grantSubmitting.current || action.kind === 'remove' && action.member.directGrant === null || grantIssueRef.current !== null && !grantIssueRef.current.observed)) return;
    if (grantAction) { grantSubmitting.current = true; grantIssueRef.current = null; setGrantIssue(null); }
    guardCallback.current?.(true); setPending(true); setDialogError(null); setNotice(null); setReceipt(null);
    const signal = controller.current!.signal;
    let dispatched = false;
    try {
      if (action.kind === 'role' || action.kind === 'remove') {
        const result = action.kind === 'role'
          ? await setProjectGrant(projectId, action.member.userId, { version: action.member.directGrant?.version ?? null, role: action.role, expectedUserId: user.id }, signal, access.session.scope.principalMismatch)
          : await removeProjectGrant(projectId, action.member.userId, { version: action.member.directGrant!.version, expectedUserId: user.id }, signal, access.session.scope.principalMismatch);
        if (signal.aborted || access.session.scope.isInvalidated) return;
        ++generation.current; readController.current?.abort();
        access.session.publishMutation(result.actorAccess);
        setDialog(null);
        setReceipt({ name: identityName(participantIdentity(action.member)), role: action.kind === 'role' ? action.role : null, lostAccess: result.actorAccess === null });
        callbacks.current.onMembershipChange?.();
        if (result.actorAccess === null) {
          setMembers(null); setInvitations(null); setUnavailable(true);
          access.session.scope.suspendProject(projectId);
          const current = await access.session.revalidateAfterMutation();
          if (current !== null && !signal.aborted && !access.session.scope.isInvalidated) {
            setUnavailable(false);
            await load(signal);
          }
          return;
        }
        if (result.actorAccess.effectiveRole !== 'admin') setInvitations(null);
        await load(signal); return;
      } else if (action.kind === 'invite') {
        const result = await createInvitation(projectId, user.id, signal, access.session.scope.principalMismatch, () => { dispatched = true; });
        if (signal.aborted) return;
        const { link, ...metadata } = result;
        setInvitations((items) => [metadata, ...(items ?? [])]);
        setDialog({ kind: 'secret', secret: link });
        if (activeRef.current) await load(signal); return;
      } else await revokeInvitation(projectId, action.invitation.id, user.id, signal, access.session.scope.principalMismatch, () => { dispatched = true; });
      if (signal.aborted) return;
      setDialog(null); if (activeRef.current) await load(signal);
    } catch (failure) {
      if ((!isAbortError(failure) || invitationAction && dispatched) && !signal.aborted) {
        if (failure instanceof ApiError && (failure.code === 'identity_mismatch' || failure.code === 'principal_mismatch')) {
          setMembers(null); setInvitations(null); setDialog(null); setNotice('identityChanged');
          return;
        }
        if (invitationAction && (!(failure instanceof ApiError) || failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown')) {
          if (action.kind === 'revoke') uncertainRevocations.current.add(action.invitation.id);
          const issue = { error: failure, observed: false, action: action.kind as 'invite' | 'revoke', ...(action.kind === 'revoke' ? { invitationId: action.invitation.id } : {}) };
          invitationIssueRef.current = issue; setInvitationIssue(issue); setDialog(null); setDialogError(null);
          return;
        }
        if (grantAction && (!(failure instanceof ApiError) || failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown')) {
          const issue = { error: failure, observed: false };
          grantIssueRef.current = issue; setGrantIssue(issue); setDialog(null); setDialogError(null);
          return;
        }
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 409 || failure.status === 404)) {
          setMembers(null); setInvitations(null); setDialog(null);
          setNotice(failure.status === 409 ? 'conflictReloaded' : 'permissionChecked');
          callbacks.current.onMembershipChange?.();
          await load(signal);
        } else setDialogError(failure);
      }
    } finally { if (grantAction) grantSubmitting.current = false; if (invitationAction) invitationSubmitting.current = false; if (!signal.aborted) setPending(false); }
  };

  const dialogTitle = dialog?.kind === 'role' ? m.roleTitle({ name: identityName(participantIdentity(dialog.member)) })
    : dialog?.kind === 'remove' ? m.removeTitle({ name: identityName(participantIdentity(dialog.member)) })
      : dialog?.kind === 'revoke' ? m.revokeTitle : m.inviteTitle;
  const roleText = (role: 'admin' | 'member' | null) => role === null ? m.noGrant : role === 'admin' ? common.roleAdmin : common.roleMember;
  const confirm = dialog?.kind === 'role' ? m.saveRole : dialog?.kind === 'remove' ? m.removeConfirm : dialog?.kind === 'revoke' ? m.revokeConfirm : m.createInvite;
  return <>
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle({ projectName })}</p></div>{admin && <button className="button primary" type="button" disabled={loading || !access.ready || invitationIssue !== null && !invitationIssue.observed} onClick={() => open({ kind: 'invite' })}>{m.invite}</button>}</div>
    {grantIssue !== null && <div className="notice warning" role="alert"><p>{grantIssue.observed ? m.grantObserved : m.grantUnknown}</p>{grantIssue.error instanceof ApiError && grantIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{grantIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal).then((observed) => { if (observed && grantIssueRef.current !== null) { const issue = { ...grantIssueRef.current, observed: true }; grantIssueRef.current = issue; setGrantIssue(issue); } }); }}>{m.readCurrentMembers}</button></div>}
    {invitationIssue !== null && <div className="notice warning" role="alert"><p>{invitationIssue.observed ? m.invitationObserved : m.invitationUnknown}</p>{!invitationIssue.observed && (access.status === 'unavailable' || access.status === 'ready' && !admin) && <p>{m.invitationUnreadable}</p>}{invitationIssue.error instanceof ApiError && invitationIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{invitationIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal, true).then((observed) => { if (observed && invitationIssueRef.current !== null) { const issue = { ...invitationIssueRef.current, observed: true }; invitationIssueRef.current = issue; setInvitationIssue(issue); } }); }}>{m.readCurrentInvitations}</button></div>}
    {receipt !== null && <div className="notice" role="status"><p>{receipt.role === null ? m.grantRemoved({ name: receipt.name }) : m.grantSaved({ name: receipt.name, role: receipt.role === 'admin' ? common.roleAdmin : common.roleMember })}</p>{receipt.lostAccess && <><p>{m.accessLost}</p>{access.status !== 'ready' && <button className="button" type="button" onClick={onRemoved}>{m.returnToProjects}</button>}</>}</div>}
    {notice !== null && <div className="notice" role="status">{m.notice[notice]}</div>}
    {(error !== null || access.error !== null && !(receipt?.lostAccess === true && access.error instanceof ApiError && access.error.kind === 'server' && access.error.status === 404 && access.error.code === 'not_found')) && <ManagementError error={error ?? access.error} retry={() => { void load(controller.current!.signal); }} />}
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {receipt?.lostAccess !== true && (unavailable || access.status === "unavailable") && error === null && access.error === null && <div className="notice error" role="alert">{common.notFound}</div>}
    {!loading && members !== null && !unavailable && access.status !== 'unavailable' && <>
      {access.ready && !admin && <div className="notice">{m.memberNotice}</div>}
      <section className="panel" aria-labelledby="members-title"><div className="panel-heading"><div><h2 id="members-title">{m.membersTitle} <span className="badge">{format.number(members.length)}</span></h2><p>{m.accessDescription}</p></div></div>
        <div className="grant-table">
          <div className="row grant-row head" aria-hidden="true"><span>{m.memberColumn}</span><span>{m.effectiveColumn}</span><span>{m.teamColumn}</span><span>{m.directColumn}</span><span>{m.actionColumn}</span></div>
          {members.map((member) => {
            const grant = member.directGrant;
            const identity = participantIdentity(member);
            const roleText = (role: 'admin' | 'member') => role === 'admin' ? common.roleAdmin : common.roleMember;
            return <div className="row grant-row" key={member.userId}><Identity user={identity} self={member.userId === user.id} />
              <div><span className="grant-label">{m.effectiveColumn}: </span><span className={`badge${member.effectiveRole === 'admin' ? ' admin' : ''}`}>{roleText(member.effectiveRole)}</span></div>
              <div><span className="grant-label">{m.teamColumn}: </span>{member.inheritedFrom === null ? '—' : <>{roleText(member.inheritedFrom.role)}<div className="row-detail">{member.inheritedFrom.team.kind === 'personal' ? m.personalTeam : member.inheritedFrom.team.name}</div></>}</div>
              <div><span className="grant-label">{m.directColumn}: </span>{admin ? <select className="role-select" aria-label={m.roleLabel({ name: identityName(identity) })} disabled={pending || !access.ready || grantBlocked} value={grant?.role ?? ''} onChange={(event) => { if (event.target.value === 'admin' || event.target.value === 'member') open({ kind: 'role', member, role: event.target.value }); }}><option value="" disabled>{m.noGrant}</option><option value="member">{common.roleMember}</option><option value="admin">{common.roleAdmin}</option></select> : grant === null ? m.noGrant : roleText(grant.role)}</div>
              <div className="actions">{admin && grant !== null ? <button className="button quiet" type="button" aria-label={m.removeLabel({ name: identityName(identity) })} disabled={pending || !access.ready || grantBlocked} onClick={() => open({ kind: 'remove', member })}>{m.remove}</button> : <span className="muted small">—</span>}</div></div>;
          })}
        </div>
      </section>
      {admin && <InvitationList invitations={invitations} disabled={pending || !access.ready || invitationIssue !== null && !invitationIssue.observed} canRevoke={(invitation) => !uncertainRevocations.current.has(invitation.id)} onRevoke={(invitation) => open({ kind: 'revoke', invitation })} />}
      <div className="role-legend"><div><h3>{common.roleAdmin}</h3><p>{m.adminDescription}</p></div><div><h3>{common.roleMember}</h3><p>{m.memberDescription}</p></div></div>
    </>}
    {dialog?.kind === 'secret' && <SecretDialog kind="invitation" secret={dialog.secret} suspended={!active} onClose={() => setDialog(null)} />}
    {dialog !== null && dialog.kind !== 'secret' && !unavailable && access.status !== 'unavailable' && <ManagementDialog title={dialogTitle} busy={pending} suspended={!active} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className={`button${dialog.kind === 'remove' || dialog.kind === 'revoke' ? ' danger' : ' primary'}`} type="button" disabled={pending || !access.ready} onClick={() => { void submit(dialog); }}>{pending ? common.submitPending : confirm}</button></>}>
      {(dialog.kind === 'role' || dialog.kind === 'remove') && <p>{m.grantChange({ before: roleText(dialog.member.directGrant?.role ?? null), after: roleText(dialog.kind === 'role' ? dialog.role : null), effective: dialog.member.inheritedFrom === null && dialog.kind === 'remove' ? m.noAccess : roleText(dialog.member.inheritedFrom?.role === 'admin' || dialog.kind === 'role' && dialog.role === 'admin' ? 'admin' : 'member') })}</p>}
      {dialog.kind === 'remove' && <p>{dialog.member.userId === user.id ? m.selfRemovalBody : m.otherRemovalBody}</p>}
      {dialog.kind === 'invite' && <><p>{m.inviteBody}</p><div className="notice">{m.inviteTerms}</div></>}
      {dialog.kind === 'revoke' && <p>{m.revokeBody}</p>}
      {dialogError !== null && <ManagementError error={dialogError} />}
    </ManagementDialog>}
  </>;
};
