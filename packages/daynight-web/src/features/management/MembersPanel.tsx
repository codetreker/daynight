import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { createInvitation, listInvitations, listMembers, removeMember, revokeInvitation, setMemberRole, type CurrentUser, type ProjectInvitation, type ProjectMember } from '../../api/auth';
import { useI18n } from '../../i18n/LocaleProvider';
import { ApiError, isAbortError } from '../../api/client';
import { ManagementDialog } from './ManagementDialog';
import { DateLabel, Identity, identityName, ManagementError, SecretDialog } from './feedback';

type MemberDialog = { readonly kind: 'role'; readonly member: ProjectMember; readonly role: 'admin' | 'member' }
  | { readonly kind: 'remove'; readonly member: ProjectMember }
  | { readonly kind: 'invite' }
  | { readonly kind: 'revoke'; readonly invitation: ProjectInvitation }
  | { readonly kind: 'secret'; readonly secret: string };

type MembersPanelProps = {
  readonly projectId: string;
  readonly projectName: string;
  readonly user: CurrentUser;
  readonly onRemoved: () => void;
  readonly onUnavailable?: () => void;
  readonly onMembershipChange?: () => void;
};

export const MembersPanel = (props: MembersPanelProps) => <ProjectAccessBoundary projectId={props.projectId} initialRead><MembersContent key={`${props.user.id}:${props.projectId}`} {...props} /></ProjectAccessBoundary>;

const MembersContent = ({ projectId, projectName, user, onRemoved, onUnavailable, onMembershipChange }: MembersPanelProps) => {
  const { messages: { auth: { management: { members: m, common } } }, format } = useI18n();
  const access = useProjectAccess(projectId);
  const [members, setMembers] = useState<readonly ProjectMember[] | null>(null);
  const [invitations, setInvitations] = useState<readonly ProjectInvitation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'permissionReloaded' | 'conflictReloaded' | 'permissionChecked' | null>(null);
  const [dialog, setDialog] = useState<MemberDialog | null>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const reloadAfterRevocation = useRef(false);
  const generation = useRef(0);
  const unavailableNotified = useRef(false);
  const notifyUnavailable = () => { if (!unavailableNotified.current) { unavailableNotified.current = true; callbacks.current.onUnavailable?.(); } };
  const callbacks = useRef({ onUnavailable, onMembershipChange });
  callbacks.current = { onUnavailable, onMembershipChange };

  const load = async (lifetime: AbortSignal) => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const request = ++generation.current;
    setLoading(true); setError(null); setUnavailable(false);
    try {
      const [result] = await Promise.all([listMembers(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch }), access.session.revalidate()]);
      if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
      setMembers(result);
      const admitted = access.session.snapshot();
      if (admitted.status === 'ready' && !admitted.refreshing && admitted.access!.effectiveRole === 'admin') {
        try {
          const invitations = await listInvitations(projectId, signal);
          if (!signal.aborted && request === generation.current && access.session.snapshot().status !== 'unavailable') setInvitations(invitations);
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.status !== 403) throw failure;
          setMembers(null); setInvitations(null);
          await access.session.revalidate();
          if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
          setMembers(result);
          callbacks.current.onMembershipChange?.();
          setNotice('permissionReloaded');
        }
      } else setInvitations(null);
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
    void load(active.signal);
    return () => { active.abort(); readController.current?.abort(); ++generation.current; };
  }, [projectId, user.id]);
  useEffect(() => {
    if (!access.ready || controller.current === null) return;
    unavailableNotified.current = false;
    const missingInvitations = access.access!.effectiveRole === 'admin' && members !== null && invitations === null && !loading && error === null;
    if (!reloadAfterRevocation.current && !missingInvitations) return;
    reloadAfterRevocation.current = false;
    void load(controller.current.signal);
  }, [access.ready, access.access?.effectiveRole, unavailable, members, invitations, loading, error, access.session]);
  const admin = access.access?.effectiveRole === 'admin';
  const adminCount = members?.filter((member) => member.role === 'admin').length;
  const open = (next: MemberDialog) => { setDialogError(null); setDialog(next); void access.session.revalidate(); };

  const submit = async (action: Exclude<MemberDialog, { readonly kind: 'secret' }>) => {
    const admitted = access.session.snapshot();
    if (admitted.status !== 'ready' || admitted.refreshing || admitted.access!.effectiveRole !== 'admin') return;
    setPending(true); setDialogError(null); setNotice(null);
    const signal = controller.current!.signal;
    try {
      if (action.kind === 'role') {
        await setMemberRole(projectId, action.member.userId, { version: action.member.version, role: action.role }, signal);
        if (signal.aborted) return;
        if (action.member.userId === user.id && action.role === 'member') { setMembers(null); setInvitations(null); }
        callbacks.current.onMembershipChange?.();
      } else if (action.kind === 'remove') {
        await removeMember(projectId, action.member.userId, action.member.version, signal);
        if (signal.aborted) return;
        callbacks.current.onMembershipChange?.();
        if (action.member.userId === user.id) { setDialog(null); onRemoved(); return; }
      } else if (action.kind === 'invite') {
        const result = await createInvitation(projectId, signal);
        if (signal.aborted) return;
        const { link, ...metadata } = result;
        setInvitations((items) => [metadata, ...(items ?? [])]);
        setDialog({ kind: 'secret', secret: link }); return;
      } else await revokeInvitation(projectId, action.invitation.id, signal);
      if (signal.aborted) return;
      setDialog(null); await load(signal);
    } catch (failure) {
      if (!isAbortError(failure) && !signal.aborted) {
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 409 || failure.status === 404)) {
          setMembers(null); setInvitations(null); setDialog(null);
          setNotice(failure.status === 409 ? 'conflictReloaded' : 'permissionChecked');
          callbacks.current.onMembershipChange?.();
          await load(signal);
        } else setDialogError(failure);
      }
    } finally { if (!signal.aborted) setPending(false); }
  };

  const dialogTitle = dialog?.kind === 'role' ? m.roleTitle({ name: identityName(dialog.member) })
    : dialog?.kind === 'remove' ? m.removeTitle({ name: identityName(dialog.member) })
      : dialog?.kind === 'revoke' ? m.revokeTitle : m.inviteTitle;
  const confirm = dialog?.kind === 'role' ? m.saveRole : dialog?.kind === 'remove' ? m.removeConfirm : dialog?.kind === 'revoke' ? m.revokeConfirm : m.createInvite;
  return <>
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle({ projectName })}</p></div>{admin && <button className="button primary" type="button" disabled={loading || !access.ready} onClick={() => open({ kind: 'invite' })}>{m.invite}</button>}</div>
    {notice !== null && <div className="notice" role="status">{m.notice[notice]}</div>}
    {(error !== null || access.error !== null) && <ManagementError error={error ?? access.error} retry={() => { void load(controller.current!.signal); }} />}
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {(unavailable || access.status === "unavailable") && error === null && access.error === null && <div className="notice error" role="alert">{common.notFound}</div>}
    {!loading && members !== null && !unavailable && access.status !== 'unavailable' && <>
      {access.ready && !admin && <div className="notice">{m.memberNotice}</div>}
      <section className="panel" aria-labelledby="members-title"><div className="panel-heading"><div><h2 id="members-title">{m.membersTitle} <span className="badge">{format.number(members.length)}</span></h2><p>{m.accessDescription}</p></div></div>
        <div className="row head" aria-hidden="true"><span>{m.memberColumn}</span><span>{m.roleColumn}</span><span>{m.actionColumn}</span></div>
        {members.map((member) => {
          const lastAdmin = member.role === 'admin' && adminCount === 1;
          return <div className="row" key={member.userId}><Identity user={member} self={member.userId === user.id} /><div>{admin ? <select className="role-select" aria-label={m.roleLabel({ name: identityName(member) })} aria-describedby={lastAdmin ? 'last-admin-note' : undefined} disabled={lastAdmin || pending || !access.ready} value={member.role} onChange={(event) => open({ kind: 'role', member, role: event.target.value as 'admin' | 'member' })}><option value="member">{common.roleMember}</option><option value="admin">{common.roleAdmin}</option></select> : <span className={`badge${member.role === 'admin' ? ' admin' : ''}`}>{member.role === 'admin' ? common.roleAdmin : common.roleMember}</span>}</div><div className="actions">{admin ? <button className="button quiet" type="button" aria-label={m.removeLabel({ name: identityName(member) })} disabled={lastAdmin || pending || !access.ready} title={lastAdmin ? m.lastAdminTitle : undefined} onClick={() => open({ kind: 'remove', member })}>{m.remove}</button> : <span className="muted small">—</span>}</div></div>;
        })}
      </section><p className="muted small" id="last-admin-note">{m.lastAdminNote}</p>
      {admin && <section className="panel" aria-labelledby="invites-title"><div className="panel-heading"><div><h2 id="invites-title">{m.invitesTitle}</h2><p>{m.invitesDescription}</p></div></div>
        {invitations !== null && (invitations.length === 0 ? <div className="empty-inline">{m.invitesEmpty}</div> : invitations.map((invitation) => <div className="row" key={invitation.id}><div><div className="person-name">{m.newInvitation}</div><div className="person-meta">{common.createdAt} <DateLabel value={invitation.createdAt} /></div></div><div className="row-detail">{common.expiresAt} <DateLabel value={invitation.expiresAt} /></div><div className="actions"><button className="button quiet" type="button" aria-label={m.revokeLabel({ id: invitation.id })} disabled={pending || !access.ready} onClick={() => open({ kind: 'revoke', invitation })}>{common.revoke}</button></div></div>))}
      </section>}
      <div className="role-legend"><div><h3>{common.roleAdmin}</h3><p>{m.adminDescription}</p></div><div><h3>{common.roleMember}</h3><p>{m.memberDescription}</p></div></div>
    </>}
    {dialog?.kind === 'secret' && <SecretDialog kind="invitation" secret={dialog.secret} onClose={() => setDialog(null)} />}
    {dialog !== null && dialog.kind !== 'secret' && !unavailable && access.status !== 'unavailable' && <ManagementDialog title={dialogTitle} busy={pending} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className={`button${dialog.kind === 'remove' || dialog.kind === 'revoke' ? ' danger' : ' primary'}`} type="button" disabled={pending || !access.ready} onClick={() => { void submit(dialog); }}>{pending ? common.submitPending : confirm}</button></>}>
      {dialog.kind === 'role' && <p>{dialog.role === 'admin' ? m.roleAdminBody : m.roleMemberBody}{dialog.member.userId === user.id && dialog.role === 'member' && m.selfDemotionBody}</p>}
      {dialog.kind === 'remove' && <p>{dialog.member.userId === user.id ? m.selfRemovalBody : m.otherRemovalBody}</p>}
      {dialog.kind === 'invite' && <><p>{m.inviteBody}</p><div className="notice">{m.inviteTerms}</div></>}
      {dialog.kind === 'revoke' && <p>{m.revokeBody}</p>}
      {dialogError !== null && <ManagementError error={dialogError} />}
    </ManagementDialog>}
  </>;
};
