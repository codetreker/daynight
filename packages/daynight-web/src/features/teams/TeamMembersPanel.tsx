import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { getTeam, listTeamMembers, removeTeamMember, setTeamMemberRole, type Team, type TeamMember, type TeamRole } from "../../api/teams";
import { useI18n } from "../../i18n/LocaleProvider";
import { Identity, identityName } from "../management/feedback";
import { ManagementDialog } from "../management/ManagementDialog";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useOperation } from "./TeamManagement";

const messages = (zh: boolean) => zh ? {
  title: "Team 成员", members: "成员", description: "Team 角色会继承到该 Team 的项目。", role: "Team 角色", action: "操作", personal: "Personal Team 的成员和角色固定。", lastAdmin: "至少保留一名 Admin。", leave: "退出 Team", remove: "移除", change: "修改 Team 角色", cancel: "取消", close: "关闭", save: "确认修改", confirmRemove: "移除成员", loading: "正在读取", failed: "无法读取成员。", retry: "重试", rejected: "操作失败，请核对后重试。", conflict: "成员或权限已变化，请重新核对后操作。", unknown: "结果未知。请核对当前状态；无法确认原操作是否成功。", check: "查看当前状态", pending: "正在提交", effect: "Team 继承权限将变化；已有 Project 单独授权保持不变。", from: "角色变更", id: "请求 ID：", unavailable: "此 Team 不可用或你没有访问权限。", storage: "无法清除已保存的 Team 选择，请重试。", current: "当前成员状态", absent: "当前不是 Team 成员。"
} : {
  title: "Team members", members: "Members", description: "Team roles are inherited by the Team's projects.", role: "Team role", action: "Action", personal: "Personal Team membership and role are fixed.", lastAdmin: "At least one admin must remain.", leave: "Leave Team", remove: "Remove", change: "Change Team role", cancel: "Cancel", close: "Close", save: "Confirm change", confirmRemove: "Remove member", loading: "Loading", failed: "Unable to read members.", retry: "Retry", rejected: "The operation failed. Check the details and try again.", conflict: "Membership or permission changed. Review the current state before trying again.", unknown: "The result is unknown. Check the current state; it cannot confirm the original operation.", check: "Check current state", pending: "Submitting", effect: "Inherited Team access will change; existing direct Project grants remain.", from: "Role change", id: "Request ID: ", unavailable: "This Team is unavailable or you do not have access.", storage: "Unable to clear the saved Team selection. Try again.", current: "Current membership", absent: "Not currently a Team member."
};
type Action = { readonly kind: "role"; readonly member: TeamMember; readonly role: TeamRole } | { readonly kind: "remove"; readonly member: TeamMember };
type Props = { readonly teamId: string; readonly active?: boolean; readonly onRoute?: boolean; readonly admission: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onChanged: (confirmed: boolean) => void; readonly onStart?: () => void; readonly onLeft: () => void; readonly onGuardChange?: (guarded: boolean) => void; readonly onUnavailable?: () => "forgotten" | "changed" | "storage_error" };

export const TeamMembersPanel = ({ teamId, active = true, onRoute = true, admission, onIdentityMismatch, onChanged, onStart, onLeft, onGuardChange, onUnavailable }: Props) => {
  const { locale, messages: { auth: { roles } } } = useI18n(), m = messages(locale === "zh-CN");
  const [team, setTeam] = useState<Team | null>(null), [members, setMembers] = useState<readonly TeamMember[] | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<unknown>(null), [storageError, setStorageError] = useState(false);
  const [action, setAction] = useState<Action | null>(null), [stale, setStale] = useState(false), [observed, setObserved] = useState(false);
  const read = useRef<AbortController | null>(null), op = useOperation(admission);
  const callbacks = useRef({ onUnavailable, onChanged, onLeft }); callbacks.current = { onUnavailable, onChanged, onLeft };
  const operation = useRef(op); operation.current = op;
  const activeRef = useRef(active); activeRef.current = active;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  useEffect(() => { guardCallback.current?.(op.pending || op.result?.kind === "unknown"); }, [op.pending, op.result]);
  const load = useCallback(async () => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); setLoading(true); setError(null); setStorageError(false);
    try {
      await admission.ready(signal);
      const [current, roster] = await Promise.all([getTeam(teamId, admission.userId, signal, onIdentityMismatch), listTeamMembers(teamId, admission.userId, signal, onIdentityMismatch)]);
      await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return;
      if (!roster.some((member) => member.userId === admission.userId)) throw new ApiError("protocol");
      setTeam(current); setMembers(roster); return true;
    } catch (failure) {
      if (signal.aborted || admission.isInvalidated) return;
      try { await admission.ready(signal); } catch { return; }
      if (signal.aborted || admission.isInvalidated) return;
      setTeam(null); setMembers(null);
      const result = failure instanceof ApiError && failure.kind === "server" && failure.status === 404 && failure.code === "not_found" && !operation.current.guarded() ? callbacks.current.onUnavailable?.() : undefined;
      if (result !== "forgotten") { setStorageError(result === "storage_error"); setError(failure); }
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [admission, teamId, onIdentityMismatch]);
  useEffect(() => { if (!active) return; void load(); return () => read.current?.abort(); }, [active, load]);
  useEffect(() => { if (!onRoute && !operation.current.guarded()) setAction(null); }, [onRoute]);
  const actor = members?.find((member) => member.userId === admission.userId);
  const admin = team?.kind === "ordinary" && actor?.role === "admin";
  const unknown = op.result?.kind === "unknown";
  const locked = loading || error !== null || op.pending || unknown || !active;
  const open = (next: Action) => { if (locked) return; op.clear(); onStart?.(); setStale(false); setObserved(false); setAction(next); };
  const submit = () => {
    if (!action || locked || stale || !team || team.kind !== "ordinary" || !actor) return;
    if (action.kind === "role" && !admin || action.kind === "remove" && !admin && action.member.userId !== admission.userId) return;
    guardCallback.current?.(true);
    const reject = (failure: unknown) => {
      if (failure instanceof ApiError && ["version_conflict", "forbidden", "not_found", "last_admin"].includes(failure.code)) { setStale(true); if (activeRef.current) void load(); callbacks.current.onChanged(false); }
    };
    const success = (actorRole: TeamRole | null) => {
      read.current?.abort(); setAction(null);
      if (actorRole === null) { callbacks.current.onLeft(); return; }
      setMembers(null); callbacks.current.onChanged(true); if (activeRef.current) void load();
    };
    if (action.kind === "role") void op.run((signal, dispatched) => setTeamMemberRole(admission.userId, action.member, action.role, signal, onIdentityMismatch, dispatched), (receipt) => success(receipt.actorRole), reject);
    else void op.run((signal, dispatched) => removeTeamMember(admission.userId, action.member, signal, onIdentityMismatch, dispatched), (receipt) => success(receipt.actorRole), reject);
  };
  const failureText = (failure: unknown) => failure instanceof ApiError && failure.code === "last_admin" ? m.lastAdmin : failure instanceof ApiError && ["version_conflict", "forbidden", "not_found"].includes(failure.code) ? m.conflict : m.rejected;
  const notice = op.result && <div className="notice error" role="alert"><p>{unknown ? m.unknown : failureText(op.result.error)}</p>{op.result.error instanceof ApiError && op.result.error.requestId !== null && <p>{m.id}<code>{op.result.error.requestId}</code></p>}</div>;
  const admins = members?.filter((member) => member.role === "admin").length ?? 0;
  return <>
    <div className="page-heading"><div><div className="eyebrow">TEAM MEMBERS</div><h1 tabIndex={-1}>{m.title}</h1></div></div>
    {loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {error !== null && <div className="notice error" role="alert"><p>{storageError ? m.storage : error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden") ? m.unavailable : m.failed}</p>{error instanceof ApiError && error.requestId !== null && <p>{m.id}<code>{error.requestId}</code></p>}<button type="button" className="button" onClick={() => void load()}>{m.retry}</button></div>}
    {action === null && notice}
    {action === null && unknown && <button className="button" type="button" disabled={loading} onClick={() => void load()}>{m.check}</button>}
    {team && members && <section className="panel"><header className="panel-heading"><div><h2>{m.members}</h2><p>{team.kind === "personal" ? m.personal : m.description}</p></div></header><div className="team-members-list">{members.map((member) => {
      const self = member.userId === admission.userId, last = member.role === "admin" && admins === 1;
      const identity = { ...member.profile, userId: member.userId };
      return <div className="team-member-row" key={member.userId}><Identity user={identity} self={self} /><div><label className="visually-hidden" htmlFor={`team-role-${member.userId}`}>{m.role}: {identityName(identity)}</label><select id={`team-role-${member.userId}`} className="role-select" value={member.role} disabled={locked || !admin || last} onChange={(event) => open({ kind: "role", member, role: event.target.value as TeamRole })}><option value="member">{roles.member}</option><option value="admin">{roles.admin}</option></select>{last && team.kind === "ordinary" && <div className="row-caption">{m.lastAdmin}</div>}</div><div><button className="button quiet" type="button" disabled={locked || team.kind === "personal" || last || !self && !admin} onClick={() => open({ kind: "remove", member })}>{self ? m.leave : m.remove}</button></div></div>;
    })}</div></section>}
    {action && <ManagementDialog title={action.kind === "role" ? m.change : action.member.userId === admission.userId ? m.leave : m.confirmRemove} busy={op.pending} suspended={!active} onClose={() => setAction(null)} footer={<><button className="button" type="button" disabled={op.pending} onClick={() => setAction(null)}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading} onClick={() => { setObserved(false); void load().then((ok) => { if (ok) setObserved(true); }); }}>{m.check}</button> : <button className={`button ${action.kind === "remove" ? "danger" : "primary"}`} type="button" disabled={locked || stale} onClick={submit}>{op.pending ? m.pending : action.kind === "role" ? m.save : action.member.userId === admission.userId ? m.leave : m.confirmRemove}</button>}</>}>
      <Identity user={{ ...action.member.profile, userId: action.member.userId }} self={action.member.userId === admission.userId} />
      {action.kind === "role" && <p>{m.from}: {roles[action.member.role]} → {roles[action.role]}</p>}<p>{m.effect}</p>{notice}
      {unknown && observed && <section><h3>{m.current}</h3>{members?.find((member) => member.userId === action.member.userId) ? <p>{roles[members.find((member) => member.userId === action.member.userId)!.role]}</p> : <p>{m.absent}</p>}</section>}
      {error !== null && <p role="alert">{error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden") ? m.unavailable : m.failed}</p>}
    </ManagementDialog>}
  </>;
};
