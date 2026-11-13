import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, authRequestsPaused, authRequestsPauseRevision, isAbortError, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { canonicalId } from "../../api/validation";
import { previewProjectTransfer, transferProject, type ProjectTransferPreview, type ProjectTransferReceipt } from "../../api/project-transfer";
import type { TeamRef } from "../../api/auth-types";
import { useI18n } from "../../i18n/LocaleProvider";
import { browserNavigation } from "../../app/navigation";
import { useProjectAccess } from "../projects/ProjectAccess";
import { useTeams } from "../teams/TeamsProvider";
import { OperationPublicationError, useOperation } from "../teams/TeamManagement";
import { ManagementDialog } from "./ManagementDialog";
import type { TransferNavigationContext } from "./transfer-navigation";
import type { ProjectManagementGuard } from "./ProjectManagementGuard";
import { TaskCacheLifecycleChanged } from "../task-cache/project-cache";

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
    {teams.list.status === "ready" && teams.list.error !== null && <p role="alert">{m.noTeams} <button type="button" onClick={teams.revalidateList}>{m.retry}</button></p>}
    {teams.list.cursor !== null && <button className="button" type="button" disabled={disabled || teams.list.more} onClick={teams.loadMore}>{teams.list.more ? m.loading : teams.list.moreError !== null ? m.retry : m.more}</button>}
  </div>;
};

export const ProjectOwnership = ({ projectId, projectName, onTransferred, active, onRoute = true, unavailable = false, onRetentionChange, onStateChange, presentationGeneration, guard }: { readonly projectId: string; readonly projectName: string | null; readonly onTransferred?: ((receipt: ProjectTransferReceipt, context: TransferNavigationContext) => void) | undefined; readonly active: boolean; readonly onRoute?: boolean; readonly unavailable?: boolean; readonly onRetentionChange?: ((retain: boolean) => void) | undefined; readonly guard?: ProjectManagementGuard | undefined; readonly onStateChange?: ((state: { dirty: boolean; pending: boolean; needsAttention: boolean }) => void) | undefined; readonly presentationGeneration?: number | undefined }) => {
  const access = useProjectAccess(projectId), scope = access.session.scope;
  const { locale, messages: { auth: { roles } } } = useI18n(), m = messages(locale === "zh-CN");
  const op = useOperation(scope);
  const operation = useRef(op); operation.current = op;
  const [subject, setSubject] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false), [target, setTarget] = useState(""), [preview, setPreview] = useState<ProjectTransferPreview | null>(null);
  const current = useRef({ active, onRoute, dialog, target, preview, presentationGeneration }); current.current = { active, onRoute, dialog, target, preview, presentationGeneration };
  const editor = useRef(0), revision = useRef(0), mounted = useRef(false);
  const revokingEditor = useRef<{ editor: number; revision: number; generation: string } | null>(null);
  const preserveRevokedDraft = useRef(false), retainedPresentation = useRef(false);
  const gate = useRef<AbortController | null>(null);
  const cleanupController = useRef<AbortController | null>(null);
  const cleanupInFlight = useRef(false);
  const transferOwner = useRef<symbol | null>(null);
  const releaseTransfer = (owner: symbol) => {
    if (transferOwner.current !== owner) return;
    transferOwner.current = null; guard?.release("transfer");
  };
  const [waiting, setWaiting] = useState(false);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState<unknown>(null), [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false);
  const [observed, setObserved] = useState(false), [cleanupError, setCleanupError] = useState<unknown>(null);
  const [cleanupPaused, setCleanupPaused] = useState(false);
  const read = useRef<AbortController | null>(null), cleanup = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => subscribeAuthPause(() => { if (cleanup.current !== null) setCleanupPaused(true); }), []);
  const retirePrivatePreview = (preserveDraft = false) => {
    read.current?.abort(); read.current = null; gate.current?.abort();
    setSubject(null);
    if (!preserveDraft) setTarget("");
    setPreview(null); setReading(false);
    setReadError(null); setInvalid(false); setConflict(false); setObserved(false);
    if (!preserveDraft && !operation.current.guarded() && !operation.current.publishing() && operation.current.result === null && cleanup.current === null) {
      setDialog(false);
      if (retainedPresentation.current) { retainedPresentation.current = false; onRetentionChange?.(false); }
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; read.current?.abort(); gate.current?.abort(); cleanupController.current?.abort();
      const owner = transferOwner.current; if (owner !== null) releaseTransfer(owner);
    };
  }, [scope, projectId, guard]);
  useEffect(() => { if (!onRoute) { read.current?.abort(); gate.current?.abort(); } }, [onRoute]);
  useEffect(() => scope.subscribe((event) => {
    if (event.projectId === projectId && event.accessRevoked) {
      const original = revokingEditor.current;
      preserveRevokedDraft.current = original !== null && event.revokedGeneration === original.generation && (original.editor !== editor.current || original.revision !== revision.current);
      retirePrivatePreview(preserveRevokedDraft.current);
    }
  }), [scope, projectId]);
  useEffect(() => { if (unavailable) retirePrivatePreview(preserveRevokedDraft.current); else preserveRevokedDraft.current = false; }, [unavailable]);
  const unknown = op.result?.kind === "unknown";
  const open = () => { if (!active) return; preserveRevokedDraft.current = false; editor.current++; revision.current++; setSubject(projectName); setDialog(true); setTarget(""); setPreview(null); setReadError(null); setInvalid(false); setConflict(false); setObserved(false); op.clear(); void access.session.revalidate(); };
  const close = () => { if (!op.pending && gate.current === null && (cleanup.current === null || cleanupPaused)) { read.current?.abort(); read.current = null; setReading(false); editor.current++; setDialog(false); if (op.result?.kind !== "unknown") { if (op.result?.kind === "rejected") op.clear(); retainedPresentation.current = cleanup.current !== null || op.publishing(); if (!retainedPresentation.current) onRetentionChange?.(false); } } };
  const change = (value: string) => { revision.current++; read.current?.abort(); read.current = null; setReading(false); setTarget(value); setPreview(null); setInvalid(false); setReadError(null); setConflict(false); };
  const inspect = async () => {
    if (!active || op.guarded()) return;
    op.clear(); if (cleanup.current === null && !op.publishing() && !retainedPresentation.current) onRetentionChange?.(false);
    const id = parseTransferTarget(target, window.location.origin);
    if (id === null) { setInvalid(true); setPreview(null); return; }
    if (id === access.access?.ownership.teamId) { setInvalid(true); setPreview(null); return; }
    const originalOwnership = access.session.snapshot().access?.ownership;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]); setReading(true); setReadError(null); setPreview(null); setInvalid(false);
    try {
      await access.session.revalidate();
      const fresh = await access.session.waitForFreshAccess(signal, true);
      if (signal.aborted || !current.current.active || !current.current.dialog || current.current.target !== target || fresh === null || !fresh.canTransfer) return;
      if (originalOwnership === undefined || fresh.ownership.teamId !== originalOwnership.teamId || fresh.ownership.version !== originalOwnership.version) { setConflict(true); return; }
      const value = await previewProjectTransfer(projectId, id, scope.userId, signal, scope.principalMismatch);
      await scope.ready(signal);
      if (signal.aborted || scope.isInvalidated) return;
      await access.session.waitForFreshAccess(signal);
      const latest = access.session.snapshot();
      if (signal.aborted || scope.isInvalidated || latest.status !== "ready" || latest.refreshing || !latest.access?.canTransfer) return;
      if (value.ownership.teamId !== latest.access.ownership.teamId || value.ownership.version !== latest.access.ownership.version) { setConflict(true); return; }
      setPreview(value); setConflict(false);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      try { await scope.ready(signal); } catch { return; }
      if (!signal.aborted && !scope.isInvalidated) { setReadError(error); if (error instanceof ApiError && (error.status === 403 || error.status === 404)) void access.session.revalidate(); }
    }
    finally { if (read.current === controller) { read.current = null; if (!signal.aborted) setReading(false); } }
  };
  const submit = () => {
    const snapshot = access.session.snapshot();
    if (!active || gate.current !== null || cleanup.current !== null || op.guarded() || preview === null || reading || snapshot.status !== "ready" || !snapshot.access?.canTransfer || snapshot.access.ownership.teamId !== preview.ownership.teamId || snapshot.access.ownership.version !== preview.ownership.version) return;
    if (guard !== undefined && !guard.tryAcquire("transfer")) return;
    const transfer = Symbol(); transferOwner.current = transfer;
    const selected = preview, originalTarget = target, originalEditor = editor.current, originalRevision = revision.current, originalPresentation = presentationGeneration;
    const navigation = browserNavigation(), location = navigation.snapshot();
    const submissionLocation = location.pathname === `/projects/${projectId}/settings` &&
      location.pathname + location.search + location.hash === window.location.pathname + window.location.search + window.location.hash ? location : null;
    const ownsEditor = () => mounted.current && editor.current === originalEditor && revision.current === originalRevision && current.current.presentationGeneration === originalPresentation;
    const ownsPresentation = () => ownsEditor() && current.current.dialog && submissionLocation !== null && navigation.snapshot() === submissionLocation &&
      window.location.pathname + window.location.search + window.location.hash === submissionLocation.pathname + submissionLocation.search + submissionLocation.hash;
    const finishPresentation = (withdrawn = false) => {
      const closeOriginal = ownsPresentation();
      const closedOriginal = !current.current.dialog && editor.current === originalEditor + 1;
      const release = closeOriginal || withdrawn && ownsEditor() || closedOriginal;
      retainedPresentation.current = !release;
      if (closeOriginal) setDialog(false);
      return release;
    };
    const controller = new AbortController(); gate.current = controller; setWaiting(true);
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const stillCurrent = (fresh: typeof access.access) => !signal.aborted && !scope.isInvalidated && current.current.active && current.current.onRoute && current.current.dialog && current.current.preview === selected && current.current.target === originalTarget && fresh?.canTransfer === true && fresh.ownership.teamId === selected.ownership.teamId && fresh.ownership.version === selected.ownership.version;
    // Observe the access session without awaiting its shared read, which may
    // outlive this transfer's cancelled preparation.
    const readyForTransfer = async (target: AbortSignal) => {
      while (true) {
        await waitForAuthRequests(target);
        const pauseRevision = authRequestsPauseRevision();
        try { await scope.ready(target); }
        catch (error) {
          if (error instanceof TaskCacheLifecycleChanged && !target.aborted && !scope.isInvalidated && (authRequestsPaused() || authRequestsPauseRevision() !== pauseRevision)) continue;
          throw error;
        }
        target.throwIfAborted();
        if (!authRequestsPaused()) return;
      }
    };
    const waitForAccess = async (target: AbortSignal) => {
      while (true) {
        await readyForTransfer(target);
        target.throwIfAborted();
        const snapshot = access.session.snapshot();
        if (!snapshot.refreshing) return snapshot.status === "ready" ? snapshot.access : null;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { unsubscribe(); target.removeEventListener("abort", abort); };
          const resume = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(target.reason); };
          const unsubscribe = access.session.subscribe(resume);
          target.addEventListener("abort", abort, { once: true });
          if (target.aborted) abort(); else if (!access.session.snapshot().refreshing) resume();
        });
      }
    };
    const waitForRead = <T,>(read: Promise<T>, target: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { target.removeEventListener("abort", abort); reject(target.reason); };
      read.then((value) => { target.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => { target.removeEventListener("abort", abort); reject(error); });
      if (target.aborted) abort(); else target.addEventListener("abort", abort, { once: true });
    });
    let started = false, dispatched = false;
    const cancelPreparation = () => { if (!dispatched) controller.abort(); };
    const unsubscribePause = subscribeAuthPause(cancelPreparation);
    if (authRequestsPaused()) cancelPreparation();
    onRetentionChange?.(true);
    void (async () => { try {
      const fresh = await waitForAccess(signal);
      if (!stillCurrent(fresh)) {
        if (!signal.aborted && !scope.isInvalidated && current.current.active && current.current.dialog && current.current.preview === selected) {
          if (fresh !== null && (fresh.ownership.teamId !== selected.ownership.teamId || fresh.ownership.version !== selected.ownership.version)) setConflict(true);
          else setReadError(new Error("Project transfer authorization changed"));
        }
        return;
      }
      started = true;
      await op.run(async (signal, dispatchedCallback) => {
      const ticket = await waitForRead(scope.beginSync(projectId, signal), signal);
      const fresh = await waitForAccess(signal);
      if (signal.aborted || !stillCurrent(fresh)) throw new Error("Project transfer authorization changed");
      const receipt = await transferProject(projectId, selected, scope.userId, signal, scope.principalMismatch, () => { dispatched = true; dispatchedCallback(); });
      return { receipt, ticket };
    }, ({ receipt, ticket }) => {
      const cleanupOwner = new AbortController(); cleanupController.current = cleanupOwner;
      const cleanupSignal = AbortSignal.any([cleanupOwner.signal, scope.signal]);
      const cleanupReady = async () => {
        await readyForTransfer(cleanupSignal);
        cleanupSignal.throwIfAborted();
        if (mounted.current) setCleanupPaused(false);
      };
      const finish = async () => {
        if (cleanupInFlight.current) return;
        cleanupInFlight.current = true;
        let withdrawn = false;
        setCleanupError(null);
        try {
          await cleanupReady();
          if (receipt.actorAccess === null) {
            revokingEditor.current = { editor: originalEditor, revision: originalRevision, generation: ticket.cacheGeneration };
            let revoked: boolean;
            try { revoked = await scope.revokeProject(ticket, cleanupSignal); }
            finally { revokingEditor.current = null; }
            withdrawn = revoked;
            await cleanupReady();
            if (!revoked) {
              await waitForRead(access.session.revalidateAfterMutation(), cleanupSignal);
              const latest = await waitForAccess(cleanupSignal);
              if (latest === null && access.session.snapshot().status !== "unavailable") throw new Error("Unable to verify current project access");
              if (latest !== null) { await cleanupReady(); if (cleanupSignal.aborted || scope.isInvalidated) return; const closed = finishPresentation(); onTransferred?.(receipt, { location: submissionLocation, ownsEditor }); cleanup.current = null; releaseTransfer(transfer); if (mounted.current && closed) onRetentionChange?.(false); return; }
            }
          }
          await cleanupReady();
          if (receipt.actorAccess === null) { access.session.publishMutation(null); withdrawn = true; }
          else {
            await waitForRead(access.session.revalidateAfterMutation(), cleanupSignal);
            const latest = await waitForAccess(cleanupSignal);
            if (latest === null && access.session.snapshot().status !== "unavailable") throw new Error("Unable to verify current project access");
          }
          await cleanupReady();
          if (cleanupSignal.aborted || scope.isInvalidated) return;
          const closed = finishPresentation(withdrawn); onTransferred?.(receipt, { location: submissionLocation, ownsEditor }); cleanup.current = null; releaseTransfer(transfer); if (mounted.current && closed) onRetentionChange?.(false);
        } catch (error) {
          if (cleanupSignal.aborted) return;
          if (!scope.isInvalidated) setCleanupError(error);
        } finally { cleanupInFlight.current = false; }
      };
      cleanup.current = finish; void finish();
    }, (error) => {
      releaseTransfer(transfer);
      if (error instanceof ApiError && (error.code === "version_conflict" || error.status === 403 || error.status === 404)) { setPreview(null); setConflict(error.code === "version_conflict"); void access.session.revalidate(); }
      });
    } catch (error) { if (!signal.aborted && !scope.isInvalidated && !isAbortError(error)) setReadError(error); } finally { unsubscribePause(); if (!started || !op.guarded() && !op.publishing() && cleanup.current === null) { releaseTransfer(transfer); if (!dispatched && mounted.current && !retainedPresentation.current) onRetentionChange?.(false); } if (gate.current === controller) { gate.current = null; if (mounted.current) setWaiting(false); } } })();
  };
  const check = () => { setObserved(false); setReading(true); void access.session.revalidateAfterMutation().then(() => setObserved(true)).finally(() => setReading(false)); };
  const describeError = (error: unknown) => access.status === "unavailable" ? m.sourceMissing : access.status === "error" && access.error instanceof ApiError && access.error.kind === "network" ? m.network : access.ready && !access.access?.canTransfer ? m.sourceDenied : error instanceof ApiError && error.kind === "network" ? m.network : error instanceof ApiError && error.status === 404 ? m.targetMissing : m.failed;
  const privateAvailable = !unavailable && !scope.isInvalidated && !scope.isProjectSuspended(projectId) && access.status !== "unavailable";
  const owner = privateAvailable ? access.access?.ownerTeam : undefined;
  // Operation results and confirmed cleanup failures remain actionable without
  // showing the Project or Team data that a revocation has withdrawn.
  const safeResult = !scope.isInvalidated && (op.result !== null || cleanupError !== null);
  const cleanupBusy = cleanup.current !== null && cleanupError === null && !cleanupPaused;
  const changedOwner = preview !== null && access.ready && (access.access!.ownership.teamId !== preview.ownership.teamId || access.access!.ownership.version !== preview.ownership.version);
  const dirty = dialog && target.trim() !== "" && !unknown && cleanup.current === null;
  const pending = op.pending || op.publicationPending || waiting || cleanupBusy;
  const needsAttention = readError !== null || invalid || conflict || changedOwner || op.result !== null || op.publicationError !== null || cleanupError !== null || cleanupPaused;
  useLayoutEffect(() => { onStateChange?.({ dirty, pending, needsAttention }); }, [dirty, pending, needsAttention, onStateChange]);
  return <>
    {!dialog && <OperationPublicationError operation={op} zh={locale === "zh-CN"} />}
    {!dialog && !scope.isInvalidated && cleanupError !== null && <div className="notice error" role="alert"><p>{m.cleanup}</p><button className="button" type="button" onClick={() => { void cleanup.current?.(); }}>{m.retry}</button></div>}
    {owner && <section className="panel project-ownership-panel" aria-labelledby="project-ownership-title"><div className="panel-heading"><div><h2 id="project-ownership-title">{m.title}</h2><p>{m.description}</p></div></div><div className="panel-body"><p><strong>{teamName(owner, m.personal)}</strong> <code>{owner.id}</code></p>{access.access?.canTransfer ? <button className="button" type="button" disabled={access.status !== "ready" || unknown || (op.pending || waiting)} onClick={open}>{m.transfer}</button> : <p className="hint">{m.restricted}</p>}</div></section>}
    {!scope.isInvalidated && unknown && !dialog && <div className="notice warning" role="alert"><p>{m.unknown}</p><button className="button" type="button" onClick={() => setDialog(true)}>{m.check}</button></div>}
    {dialog && <ManagementDialog title={m.transfer} suspended={!active || scope.isInvalidated || !privateAvailable && !safeResult} busy={(op.pending || waiting) || cleanupBusy} onClose={close} footer={<><button className="button" type="button" disabled={(op.pending || waiting) || cleanupBusy} onClick={close}>{unknown ? m.close : m.cancel}</button>{cleanupError !== null ? <button className="button primary" type="button" onClick={() => { void cleanup.current?.(); }}>{m.retry}</button> : unknown ? <button className="button" type="button" disabled={reading} onClick={check}>{m.check}</button> : <button className="button danger" type="button" disabled={(op.pending || waiting) || cleanup.current !== null || op.publicationError !== null || reading || preview === null || guard?.isBlocked("transfer") || access.status !== "ready" || !access.access?.canTransfer || access.access.ownership.teamId !== preview.ownership.teamId || access.access.ownership.version !== preview.ownership.version} onClick={submit}>{(op.pending || waiting) ? m.busy : m.confirm}</button>}</>}>
      <OperationPublicationError operation={op} zh={locale === "zh-CN"} />
      {privateAvailable && !unknown && cleanupError === null && <>{subject !== null && <p><strong style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{subject}</strong></p>}<div className="field"><label htmlFor="transfer-target">{m.target}</label><input id="transfer-target" value={target} disabled={(op.pending || waiting)} onChange={(event) => change(event.target.value)} autoComplete="off" /><p className="hint">{m.hint}</p>{invalid && <p className="hint error" role="alert">{parseTransferTarget(target, window.location.origin) === access.access?.ownership.teamId ? m.same : m.invalid}</p>}</div><TeamChoices value={target} onChange={change} disabled={(op.pending || waiting)} /><button className="button" type="button" disabled={(op.pending || waiting) || reading || access.status !== "ready" || !access.access?.canTransfer} onClick={() => { void inspect(); }}>{reading ? m.loading : m.preview}</button>{preview && <div><h3>{m.changes}</h3><p><strong>{teamName(preview.sourceTeam, m.personal)}</strong> <code>{preview.sourceTeam.id}</code> → <strong>{teamName(preview.targetTeam, m.personal)}</strong> <code>{preview.targetTeam.id}</code></p><p>{m.grants}</p><p>{preview.actorRole === null ? m.noAccess : `${m.role}: ${roles[preview.actorRole]}`}</p></div>}{(conflict || changedOwner) && <p className="notice warning" role="alert">{m.conflict}</p>}{readError !== null && <p className="notice error" role="alert">{describeError(readError)} {readError instanceof ApiError && readError.requestId && <>{m.requestId}<code>{readError.requestId}</code></>}</p>}</>}
      {op.result !== null && <div className="notice error" role="alert"><p>{unknown ? m.unknown : conflict ? m.conflict : describeError(op.result.error)}</p>{op.result.error instanceof ApiError && op.result.error.requestId && <p>{m.requestId}<code>{op.result.error.requestId}</code></p>}</div>}
      {unknown && observed && <p>{privateAvailable && access.access ? <>{m.current}: {teamName(access.access.ownerTeam, m.personal)} <code>{access.access.ownerTeam.id}</code></> : !privateAvailable ? m.unavailable : m.failed}</p>}
      {cleanupError !== null && <p className="notice error" role="alert">{m.cleanup}</p>}
    </ManagementDialog>}
  </>;
};
