import { useMemberProjectName } from "./useMemberProjectName";
import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { createInvitation, listInvitations, listMembers, removeProjectGrant, revokeInvitation, setProjectGrant, type CurrentUser, type CreatedProjectInvitation, type ProjectInvitation, type ProjectParticipant } from '../../api/auth';
import { useI18n } from '../../i18n/LocaleProvider';
import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { ManagementDialog } from './ManagementDialog';
import { Identity, identityName, ManagementError, SecretDialog } from './feedback';
import { InvitationList } from './InvitationList';

type MemberDialog = { readonly kind: 'role'; readonly member: ProjectParticipant; readonly role: 'admin' | 'member' }
  | { readonly kind: 'remove'; readonly member: ProjectParticipant }
  | { readonly kind: 'invite' }
  | { readonly kind: 'revoke'; readonly invitation: ProjectInvitation }
  | { readonly kind: 'secret'; readonly secret: string };
type MembersRead = { readonly invitations: boolean };

const sameParticipant = (a: ProjectParticipant, b: ProjectParticipant) =>
  a.userId === b.userId && a.profile.name === b.profile.name && a.profile.email === b.profile.email && a.profile.avatarUrl === b.profile.avatarUrl &&
  a.effectiveRole === b.effectiveRole && a.directGrant?.version === b.directGrant?.version && a.directGrant?.role === b.directGrant?.role && a.directGrant?.projectId === b.directGrant?.projectId && a.directGrant?.userId === b.directGrant?.userId && a.directGrant?.createdAt === b.directGrant?.createdAt && a.directGrant?.updatedAt === b.directGrant?.updatedAt &&
  a.inheritedFrom?.role === b.inheritedFrom?.role && a.inheritedFrom?.team.id === b.inheritedFrom?.team.id && a.inheritedFrom?.team.kind === b.inheritedFrom?.team.kind && a.inheritedFrom?.team.name === b.inheritedFrom?.team.name;
const sameInvitation = (a: ProjectInvitation, b: ProjectInvitation) =>
  a.id === b.id && a.projectId === b.projectId && a.createdBy === b.createdBy && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt && a.consumedBy === b.consumedBy && a.consumedAt === b.consumedAt && a.revokedAt === b.revokedAt;

type MembersPanelProps = {
  readonly projectId: string;
  readonly active?: boolean;
  readonly onRoute?: boolean;
  readonly onGuardChange?: (guarded: boolean) => void;
  readonly user: CurrentUser;
  readonly onRemoved: () => void;
  readonly onUnavailable?: () => void;
  readonly onMembershipChange?: () => void;
};

export const MembersPanel = (props: MembersPanelProps) => <ProjectAccessBoundary projectId={props.projectId} initialRead active={props.active ?? true}><MembersContent key={`${props.user.id}:${props.projectId}`} {...props} /></ProjectAccessBoundary>;

const MembersContent = ({ projectId, user, onRemoved, onUnavailable, onMembershipChange, active = true, onRoute = true, onGuardChange }: MembersPanelProps) => {
  const { locale, messages: { auth: { management: { members: m, common } }, common: globalCommon }, format } = useI18n();
  const access = useProjectAccess(projectId);
  const projectName = useMemberProjectName(projectId, active);
  const [members, setMembers] = useState<readonly ProjectParticipant[] | null>(null);
  const [invitations, setInvitations] = useState<readonly ProjectInvitation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'permissionReloaded' | 'conflictReloaded' | 'permissionChecked' | 'identityChanged' | null>(null);
  const [dialog, setDialog] = useState<MemberDialog | null>(null);
  const dialogRef = useRef(dialog); dialogRef.current = dialog;
  const membersRef = useRef(members); membersRef.current = members;
  const invitationsRef = useRef(invitations); invitationsRef.current = invitations;
  const publishMembers = (value: readonly ProjectParticipant[] | null) => {
    const previous = membersRef.current;
    if (previous === value || previous !== null && value !== null && previous.length === value.length && previous.every((item, index) => sameParticipant(item, value[index]!))) return;
    membersRef.current = value; setMembers(value);
  };
  const publishInvitations = (value: readonly ProjectInvitation[] | null) => {
    const previous = invitationsRef.current;
    if (previous === value || previous !== null && value !== null && previous.length === value.length && previous.every((item, index) => sameInvitation(item, value[index]!))) return;
    invitationsRef.current = value; setInvitations(value);
  };
  const [hasHeldInvitation, setHasHeldInvitation] = useState(false);
  const heldInvitation = useRef<CreatedProjectInvitation | null>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ readonly name: string; readonly role: 'admin' | 'member' | null; readonly lostAccess: boolean } | null>(null);
  const heldGrant = useRef<{ readonly name: string; readonly role: 'admin' | 'member' | null; readonly lostAccess: boolean } | null>(null);
  const [hasHeldGrant, setHasHeldGrant] = useState(false);
  const [pending, setPending] = useState(false);
  const [grantIssue, setGrantIssue] = useState<{ readonly error: unknown; readonly observed: boolean } | null>(null);
  const grantIssueRef = useRef(grantIssue); grantIssueRef.current = grantIssue;
  const grantSubmitting = useRef(false);
  const [invitationIssue, setInvitationIssue] = useState<{ readonly error: unknown; readonly observed: boolean; readonly action: 'invite' | 'revoke'; readonly invitationId?: string } | null>(null);
  const invitationIssueRef = useRef(invitationIssue); invitationIssueRef.current = invitationIssue;
  const invitationSubmitting = useRef(false);
  const uncertainRevocations = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const admissionController = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const readPromise = useRef<Promise<MembersRead | undefined> | null>(null);
  const latestRead = useRef<Promise<MembersRead | undefined> | null>(null);
  const internalAccessRead = useRef(false);
  const refreshQueued = useRef(false);
  const writeInFlight = useRef(false);
  const reloadAfterRevocation = useRef(false);
  const generation = useRef(0);
  const unavailableNotified = useRef(false);
  const notifyUnavailable = () => { if (!unavailableNotified.current) { unavailableNotified.current = true; callbacks.current.onUnavailable?.(); } };
  const activeRef = useRef(active); activeRef.current = active;
  const route = useRef({ onRoute, generation: 0 });
  if (route.current.onRoute && !onRoute) route.current.generation++;
  route.current.onRoute = onRoute;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  useEffect(() => { guardCallback.current?.(pending || hasHeldInvitation || hasHeldGrant || grantIssue !== null && !grantIssue.observed || invitationIssue !== null && !invitationIssue.observed); }, [pending, hasHeldInvitation, hasHeldGrant, grantIssue, invitationIssue]);
  useEffect(() => { if (!onRoute) admissionController.current?.abort(); if (!onRoute && !grantSubmitting.current && !invitationSubmitting.current && heldInvitation.current === null && heldGrant.current === null && !(grantIssueRef.current && !grantIssueRef.current.observed) && !(invitationIssueRef.current && !invitationIssueRef.current.observed)) setDialog((current) => current?.kind === 'secret' ? current : null); }, [onRoute]);
  const callbacks = useRef({ onUnavailable, onMembershipChange });
  callbacks.current = { onUnavailable, onMembershipChange };
  const checkAccessForRead = () => {
    internalAccessRead.current = true;
    try { return access.session.revalidate(); }
    finally { internalAccessRead.current = false; }
  };

  const readMembers = async (lifetime: AbortSignal, background: boolean): Promise<MembersRead | undefined> => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const request = ++generation.current;
    if (!background || membersRef.current === null) setLoading(true);
    setError(null);
    try {
      let invitationsLoaded = false;
      if (!background) {
        await checkAccessForRead();
        await access.session.scope.ready(signal);
        if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
      } else {
        const freshAccess = await access.session.waitForFreshAccess(signal, true);
        if (signal.aborted || request !== generation.current || freshAccess === null) return;
      }
      const observation = access.session.beginObservation();
      const result = await listMembers(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
      let items = result.items;
      await access.session.scope.ready(signal);
      if (signal.aborted || request !== generation.current || access.session.snapshot().status === 'unavailable') return;
      if (!access.session.publishSync(observation, result.actorAccess)) {
        if (!access.session.scope.isInvalidated) return startRead(lifetime, background);
        return;
      }
      const admitted = await access.session.waitForFreshAccess(signal);
      if (signal.aborted || access.session.scope.isInvalidated || request !== generation.current || admitted === null) return;
      if (admitted.effectiveRole === 'admin') {
        try {
          const invitations = await listInvitations(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
          const fresh = await access.session.waitForFreshAccess(signal);
          if (!signal.aborted && !access.session.scope.isInvalidated && request === generation.current && fresh?.effectiveRole === 'admin') { publishInvitations(invitations); invitationsLoaded = true; }
          else if (!signal.aborted && request === generation.current && fresh !== null) publishInvitations(null);
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.status !== 403) throw failure;
          await access.session.scope.ready(signal);
          if (signal.aborted || access.session.scope.isInvalidated || request !== generation.current) return;
          publishMembers(null); publishInvitations(null);
          await checkAccessForRead();
          if (await access.session.waitForFreshAccess(signal) === null || signal.aborted || request !== generation.current) return;
          const refreshedObservation = access.session.beginObservation();
          const refreshed = await listMembers(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
          if (await access.session.waitForFreshAccess(signal) === null || signal.aborted || request !== generation.current) return;
          if (!access.session.publishSync(refreshedObservation, refreshed.actorAccess)) return startRead(lifetime, background);
          items = refreshed.items;
          const currentAccess = await access.session.waitForFreshAccess(signal, true);
          if (signal.aborted || access.session.scope.isInvalidated || request !== generation.current || currentAccess === null) return;
          if (currentAccess.effectiveRole === 'admin') {
            const retryInvitations = await listInvitations(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
            const fresh = await access.session.waitForFreshAccess(signal, true);
            if (signal.aborted || access.session.scope.isInvalidated || request !== generation.current || fresh === null) return;
            if (fresh.effectiveRole === 'admin') { publishInvitations(retryInvitations); invitationsLoaded = true; }
          }
          callbacks.current.onMembershipChange?.();
          setNotice('permissionReloaded');
        }
      } else publishInvitations(null);
      const current = access.session.snapshot();
      if (current.status === 'ready' && !current.refreshing && (current.access!.effectiveRole !== 'admin' || invitationsLoaded)) { publishMembers(items); setUnavailable(false); }
      if (current.status === 'ready' && !current.refreshing && (current.access!.effectiveRole !== 'admin' || invitationsLoaded)) return { invitations: invitationsLoaded };
      return;
    } catch (failure) {
      if (!isAbortError(failure) && !signal.aborted) { try { await access.session.scope.ready(signal); } catch { return; } }
      if (!isAbortError(failure) && !signal.aborted && !access.session.scope.isInvalidated && request === generation.current) {
        setError(failure);
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) {
          publishMembers(null); publishInvitations(null);
          if (failure.status === 404) { setUnavailable(true); notifyUnavailable(); }
        }
      }
    } finally {
      if (readController.current === read) readController.current = null;
      if (!signal.aborted && request === generation.current) setLoading(false);
    }
  };
  const startRead = (lifetime: AbortSignal, background: boolean): Promise<MembersRead | undefined> => {
    const operation = readMembers(lifetime, background);
    const result: Promise<MembersRead | undefined> = operation.then(async (observed) => {
      if (!observed && latestRead.current !== null && latestRead.current !== result) return latestRead.current;
      return observed;
    });
    readPromise.current = result; latestRead.current = result;
    void result.finally(() => {
      if (readPromise.current !== result) return;
      readPromise.current = null;
      if (refreshQueued.current && !writeInFlight.current && activeRef.current && controller.current !== null && !controller.current.signal.aborted) {
        refreshQueued.current = false;
        void load(controller.current.signal, false, true);
      }
    });
    return result;
  };
  const load = (lifetime: AbortSignal, requireInvitations = false, background = false): Promise<boolean> =>
    startRead(lifetime, background).then((observed) => observed !== undefined && (!requireInvitations || observed.invitations));
  useEffect(() => {
    let refreshing = access.session.snapshot().refreshing;
    return access.session.subscribe(() => {
      const next = access.session.snapshot().refreshing;
      if (!refreshing && next && !internalAccessRead.current && activeRef.current) {
        refreshQueued.current = true;
        if (readController.current !== null) {
          ++generation.current; readController.current.abort(); readController.current = null;
        }
        if (!writeInFlight.current && controller.current !== null) {
          refreshQueued.current = false;
          void load(controller.current.signal, false, true);
        }
      }
      refreshing = next;
    });
  }, [access.session, projectId, user.id]);
  useEffect(() => access.session.scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    ++generation.current; readController.current?.abort();
    reloadAfterRevocation.current = true;
    publishMembers(null); publishInvitations(null); setUnavailable(true); setLoading(false); setError(null); notifyUnavailable();
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    publishMembers(null); publishInvitations(null); setDialog(null); setNotice(null);
    return () => { active.abort(); admissionController.current?.abort(); readController.current?.abort(); ++generation.current; guardCallback.current?.(false); };
  }, [projectId, user.id]);
  useEffect(() => {
    if (!active || controller.current === null) return;
    void load(controller.current.signal, false, membersRef.current !== null);
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
  useEffect(() => {
    if (!active || !hasHeldInvitation) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, access.session.scope.signal]);
    void (async () => {
      try {
        await access.session.scope.ready(signal);
        if (signal.aborted || !activeRef.current || access.session.scope.isInvalidated || heldInvitation.current === null) return;
        const { link } = heldInvitation.current;
        heldInvitation.current = null; setHasHeldInvitation(false);
        setDialog({ kind: 'secret', secret: link }); setPending(false);
        const componentSignal = controller.current?.signal;
        if (componentSignal !== undefined) void (async () => {
          try {
            await access.session.revalidate();
            const current = await access.session.waitForFreshAccess(componentSignal);
            if (!componentSignal.aborted && activeRef.current && current?.effectiveRole === 'admin') void load(componentSignal);
          } catch { /* The owning scope or component ended before the refresh. */ }
        })();
      } catch { /* The owning scope or route ended before admission. */ }
    })();
    return () => lifetime.abort();
  }, [active, hasHeldInvitation, access.session]);
  const heldRouteChecked = useRef(false);
  const releaseHeldGrant = (current: ReturnType<typeof access.session.snapshot>['access']) => {
    if (!activeRef.current || authRequestsPaused() || access.session.scope.isInvalidated) return;
    if (hasHeldGrant && current !== null && heldGrant.current !== null) {
      const confirmed = heldGrant.current; heldGrant.current = null; setHasHeldGrant(false);
      setDialog(null); setReceipt(confirmed); setPending(false); callbacks.current.onMembershipChange?.();
      if (controller.current !== null) void load(controller.current.signal);
    } else setPending(false);
  };
  useEffect(() => {
    heldRouteChecked.current = false;
    if (!active || !hasHeldGrant) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, access.session.scope.signal]);
    void (async () => {
      try {
        await access.session.revalidate();
        const current = await access.session.waitForFreshAccess(signal);
        if (signal.aborted || !activeRef.current) return;
        heldRouteChecked.current = true; releaseHeldGrant(current);
      } catch { /* The owning scope or route ended before admission. */ }
    })();
    return () => { lifetime.abort(); heldRouteChecked.current = false; };
  }, [active, hasHeldGrant, access.session]);
  useEffect(() => {
    if (!active || !heldRouteChecked.current || !access.ready) return;
    releaseHeldGrant(access.access);
  }, [active, access.ready, hasHeldGrant]);
  const grantBlocked = grantIssue !== null && !grantIssue.observed;
  const participantIdentity = (member: ProjectParticipant) => ({ ...member.profile, userId: member.userId });
  const open = (next: MemberDialog) => { if ((next.kind === 'role' || next.kind === 'remove') && grantIssueRef.current !== null && !grantIssueRef.current.observed) return; setDialogError(null); setDialog(next); void access.session.revalidate(); };

  const submit = async (action: Exclude<MemberDialog, { readonly kind: 'secret' }>) => {
    const admitted = access.session.snapshot();
    if (!active || access.session.scope.isInvalidated || admitted.status !== 'ready' || admitted.access?.effectiveRole !== 'admin') return;
    const grantAction = action.kind === 'role' || action.kind === 'remove';
    const invitationAction = !grantAction;
    if (invitationAction && (heldInvitation.current !== null || invitationSubmitting.current || invitationIssueRef.current !== null && (!invitationIssueRef.current.observed || action.kind === 'revoke' && uncertainRevocations.current.has(action.invitation.id)))) return;
    if (invitationAction) invitationSubmitting.current = true;
    if (grantAction && (heldGrant.current !== null || grantSubmitting.current || action.kind === 'remove' && action.member.directGrant === null || grantIssueRef.current !== null && !grantIssueRef.current.observed)) return;
    if (grantAction) { grantSubmitting.current = true; grantIssueRef.current = null; setGrantIssue(null); }
    guardCallback.current?.(true); setPending(true); setDialogError(null); setNotice(null); setReceipt(null);
    const signal = controller.current!.signal;
    const routeGeneration = route.current.generation;
    const admission = new AbortController(); admissionController.current = admission;
    const admissionSignal = AbortSignal.any([signal, admission.signal, access.session.scope.signal]);
    let dispatched = false;
    let writeStarted = false;
    try {
      let fresh = await access.session.waitForFreshAccess(admissionSignal, true);
      if (fresh?.effectiveRole !== 'admin' || fresh.ownership.teamId !== admitted.access.ownership.teamId || fresh.ownership.version !== admitted.access.ownership.version) {
        setDialogError(new Error('Project access changed before submission'));
        return;
      }
      while (readPromise.current !== null) {
        const reading = readPromise.current;
        const readSignal = readController.current?.signal;
        const observed = await new Promise<MembersRead | undefined>((resolve) => {
          const abort = () => resolve(undefined);
          if (admissionSignal.aborted || readSignal?.aborted) { resolve(undefined); return; }
          admissionSignal.addEventListener('abort', abort, { once: true });
          readSignal?.addEventListener('abort', abort, { once: true });
          void reading.then((value) => { admissionSignal.removeEventListener('abort', abort); readSignal?.removeEventListener('abort', abort); resolve(value); });
        });
        if (admissionSignal.aborted) return;
        if (readPromise.current !== null && readPromise.current !== reading) { fresh = await access.session.waitForFreshAccess(admissionSignal, true); continue; }
        if (!observed) { setDialogError(new Error('Unable to verify current project members')); return; }
        fresh = await access.session.waitForFreshAccess(admissionSignal, true);
      }
      if (admissionSignal.aborted || access.session.scope.isInvalidated || !activeRef.current || !route.current.onRoute || route.current.generation !== routeGeneration || dialogRef.current !== action) return;
      if (fresh?.effectiveRole !== 'admin' || fresh.ownership.teamId !== admitted.access.ownership.teamId || fresh.ownership.version !== admitted.access.ownership.version) {
        setDialogError(new Error('Project access changed before submission'));
        return;
      }
      if (grantAction) {
        const currentMember = membersRef.current?.find((member) => member.userId === action.member.userId);
        if (currentMember === undefined || !sameParticipant(currentMember, action.member)) { setDialogError(new Error('The project grant changed before submission')); return; }
      } else if (action.kind === 'revoke' && !invitationsRef.current?.some((invitation) => sameInvitation(invitation, action.invitation))) { setDialogError(new Error('The invitation changed before submission')); return; }
      writeStarted = true;
      if (admissionController.current === admission) admissionController.current = null;
      writeInFlight.current = true;
      if (action.kind === 'role' || action.kind === 'remove') {
        const result = action.kind === 'role'
          ? await setProjectGrant(projectId, action.member.userId, { version: action.member.directGrant?.version ?? null, role: action.role, expectedUserId: user.id }, signal, access.session.scope.principalMismatch)
          : await removeProjectGrant(projectId, action.member.userId, { version: action.member.directGrant!.version, expectedUserId: user.id }, signal, access.session.scope.principalMismatch);
        await access.session.scope.ready(signal);
        if (signal.aborted || access.session.scope.isInvalidated) return;
        ++generation.current; readController.current?.abort();
        if (result.actorAccess === null) access.session.scope.suspendProject(projectId);
        await access.session.revalidateAfterMutation();
        const current = await access.session.waitForFreshAccess(signal);
        if (signal.aborted || access.session.scope.isInvalidated) return;
        const selfLoss = result.actorAccess === null && action.member.userId === user.id;
        const confirmed = { name: selfLoss ? user.name ?? user.email ?? user.id : identityName(participantIdentity(action.member)), role: action.kind === 'role' ? action.role : null, lostAccess: result.actorAccess === null };
        if (current === null && !selfLoss) { heldGrant.current = confirmed; setHasHeldGrant(true); return; }
        setDialog(null); setReceipt(confirmed);
        callbacks.current.onMembershipChange?.();
        if (result.actorAccess === null) {
          publishMembers(null); publishInvitations(null); setUnavailable(true);
          if (current !== null && !signal.aborted && !access.session.scope.isInvalidated) {
            setUnavailable(false);
            await load(signal);
          }
          return;
        }
        if (current?.effectiveRole !== 'admin') publishInvitations(null);
        if (current !== null && activeRef.current) await load(signal); return;
      } else if (action.kind === 'invite') {
        const result = await createInvitation(projectId, user.id, signal, access.session.scope.principalMismatch, () => { dispatched = true; });
        await access.session.scope.ready(signal);
        if (signal.aborted || access.session.scope.isInvalidated) return;
        heldInvitation.current = result; setHasHeldInvitation(true);
        return;
      } else await revokeInvitation(projectId, action.invitation.id, user.id, signal, access.session.scope.principalMismatch, () => { dispatched = true; });
      await access.session.scope.ready(signal);
      if (signal.aborted || access.session.scope.isInvalidated) return;
      setDialog(null); if (activeRef.current) await load(signal);
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'identity_mismatch' || failure.code === 'principal_mismatch')) {
        publishMembers(null); publishInvitations(null); setDialog(null); setNotice('identityChanged');
        return;
      }
      if (!signal.aborted && !isAbortError(failure)) { try { await access.session.scope.ready(signal); } catch { return; } }
      if (access.session.scope.isInvalidated) return;
      if ((!isAbortError(failure) || invitationAction && dispatched) && !signal.aborted) {
        if (!writeStarted) { setDialogError(failure); return; }
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
          publishMembers(null); publishInvitations(null); setDialog(null);
          setNotice(failure.status === 409 ? 'conflictReloaded' : 'permissionChecked');
          callbacks.current.onMembershipChange?.();
          await load(signal);
        } else setDialogError(failure);
      }
    } finally {
      if (admissionController.current === admission) admissionController.current = null;
      if (!writeStarted && !route.current.onRoute) setDialog(null);
      if (writeStarted) writeInFlight.current = false;
      if (grantAction) grantSubmitting.current = false;
      if (invitationAction) invitationSubmitting.current = false;
      if (!signal.aborted && heldInvitation.current === null && heldGrant.current === null) setPending(false);
      if (refreshQueued.current && !writeInFlight.current && readController.current === null && activeRef.current && controller.current !== null && !controller.current.signal.aborted) {
        refreshQueued.current = false; void load(controller.current.signal, false, true);
      }
    }
  };

  const dialogTitle = dialog?.kind === 'role' ? m.roleTitle({ name: identityName(participantIdentity(dialog.member)) })
    : dialog?.kind === 'remove' ? m.removeTitle({ name: identityName(participantIdentity(dialog.member)) })
      : dialog?.kind === 'revoke' ? m.revokeTitle : m.inviteTitle;
  const roleText = (role: 'admin' | 'member' | null) => role === null ? m.noGrant : role === 'admin' ? common.roleAdmin : common.roleMember;
  const confirm = dialog?.kind === 'role' ? m.saveRole : dialog?.kind === 'remove' ? m.removeConfirm : dialog?.kind === 'revoke' ? m.revokeConfirm : m.createInvite;
  return <>
    <div className="page-heading members-page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{m.title}</h1><p className="subtitle members-project-name">{projectName.name === null ? <span className="members-project-name-placeholder" aria-hidden="true">&nbsp;</span> : m.subtitle({ projectName: projectName.name })}</p></div>{admin && <button className="button primary" type="button" disabled={loading || access.status !== 'ready' || invitationIssue !== null && !invitationIssue.observed} onClick={() => open({ kind: 'invite' })}>{m.invite}</button>}</div>
    {projectName.error !== null && <ManagementError error={projectName.error} retry={projectName.retry} />}
    {grantIssue !== null && <div className="notice warning" role="alert"><p>{grantIssue.observed ? m.grantObserved : m.grantUnknown}</p>{grantIssue.error instanceof ApiError && grantIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{grantIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal).then((observed) => { if (observed && grantIssueRef.current !== null) { const issue = { ...grantIssueRef.current, observed: true }; grantIssueRef.current = issue; setGrantIssue(issue); } }); }}>{m.readCurrentMembers}</button></div>}
    {invitationIssue !== null && <div className="notice warning" role="alert"><p>{invitationIssue.observed ? m.invitationObserved : m.invitationUnknown}</p>{!invitationIssue.observed && (access.status === 'unavailable' || access.status === 'ready' && !admin) && <p>{m.invitationUnreadable}</p>}{invitationIssue.error instanceof ApiError && invitationIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{invitationIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal, true).then((observed) => { if (observed && invitationIssueRef.current !== null) { const issue = { ...invitationIssueRef.current, observed: true }; invitationIssueRef.current = issue; setInvitationIssue(issue); } }); }}>{m.readCurrentInvitations}</button></div>}
    {hasHeldGrant && !pending && <div className="notice" role="status">{locale === 'zh-CN' ? '变更已确认；确认当前访问权限后可查看详情。' : 'The change was confirmed; its details are available after access is verified.'}</div>}
    {receipt !== null && <div className="notice" role="status"><p>{receipt.role === null ? m.grantRemoved({ name: receipt.name }) : m.grantSaved({ name: receipt.name, role: receipt.role === 'admin' ? common.roleAdmin : common.roleMember })}</p>{receipt.lostAccess && <><p>{m.accessLost}</p>{access.status !== 'ready' && <button className="button" type="button" onClick={onRemoved}>{m.returnToProjects}</button>}</>}</div>}
    {notice !== null && <div className="notice" role="status">{m.notice[notice]}</div>}
    {(error !== null || access.error !== null && !(receipt?.lostAccess === true && access.error instanceof ApiError && access.error.kind === 'server' && access.error.status === 404 && access.error.code === 'not_found')) && <ManagementError error={error ?? access.error} retry={() => { void load(controller.current!.signal); }} />}
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {receipt?.lostAccess !== true && (unavailable || access.status === "unavailable") && error === null && access.error === null && <div className="notice error" role="alert">{common.notFound}</div>}
    {!loading && members !== null && !unavailable && access.status !== 'unavailable' && <>
      {access.status === 'ready' && !admin && <div className="notice">{m.memberNotice}</div>}
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
              <div><span className="grant-label">{m.directColumn}: </span>{admin ? <select className="role-select" aria-label={m.roleLabel({ name: identityName(identity) })} disabled={pending || access.status !== 'ready' || grantBlocked} value={grant?.role ?? ''} onChange={(event) => { if (event.target.value === 'admin' || event.target.value === 'member') open({ kind: 'role', member, role: event.target.value }); }}><option value="" disabled>{m.noGrant}</option><option value="member">{common.roleMember}</option><option value="admin">{common.roleAdmin}</option></select> : grant === null ? m.noGrant : roleText(grant.role)}</div>
              <div className="actions">{admin && grant !== null ? <button className="button quiet" type="button" aria-label={m.removeLabel({ name: identityName(identity) })} disabled={pending || access.status !== 'ready' || grantBlocked} onClick={() => open({ kind: 'remove', member })}>{m.remove}</button> : <span className="muted small">—</span>}</div></div>;
          })}
        </div>
      </section>
      {admin && <InvitationList invitations={invitations} disabled={pending || access.status !== 'ready' || invitationIssue !== null && !invitationIssue.observed} canRevoke={(invitation) => !uncertainRevocations.current.has(invitation.id)} onRevoke={(invitation) => open({ kind: 'revoke', invitation })} />}
      <div className="role-legend"><div><h3>{common.roleAdmin}</h3><p>{m.adminDescription}</p></div><div><h3>{common.roleMember}</h3><p>{m.memberDescription}</p></div></div>
    </>}
    {dialog?.kind === 'secret' && <SecretDialog kind="invitation" secret={dialog.secret} suspended={!active} onClose={() => setDialog(null)} />}
    {dialog !== null && dialog.kind !== 'secret' && !unavailable && access.status !== 'unavailable' && <ManagementDialog title={dialogTitle} busy={pending} suspended={!active || access.status === 'ready' && !admin} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className={`button${dialog.kind === 'remove' || dialog.kind === 'revoke' ? ' danger' : ' primary'}`} type="button" disabled={pending || access.status !== 'ready'} onClick={() => { void submit(dialog); }}>{pending ? common.submitPending : confirm}</button></>}>
      {(dialog.kind === 'role' || dialog.kind === 'remove') && <p>{m.grantChange({ before: roleText(dialog.member.directGrant?.role ?? null), after: roleText(dialog.kind === 'role' ? dialog.role : null), effective: dialog.member.inheritedFrom === null && dialog.kind === 'remove' ? m.noAccess : roleText(dialog.member.inheritedFrom?.role === 'admin' || dialog.kind === 'role' && dialog.role === 'admin' ? 'admin' : 'member') })}</p>}
      {dialog.kind === 'remove' && <p>{dialog.member.userId === user.id ? m.selfRemovalBody : m.otherRemovalBody}</p>}
      {dialog.kind === 'invite' && <><p>{m.inviteBody}</p><div className="notice">{m.inviteTerms}</div></>}
      {dialog.kind === 'revoke' && <p>{m.revokeBody}</p>}
      {dialogError !== null && <ManagementError error={dialogError} />}
    </ManagementDialog>}
  </>;
};
