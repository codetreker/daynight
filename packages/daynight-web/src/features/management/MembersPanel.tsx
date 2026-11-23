import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { createPortal } from "react-dom";
import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectSettingsSectionState } from './project-settings/section-state';
import { createInvitation, listInvitations, listMembers, removeProjectGrant, revokeInvitation, setProjectGrant, type CurrentUser, type CreatedProjectInvitation, type ProjectInvitation, type ProjectParticipant } from '../../api/auth';
import { useI18n } from '../../i18n/LocaleProvider';
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause } from '../../api/client';
import { ManagementDialog } from './ManagementDialog';
import { Identity, identityName, ManagementError, SecretDialog } from './feedback';
import { InvitationList } from './InvitationList';
import { MemberSearch, type MemberAdditionPresentation } from '../member-search/MemberSearch';
import { useMemberSearch } from '../member-search/useMemberSearch';
import { addExistingProjectMember, searchProjectMemberCandidates } from '../../api/project-member-search';
import { sameGrant } from '../../api/auth-parse';
import { isRetryableTaskCacheLifecycleChange } from '../task-cache/project-cache';

type MemberDialog = { readonly kind: 'role'; readonly member: ProjectParticipant; readonly role: 'admin' | 'member' }
  | { readonly kind: 'remove'; readonly member: ProjectParticipant }
  | { readonly kind: 'invite' }
  | { readonly kind: 'revoke'; readonly invitation: ProjectInvitation }
  | { readonly kind: 'secret'; readonly secret: string };
type MembersRead = { readonly invitations: boolean };

// Some access checks share a session-owned read, so aborting the caller's
// signal does not itself settle that read. The caller must stop waiting too.
const abortable = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  if (signal.aborted) { void promise.catch(() => {}); reject(signal.reason); return; }
  const abort = () => { cleanup(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener('abort', abort);
  signal.addEventListener('abort', abort, { once: true });
  void promise.then((value) => { cleanup(); resolve(value); }, (failure: unknown) => { cleanup(); reject(failure); });
});

type SubmittedDialog = Exclude<MemberDialog, { readonly kind: 'secret' }>;
type PresentationOwner = { readonly action: SubmittedDialog; readonly routeGeneration: number; readonly presentationGeneration: number | undefined };

const ProjectMemberSearch = ({ projectId, access, active, members, addition, onAdd, onCheck }: {
  readonly projectId: string; readonly access: ReturnType<typeof useProjectAccess>; readonly active: boolean;
  readonly members: readonly ProjectParticipant[]; readonly addition: MemberAdditionPresentation;
  readonly onAdd: (id: string) => void; readonly onCheck: () => void;
}) => {
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  useEffect(() => {
    let previous = access.session.snapshot();
    return access.session.subscribe(() => {
      const current = access.session.snapshot();
      if (current.status === 'unavailable' || current.status === 'ready' && current.access?.effectiveRole !== 'admin') search.setDraft('');
      if ((!previous.refreshing && current.refreshing) || previous.access?.effectiveRole !== current.access?.effectiveRole || previous.access?.ownership.version !== current.access?.ownership.version || previous.access?.ownership.teamId !== current.access?.ownership.teamId) {
        revisionRef.current++; setRevision(revisionRef.current);
      }
      previous = current;
    });
  }, [access.session]);
  const getRevision = () => {
    const current = access.session.snapshot();
    return current.status === 'ready' && !current.refreshing && current.access?.effectiveRole === 'admin' && !access.session.scope.isInvalidated && !access.session.scope.hasIdentityMismatch ? revisionRef.current : null;
  };
  const search = useMemberSearch({ resourceId: projectId, search: searchProjectMemberCandidates, admission: access.session.scope, active, admissionBlocked: !access.ready, permissionReady: access.ready, permissionRevision: revision, getPermissionRevision: getRevision, onIdentityMismatch: access.session.scope.principalMismatch, onPermissionChange: () => { void access.session.revalidate(); } });
  return <MemberSearch scope="project" search={search} active={active} admissionBlocked={!access.ready} permissionReady={access.ready} members={members} addition={addition} onAdd={onAdd} onCheck={onCheck} />;
};

const sameParticipant = (a: ProjectParticipant, b: ProjectParticipant) =>
  a.userId === b.userId && a.profile.name === b.profile.name && a.profile.email === b.profile.email && a.profile.avatarUrl === b.profile.avatarUrl &&
  a.effectiveRole === b.effectiveRole && a.directGrant?.version === b.directGrant?.version && a.directGrant?.role === b.directGrant?.role && a.directGrant?.projectId === b.directGrant?.projectId && a.directGrant?.userId === b.directGrant?.userId && a.directGrant?.createdAt === b.directGrant?.createdAt && a.directGrant?.updatedAt === b.directGrant?.updatedAt &&
  a.inheritedFrom?.role === b.inheritedFrom?.role && a.inheritedFrom?.team.id === b.inheritedFrom?.team.id && a.inheritedFrom?.team.kind === b.inheritedFrom?.team.kind && a.inheritedFrom?.team.name === b.inheritedFrom?.team.name;
const sameInvitation = (a: ProjectInvitation, b: ProjectInvitation) =>
  a.id === b.id && a.projectId === b.projectId && a.createdBy === b.createdBy && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt && a.consumedBy === b.consumedBy && a.consumedAt === b.consumedAt && a.revokedAt === b.revokedAt;

type MembersPanelProps = {
  readonly projectId: string;
  readonly resultHost?: HTMLElement | null | undefined;
  readonly presentationGeneration?: number | undefined;
  readonly onStateChange?: ((state: ProjectSettingsSectionState) => void) | undefined;
  readonly active?: boolean;
  readonly onRoute?: boolean;
  readonly onGuardChange?: ((guarded: boolean) => void) | undefined;
  readonly user: CurrentUser;
  readonly onRemoved: () => void;
  readonly onUnavailable?: (() => void) | undefined;
  readonly onMembershipChange?: (() => void) | undefined;
};

export const MembersPanel = (props: MembersPanelProps) => <ProjectAccessBoundary projectId={props.projectId} initialRead active={props.active ?? true}><MembersContent key={`${props.user.id}:${props.projectId}`} {...props} /></ProjectAccessBoundary>;

const MembersContent = ({ projectId, resultHost, presentationGeneration, onStateChange, user, onRemoved, onUnavailable, onMembershipChange, active = true, onRoute = true, onGuardChange }: MembersPanelProps) => {
  const { locale, messages: { auth: { management: { members: m, common } }, common: globalCommon }, format } = useI18n();
  const access = useProjectAccess(projectId);
  const [members, setMembers] = useState<readonly ProjectParticipant[] | null>(null);
  const [invitations, setInvitations] = useState<readonly ProjectInvitation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [knownRejection, setKnownRejection] = useState<ApiError | null>(null);
  const knownRejectionRef = useRef(knownRejection); knownRejectionRef.current = knownRejection;
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'permissionReloaded' | 'conflictReloaded' | 'permissionChecked' | 'identityChanged' | null>(null);
  const [dialog, setDialogState] = useState<MemberDialog | null>(null);
  const dialogRef = useRef(dialog); dialogRef.current = dialog;
  const setDialog = (next: MemberDialog | null | ((current: MemberDialog | null) => MemberDialog | null)) => {
    const value = typeof next === 'function' ? next(dialogRef.current) : next;
    dialogRef.current = value; setDialogState(value);
  };
  const membersRef = useRef(members); membersRef.current = members;
  // Counts successful roster observations even when the visible rows are equal.
  const membersObservation = useRef(0);
  const accessObservation = useRef(0);
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
  const heldInvitation = useRef<{ readonly result: CreatedProjectInvitation; readonly owner: PresentationOwner } | null>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ readonly name: string; readonly role: 'admin' | 'member' | null; readonly lostAccess: boolean } | null>(null);
  const receiptIsSelf = useRef(false);
  const heldGrant = useRef<{ readonly receipt: { readonly name: string; readonly role: 'admin' | 'member' | null; readonly lostAccess: boolean }; readonly owner: PresentationOwner; readonly selfLoss: boolean } | null>(null);
  const [hasHeldGrant, setHasHeldGrant] = useState(false);
  const [pending, setPending] = useState(false);
  const [grantIssue, setGrantIssue] = useState<{ readonly error: unknown; readonly observed: boolean } | null>(null);
  const grantIssueRef = useRef(grantIssue); grantIssueRef.current = grantIssue;
  const grantSubmitting = useRef(false);
  const [invitationIssue, setInvitationIssue] = useState<{ readonly error: unknown; readonly observed: boolean; readonly action: 'invite' | 'revoke'; readonly invitationId?: string } | null>(null);
  const invitationIssueRef = useRef(invitationIssue); invitationIssueRef.current = invitationIssue;
  const invitationSubmitting = useRef(false);
  const addSubmitting = useRef(false);
  const [addConfirmed, setAddConfirmed] = useState(false);
  const heldAddition = useRef<Awaited<ReturnType<typeof addExistingProjectMember>> | null>(null);
  const [addition, setAdditionState] = useState<MemberAdditionPresentation>({ targetId: null, pending: false, unknown: false, checking: false, error: null, observed: false, locked: false });
  const additionRef = useRef(addition); additionRef.current = addition;
  const setAddition = (next: MemberAdditionPresentation) => { additionRef.current = next; setAdditionState(next); };
  const addAdmission = useRef<AbortController | null>(null);
  const uncertainRevocations = useRef(new Set<string>());
  const confirmedRevocations = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const admissionController = useRef<AbortController | null>(null);
  const publicationController = useRef<AbortController | null>(null);
  const grantPublicationController = useRef<AbortController | null>(null);
  const operationGeneration = useRef(0);
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
  const presentationRef = useRef(presentationGeneration); presentationRef.current = presentationGeneration;
  const route = useRef({ onRoute, generation: 0 });
  if (route.current.onRoute && !onRoute) route.current.generation++;
  route.current.onRoute = onRoute;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  const retained = pending || addition.pending || addition.unknown || addConfirmed || hasHeldInvitation || hasHeldGrant || receipt !== null || dialog?.kind === 'secret' || grantIssue !== null && !grantIssue.observed || invitationIssue !== null && !invitationIssue.observed || uncertainRevocations.current.size > 0 || confirmedRevocations.current.size > 0;
  useLayoutEffect(() => { guardCallback.current?.(retained); }, [retained]);
  const dirty = dialog?.kind === 'role' && dialog.member.directGrant?.role !== dialog.role;
  const needsAttention = error !== null || access.error !== null || knownRejection !== null || grantIssue !== null || invitationIssue !== null || addition.unknown || hasHeldInvitation || hasHeldGrant || uncertainRevocations.current.size > 0;
  useLayoutEffect(() => { onStateChange?.({ dirty, pending: pending || addition.pending, needsAttention }); }, [onStateChange, dirty, pending, addition.pending, needsAttention]);
  useEffect(() => { if (!onRoute) addAdmission.current?.abort(); }, [onRoute]);
  useEffect(() => { if (!onRoute) admissionController.current?.abort(); if (!onRoute && !grantSubmitting.current && !invitationSubmitting.current && heldInvitation.current === null && heldGrant.current === null && !(grantIssueRef.current && !grantIssueRef.current.observed) && !(invitationIssueRef.current && !invitationIssueRef.current.observed)) setDialog((current) => current?.kind === 'secret' ? current : null); }, [onRoute]);
  const callbacks = useRef({ onUnavailable, onMembershipChange });
  callbacks.current = { onUnavailable, onMembershipChange };
  const checkAccessForRead = () => {
    internalAccessRead.current = true;
    try { return access.session.revalidate(); }
    finally { internalAccessRead.current = false; }
  };
  const checkAccessAfterMutation = () => {
    internalAccessRead.current = true;
    try { return access.session.revalidateAfterMutation(); }
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
      if (current.status === 'ready' && !current.refreshing && (current.access!.effectiveRole !== 'admin' || invitationsLoaded)) { membersObservation.current++; publishMembers(items); setUnavailable(false); }
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
  const retireRead = () => {
    ++generation.current; readController.current?.abort(); readController.current = null; refreshQueued.current = false; setLoading(false);
  };
  const load = (lifetime: AbortSignal, requireInvitations = false, background = false): Promise<boolean> =>
    startRead(lifetime, background).then((observed) => observed !== undefined && (!requireInvitations || observed.invitations));
  useEffect(() => {
    let refreshing = access.session.snapshot().refreshing;
    return access.session.subscribe(() => {
      const state = access.session.snapshot();
      const next = state.refreshing;
      if (state.status === 'unavailable' || state.status === 'ready' && state.access?.effectiveRole !== 'admin') {
        heldAddition.current = null;
        if (additionRef.current.error !== null || additionRef.current.observed) setAddition({ ...additionRef.current, error: null, observed: false });
      }
      if (!refreshing && next) accessObservation.current++;
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
    accessObservation.current++;
    ++generation.current; readController.current?.abort();
    reloadAfterRevocation.current = true;
    if (event.error instanceof ApiError && event.error.kind === 'server' && event.error.status === 404 && event.error.code === 'not_found') {
      heldInvitation.current = null; setHasHeldInvitation(false);
      setDialog((current) => current?.kind === 'secret' ? null : current);
    }
    publishMembers(null); publishInvitations(null); setUnavailable(true); setLoading(false); setError(null); notifyUnavailable();
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    publishMembers(null); publishInvitations(null); setDialog(null); setNotice(null);
    return () => { active.abort(); addAdmission.current?.abort(); admissionController.current?.abort(); publicationController.current?.abort(); grantPublicationController.current?.abort(); readController.current?.abort(); ++generation.current; ++operationGeneration.current; guardCallback.current?.(false); };
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
  const admin = !access.session.scope.isInvalidated && !access.session.scope.hasIdentityMismatch && access.access?.effectiveRole === 'admin';
  useEffect(() => {
    if (access.refreshing || access.status !== 'unavailable' && (access.status !== 'ready' || admin)) return;
    heldAddition.current = null;
    if (additionRef.current.error !== null || additionRef.current.observed) setAddition({ ...additionRef.current, error: null, observed: false });
  }, [access.status, access.refreshing, admin]);
  const ownsDialog = (owner: PresentationOwner) => activeRef.current && dialogRef.current === owner.action && route.current.onRoute && route.current.generation === owner.routeGeneration && presentationRef.current === owner.presentationGeneration;
  const revealHeldInvitation = () => {
    const held = heldInvitation.current;
    if (held === null || controller.current === null) return;
    publicationController.current?.abort();
    const publication = new AbortController(); publicationController.current = publication;
    const signal = AbortSignal.any([controller.current.signal, access.session.scope.signal, publication.signal]);
    const operation = operationGeneration.current;
    const dialogAtRequest = dialogRef.current;
    const routeAtRequest = route.current.generation;
    void (async () => {
      try {
        await access.session.scope.ready(signal);
        if (signal.aborted || access.session.scope.isInvalidated || !activeRef.current || !route.current.onRoute || route.current.generation !== routeAtRequest || dialogRef.current !== dialogAtRequest || heldInvitation.current !== held || operation !== operationGeneration.current) return;
        heldInvitation.current = null; setHasHeldInvitation(false);
        setDialog({ kind: 'secret', secret: held.result.link });
        await abortable(checkAccessForRead(), signal);
        const current = await abortable(access.session.waitForFreshAccess(signal), signal);
        if (!signal.aborted && activeRef.current && current?.effectiveRole === 'admin') await abortable(load(signal), signal);
      } catch (failure) {
        if (!signal.aborted && !isAbortError(failure)) setError(failure);
      } finally {
        if (publicationController.current === publication) publicationController.current = null;
      }
    })();
  };
  useEffect(() => {
    if (!active || pending || !hasHeldInvitation) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, access.session.scope.signal]);
    void (async () => {
      try {
        await access.session.scope.ready(signal);
        if (signal.aborted || !activeRef.current || access.session.scope.isInvalidated || heldInvitation.current === null) return;
        const held = heldInvitation.current;
        if (!ownsDialog(held.owner)) return;
        revealHeldInvitation();
      } catch (failure) { if (!signal.aborted && !isAbortError(failure)) setError(failure); }
    })();
    return () => lifetime.abort();
  }, [active, pending, hasHeldInvitation, access.session]);
  const heldRouteChecked = useRef(false);
  const [heldGrantReady, setHeldGrantReady] = useState(false);
  const refreshAfterGrant = () => {
    if (controller.current === null) return;
    grantPublicationController.current?.abort();
    const publication = new AbortController(); grantPublicationController.current = publication;
    const signal = AbortSignal.any([controller.current.signal, access.session.scope.signal, publication.signal]);
    void (async () => {
      try { await abortable(load(signal), signal); }
      catch (failure) { if (!signal.aborted && !isAbortError(failure)) setError(failure); }
      finally { if (grantPublicationController.current === publication) grantPublicationController.current = null; }
    })();
  };
  const releaseHeldGrant = (current: ReturnType<typeof access.session.snapshot>['access']) => {
    if (authRequestsPaused() || access.session.scope.isInvalidated) return;
    if (hasHeldGrant && heldGrant.current !== null && (current !== null || heldGrant.current.selfLoss)) {
      const held = heldGrant.current; heldGrant.current = null; setHasHeldGrant(false);
      setHeldGrantReady(false);
      if (ownsDialog(held.owner)) setDialog(null);
      receiptIsSelf.current = held.selfLoss; setReceipt(held.receipt); callbacks.current.onMembershipChange?.();
      if (held.selfLoss) {
        publishMembers(null); publishInvitations(null); setUnavailable(true);
        if (current !== null) { setUnavailable(false); if (activeRef.current) refreshAfterGrant(); }
      } else if (activeRef.current) refreshAfterGrant();
    }
  };
  useEffect(() => {
    heldRouteChecked.current = false;
    if (!hasHeldGrant) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, access.session.scope.signal]);
    void (async () => {
      try {
        do { await access.session.scope.ready(signal); signal.throwIfAborted(); } while (authRequestsPaused());
        const held = heldGrant.current;
        if (signal.aborted || held === null) return;
        if (held.receipt.lostAccess && !access.session.scope.isProjectSuspended(projectId)) access.session.scope.suspendProject(projectId);
        await abortable(checkAccessAfterMutation(), signal);
        await abortable(access.session.waitForFreshAccess(signal), signal);
        if (signal.aborted || heldGrant.current !== held) return;
        heldRouteChecked.current = true; setHeldGrantReady(true);
      } catch (failure) { if (!signal.aborted && !isAbortError(failure)) setError(failure); }
    })();
    return () => { lifetime.abort(); heldRouteChecked.current = false; };
  }, [hasHeldGrant, access.session]);
  useEffect(() => {
    if (pending || !heldGrantReady || !heldRouteChecked.current || !access.ready && heldGrant.current?.selfLoss !== true) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, access.session.scope.signal]);
    const held = heldGrant.current;
    void (async () => {
      try {
        do { await access.session.scope.ready(signal); signal.throwIfAborted(); } while (authRequestsPaused());
        if (heldGrant.current !== held || !heldRouteChecked.current) return;
        const current = access.session.snapshot();
        if (held?.selfLoss !== true && (current.status !== 'ready' || current.refreshing)) return;
        releaseHeldGrant(current.status === 'ready' && !current.refreshing ? current.access : null);
      } catch (failure) { if (!signal.aborted && !isAbortError(failure)) setError(failure); }
    })();
    return () => lifetime.abort();
  }, [pending, access.ready, heldGrantReady, hasHeldGrant]);
  const grantBlocked = grantIssue !== null && !grantIssue.observed;
  const participantIdentity = (member: ProjectParticipant) => ({ ...member.profile, userId: member.userId });
  const open = (next: MemberDialog) => { if ((next.kind === 'role' || next.kind === 'remove') && grantIssueRef.current !== null && !grantIssueRef.current.observed) return; setDialogError(null); setDialog(next); void access.session.revalidate(); };

  // This read is independent of invitation availability and never resolves an
  // unknown write: a current roster cannot prove what that write did.
  const checkAddition = async (): Promise<boolean> => {
    if (controller.current === null || additionRef.current.checking) return false;
    const lifetime = controller.current.signal;
    retireRead();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const request = ++generation.current;
    setAddition({ ...additionRef.current, checking: true, error: null, observed: false });
    try {
      const current = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (current?.effectiveRole !== 'admin' || signal.aborted) return false;
      const ticket = access.session.beginObservation();
      const result = await listMembers(projectId, signal, { userId: access.session.scope.userId, onPrincipalMismatch: access.session.scope.principalMismatch });
      await access.session.scope.ready(signal);
      if (signal.aborted || request !== generation.current || !access.session.publishSync(ticket, result.actorAccess)) return false;
      const fresh = await access.session.waitForFreshAccess(signal, true);
      if (signal.aborted || request !== generation.current || fresh?.effectiveRole !== 'admin') return false;
      membersObservation.current++; publishMembers(result.items); setUnavailable(false);
      setAddition({ ...additionRef.current, checking: false, observed: true, error: null });
      return true;
    } catch (failure) {
      if (!signal.aborted && !access.session.scope.isInvalidated && !isAbortError(failure)) {
        setAddition({ ...additionRef.current, checking: false, error: failure });
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) void access.session.revalidate();
      }
      return false;
    } finally {
      if (readController.current === read) readController.current = null;
      if (!lifetime.aborted && additionRef.current.checking) setAddition({ ...additionRef.current, checking: false });
    }
  };
  useEffect(() => {
    if (!addConfirmed || !active || !access.ready || access.access?.effectiveRole !== 'admin') return;
    void checkAddition().then((success) => { if (success) { heldAddition.current = null; setAddConfirmed(false); } });
  }, [addConfirmed, active, access.ready, access.access?.effectiveRole]);

  const addMember = async (targetId: string) => {
    const admitted = access.session.snapshot();
    if (!activeRef.current || !route.current.onRoute || access.session.scope.hasIdentityMismatch || admitted.status !== 'ready' || admitted.refreshing || admitted.access?.effectiveRole !== 'admin' || membersRef.current === null || membersRef.current.some(member => member.userId === targetId) || additionRef.current.unknown || addConfirmed || addSubmitting.current || grantSubmitting.current || invitationSubmitting.current || authRequestsPaused()) return;
    addSubmitting.current = true;
    guardCallback.current?.(true);
    setAddition({ targetId, pending: true, unknown: false, checking: false, error: null, observed: false, locked: true });
    const componentSignal = controller.current!.signal;
    const admission = new AbortController(); addAdmission.current = admission;
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const signal = AbortSignal.any([componentSignal, admission.signal, deadline.signal, access.session.scope.signal]);
    let dispatched = false;
    let confirmed: Awaited<ReturnType<typeof addExistingProjectMember>> | null = null;
    const waitForScope = async () => {
      while (true) {
        try { await access.session.scope.ready(componentSignal); if (!authRequestsPaused()) return; }
        catch (failure) {
          if (componentSignal.aborted || access.session.scope.isInvalidated || !isRetryableTaskCacheLifecycleChange(failure)) throw failure;
        }
      }
    };
    const stopForPause = () => { if (!dispatched) admission.abort(); };
    const unsubscribe = subscribeAuthPause(stopForPause);
    if (authRequestsPaused()) stopForPause();
    try {
      const fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (signal.aborted || !activeRef.current || !route.current.onRoute || fresh?.effectiveRole !== 'admin' || fresh.ownership.teamId !== admitted.access.ownership.teamId || fresh.ownership.version !== admitted.access.ownership.version || membersRef.current === null || membersRef.current.some(member => member.userId === targetId)) return;
      retireRead();
      const rosterRevision = membersObservation.current, permissionRevision = accessObservation.current;
      const scopeRevision = access.session.scope.getProjectRevision(projectId), admissionRevision = access.session.scope.getAdmissionRevision(projectId);
      writeInFlight.current = true;
      const result = await addExistingProjectMember(user.id, projectId, targetId, signal, access.session.scope.principalMismatch, () => { dispatched = true; timer = setTimeout(() => deadline.abort(), 30_000); if (addAdmission.current === admission) addAdmission.current = null; });
      confirmed = result;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      await waitForScope();
      if (componentSignal.aborted || access.session.scope.isInvalidated) return;
      const current = access.session.snapshot();
      heldAddition.current = current.status === 'ready' && current.access?.effectiveRole === 'admin' ? result : null;
      if (current.status === 'ready' && !current.refreshing && current.access?.effectiveRole === 'admin' && current.access.ownership.teamId === admitted.access.ownership.teamId && current.access.ownership.version === admitted.access.ownership.version && current.access.ownership.teamId === result.actorAccess.ownership.teamId && current.access.ownership.version === result.actorAccess.ownership.version && current.access.ownerTeam.kind === result.actorAccess.ownerTeam.kind && current.access.ownerTeam.name === result.actorAccess.ownerTeam.name && current.access.teamRole === result.actorAccess.teamRole && current.access.canTransfer === result.actorAccess.canTransfer && sameGrant(current.access.directGrant, result.actorAccess.directGrant) && scopeRevision === access.session.scope.getProjectRevision(projectId) && admissionRevision === access.session.scope.getAdmissionRevision(projectId) && permissionRevision === accessObservation.current && rosterRevision === membersObservation.current && membersRef.current !== null) {
        retireRead();
        const index = membersRef.current.findIndex(member => member.userId === targetId);
        const updated = [...membersRef.current];
        if (index < 0) updated.push(result.participant); else updated[index] = result.participant;
        publishMembers(updated);
        heldAddition.current = null;
      } else setAddConfirmed(true);
      callbacks.current.onMembershipChange?.();
      setAddition({ targetId, pending: false, unknown: false, checking: false, error: null, observed: false, locked: false });
    } catch (failure) {
      if (componentSignal.aborted || access.session.scope.isInvalidated) return;
      if (!dispatched) { if (!signal.aborted && !isAbortError(failure)) setAddition({ ...additionRef.current, error: failure }); return; }
      try { await waitForScope(); } catch {
        if (!componentSignal.aborted && !access.session.scope.isInvalidated && !access.session.scope.hasIdentityMismatch) {
          if (confirmed !== null) { const state = access.session.snapshot(); heldAddition.current = state.status === 'ready' && state.access?.effectiveRole === 'admin' ? confirmed : null; setAddConfirmed(true); }
          setAddition({ targetId, pending: false, unknown: confirmed === null, checking: false, error: null, observed: false, locked: confirmed === null });
        }
        return;
      }
      if (componentSignal.aborted || access.session.scope.isInvalidated || access.session.scope.hasIdentityMismatch) return;
      if (confirmed !== null) { const state = access.session.snapshot(); heldAddition.current = state.status === 'ready' && state.access?.effectiveRole === 'admin' ? confirmed : null; setAddConfirmed(true); setAddition({ targetId, pending: false, unknown: false, checking: false, error: null, observed: false, locked: false }); return; }
      const unknown = !(failure instanceof ApiError) || failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown';
      const current = access.session.snapshot();
      setAddition({ targetId, pending: false, unknown, checking: false, error: current.status === 'ready' && current.access?.effectiveRole === 'admin' ? failure : null, observed: false, locked: unknown });
      if (!unknown && failure instanceof ApiError && (failure.status === 403 || failure.status === 404 && failure.code !== 'user_not_found')) void access.session.revalidate();
    } finally {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      if (addAdmission.current === admission) addAdmission.current = null;
      addSubmitting.current = false; writeInFlight.current = false;
      if (!componentSignal.aborted && additionRef.current.pending) setAddition({ ...additionRef.current, pending: false, locked: false });
      if (!authRequestsPaused() && refreshQueued.current && activeRef.current && controller.current !== null && !controller.current.signal.aborted) { refreshQueued.current = false; void load(controller.current.signal, false, true); }
    }
  };

  const submit = async (action: SubmittedDialog) => {
    const admitted = access.session.snapshot();
    if (!active || knownRejectionRef.current !== null || access.session.scope.isInvalidated || admitted.status !== 'ready' || admitted.access?.effectiveRole !== 'admin') return;
    const grantAction = action.kind === 'role' || action.kind === 'remove';
    const invitationAction = !grantAction;
    if (grantSubmitting.current || invitationSubmitting.current || addSubmitting.current) return;
    if (invitationAction && (heldInvitation.current !== null || action.kind === 'revoke' && confirmedRevocations.current.has(action.invitation.id) || invitationIssueRef.current !== null && (!invitationIssueRef.current.observed || action.kind === 'revoke' && uncertainRevocations.current.has(action.invitation.id)))) return;
    if (grantAction && (heldGrant.current !== null || action.kind === 'remove' && action.member.directGrant === null || grantIssueRef.current !== null && !grantIssueRef.current.observed)) return;
    if (invitationAction) invitationSubmitting.current = true;
    if (grantAction) { grantSubmitting.current = true; grantIssueRef.current = null; setGrantIssue(null); }
    publicationController.current?.abort();
    grantPublicationController.current?.abort();
    const operation = ++operationGeneration.current;
    const owner = { action, routeGeneration: route.current.generation, presentationGeneration: presentationRef.current };
    guardCallback.current?.(true); setPending(true); setDialogError(null); setNotice(null); setReceipt(null);
    const componentSignal = controller.current!.signal;
    const admission = new AbortController(); admissionController.current = admission;
    const signal = AbortSignal.any([componentSignal, admission.signal, access.session.scope.signal]);
    let dispatched = false;
    let writeStarted = false;
    const stopForPause = () => { if (!dispatched) admission.abort(); };
    const unsubscribePause = subscribeAuthPause(stopForPause);
    if (authRequestsPaused()) stopForPause();
    const isCurrent = () => !componentSignal.aborted && !access.session.scope.isInvalidated && operation === operationGeneration.current;
    const publishLater = (publish: (signal: AbortSignal) => Promise<void>) => {
      const publication = new AbortController(); publicationController.current = publication;
      const publicationSignal = AbortSignal.any([componentSignal, access.session.scope.signal, publication.signal]);
      void (async () => {
        try {
          await access.session.scope.ready(publicationSignal);
          if (publicationSignal.aborted || !isCurrent()) return;
          await publish(publicationSignal);
        } catch (failure) {
          if (!publicationSignal.aborted && isCurrent() && !isAbortError(failure)) setError(failure);
        } finally {
          if (publicationController.current === publication) publicationController.current = null;
        }
      })();
    };
    try {
      let fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (fresh?.effectiveRole !== 'admin' || fresh.ownership.teamId !== admitted.access.ownership.teamId || fresh.ownership.version !== admitted.access.ownership.version) {
        if (ownsDialog(owner)) setDialogError(new Error('Project access changed before submission'));
        return;
      }
      while (readPromise.current !== null) {
        const reading = readPromise.current;
        const readSignal = readController.current?.signal;
        const waitingSignal = readSignal === undefined ? signal : AbortSignal.any([signal, readSignal]);
        let observed: MembersRead | undefined;
        try { observed = await abortable(reading, waitingSignal); }
        catch (failure) { if (signal.aborted) throw failure; observed = undefined; }
        if (readPromise.current !== null && readPromise.current !== reading) { fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal); continue; }
        if (!observed) { if (ownsDialog(owner)) setDialogError(new Error('Unable to verify current project members')); return; }
        fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      }
      if (signal.aborted || access.session.scope.isInvalidated || !activeRef.current || !ownsDialog(owner)) return;
      if (fresh?.effectiveRole !== 'admin' || fresh.ownership.teamId !== admitted.access.ownership.teamId || fresh.ownership.version !== admitted.access.ownership.version) {
        setDialogError(new Error('Project access changed before submission'));
        return;
      }
      if (grantAction) {
        const currentMember = membersRef.current?.find((member) => member.userId === action.member.userId);
        if (currentMember === undefined || !sameParticipant(currentMember, action.member)) { setDialogError(new Error('The project grant changed before submission')); return; }
      } else if (action.kind === 'revoke' && !invitationsRef.current?.some((invitation) => sameInvitation(invitation, action.invitation))) { setDialogError(new Error('The invitation changed before submission')); return; }
      writeStarted = true;
      writeInFlight.current = true;
      const onDispatch = () => { dispatched = true; if (admissionController.current === admission) admissionController.current = null; };
      const onIdentityMismatch = () => {
        access.session.scope.principalMismatch();
        if (!componentSignal.aborted && operation === operationGeneration.current && !authRequestsPaused()) {
          publishMembers(null); publishInvitations(null); if (ownsDialog(owner)) setDialog(null); setNotice('identityChanged');
        }
      };
      if (action.kind === 'role' || action.kind === 'remove') {
        const result = action.kind === 'role'
          ? await abortable(setProjectGrant(projectId, action.member.userId, { version: action.member.directGrant?.version ?? null, role: action.role, expectedUserId: user.id }, signal, onIdentityMismatch, onDispatch), signal)
          : await abortable(removeProjectGrant(projectId, action.member.userId, { version: action.member.directGrant!.version, expectedUserId: user.id }, signal, onIdentityMismatch, onDispatch), signal);
        if (!isCurrent()) return;
        retireRead();
        const selfLoss = result.actorAccess === null && action.member.userId === user.id;
        if (result.actorAccess === null && !access.session.scope.isProjectSuspended(projectId)) access.session.scope.suspendProject(projectId);
        if (result.actorAccess === null) {
          heldInvitation.current = null; setHasHeldInvitation(false);
          setDialog((current) => current?.kind === 'secret' ? null : current);
        }
        const confirmed = { name: selfLoss ? user.name ?? user.email ?? user.id : identityName(participantIdentity(action.member)), role: action.kind === 'role' ? action.role : null, lostAccess: result.actorAccess === null };
        heldGrant.current = { receipt: confirmed, owner, selfLoss }; setHasHeldGrant(true);
      } else if (action.kind === 'invite') {
        const result = await abortable(createInvitation(projectId, user.id, signal, onIdentityMismatch, onDispatch), signal);
        if (!isCurrent()) return;
        retireRead();
        heldInvitation.current = { result, owner }; setHasHeldInvitation(true);
      } else {
        await abortable(revokeInvitation(projectId, action.invitation.id, user.id, signal, onIdentityMismatch, onDispatch), signal);
        if (!isCurrent()) return;
        retireRead();
        confirmedRevocations.current.add(action.invitation.id);
        publishLater(async (publicationSignal) => {
          if (ownsDialog(owner)) setDialog(null);
          if (activeRef.current) await abortable(load(publicationSignal), publicationSignal);
        });
      }
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'identity_mismatch' || failure.code === 'principal_mismatch')) {
        if (!componentSignal.aborted && operation === operationGeneration.current && !authRequestsPaused()) { publishMembers(null); publishInvitations(null); if (ownsDialog(owner)) setDialog(null); setNotice('identityChanged'); }
        return;
      }
      if (!isCurrent()) return;
      if (!dispatched) {
        if (!isAbortError(failure) && !signal.aborted && ownsDialog(owner)) setDialogError(failure);
        return;
      }
      const unknown = !(failure instanceof ApiError) || failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown';
      if (unknown) {
        if (invitationAction) {
          if (action.kind === 'revoke') uncertainRevocations.current.add(action.invitation.id);
          const issue = { error: failure, observed: false, action: action.kind as 'invite' | 'revoke', ...(action.kind === 'revoke' ? { invitationId: action.invitation.id } : {}) };
          invitationIssueRef.current = issue; setInvitationIssue(issue);
        } else {
          const issue = { error: failure, observed: false };
          grantIssueRef.current = issue; setGrantIssue(issue);
        }
        if (!authRequestsPaused() && ownsDialog(owner)) { setDialog(null); setDialogError(null); }
        return;
      }
      if (failure instanceof ApiError && (failure.status === 403 || failure.status === 409 || failure.status === 404)) {
        knownRejectionRef.current = failure; setKnownRejection(failure);
        publishLater(async (publicationSignal) => {
          publishMembers(null); publishInvitations(null); if (ownsDialog(owner)) setDialog(null);
          setNotice(failure.status === 409 ? 'conflictReloaded' : 'permissionChecked');
          callbacks.current.onMembershipChange?.();
          if (activeRef.current && await abortable(load(publicationSignal), publicationSignal) && knownRejectionRef.current === failure) { knownRejectionRef.current = null; setKnownRejection(null); }
        });
      } else if (ownsDialog(owner)) setDialogError(failure);
    } finally {
      unsubscribePause();
      if (admissionController.current === admission) admissionController.current = null;
      if (isCurrent()) {
        if (!writeStarted && !route.current.onRoute && dialogRef.current === action) setDialog(null);
        if (writeStarted) writeInFlight.current = false;
        if (grantAction) grantSubmitting.current = false;
        if (invitationAction) invitationSubmitting.current = false;
        setPending(false);
        if (!authRequestsPaused() && refreshQueued.current && !writeInFlight.current && readController.current === null && activeRef.current && controller.current !== null && !controller.current.signal.aborted) {
          refreshQueued.current = false; void load(controller.current.signal, false, true);
        }
      }
    }
  };

  const dialogTitle = dialog?.kind === 'role' ? m.roleTitle({ name: identityName(participantIdentity(dialog.member)) })
    : dialog?.kind === 'remove' ? m.removeTitle({ name: identityName(participantIdentity(dialog.member)) })
      : dialog?.kind === 'revoke' ? m.revokeTitle : m.inviteTitle;
  const roleText = (role: 'admin' | 'member' | null) => role === null ? m.noGrant : role === 'admin' ? common.roleAdmin : common.roleMember;
  const confirm = dialog?.kind === 'role' ? m.saveRole : dialog?.kind === 'remove' ? m.removeConfirm : dialog?.kind === 'revoke' ? m.revokeConfirm : m.createInvite;
  const result = <>
    {hasHeldGrant && !pending && <div className="notice" role="status">{locale === 'zh-CN' ? '变更已确认；确认当前访问权限后可查看详情。' : 'The change was confirmed; its details are available after access is verified.'}</div>}
    {receipt !== null && (access.status === 'ready' || receiptIsSelf.current) && <div className="notice" role="status"><p>{receipt.role === null ? m.grantRemoved({ name: receipt.name }) : m.grantSaved({ name: receipt.name, role: receipt.role === 'admin' ? common.roleAdmin : common.roleMember })}</p>{receipt.lostAccess && <><p>{m.accessLost}</p>{access.status !== 'ready' && <button className="button" type="button" onClick={onRemoved}>{m.returnToProjects}</button>}</>}</div>}
  </>;
  return <>
    {onRoute && (resultHost === undefined ? result : resultHost !== null ? createPortal(result, resultHost) : null)}
    <div className="members-page-heading"><h2 tabIndex={-1}>{m.title}</h2>{admin && <button className="button primary" type="button" disabled={loading || access.status !== 'ready' || invitationIssue !== null && !invitationIssue.observed} onClick={() => open({ kind: 'invite' })}>{m.invite}</button>}</div>
    {grantIssue !== null && <div className="notice warning" role="alert"><p>{grantIssue.observed ? m.grantObserved : m.grantUnknown}</p>{grantIssue.error instanceof ApiError && grantIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{grantIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal).then((observed) => { if (observed && grantIssueRef.current !== null) { const issue = { ...grantIssueRef.current, observed: true }; grantIssueRef.current = issue; setGrantIssue(issue); } }); }}>{m.readCurrentMembers}</button></div>}
    {admin && (addition.unknown || addConfirmed) && <div className="notice warning" role="status"><p>{addition.unknown ? (locale === 'zh-CN' ? '添加结果未确认。核对当前成员不会解除重复提交保护。' : 'The add result is unconfirmed. Checking current members does not unlock another add.') : (locale === 'zh-CN' ? '添加已确认；正在等待最新成员列表。' : 'The add was confirmed; the current member list is pending.')}</p>{addition.observed && addition.unknown && <p>{members?.some(member => member.userId === addition.targetId) ? (locale === 'zh-CN' ? '当前已加入。' : 'Currently a member.') : (locale === 'zh-CN' ? '当前不是项目成员。' : 'Not currently a project member.')}</p>}{addition.error !== null && <ManagementError error={addition.error} />}<button className="button" type="button" disabled={addition.checking || !access.ready || !active} onClick={() => { void checkAddition().then(success => { if (success && addConfirmed) { heldAddition.current = null; setAddConfirmed(false); } }); }}>{addition.checking ? (locale === 'zh-CN' ? '正在核对…' : 'Checking…') : m.readCurrentMembers}</button></div>}
    {invitationIssue !== null && <div className="notice warning" role="alert"><p>{invitationIssue.observed ? m.invitationObserved : m.invitationUnknown}</p>{!invitationIssue.observed && (access.status === 'unavailable' || access.status === 'ready' && !admin) && <p>{m.invitationUnreadable}</p>}{invitationIssue.error instanceof ApiError && invitationIssue.error.requestId !== null && <p className="request-id">{globalCommon.requestId}<code>{invitationIssue.error.requestId}</code></p>}<button className="button" type="button" disabled={loading || pending} onClick={() => { void load(controller.current!.signal, true).then((observed) => { if (observed && invitationIssueRef.current !== null) { const issue = { ...invitationIssueRef.current, observed: true }; invitationIssueRef.current = issue; setInvitationIssue(issue); } }); }}>{m.readCurrentInvitations}</button></div>}
    {invitations?.some((invitation) => confirmedRevocations.current.has(invitation.id)) && <div className="notice" role="status"><p>{locale === 'zh-CN' ? '邀请撤销已确认；列表等待更新。' : 'The invitation revocation was confirmed; the list is awaiting refresh.'}</p><button className="button" type="button" disabled={pending || loading} onClick={() => { if (controller.current !== null) void load(controller.current.signal, true); }}>{locale === 'zh-CN' ? '刷新邀请列表' : 'Refresh invitation list'}</button></div>}
    {hasHeldInvitation && !pending && <div className="notice" role="status"><p>{locale === 'zh-CN' ? '邀请已创建；一次性链接等待查看。' : 'The invitation was created; its one-time link is ready to view.'}</p><button className="button" type="button" onClick={revealHeldInvitation}>{locale === 'zh-CN' ? '查看邀请链接' : 'View invitation link'}</button></div>}
    {notice !== null && <div className="notice" role="status">{m.notice[notice]}</div>}
    {knownRejection !== null && <ManagementError error={knownRejection} retry={() => { const failure = knownRejection; void load(controller.current!.signal).then((observed) => { if (observed && knownRejectionRef.current === failure) { knownRejectionRef.current = null; setKnownRejection(null); } }); }} />}
    {(error !== null || access.error !== null && !(receipt?.lostAccess === true && access.error instanceof ApiError && access.error.kind === 'server' && access.error.status === 404 && access.error.code === 'not_found')) && <ManagementError error={error ?? access.error} retry={() => { void load(controller.current!.signal); }} />}
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {receipt?.lostAccess !== true && (unavailable || access.status === "unavailable") && error === null && access.error === null && <div className="notice error" role="alert">{common.notFound}</div>}
    {!loading && members !== null && !unavailable && access.status !== 'unavailable' && <>
      {access.status === 'ready' && !admin && <div className="notice">{m.memberNotice}</div>}
      <section className="panel" aria-labelledby="members-title"><div className="panel-heading"><div><h3 id="members-title">{m.membersTitle} <span className="badge">{format.number(members.length)}</span></h3><p>{m.accessDescription}</p></div>{admin && <ProjectMemberSearch projectId={projectId} access={access} active={active && onRoute} members={members} addition={{ ...addition, locked: addition.locked || pending || addConfirmed }} onAdd={(id) => { void addMember(id); }} onCheck={() => { void checkAddition(); }} />}</div>
        <div className="grant-table">
          <div className="row grant-row head" aria-hidden="true"><span>{m.memberColumn}</span><span>{m.effectiveColumn}</span><span>{m.teamColumn}</span><span>{m.directColumn}</span><span>{m.actionColumn}</span></div>
          {members.map((member) => {
            const grant = member.directGrant;
            const identity = participantIdentity(member);
            const roleText = (role: 'admin' | 'member') => role === 'admin' ? common.roleAdmin : common.roleMember;
            return <div className="row grant-row" key={member.userId}><Identity user={identity} self={member.userId === user.id} />
              <div><span className="grant-label">{m.effectiveColumn}: </span><span className={`badge${member.effectiveRole === 'admin' ? ' admin' : ''}`}>{roleText(member.effectiveRole)}</span></div>
              <div><span className="grant-label">{m.teamColumn}: </span>{member.inheritedFrom === null ? '—' : <>{roleText(member.inheritedFrom.role)}<div className="row-detail">{member.inheritedFrom.team.kind === 'personal' ? m.personalTeam : member.inheritedFrom.team.name}</div></>}</div>
              <div><span className="grant-label">{m.directColumn}: </span>{admin ? <NativeSelect density="filter" wrapperClassName="role-select" aria-label={m.roleLabel({ name: identityName(identity) })} disabled={pending || access.status !== 'ready' || grantBlocked} value={grant?.role ?? ''} onChange={(event) => { if (event.target.value === 'admin' || event.target.value === 'member') open({ kind: 'role', member, role: event.target.value }); }}><option value="" disabled>{m.noGrant}</option><option value="member">{common.roleMember}</option><option value="admin">{common.roleAdmin}</option></NativeSelect> : grant === null ? m.noGrant : roleText(grant.role)}</div>
              <div className="actions">{admin && grant !== null ? <button className="button quiet" type="button" aria-label={m.removeLabel({ name: identityName(identity) })} disabled={pending || access.status !== 'ready' || grantBlocked} onClick={() => open({ kind: 'remove', member })}>{m.remove}</button> : <span className="muted small">—</span>}</div></div>;
          })}
        </div>
      </section>
      {admin && <InvitationList invitations={invitations} disabled={pending || access.status !== 'ready' || invitationIssue !== null && !invitationIssue.observed} canRevoke={(invitation) => !uncertainRevocations.current.has(invitation.id) && !confirmedRevocations.current.has(invitation.id)} onRevoke={(invitation) => open({ kind: 'revoke', invitation })} />}
      <div className="role-legend"><div><h3>{common.roleAdmin}</h3><p>{m.adminDescription}</p></div><div><h3>{common.roleMember}</h3><p>{m.memberDescription}</p></div></div>
    </>}
    {dialog?.kind === 'secret' && <SecretDialog kind="invitation" secret={dialog.secret} suspended={!active || access.status === 'unavailable'} onClose={() => setDialog(null)} />}
    {dialog !== null && dialog.kind !== 'secret' && !unavailable && access.status !== 'unavailable' && <ManagementDialog title={dialogTitle} busy={pending} suspended={!active || access.status === 'ready' && !admin} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className={`button${dialog.kind === 'remove' || dialog.kind === 'revoke' ? ' danger' : ' primary'}`} type="button" disabled={pending || knownRejection !== null || access.status !== 'ready'} onClick={() => { void submit(dialog); }}>{pending ? common.submitPending : confirm}</button></>}>
      {(dialog.kind === 'role' || dialog.kind === 'remove') && <p>{m.grantChange({ before: roleText(dialog.member.directGrant?.role ?? null), after: roleText(dialog.kind === 'role' ? dialog.role : null), effective: dialog.member.inheritedFrom === null && dialog.kind === 'remove' ? m.noAccess : roleText(dialog.member.inheritedFrom?.role === 'admin' || dialog.kind === 'role' && dialog.role === 'admin' ? 'admin' : 'member') })}</p>}
      {dialog.kind === 'remove' && <p>{dialog.member.userId === user.id ? m.selfRemovalBody : m.otherRemovalBody}</p>}
      {dialog.kind === 'invite' && <><p>{m.inviteBody}</p><div className="notice">{m.inviteTerms}</div></>}
      {dialog.kind === 'revoke' && <p>{m.revokeBody}</p>}
      {dialogError !== null && <ManagementError error={dialogError} />}
    </ManagementDialog>}
  </>;
};
