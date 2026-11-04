import { useEffect, useRef, useState } from "react";
import { ApiError, isAbortError } from "../../api/client";
import { canonicalId } from "../../api/validation";
import { previewProjectTransfer, transferProject, type ProjectTransferPreview, type ProjectTransferReceipt } from "../../api/project-transfer";
import type { TeamRef } from "../../api/auth-types";
import { useI18n } from "../../i18n/LocaleProvider";
import { useProjectAccess } from "../projects/ProjectAccess";
import { useTeams } from "../teams/TeamsProvider";
import { useOperation } from "../teams/TeamManagement";
import { ManagementDialog } from "./ManagementDialog";

export const parseTransferTarget = (value: string, origin: string): string | null => {
  const trimmed = value.trim(), direct = canonicalId(trimmed);
  if (direct !== null) return direct;
  try {
    const url = new URL(trimmed);
    if (url.origin !== origin || url.username || url.password || trimmed.includes("?") || trimmed.includes("#") || !/^https?:\/\/[^/]+\/teams\/[^/]+$/i.test(trimmed)) return null;
    const match = /^\/teams\/([^/]+)$/.exec(url.pathname);
    if (match === null) return null;
    return canonicalId(decodeURIComponent(match[1]!));
  } catch { return null; }
};

const messages = (zh: boolean) => zh ? {
  title: "项目归属", description: "项目继承所属 Team 的权限，项目单独授权保持不变。", personal: "个人", transfer: "转移项目", restricted: "只有所属 Team 的 admin 可以转移项目。", target: "目标 Team ID 或链接", hint: "输入 Team ID 或当前服务的 Team 页面链接，无需加入目标 Team。", known: "已加入的 Team", choose: "选择 Team…", more: "加载更多", retry: "重试", loading: "正在读取", preview: "预览", cancel: "取消", close: "关闭", confirm: "确认转移", busy: "正在提交", invalid: "请输入有效的 Team ID 或当前服务的 Team 页面链接。", same: "项目已属于此 Team。请选择其他 Team。", changes: "转移后的变化", grants: "项目将继承目标 Team 的成员权限；全部项目单独授权和已有项目邀请保持不变。", role: "转移后你的项目权限", noAccess: "转移后你将失去此项目的访问权，系统不会额外保留授权。", failed: "无法完成操作，请检查后重试。", network: "无法连接服务，请重试。", targetMissing: "目标 Team 不存在或当前不可用。", sourceDenied: "你不再是原 Team 的管理员，无法转移。", sourceMissing: "项目已不可访问。", conflict: "归属或目标 Team 已变化。请重新预览并确认。", unknown: "转移结果未知。读取当前状态不能确认原操作是否成功，也不会重发操作。", check: "查看当前状态", current: "当前归属", unavailable: "项目当前不可访问。原转移结果仍未知。", cleanup: "转移已成功，但无法清理项目缓存。请重试。", noTeams: "无法读取已加入的 Team。", requestId: "请求 ID：",
} : {
  title: "Project ownership", description: "The project inherits permissions from its owner Team. Direct project grants remain unchanged.", personal: "Personal", transfer: "Transfer project", restricted: "Only an admin of the owner Team can transfer this project.", target: "Team ID or link", hint: "Enter a Team ID or a Team page link from this service. You do not need to join the target Team.", known: "Your Teams", choose: "Choose a Team…", more: "Load more", retry: "Retry", loading: "Loading", preview: "Preview", cancel: "Cancel", close: "Close", confirm: "Confirm transfer", busy: "Submitting", invalid: "Enter a valid Team ID or a Team page link from this service.", same: "The project already belongs to this Team. Choose another Team.", changes: "After transfer", grants: "The project will inherit the target Team's permissions. Direct project grants and existing project invitations remain unchanged.", role: "Your project access after transfer", noAccess: "You will lose access to this project after transfer. No extra grant will be added.", failed: "The operation could not be completed. Check the details and try again.", network: "Unable to connect to the service. Try again.", targetMissing: "The target Team does not exist or is unavailable.", sourceDenied: "You are no longer an admin of the source Team and cannot transfer this project.", sourceMissing: "The project is no longer accessible.", conflict: "The ownership or target Team changed. Preview and confirm again.", unknown: "The transfer result is unknown. Reading the current state cannot confirm the original operation and will not resend it.", check: "Check current state", current: "Current owner", unavailable: "The project is currently unavailable. The original transfer result remains unknown.", cleanup: "The transfer succeeded, but project cache cleanup failed. Retry.", noTeams: "Unable to load your Teams.", requestId: "Request ID: ",
};
const teamName = (team: TeamRef, personal: string) => team.kind === "personal" ? personal : team.name!;

const TeamChoices = ({ value, onChange, disabled }: { readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean }) => {
  const teams = useTeams(), { locale } = useI18n(), m = messages(locale === "zh-CN");
  return <div className="field"><label htmlFor="transfer-known">{m.known}</label><select id="transfer-known" value={teams.list.items.some((team) => team.id === value) ? value : ""} disabled={disabled || teams.list.status === "loading"} onChange={(event) => onChange(event.target.value)}><option value="">{m.choose}</option>{teams.list.items.map((team) => <option key={team.id} value={team.id}>{teamName(team, m.personal)} · {team.membership.role}</option>)}</select>
    {teams.list.status === "error" && <p role="alert">{m.noTeams} <button type="button" onClick={teams.refreshList}>{m.retry}</button></p>}
    {teams.list.cursor !== null && <button className="button" type="button" disabled={disabled || teams.list.more} onClick={teams.loadMore}>{teams.list.more ? m.loading : teams.list.moreError !== null ? m.retry : m.more}</button>}
  </div>;
};

export const ProjectOwnership = ({ projectId, projectName, onTransferred, active, onRetentionChange }: { readonly projectId: string; readonly projectName: string | null; readonly onTransferred?: ((receipt: ProjectTransferReceipt) => void) | undefined; readonly active: boolean; readonly onRetentionChange?: ((retain: boolean) => void) | undefined }) => {
  const access = useProjectAccess(projectId), scope = access.session.scope;
  const { locale, messages: { auth: { roles } } } = useI18n(), m = messages(locale === "zh-CN");
  const op = useOperation(scope);
  const [subject, setSubject] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false), [target, setTarget] = useState(""), [preview, setPreview] = useState<ProjectTransferPreview | null>(null);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState<unknown>(null), [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false);
  const [observed, setObserved] = useState(false), [cleanupError, setCleanupError] = useState<unknown>(null);
  const read = useRef<AbortController | null>(null), cleanup = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => () => { read.current?.abort(); }, []);
  const unknown = op.result?.kind === "unknown";
  const open = () => { if (!active) return; setSubject(projectName); setDialog(true); setTarget(""); setPreview(null); setReadError(null); setInvalid(false); setConflict(false); setObserved(false); op.clear(); void access.session.revalidate(); };
  const close = () => { if (!op.pending && cleanup.current === null) { read.current?.abort(); read.current = null; setReading(false); setDialog(false); if (op.result?.kind === "rejected") { op.clear(); onRetentionChange?.(false); } } };
  const change = (value: string) => { read.current?.abort(); read.current = null; setReading(false); setTarget(value); setPreview(null); setInvalid(false); setReadError(null); setConflict(false); };
  const inspect = async () => {
    if (!active || op.guarded()) return;
    op.clear(); onRetentionChange?.(false);
    const id = parseTransferTarget(target, window.location.origin);
    if (id === null) { setInvalid(true); setPreview(null); return; }
    if (id === access.access?.ownership.teamId) { setInvalid(true); setPreview(null); return; }
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]); setReading(true); setReadError(null); setPreview(null); setInvalid(false);
    try {
      const current = await access.session.revalidate();
      if (signal.aborted || current === null || !current.canTransfer) return;
      const value = await previewProjectTransfer(projectId, id, scope.userId, signal, scope.principalMismatch);
      if (signal.aborted) return;
      if (value.ownership.teamId !== current.ownership.teamId || value.ownership.version !== current.ownership.version) { setConflict(true); return; }
      setPreview(value); setConflict(false);
    } catch (error) { if (!signal.aborted && !isAbortError(error)) { setReadError(error); if (error instanceof ApiError && (error.status === 403 || error.status === 404)) void access.session.revalidate(); } }
    finally { if (read.current === controller) { read.current = null; if (!signal.aborted) setReading(false); } }
  };
  const submit = () => {
    const current = access.session.snapshot();
    if (!active || op.guarded() || preview === null || reading || current.status !== "ready" || current.refreshing || !current.access?.canTransfer || current.access.ownership.teamId !== preview.ownership.teamId || current.access.ownership.version !== preview.ownership.version) return;
    onRetentionChange?.(true);
    void op.run(async (signal, dispatched) => {
      const ticket = await scope.beginSync(projectId, signal);
      const receipt = await transferProject(projectId, preview, scope.userId, signal, scope.principalMismatch, dispatched);
      return { receipt, ticket };
    }, ({ receipt, ticket }) => {
      const finish = async () => {
        setCleanupError(null);
        try {
          if (receipt.actorAccess === null) {
            if (!await scope.revokeProject(ticket, scope.signal)) {
              const latest = await access.session.revalidateAfterMutation();
              if (latest === null && access.session.snapshot().status !== "unavailable") throw new Error("Unable to verify current project access");
              if (latest !== null) { cleanup.current = null; setDialog(false); onTransferred?.(receipt); onRetentionChange?.(false); return; }
            }
          }
          access.session.publishMutation(receipt.actorAccess);
          cleanup.current = null; setDialog(false); onTransferred?.(receipt); onRetentionChange?.(false);
          if (receipt.actorAccess !== null) void access.session.revalidateAfterMutation();
        } catch (error) { if (!scope.signal.aborted) setCleanupError(error); }
      };
      cleanup.current = finish; void finish();
    }, (error) => {
      if (error instanceof ApiError && (error.code === "version_conflict" || error.status === 403 || error.status === 404)) { setPreview(null); setConflict(error.code === "version_conflict"); void access.session.revalidate(); }
    });
  };
  const check = () => { setObserved(false); setReading(true); void access.session.revalidateAfterMutation().then(() => setObserved(true)).finally(() => setReading(false)); };
  const describeError = (error: unknown) => access.status === "unavailable" ? m.sourceMissing : access.status === "error" && access.error instanceof ApiError && access.error.kind === "network" ? m.network : access.ready && !access.access?.canTransfer ? m.sourceDenied : error instanceof ApiError && error.kind === "network" ? m.network : error instanceof ApiError && error.status === 404 ? m.targetMissing : m.failed;
  const owner = access.access?.ownerTeam;
  const changedOwner = preview !== null && access.ready && (access.access!.ownership.teamId !== preview.ownership.teamId || access.access!.ownership.version !== preview.ownership.version);
  return <>
    {owner && <section className="panel project-settings-panel" aria-labelledby="project-ownership-title"><div className="panel-heading"><div><h2 id="project-ownership-title">{m.title}</h2><p>{m.description}</p></div></div><div className="panel-body"><p><strong>{teamName(owner, m.personal)}</strong> <code>{owner.id}</code></p>{access.access?.canTransfer ? <button className="button" type="button" disabled={!access.ready || unknown || op.pending} onClick={open}>{m.transfer}</button> : <p className="hint">{m.restricted}</p>}</div></section>}
    {unknown && !dialog && <div className="notice warning" role="alert"><p>{m.unknown}</p><button className="button" type="button" onClick={() => setDialog(true)}>{m.check}</button></div>}
    {dialog && <ManagementDialog title={m.transfer} suspended={!active} busy={op.pending || cleanup.current !== null && cleanupError === null} onClose={close} footer={<><button className="button" type="button" disabled={op.pending || cleanup.current !== null && cleanupError === null} onClick={close}>{unknown ? m.close : m.cancel}</button>{cleanupError !== null ? <button className="button primary" type="button" onClick={() => { void cleanup.current?.(); }}>{m.retry}</button> : unknown ? <button className="button" type="button" disabled={reading} onClick={check}>{m.check}</button> : <button className="button danger" type="button" disabled={op.pending || reading || preview === null || !access.ready || !access.access?.canTransfer || access.access.ownership.teamId !== preview.ownership.teamId || access.access.ownership.version !== preview.ownership.version} onClick={submit}>{op.pending ? m.busy : m.confirm}</button>}</>}>
      {!unknown && cleanupError === null && <>{subject !== null && <p><strong style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{subject}</strong></p>}<div className="field"><label htmlFor="transfer-target">{m.target}</label><input id="transfer-target" value={target} disabled={op.pending} onChange={(event) => change(event.target.value)} autoComplete="off" /><p className="hint">{m.hint}</p>{invalid && <p className="hint error" role="alert">{parseTransferTarget(target, window.location.origin) === access.access?.ownership.teamId ? m.same : m.invalid}</p>}</div><TeamChoices value={target} onChange={change} disabled={op.pending} /><button className="button" type="button" disabled={op.pending || reading || !access.ready || !access.access?.canTransfer} onClick={() => { void inspect(); }}>{reading ? m.loading : m.preview}</button>{preview && <div><h3>{m.changes}</h3><p><strong>{teamName(preview.sourceTeam, m.personal)}</strong> <code>{preview.sourceTeam.id}</code> → <strong>{teamName(preview.targetTeam, m.personal)}</strong> <code>{preview.targetTeam.id}</code></p><p>{m.grants}</p><p>{preview.actorRole === null ? m.noAccess : `${m.role}: ${roles[preview.actorRole]}`}</p></div>}{(conflict || changedOwner) && <p className="notice warning" role="alert">{m.conflict}</p>}{readError !== null && <p className="notice error" role="alert">{describeError(readError)} {readError instanceof ApiError && readError.requestId && <>{m.requestId}<code>{readError.requestId}</code></>}</p>}</>}
      {op.result !== null && <div className="notice error" role="alert"><p>{unknown ? m.unknown : conflict ? m.conflict : describeError(op.result.error)}</p>{op.result.error instanceof ApiError && op.result.error.requestId && <p>{m.requestId}<code>{op.result.error.requestId}</code></p>}</div>}
      {unknown && observed && <p>{access.access ? <>{m.current}: {teamName(access.access.ownerTeam, m.personal)} <code>{access.access.ownerTeam.id}</code></> : access.status === "unavailable" ? m.unavailable : m.failed}</p>}
      {cleanupError !== null && <p className="notice error" role="alert">{m.cleanup}</p>}
    </ManagementDialog>}
  </>;
};
