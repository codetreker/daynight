import { NativeSelect } from "../../ui/native-select/NativeSelect";
import { useTeamForeground } from "./useTeamForeground";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, authRequestsPaused } from "../../api/client";
import { browserNavigation } from "../../app/navigation";
import { getTeam, listTeamMembers, removeTeamMember, setTeamMemberRole, type Team, type TeamMember, type TeamMembership, type TeamRole } from "../../api/teams";
import { useI18n } from "../../i18n/LocaleProvider";
import { Identity, identityName } from "../management/feedback";
import { ManagementDialog } from "../management/ManagementDialog";
import { TeamInvitations } from "../management/TeamInvitations";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { OperationPublicationError, useOperation } from "./TeamManagement";

const messages = (zh: boolean) => zh ? {
  members: "成员", description: "Team 角色会继承到该 Team 的项目。", role: "Team 角色", action: "操作", personal: "Personal Team 的成员和角色固定。", lastAdmin: "至少保留一名 Admin。", leave: "退出 Team", remove: "移除", change: "修改 Team 角色", cancel: "取消", close: "关闭", save: "确认修改", confirmRemove: "移除成员", loading: "正在读取", failed: "无法读取成员。", retry: "重试", rejected: "操作失败，请核对后重试。", conflict: "成员或权限已变化，请重新核对后操作。", unknown: "结果未知。请核对当前状态；无法确认原操作是否成功。", check: "查看当前状态", pending: "正在提交", effect: "Team 继承权限将变化；已有 Project 单独授权保持不变。", from: "角色变更", id: "请求 ID：", unavailable: "此 Team 不可用或你没有访问权限。", storage: "无法清除已保存的 Team 选择，请重试。", current: "当前成员状态", absent: "当前不是 Team 成员。"
} : {
  members: "Members", description: "Team roles are inherited by the Team's projects.", role: "Team role", action: "Action", personal: "Personal Team membership and role are fixed.", lastAdmin: "At least one admin must remain.", leave: "Leave Team", remove: "Remove", change: "Change Team role", cancel: "Cancel", close: "Close", save: "Confirm change", confirmRemove: "Remove member", loading: "Loading", failed: "Unable to read members.", retry: "Retry", rejected: "The operation failed. Check the details and try again.", conflict: "Membership or permission changed. Review the current state before trying again.", unknown: "The result is unknown. Check the current state; it cannot confirm the original operation.", check: "Check current state", pending: "Submitting", effect: "Inherited Team access will change; existing direct Project grants remain.", from: "Role change", id: "Request ID: ", unavailable: "This Team is unavailable or you do not have access.", storage: "Unable to clear the saved Team selection. Try again.", current: "Current membership", absent: "Not currently a Team member."
};
type ReadReason = "initial" | "background" | "reconcile";
type Action = { readonly kind: "role"; readonly member: TeamMember; readonly role: TeamRole } | { readonly kind: "remove"; readonly member: TeamMember };
type Props = { readonly teamId: string; readonly active?: boolean; readonly admissionBlocked?: boolean; readonly preferenceDenied?: boolean; readonly confirmedTeam?: Team | null; readonly onRoute?: boolean; readonly admission: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onChanged: (confirmed: boolean) => void; readonly onStart?: () => void; readonly onLeft: (unchangedContext: boolean, version: bigint) => void; readonly onGuardChange?: (guarded: boolean) => void; readonly onUnavailable?: () => "forgotten" | "changed" | "storage_error" };

export const TeamMembersPanel = ({ teamId, active = true, admissionBlocked = false, preferenceDenied = false, confirmedTeam = null, onRoute = true, admission, onIdentityMismatch, onChanged, onStart, onLeft, onGuardChange, onUnavailable }: Props) => {
  const { locale, messages: { auth: { roles } } } = useI18n(), m = messages(locale === "zh-CN");
  const [team, setTeam] = useState<Team | null>(null), [members, setMembers] = useState<readonly TeamMember[] | null>(null);
  const latestMembers = useRef<readonly TeamMember[] | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<unknown>(null), [accessDenied, setAccessDenied] = useState(false), [storageError, setStorageError] = useState(false);
  const [action, setAction] = useState<Action | null>(null), [stale, setStale] = useState(false), [observed, setObserved] = useState(false);
  const actionRef = useRef(action); actionRef.current = action;
  const owner = useRef({ teamId, admission }); owner.current = { teamId, admission };
  const confirmed = useRef(confirmedTeam); confirmed.current = confirmedTeam;
  const selectAction = (next: Action | null) => { actionRef.current = next; setAction(next); };
  // Retain the roster while rechecking, but admit writes only against fresh membership.
  const loaded = useRef(false), fresh = useRef(false);
  const [reconciling, setReconciling] = useState(false);
  const [permissionReady, setPermissionReady] = useState(false);
  const [permissionRevision, setPermissionRevision] = useState(0);
  const permissionEpoch = useRef(0);
  const getPermissionRevision = useCallback(() => fresh.current ? permissionEpoch.current : null, []);
  if (!active || admissionBlocked) fresh.current = false;
  const [invitationGuard, setInvitationGuard] = useState({ retain: false, lock: false });
  const invitationGuardRef = useRef(invitationGuard); invitationGuardRef.current = invitationGuard;
  const read = useRef<AbortController | null>(null), op = useOperation(admission);
  const callbacks = useRef({ onUnavailable, onChanged, onLeft }); callbacks.current = { onUnavailable, onChanged, onLeft };
  const operation = useRef(op); operation.current = op;
  const activeRef = useRef(active); activeRef.current = active;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  useEffect(() => { guardCallback.current?.(op.pending || op.publicationPending || op.result?.kind === "unknown" || op.publicationError !== null || invitationGuardRef.current.retain); }, [op.pending, op.publicationPending, op.result, op.publicationError, invitationGuard.retain]);
  const load = useCallback(async (reason: ReadReason = "reconcile") => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    ++permissionEpoch.current; fresh.current = false; setPermissionReady(false);
    setReconciling(reason === "reconcile");
    if (!loaded.current) setLoading(true);
    setError(null); setStorageError(false);
    try {
      await admission.ready(signal);
      const [current, roster] = await Promise.all([getTeam(teamId, admission.userId, signal, onIdentityMismatch), listTeamMembers(teamId, admission.userId, signal, onIdentityMismatch)]);
      await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return;
      if (!roster.some((member) => member.userId === admission.userId)) throw new ApiError("protocol");
      const selected = actionRef.current;
      if (selected !== null && !roster.some((member) => member.userId === selected.member.userId && member.version === selected.member.version && member.role === selected.member.role)) setStale(true);
      loaded.current = true; fresh.current = true; setPermissionReady(true); setPermissionRevision(permissionEpoch.current); setAccessDenied(false); setTeam(current); latestMembers.current = roster; setMembers(roster); return true;
    } catch (failure) {
      if (signal.aborted || admission.isInvalidated) return;
      try { await admission.ready(signal); } catch { return; }
      if (signal.aborted || admission.isInvalidated) return;
      const denied = failure instanceof ApiError && failure.kind === "server" && ((failure.status === 404 && failure.code === "not_found") || (failure.status === 403 && failure.code === "forbidden"));
      if (denied) { setAccessDenied(true); loaded.current = false; setTeam(null); latestMembers.current = null; setMembers(null); }
      const result = failure instanceof ApiError && failure.kind === "server" && failure.status === 404 && failure.code === "not_found" && !operation.current.guarded() && !invitationGuardRef.current.retain ? callbacks.current.onUnavailable?.() : undefined;
      if (result !== "forgotten") { setStorageError(result === "storage_error"); setError(failure); }
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) { setLoading(false); setReconciling(false); } } }
  }, [admission, teamId, onIdentityMismatch]);
  useEffect(() => {
    if (!active || admissionBlocked || preferenceDenied) return;
    void load(loaded.current ? "background" : "initial");
    return () => read.current?.abort();
  }, [active, admissionBlocked, preferenceDenied, load]);
  useEffect(() => { if (!onRoute && !operation.current.guarded()) selectAction(null); }, [onRoute]);
  useTeamForeground(active && !admissionBlocked && !preferenceDenied, () => { void load("background"); });
  const actor = members?.find((member) => member.userId === admission.userId);
  const admin = team?.kind === "ordinary" && actor?.role === "admin";
  const unknown = op.result?.kind === "unknown";
  const unavailable = accessDenied || preferenceDenied;
  const locked = unavailable || loading || reconciling || error !== null || op.pending || unknown || op.publicationError !== null || invitationGuard.lock || !active;
  const open = (next: Action) => { if (locked) return; op.clear(); onStart?.(); setStale(false); setObserved(false); selectAction(next); };
  const submit = () => {
    if (!action || locked || stale || authRequestsPaused() || !fresh.current || !team || team.kind !== "ordinary" || !actor) return;
    if (action.kind === "role" && !admin || action.kind === "remove" && !admin && action.member.userId !== admission.userId) return;
    const navigation = browserNavigation().snapshot();
    guardCallback.current?.(true);
    const reject = (failure: unknown) => {
      if (failure instanceof ApiError && ["version_conflict", "forbidden", "not_found", "last_admin"].includes(failure.code)) { setStale(true); if (activeRef.current) void load(); callbacks.current.onChanged(false); }
    };
    const success = (actorRole: TeamRole | null, change: { readonly kind: "role"; readonly membership: TeamMembership } | { readonly kind: "remove"; readonly userId: string }) => {
      if (owner.current.teamId !== teamId || owner.current.admission !== admission) return;
      read.current?.abort();
      // An Action is an immutable confirmation and its in-memory revision.
      const unchangedContext = actionRef.current === action && browserNavigation().snapshot() === navigation;
      if (unchangedContext) selectAction(null);
      else if (actionRef.current === action) setStale(true);
      const current = latestMembers.current?.find((member) => member.userId === action.member.userId);
      const newerActor = action.member.userId === admission.userId && confirmed.current?.id === teamId && confirmed.current.membership.version > action.member.version;
      const sameSubmission = !newerActor && (current === undefined || current.createdAt === action.member.createdAt && current.version <= action.member.version);
      if (actorRole === null && sameSubmission) {
        ++permissionEpoch.current; fresh.current = false; setPermissionReady(false); setAccessDenied(true);
        loaded.current = false; setTeam(null); latestMembers.current = null; setMembers(null);
        callbacks.current.onLeft(unchangedContext, action.member.version); return;
      }
      const next = latestMembers.current?.flatMap((member) => {
        if (change.kind === "remove" && member.userId === change.userId && sameSubmission) return [];
        if (change.kind === "role" && member.userId === change.membership.userId && member.createdAt === change.membership.createdAt && member.version <= change.membership.version) return [{ ...member, ...change.membership }];
        return [member];
      }) ?? null;
      latestMembers.current = next; setMembers(next);
      callbacks.current.onChanged(true); if (activeRef.current) void load();
    };
    if (action.kind === "role") void op.run((signal, dispatched) => setTeamMemberRole(admission.userId, action.member, action.role, signal, onIdentityMismatch, dispatched), (receipt) => success(receipt.actorRole, { kind: "role", membership: receipt.membership }), reject);
    else void op.run((signal, dispatched) => removeTeamMember(admission.userId, action.member, signal, onIdentityMismatch, dispatched), (receipt) => success(receipt.actorRole, { kind: "remove", userId: receipt.userId }), reject);
  };
  const failureText = (failure: unknown) => failure instanceof ApiError && failure.code === "last_admin" ? m.lastAdmin : failure instanceof ApiError && ["version_conflict", "forbidden", "not_found"].includes(failure.code) ? m.conflict : m.rejected;
  const notice = op.result && <div className="notice error" role="alert"><p>{unknown ? m.unknown : failureText(op.result.error)}</p>{op.result.error instanceof ApiError && op.result.error.requestId !== null && <p>{m.id}<code>{op.result.error.requestId}</code></p>}</div>;
  const admins = members?.filter((member) => member.role === "admin").length ?? 0;
  return <>
    {action === null && <OperationPublicationError operation={op} zh={locale === "zh-CN"} />}
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {error !== null && <div className="notice error" role="alert"><p>{storageError ? m.storage : error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden") ? m.unavailable : m.failed}</p>{error instanceof ApiError && error.requestId !== null && <p>{m.id}<code>{error.requestId}</code></p>}<button type="button" className="button" onClick={() => void load()}>{m.retry}</button></div>}
    {accessDenied && !preferenceDenied && error === null && <div className="notice error" role="alert">{m.unavailable}</div>}
    {(action === null || unavailable) && notice}
    {(action === null || unavailable) && unknown && <button className="button" type="button" disabled={loading || reconciling} onClick={() => void load()}>{m.check}</button>}
    {unavailable && !op.pending && action !== null && <button className="button" type="button" onClick={() => selectAction(null)}>{m.close}</button>}
    {unavailable && op.pending && <div role="status">{m.pending}</div>}
    {!unavailable && team && members && <section className="panel"><header className="panel-heading"><div><h2>{m.members}</h2><p>{team.kind === "personal" ? m.personal : m.description}</p></div></header><div className="team-members-list">{members.map((member) => {
      const self = member.userId === admission.userId, last = member.role === "admin" && admins === 1;
      const identity = { ...member.profile, userId: member.userId };
      return <div className="team-member-row" key={member.userId}><Identity user={identity} self={self} /><div className="team-member-role"><label className="visually-hidden" htmlFor={`team-role-${teamId}-${member.userId}`}>{m.role}: {identityName(identity)}</label><NativeSelect id={`team-role-${teamId}-${member.userId}`} density="filter" wrapperClassName="role-select" value={member.role} disabled={locked || !admin || last} onChange={(event) => open({ kind: "role", member, role: event.target.value as TeamRole })}><option value="member">{roles.member}</option><option value="admin">{roles.admin}</option></NativeSelect></div>{last && team.kind === "ordinary" && <div className="team-member-caption">{m.lastAdmin}</div>}<div className="team-member-actions"><button className="button quiet" type="button" disabled={locked || team.kind === "personal" || last || !self && !admin} onClick={() => open({ kind: "remove", member })}>{self ? m.leave : m.remove}</button></div></div>;
    })}</div></section>}
    <TeamInvitations teamId={teamId} teamName={team?.name ?? ""} active={active} admissionBlocked={admissionBlocked} permissionReady={permissionReady && fresh.current && !admissionBlocked && !unavailable} permissionRevision={permissionRevision} getPermissionRevision={getPermissionRevision} onRoute={onRoute} editable={!unavailable && Boolean(admin) && !loading && !reconciling && !op.pending && !unknown && error === null} actorRole={unavailable || team?.kind !== "ordinary" ? null : actor?.role ?? null} unavailable={unavailable} admission={admission} onIdentityMismatch={onIdentityMismatch} onPermissionChange={() => { if (activeRef.current) void load(); callbacks.current.onChanged(false); }} onGuardChange={(retain, lock) => { invitationGuardRef.current = { retain, lock }; guardCallback.current?.(retain || operation.current.guarded() || operation.current.publicationPending); setInvitationGuard((previous) => previous.retain === retain && previous.lock === lock ? previous : { retain, lock }); }} />
    {action && <ManagementDialog title={action.kind === "role" ? m.change : action.member.userId === admission.userId ? m.leave : m.confirmRemove} busy={op.pending} suspended={!active || unavailable} onClose={() => selectAction(null)} footer={<><button className="button" type="button" disabled={op.pending} onClick={() => selectAction(null)}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading || reconciling} onClick={() => { setObserved(false); void load().then((ok) => { if (ok) setObserved(true); }); }}>{m.check}</button> : <button className={`button ${action.kind === "remove" ? "danger" : "primary"}`} type="button" disabled={locked || stale} onClick={submit}>{op.pending ? m.pending : action.kind === "role" ? m.save : action.member.userId === admission.userId ? m.leave : m.confirmRemove}</button>}</>}>
      <OperationPublicationError operation={op} zh={locale === "zh-CN"} />
      <Identity user={{ ...action.member.profile, userId: action.member.userId }} self={action.member.userId === admission.userId} />
      {action.kind === "role" && <p>{m.from}: {roles[action.member.role]} → {roles[action.role]}</p>}<p>{m.effect}</p>{notice}
      {unknown && observed && <section><h3>{m.current}</h3>{members?.find((member) => member.userId === action.member.userId) ? <p>{roles[members.find((member) => member.userId === action.member.userId)!.role]}</p> : <p>{m.absent}</p>}</section>}
      {error !== null && <p role="alert">{error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden") ? m.unavailable : m.failed}</p>}
    </ManagementDialog>}
  </>;
};
