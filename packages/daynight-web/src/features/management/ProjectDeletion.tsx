import { useEffect, useRef, useState } from "react";
import { ApiError, isAbortError } from "../../api/client";
import { deleteProject, isConfirmedProjectDeletionRefusal, previewProjectDeletion, type ProjectDeletionPreview, type ProjectDeletionReceipt } from "../../api/project-deletion";
import { navigate } from "../../app/router";
import { useI18n } from "../../i18n/LocaleProvider";
import { useProjectAccess } from "../projects/ProjectAccess";
import { ManagementDialog } from "./ManagementDialog";
import type { ProjectManagementGuard } from "./ProjectManagementGuard";

const labels = (zh: boolean) => zh ? {
  title: "删除项目", description: "删除整个项目，使项目及其内容退出访问。", restricted: "只有所属 Team 的 admin 可以删除项目。", open: "删除项目", question: "删除此项目？", loading: "正在读取项目信息…", failedRead: "无法读取删除预览。", retry: "重试", cancel: "取消", name: "项目名称", id: "Project ID", repo: "仓库地址", team: "所属 Team", personal: "个人", scope: "删除范围", impact: "项目及其全部任务、依赖、Steps、讨论、附件和 Session 将退出访问；项目授权和旧邀请不再生效。", retention: "服务端保留历史数据和文件，产品内没有恢复入口。Git 仓库、PR、分支和本地文件不受影响。", exact: "名称必须完全一致，包括空白和大小写。", observed: "预览时的观察", tasks: "任务", unfinished: "未完成", attachments: "附件", blockers: "以下 Worker 认领阻止删除。请先停止执行并解除认领。", more: "加载更多", input: "输入项目名称以确认", escaped: "输入 JSON 双引号内的转义内容以确认", delete: "确认删除", submitting: "正在删除…", rejected: "删除未提交。请检查原因后重试。", denied: "你不再拥有删除权限。", blocked: "存在活跃的 Worker 认领，删除未提交。", unknown: "删除结果未确认。核对当前状态不能证明原操作成功，也不会再次发送删除请求。", check: "核对当前状态", checking: "正在核对…", unavailable: "项目当前不可访问；原删除结果仍未确认。", available: "项目当前仍可访问；原删除结果仍未确认。", back: "返回项目列表", offline: "离线", paused: "暂停", request: "请求 ID：",
} : {
  title: "Delete project", description: "Remove the entire project and its contents from access.", restricted: "Only an admin of the owner Team can delete this project.", open: "Delete project", question: "Delete this project?", loading: "Loading project information…", failedRead: "Unable to load the deletion preview.", retry: "Retry", cancel: "Cancel", name: "Project name", id: "Project ID", repo: "Repository", team: "Owner Team", personal: "Personal", scope: "Deletion scope", impact: "The project and all its tasks, dependencies, Steps, discussions, attachments and Sessions will become inaccessible. Project grants and old invitations will no longer grant access.", retention: "Historical data and files remain on the server; recovery is not available in the product. The Git repository, PRs, branches and local files are unaffected.", exact: "The name must match exactly, including whitespace and case.", observed: "Observed in this preview", tasks: "tasks", unfinished: "unfinished", attachments: "attachments", blockers: "These Worker claims block deletion. Stop execution and release the claims first.", more: "Load more", input: "Enter the project name to confirm", escaped: "Enter the escaped content inside the JSON quotes to confirm", delete: "Confirm deletion", submitting: "Deleting…", rejected: "Deletion was not committed. Check the reason and try again.", denied: "You no longer have permission to delete this project.", blocked: "Active Worker claims prevented deletion. No deletion was committed.", unknown: "The deletion result is unknown. Checking current state cannot prove the original operation succeeded and will not resend it.", check: "Check current state", checking: "Checking…", unavailable: "The project is currently unavailable; the original deletion result remains unknown.", available: "The project is currently accessible; the original deletion result remains unknown.", back: "Return to projects", offline: "Offline", paused: "Paused", request: "Request ID: ",
};

const needsEscape = (name: string) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name);
const encodedName = (name: string) => JSON.stringify(name).replace(/[\u007f-\u009f\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
const matchesName = (value: string, name: string) => {
  if (!needsEscape(name)) return value === name;
  try { return JSON.parse(`"${value}"`) === name; } catch { return false; }
};

type Result = { readonly kind: "rejected" | "unknown"; readonly error: unknown } | null;
export const ProjectDeletion = ({ projectId, active, onRoute, unavailable, onRetentionChange, guard, onDeleted, onOutcome }: {
  readonly projectId: string; readonly active: boolean; readonly onRoute: boolean; readonly unavailable: boolean;
  readonly onRetentionChange?: ((retain: boolean) => void) | undefined; readonly guard: ProjectManagementGuard;
  readonly onDeleted?: ((receipt: ProjectDeletionReceipt, finish: () => Promise<void>) => void) | undefined;
  readonly onOutcome?: ((kind: "unknown" | "rejected", error: unknown, check: () => Promise<"available" | "unavailable">) => void) | undefined;
}) => {
  const access = useProjectAccess(projectId), scope = access.session.scope;
  const { locale, messages: { inspection: { claim } } } = useI18n(), m = labels(locale === "zh-CN");
  const [dialog, setDialog] = useState(false), [preview, setPreview] = useState<ProjectDeletionPreview | null>(null);
  const [typed, setTyped] = useState(""), [loading, setLoading] = useState(false), [readError, setReadError] = useState<unknown>(null);
  const [pending, setPending] = useState(false), [result, setResult] = useState<Result>(null), [checked, setChecked] = useState<"available" | "unavailable" | null>(null);
  const read = useRef<AbortController | null>(null), operation = useRef<{ controller: AbortController; dispatched: boolean } | null>(null);
  const latest = useRef({ active, onRoute, dialog }); latest.current = { active, onRoute, dialog };
  const resultRef = useRef<Result>(null); resultRef.current = result;
  useEffect(() => () => { read.current?.abort(); operation.current?.controller.abort(); }, []);
  useEffect(() => { if (!onRoute) { read.current?.abort(); setLoading(false); if (operation.current !== null && !operation.current.dispatched) operation.current.controller.abort(); } }, [onRoute]);
  useEffect(() => scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    read.current?.abort(); setPreview(null); setTyped("");
    if (resultRef.current?.kind !== "unknown" && operation.current === null) setDialog(false);
  }), [scope, projectId]);
  useEffect(() => {
    if (access.status !== "ready" || access.refreshing || access.access?.teamRole === "admin") return;
    read.current?.abort(); setLoading(false); setPreview(null); setTyped("");
  }, [access.status, access.refreshing, access.access]);
  const load = (cursor?: string) => {
    if (!active || read.current !== null) return;
    const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]); setLoading(true); setReadError(null);
    void (async () => { let ticket: Awaited<ReturnType<typeof scope.beginSync>> | null = null; try {
      await scope.ready(signal);
      ticket = await scope.beginSync(projectId, signal);
      const checkingUnknown = resultRef.current?.kind === "unknown";
      if (!checkingUnknown) {
        const before = await access.session.waitForFreshAccess(signal, true);
        if (before?.teamRole !== "admin" || !scope.canRevokeProject(ticket)) throw new Error("Project deletion access changed");
      }
      const page = await previewProjectDeletion(projectId, cursor === undefined ? {} : { cursor }, scope.userId, signal, scope.principalMismatch);
      await scope.ready(signal);
      const fresh = checkingUnknown ? null : await access.session.waitForFreshAccess(signal, true);
      if (signal.aborted || scope.isInvalidated || !latest.current.onRoute) return;
      if (!scope.canRevokeProject(ticket) || !checkingUnknown && fresh?.teamRole !== "admin") { setPreview(null); setTyped(""); setReadError(new Error("Project observation changed")); return; }
      if (resultRef.current?.kind === "unknown") { setChecked("available"); return; }
      setPreview((previous) => cursor === undefined || previous === null ? page : { ...page, activeClaims: [...previous.activeClaims, ...page.activeClaims] });
    } catch (error) {
      if (signal.aborted || isAbortError(error) || scope.isInvalidated) return;
      const denied = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found" && ticket !== null;
      if (denied && read.current === controller) read.current = null;
      const withdrawal = denied ? scope.revokeProject(ticket!, scope.signal).catch((failure: unknown) => failure) : null;
      try { await scope.ready(signal); } catch { return; }
      if (signal.aborted || scope.isInvalidated) return;
      if (denied) {
        const value = await withdrawal;
        if (signal.aborted || scope.isInvalidated) return;
        if (value === true && scope.canRevokeProject(ticket!)) {
          if (resultRef.current?.kind === "unknown") setChecked("unavailable");
          else setReadError(error);
        } else setReadError(value === false ? new Error("Project observation changed") : value);
        setLoading(false);
      } else {
        setReadError(error);
        if (error instanceof ApiError && error.kind === "server" && error.status === 403 && error.code === "forbidden") void access.session.revalidate();
      }
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !scope.isInvalidated) setLoading(false); } } })();
  };
  const open = () => { if (!active || guard.isBlocked("delete")) return; setDialog(true); setReadError(null); if (resultRef.current?.kind !== "unknown") { setPreview(null); setTyped(""); setResult(null); load(); } };
  const close = () => { if (pending) return; read.current?.abort(); read.current = null; setLoading(false); setDialog(false); };
  const submit = () => {
    const selected = preview;
    if (!active || !onRoute || selected === null || selected.nextCursor !== null || selected.activeClaims.length !== 0 || !matchesName(typed, selected.project.name) || operation.current !== null || resultRef.current?.kind === "unknown" || !guard.tryAcquire("delete")) return;
    const op = { controller: new AbortController(), dispatched: false }; operation.current = op;
    const signal = AbortSignal.any([op.controller.signal, scope.signal]); setPending(true); setResult(null); setReadError(null); onRetentionChange?.(true);
    void (async () => { let ticket: Awaited<ReturnType<typeof scope.beginSync>> | null = null; try {
      ticket = await scope.beginSync(projectId, signal);
      const fresh = await access.session.waitForFreshAccess(signal, true);
      if (signal.aborted || !latest.current.active || !latest.current.onRoute || !latest.current.dialog || fresh?.teamRole !== "admin") throw new Error("Project deletion admission changed");
      const receipt = await deleteProject(projectId, scope.userId, signal, scope.principalMismatch, () => { op.dispatched = true; });
      // Preserve the receipt before any asynchronous cleanup or navigation.
      const confirmedTicket = ticket;
      const finish = async () => {
        await scope.revokeProject(confirmedTicket, scope.signal);
        guard.release("delete"); onRetentionChange?.(false);
      };
      setDialog(false);
      if (onDeleted !== undefined) onDeleted(receipt, finish); else await finish();
    } catch (error) {
      if (signal.aborted || scope.isInvalidated) return;
      const withdrawal = isConfirmedProjectDeletionRefusal(error) && error.status === 404 && ticket !== null ? scope.revokeProject(ticket, scope.signal).catch((failure: unknown) => failure) : null;
      try { await scope.ready(signal); } catch { return; }
      if (signal.aborted || scope.isInvalidated) return;
      const kind = op.dispatched && !isConfirmedProjectDeletionRefusal(error) ? "unknown" : "rejected";
      const next = { kind, error } as const; resultRef.current = next; setResult(next);
      void withdrawal?.then((value) => { if (value !== true && value !== false && !scope.isInvalidated) setReadError(value); });
      const check = async (): Promise<"available" | "unavailable"> => {
        const checkTicket = await scope.beginSync(projectId, scope.signal);
        try {
          await previewProjectDeletion(projectId, {}, scope.userId, scope.signal, scope.principalMismatch);
          await scope.ready(scope.signal);
          if (!scope.canRevokeProject(checkTicket)) throw new Error("Project observation changed");
          return "available";
        } catch (failure) {
          if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404 && failure.code === "not_found") {
            if (!await scope.revokeProject(checkTicket, scope.signal) || !scope.canRevokeProject(checkTicket)) throw new Error("Project observation changed");
            await scope.ready(scope.signal);
            if (!scope.canRevokeProject(checkTicket)) throw new Error("Project observation changed");
            return "unavailable";
          }
          throw failure;
        }
      };
      onOutcome?.(kind, error, check);
      if (kind === "rejected") { guard.release("delete"); onRetentionChange?.(false); if (error instanceof ApiError && (error.status === 403 || error.status === 404)) void access.session.revalidate(); if (error instanceof ApiError && error.status === 409) { setPreview(null); if (latest.current.active) load(); } }
    } finally {
      if (operation.current === op) operation.current = null;
      if (!scope.isInvalidated) { setPending(false); if (signal.aborted && !op.dispatched) { guard.release("delete"); onRetentionChange?.(false); } }
    } })();
  };
  const unknown = result?.kind === "unknown", canDelete = access.access?.teamRole === "admin";
  const error = result?.error;
  const detail = error instanceof ApiError && error.code === "forbidden" ? m.denied : error instanceof ApiError && error.code === "active_worker_claims" ? m.blocked : m.rejected;
  return <section className="panel project-settings-panel" aria-labelledby="project-delete-title"><div className="panel-heading"><div><h2 id="project-delete-title">{m.title}</h2><p>{m.description}</p></div></div><div className="panel-body">
    {!canDelete && <p>{m.restricted}</p>}
    <button className="button danger" type="button" disabled={!active || guard.isBlocked("delete") || !unknown && (unavailable || !access.ready || !canDelete)} onClick={open}>{m.open}</button>
  </div>{dialog && <ManagementDialog title={unknown ? m.unknown : m.question} initialFocus="cancel" closeOnBackdrop busy={pending} suspended={!active} onClose={close} footer={<>
    <button className="button" type="button" data-dialog-cancel disabled={pending} onClick={unknown ? () => { close(); navigate("/projects"); } : close}>{unknown ? m.back : m.cancel}</button>
    {unknown ? <button className="button primary" type="button" disabled={loading} onClick={() => load()}>{loading ? m.checking : m.check}</button> : <button className="button danger" type="button" disabled={pending || loading || preview === null || preview.nextCursor !== null || preview.activeClaims.length !== 0 || !matchesName(typed, preview.project.name) || guard.isBlocked("delete")} onClick={submit}>{pending ? m.submitting : m.delete}</button>}
  </>}>
    {loading && preview === null && !unknown && <p role="status">{m.loading}</p>}
    {readError !== null && <div className="notice error" role="alert"><p>{readError instanceof ApiError && readError.kind === "server" && readError.status === 403 && readError.code === "forbidden" ? m.denied : m.failedRead}</p>{readError instanceof ApiError && readError.requestId !== null && <p>{m.request}<code>{readError.requestId}</code></p>}<button className="button" type="button" onClick={() => load(preview?.nextCursor ?? undefined)}>{m.retry}</button></div>}
    {unknown && <div className="notice warning" role="alert"><p>{m.unknown}</p>{checked !== null && <p>{checked === "available" ? m.available : m.unavailable}</p>}</div>}
    {result?.kind === "rejected" && <div className="notice error" role="alert"><p>{detail}</p>{error instanceof ApiError && error.requestId !== null && <p>{m.request}<code>{error.requestId}</code></p>}</div>}
    {preview !== null && !unknown && !unavailable && access.status === "ready" && access.access?.teamRole === "admin" && !scope.isProjectSuspended(projectId) && <>
      <dl className="project-deletion-details"><dt>{m.name}</dt><dd>{needsEscape(preview.project.name) ? encodedName(preview.project.name) : preview.project.name}</dd><dt>{m.id}</dt><dd><code>{preview.project.id}</code></dd><dt>{m.repo}</dt><dd>{preview.project.repoUrl}</dd><dt>{m.team}</dt><dd>{preview.project.ownerTeam.kind === "personal" ? m.personal : preview.project.ownerTeam.name}</dd></dl>
      <p><strong>{m.scope}</strong><br />{m.impact}</p><p>{m.observed} · {preview.summary.taskCount} {m.tasks} · {preview.summary.unfinishedTaskCount} {m.unfinished} · {preview.summary.attachmentCount} {m.attachments} · <time>{preview.observedAt}</time></p><div className="notice warning">{m.retention}</div>
      {preview.activeClaims.length > 0 && <div className="notice warning"><p>{m.blockers}</p><ul>{preview.activeClaims.map((entry) => <li key={entry.taskId}><a href={`/projects/${projectId}/tasks/${entry.taskId}`}>{entry.title}</a> <code>{entry.taskId}</code> · {entry.worker.machineName} · {entry.worker.platform} · {entry.worker.connectivity === "offline" ? m.offline : entry.worker.paused || entry.worker.phase === "paused" ? m.paused : claim.phase[entry.worker.phase]}</li>)}</ul></div>}
      {preview.nextCursor !== null && <button className="button" type="button" disabled={loading} onClick={() => load(preview.nextCursor!)}>{loading ? m.loading : m.more}</button>}
      <div className="field"><label htmlFor="project-deletion-name">{needsEscape(preview.project.name) ? m.escaped : m.input}</label><p className="project-deletion-challenge">{needsEscape(preview.project.name) ? encodedName(preview.project.name) : preview.project.name}</p><input id="project-deletion-name" type="text" autoComplete="off" spellCheck={false} value={typed} disabled={pending} onChange={(event) => setTyped(event.target.value)} /><p className="hint">{m.exact}</p></div>
    </>}
  </ManagementDialog>}</section>;
};
