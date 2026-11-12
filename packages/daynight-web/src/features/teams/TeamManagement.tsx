import { useTeamForeground } from "./useTeamForeground";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, authRequestsPaused, authRequestsPauseRevision, isAbortError, readAuthRequestGeneration, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { browserNavigation } from "../../app/navigation";
import { createTeam, deleteTeam, getTeam, listTeams, renameTeam, type Team } from "../../api/teams";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "../management/ManagementDialog";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { TaskCacheLifecycleChanged } from "../task-cache/project-cache";
import { TeamIdCopy } from "./TeamIdCopy";

const messages = (zh: boolean) => zh ? {
  create: "创建 Team", name: "Team 名称", edit: "修改", editName: "修改 Team 名称", createHint: "你将成为新 Team 的 Admin。", cancel: "取消", close: "关闭", save: "保存修改", saving: "正在提交", invalid: "请输入有效且不全为空白的名称。", failed: "操作失败，请检查后重试。", unknown: "结果未知。请核对当前状态；无法确认原操作是否成功。", check: "查看当前状态", checking: "正在读取", checkFailed: "无法读取当前状态。", storageError: "无法读取或清除已保存的 Team 选择，请重试。", observed: "当前 Team", more: "加载更多", settings: "团队设置", basic: "基本信息", description: "Team 名称展示在导航和项目归属中。", id: "Team ID", personal: "个人", readOnly: "只有普通 Team 的 admin 可以修改设置。", delete: "删除 Team", deleteHint: "删除前必须转出全部项目。", confirm: "输入 Team 名称确认", mismatch: "输入的 Team 名称不匹配。", conflict: "Team 已变化。请核对当前名称和版本后重新操作。", notEmpty: "Team 仍有项目，请先转出全部项目。", unavailable: "此 Team 不可用或你没有访问权限。", saved: "已保存", retry: "重试", created: "当前可访问的 Team", confirmedCreate: "已创建 Team", idLabel: "请求 ID："
} : {
  create: "Create Team", name: "Team name", edit: "Edit", editName: "Edit Team name", createHint: "You will become an admin of the new Team.", cancel: "Cancel", close: "Close", save: "Save changes", saving: "Submitting", invalid: "Enter a valid name that is not all whitespace.", failed: "The operation failed. Check the details and try again.", unknown: "The result is unknown. Check the current state; it cannot confirm the original operation.", check: "Check current state", checking: "Loading", checkFailed: "Unable to read the current state.", storageError: "Unable to read or clear the saved Team selection. Try again.", observed: "Current Team", more: "Load more", settings: "Team settings", basic: "General", description: "The Team name appears in navigation and project ownership.", id: "Team ID", personal: "Personal", readOnly: "Only an admin of an ordinary Team can change its settings.", delete: "Delete Team", deleteHint: "Move all projects out before deleting this Team.", confirm: "Enter the Team name to confirm", mismatch: "The Team name does not match.", conflict: "The Team changed. Review its current name and version before trying again.", notEmpty: "This Team still has projects. Move them out first.", unavailable: "This Team is unavailable or you do not have access.", saved: "Saved", retry: "Retry", created: "Currently accessible Teams", confirmedCreate: "Created Team", idLabel: "Request ID: "
};
const validName = (value: string) => value.isWellFormed() && !value.includes("\0") && !/^\p{White_Space}*$/u.test(value);
const textValue = (value: string) => value.replace(/\r\n?/g, "\n");
// Team details and the actor's membership have independent versions.
const mergeTeam = (current: Team | null, incoming: Team): Team => {
  if (current === null) return incoming;
  const detail = current.version > incoming.version ? current : incoming;
  const membership = current.membership.version >= incoming.membership.version ? current.membership : incoming.membership;
  return { ...detail, membership };
};
type ReadReason = "initial" | "background" | "reconcile";
type Result = { readonly kind: "rejected" | "unknown"; readonly error: unknown } | null;

// A response lost after dispatch is not safe to repeat, even if a later read matches the intended state.
export const useOperation = (admission: TaskCacheScope) => {
  const active = useRef<AbortController | null>(null);
  const publication = useRef<AbortController | null>(null);
  const retainedPublication = useRef<(() => void) | null>(null);
  const publicationFailed = useRef(false);
  const retryPublicationRef = useRef<(() => void) | null>(null);
  const owner = useRef(admission); owner.current = admission;
  const mounted = useRef(false);
  const previousOwner = useRef(admission);
  const [outcome, setOutcome] = useState<"confirmed" | "unknown" | "rejected" | "cancelled" | null>(null);
  const [pending, setPending] = useState(false);
  const [publicationPending, setPublicationPending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [publicationError, setPublicationError] = useState<{ readonly retryable: boolean } | null>(null);
  const resultRef = useRef<Result>(null);
  useEffect(() => {
    mounted.current = true;
    if (previousOwner.current !== admission) {
      previousOwner.current = admission; active.current = null; publication.current = null;
      resultRef.current = null; setPending(false); setPublicationPending(false); setResult(null); setOutcome(null); setPublicationError(null);
    }
    return () => { mounted.current = false; active.current?.abort(); publication.current?.abort(); retainedPublication.current = null; publicationFailed.current = false; retryPublicationRef.current = null; };
  }, [admission]);
  const run = async <T,>(operation: (signal: AbortSignal, dispatched: () => void) => Promise<T>, success: (value: T) => void, rejected?: (error: unknown) => void) => {
    if (authRequestsPaused() || active.current !== null || publicationFailed.current || resultRef.current?.kind === "unknown") return;
    publication.current?.abort(); publication.current = null; retainedPublication.current = null; retryPublicationRef.current = null; setPublicationPending(false);
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const generation = readAuthRequestGeneration();
    const owns = () => mounted.current && owner.current === admission && !admission.isInvalidated && readAuthRequestGeneration() === generation;
    let sent = false; setPending(true); resultRef.current = null; setResult(null); setOutcome(null); setPublicationError(null);
    // A temporary identity check may cancel preparation, but not a dispatched request.
    const unsubscribe = subscribeAuthPause(() => { if (!sent) controller.abort(); });
    const publish = (callback: () => void) => {
      if (!owns()) return;
      const continuation = new AbortController(); publication.current = continuation; retainedPublication.current = callback; setPublicationPending(true);
      const publicationSignal = AbortSignal.any([continuation.signal, admission.signal]);
      let callbackStarted = false;
      retryPublicationRef.current = () => {
        if (!publicationFailed.current || publication.current !== null || !owns() || continuation.signal.aborted) return;
        setPublicationError({ retryable: false }); publish(callback);
      };
      void (async () => {
        try {
          while (true) {
            await waitForAuthRequests(publicationSignal);
            const pauseRevision = authRequestsPauseRevision();
            try { await admission.ready(publicationSignal); }
            catch (error) {
              if (error instanceof TaskCacheLifecycleChanged && !publicationSignal.aborted && owns() && (authRequestsPaused() || authRequestsPauseRevision() !== pauseRevision)) continue;
              throw error;
            }
            if (!authRequestsPaused()) break;
          }
          if (!publicationSignal.aborted && owns() && publication.current === continuation) {
            callbackStarted = true; callback(); retainedPublication.current = null; retryPublicationRef.current = null; setPublicationPending(false);
            if (publicationFailed.current) { publicationFailed.current = false; setPublicationError(null); }
          }
        } catch (error) {
          if (!publicationSignal.aborted && owns() && publication.current === continuation) {
            publicationFailed.current = true; setPublicationError({ retryable: !callbackStarted });
            if (callbackStarted) retryPublicationRef.current = null;
            console.error("Team operation publication failed", { error_category: error instanceof ApiError ? error.kind : "unexpected" });
          }
        } finally {
          if (publication.current === continuation) {
            publication.current = null;
            if (!publicationFailed.current) { retainedPublication.current = null; if (mounted.current && owner.current === admission) setPublicationPending(false); }
          }
        }
      })();
    };
    try {
      await admission.ready(signal);
      signal.throwIfAborted();
      const value = await operation(signal, () => { sent = true; });
      if (owns() && active.current === controller) { setOutcome("confirmed"); publish(() => success(value)); }
    } catch (error) {
      if (!owns() || active.current !== controller) return;
      const definite = error instanceof ApiError && error.kind === "server" && error.status !== null && error.status < 500 && error.code !== "write_outcome_unknown";
      if (!sent && (signal.aborted || isAbortError(error))) { setOutcome("cancelled"); return; }
      const kind = sent && !definite ? "unknown" : "rejected";
      const localError = error instanceof ApiError && definite
        ? new ApiError(error.kind, error.status, error.code)
        : new Error("Operation result pending admission");
      resultRef.current = { kind, error }; setResult({ kind, error: localError }); setOutcome(kind);
      publish(() => { setResult({ kind, error }); if (kind === "rejected") rejected?.(error); });
    } finally {
      unsubscribe();
      if (active.current === controller) { active.current = null; if (owns()) setPending(false); }
    }
  };
  return { pending, publicationPending, result, outcome, publicationError, retryPublication: () => retryPublicationRef.current?.(), run, publishing: () => publication.current !== null || publicationFailed.current, guarded: () => active.current !== null || publicationFailed.current || resultRef.current?.kind === "unknown", clear: () => { resultRef.current = null; setResult(null); if (!publicationFailed.current && retainedPublication.current === null) { setOutcome(null); setPublicationError(null); } } };
};

export const OperationPublicationError = ({ operation, zh }: { readonly operation: ReturnType<typeof useOperation>; readonly zh: boolean }) => {
  if (operation.publicationError === null) return null;
  const confirmed = operation.outcome === "confirmed";
  return <div className="notice error" role="alert"><p>{confirmed
    ? zh ? "操作已成功，但无法显示其结果。" : "The operation succeeded, but its result could not be displayed."
    : zh ? "无法显示操作结果。" : "The operation's result could not be displayed."}</p>
    {operation.publicationError.retryable && <button className="button" type="button" onClick={operation.retryPublication}>{zh ? "重试显示结果" : "Retry showing result"}</button>}</div>;
};

const ErrorNotice = ({ result, zh }: { readonly result: Result; readonly zh: boolean }) => {
  if (result === null) return null;
  const m = messages(zh), error = result.error;
  const detail = result.kind === "unknown" ? m.unknown : error instanceof ApiError && error.code === "version_conflict" ? m.conflict : error instanceof ApiError && error.code === "team_not_empty" ? m.notEmpty : error instanceof ApiError && (error.code === "forbidden" || error.code === "not_found") ? m.unavailable : m.failed;
  return <div className="notice error" role="alert"><p>{detail}</p>{error instanceof ApiError && error.requestId !== null && <p>{m.idLabel}<code>{error.requestId}</code></p>}</div>;
};

type CommonProps = { readonly admission: TaskCacheScope; readonly onIdentityMismatch: () => void };
export const CreateTeamDialog = ({ admission, onIdentityMismatch, onClose, onCreated, active = true }: CommonProps & { readonly active?: boolean; readonly onClose: () => void; readonly onCreated: (team: Team, finish: boolean) => void }) => {
  const { locale } = useI18n(), zh = locale === "zh-CN", m = messages(zh);
  const [name, setName] = useState(""), [invalid, setInvalid] = useState(false);
  const [confirmed, setConfirmed] = useState<{ team: Team; revision: number } | null>(null);
  const [observed, setObserved] = useState<{ items: readonly Team[]; cursor: string | null; loading: boolean; error: unknown } | null>(null);
  const read = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const op = useOperation(admission);
  useEffect(() => () => read.current?.abort(), []);
  const check = (cursor: string | null) => {
    if (!active || read.current !== null) return;
    const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    setObserved((previous) => ({ items: cursor === null ? [] : previous?.items ?? [], cursor, loading: true, error: null }));
    void (async () => { try {
      await admission.ready(signal); const page = await listTeams(cursor, admission.userId, signal, onIdentityMismatch); await admission.ready(signal);
      if (!signal.aborted) setObserved((previous) => ({ items: cursor === null ? page.items : [...(previous?.items ?? []), ...page.items], cursor: page.nextCursor, loading: false, error: null }));
    } catch (error) { if (!signal.aborted && !admission.isInvalidated) { try { await admission.ready(signal); } catch { return; } if (!signal.aborted && !admission.isInvalidated) setObserved((previous) => ({ items: previous?.items ?? [], cursor, loading: false, error })); } }
    finally { if (read.current === controller) read.current = null; } })();
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!active || confirmed?.revision === revision.current) return; if (!validName(name)) { setInvalid(true); return; } const submitted = revision.current, location = browserNavigation().snapshot(); void op.run((signal, dispatched) => createTeam(admission.userId, name, signal, onIdentityMismatch, dispatched), (team) => { setConfirmed({ team, revision: submitted }); onCreated(team, revision.current === submitted && browserNavigation().snapshot() === location); }); };
  const unknown = op.result?.kind === "unknown";
  return <ManagementDialog title={m.create} busy={op.pending} suspended={!active} onClose={onClose} footer={<><button className="button" type="button" disabled={op.pending} onClick={onClose}>{unknown || confirmed !== null ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={observed?.loading} onClick={() => check(null)}>{m.check}</button> : <button className="button primary" type="submit" form="create-team-form" disabled={op.pending || op.publicationError !== null || confirmed?.revision === revision.current}>{op.pending ? m.saving : m.create}</button>}</>}>
    <form id="create-team-form" onSubmit={submit} noValidate><div className="field"><label htmlFor="create-team-name">{m.name} <span className="required">*</span></label><textarea id="create-team-name" rows={1} value={name} disabled={op.pending || unknown} onChange={(event) => { revision.current++; setName(event.target.value); setInvalid(false); }} /><p className="hint">{m.createHint}</p>{invalid && <p className="hint error" role="alert">{m.invalid}</p>}</div></form>
    <ErrorNotice result={op.result} zh={zh} />
    <OperationPublicationError operation={op} zh={zh} />
    {confirmed !== null && <p role="status">{m.confirmedCreate}: {confirmed.team.name} <code>{confirmed.team.id}</code></p>}
    {observed !== null && <section><h3>{m.created}</h3>{observed.loading ? <p role="status">{m.checking}</p> : observed.error !== null ? <p role="alert">{m.checkFailed}</p> : <ul>{observed.items.map((team) => <li key={team.id}>{team.kind === "personal" ? m.personal : team.name} <code>{team.id}</code></li>)}</ul>}{observed.cursor !== null && !observed.loading && <button className="button" type="button" onClick={() => check(observed.cursor)}>{m.more}</button>}</section>}
  </ManagementDialog>;
};

export const TeamSettingsPanel = ({ teamId, admission, onIdentityMismatch, onUpdated, onDeleted, onUnavailable, onGuardChange, active = true, admissionBlocked = false, preferenceDenied = false, confirmedTeam = null }: CommonProps & { readonly teamId: string; readonly active?: boolean; readonly admissionBlocked?: boolean; readonly preferenceDenied?: boolean; readonly confirmedTeam?: Team | null; readonly onUpdated: (team: Team) => void; readonly onDeleted: (finish: boolean) => void; readonly onUnavailable?: () => "forgotten" | "changed" | "storage_error"; readonly onGuardChange?: (guarded: boolean) => void }) => {
  const { locale, messages: { auth: { roles } } } = useI18n(), zh = locale === "zh-CN", m = messages(zh);
  const renameFormId = useId(), nameId = useId(), deleteFormId = useId(), deleteNameId = useId();
  const [team, setTeam] = useState<Team | null>(null), [draft, setDraft] = useState(""), [edited, setEdited] = useState(false), [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true), [readError, setReadError] = useState<unknown>(null), [accessDenied, setAccessDenied] = useState(false), [storageError, setStorageError] = useState(false), [saved, setSaved] = useState(false), [changed, setChanged] = useState(false);
  const latestTeam = useRef<Team | null>(null);
  if (latestTeam.current !== null && confirmedTeam?.id === teamId) latestTeam.current = mergeTeam(latestTeam.current, confirmedTeam);
  // Display survives identity checks; writes still require a fresh Team read.
  const fresh = useRef(false), reconcileActive = useRef(false);
  const [reconciling, setReconciling] = useState(false);
  if (!active || admissionBlocked) fresh.current = false;
  const [deleting, setDeleting] = useState(false), [renaming, setRenaming] = useState(false), [typed, setTyped] = useState(""), [mismatch, setMismatch] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const renameOpen = useRef(false); renameOpen.current = renaming;
  const renameRevision = useRef(0), deleteRevision = useRef(0);
  const read = useRef<AbortController | null>(null), op = useOperation(admission);
  const operation = useRef(op); operation.current = op;
  const guardCallback = useRef(onGuardChange); guardCallback.current = onGuardChange;
  const guarded = useRef(false);
  const setGuard = (value: boolean) => { if (guarded.current !== value) { guarded.current = value; guardCallback.current?.(value); } };
  useEffect(() => { setGuard(op.pending || op.publicationPending || op.result?.kind === "unknown" || op.publicationError !== null); }, [op.pending, op.publicationPending, op.result, op.publicationError]);
  useEffect(() => () => { if (guarded.current) { guarded.current = false; guardCallback.current?.(false); } }, []);
  const callbacks = useRef({ onUnavailable, onUpdated, onDeleted }); callbacks.current = { onUnavailable, onUpdated, onDeleted };
  const activeRef = useRef(active); activeRef.current = active;
  const deleteButton = useRef<HTMLButtonElement>(null), editButton = useRef<HTMLButtonElement>(null), heading = useRef<HTMLDivElement>(null), restoreFocus = useRef(false), restoreEditFocus = useRef(false);
  useLayoutEffect(() => {
    if (team === null || confirmedTeam?.id !== teamId || confirmedTeam.version <= team.version && confirmedTeam.membership.version <= team.membership.version) return;
    const merged = mergeTeam(team, confirmedTeam);
    setTeam(merged);
    if (team.version !== merged.version) {
      if (!renameOpen.current) { setDraft(merged.name ?? ""); setEdited(false); }
      setChanged(true); deleteRevision.current++; setTyped(""); setSaved(false);
    }
  }, [team, confirmedTeam, teamId]);
  useLayoutEffect(() => {
    if (active && !deleting && restoreFocus.current) {
      restoreFocus.current = false;
      queueMicrotask(() => { const target = deleteButton.current; if (target?.isConnected && !target.disabled) target.focus(); else if (heading.current?.isConnected) heading.current.focus(); });
    }
  }, [active, deleting]);
  useLayoutEffect(() => {
    if (active && !renaming && restoreEditFocus.current) {
      restoreEditFocus.current = false;
      queueMicrotask(() => { const target = editButton.current; if (target?.isConnected && !target.disabled) target.focus(); else if (heading.current?.isConnected) heading.current.focus(); });
    }
  }, [active, renaming]);
  const closeDelete = () => { deleteRevision.current++; restoreFocus.current = activeRef.current; setDeleting(false); };
  const closeRename = () => { renameRevision.current++; restoreEditFocus.current = activeRef.current; setRenaming(false); };
  const load = useCallback(async (reason: ReadReason, resetDraft = false): Promise<Team | null> => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    fresh.current = false;
    reconcileActive.current = reason === "reconcile"; setReconciling(reconcileActive.current);
    if (latestTeam.current === null) setLoading(true);
    setReadError(null); setStorageError(false);
    try {
      await admission.ready(signal); const value = await getTeam(teamId, admission.userId, signal, onIdentityMismatch); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return null;
      const merged = mergeTeam(latestTeam.current, value);
      const changedVersion = latestTeam.current !== null && latestTeam.current.version !== merged.version;
      latestTeam.current = merged; fresh.current = true; setAccessDenied(false); setTeam(merged);
      if ((resetDraft || changedVersion) && !renameOpen.current) { setDraft(merged.name ?? ""); setEdited(false); }
      if (changedVersion) { setChanged(true); deleteRevision.current++; setTyped(""); setSaved(false); }
      return merged;
    } catch (error) { if (!signal.aborted && !admission.isInvalidated) {
      try { await admission.ready(signal); } catch { return null; }
      if (signal.aborted || admission.isInvalidated) return null;
      const denied = error instanceof ApiError && error.kind === "server" && ((error.status === 403 && error.code === "forbidden") || (error.status === 404 && error.code === "not_found"));
      if (denied) setAccessDenied(true);
      const unavailableResult = denied && error.status === 404 && !operation.current.guarded() ? callbacks.current.onUnavailable?.() : undefined;
      if (unavailableResult !== "forgotten") { setStorageError(unavailableResult === "storage_error"); setReadError(error); }
    } return null; }
    finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) { reconcileActive.current = false; setLoading(false); setReconciling(false); } } }
  }, [admission, teamId, onIdentityMismatch]);
  useEffect(() => {
    if (!active || admissionBlocked) return;
    const initial = latestTeam.current === null;
    void load(initial ? "initial" : "background", initial);
    return () => read.current?.abort();
  }, [load, active, admissionBlocked]);
  useTeamForeground(active && !admissionBlocked, () => { void load("background"); });
  const editable = team?.kind === "ordinary" && team.membership.role === "admin";
  const unknown = op.result?.kind === "unknown";
  const unavailable = accessDenied || preferenceDenied;
  const openRename = () => {
    if (!active || !team || !editable || loading || op.pending || unknown || readError !== null || op.guarded()) return;
    renameRevision.current++; setDraft(team.name ?? ""); setEdited(false); setInvalid(false); setSaved(false); op.clear(); setRenaming(true);
  };
  const conflict = (error: unknown) => { if (error instanceof ApiError && (error.code === "version_conflict" || error.code === "forbidden" || error.code === "not_found")) { deleteRevision.current++; setTyped(""); if (activeRef.current) void load("reconcile", true); } };
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!active || preferenceDenied || authRequestsPaused() || op.guarded() || !fresh.current || !renaming || !team || !editable || loading || readError !== null || !edited || unknown) return;
    if (!validName(draft)) { setInvalid(true); return; }
    setSaved(false);
    setGuard(true);
    const submitted = renameRevision.current, location = browserNavigation().snapshot();
    void op.run((signal, dispatched) => renameTeam(admission.userId, team, draft, signal, onIdentityMismatch, dispatched), (value) => { const merged = mergeTeam(latestTeam.current, value); latestTeam.current = merged; setTeam(merged); if (renameRevision.current === submitted && browserNavigation().snapshot() === location) { setDraft(merged.name ?? ""); setEdited(false); setChanged(false); setSaved(true); closeRename(); } callbacks.current.onUpdated(merged); }, conflict);
  };
  const openDelete = () => { if (!active || !editable || deleted || loading || reconcileActive.current || op.pending || unknown) return; void (async () => { const latest = await load("reconcile"); if (latest?.kind === "ordinary" && latest.membership.role === "admin") { deleteRevision.current++; setTyped(""); setMismatch(false); op.clear(); setDeleting(true); } })(); };
  const remove = (event: FormEvent) => {
    event.preventDefault(); if (!active || deleted || preferenceDenied || authRequestsPaused() || op.guarded() || !fresh.current || !team || !editable || loading || readError !== null || unknown) return;
    if (typed !== textValue(team.name!)) { setMismatch(true); return; }
    setGuard(true);
    const submitted = deleteRevision.current, location = browserNavigation().snapshot();
    void op.run((signal, dispatched) => deleteTeam(admission.userId, team, signal, onIdentityMismatch, dispatched), () => { setDeleted(true); callbacks.current.onDeleted(deleteRevision.current === submitted && browserNavigation().snapshot() === location); }, conflict);
  };
  return <div ref={heading} tabIndex={-1}>
    {loading && <div className="empty-inline" role="status">{m.checking}</div>}
    {readError !== null && <div className="notice error" role="alert"><p>{storageError ? m.storageError : readError instanceof ApiError && readError.kind === "server" && (readError.code === "not_found" || readError.code === "forbidden") ? m.unavailable : m.checkFailed}</p>{readError instanceof ApiError && readError.requestId !== null && <p>{m.idLabel}<code>{readError.requestId}</code></p>}<button type="button" className="button" onClick={() => { void load("reconcile", true); }}>{m.retry}</button></div>}
    {!deleting && !renaming && changed && <div className="notice warning" role="alert">{m.conflict}</div>}
    {unavailable && op.pending && <div role="status">{m.saving}</div>}
    {unavailable && saved && <p role="status">{m.saved}</p>}
    {(!deleting && !renaming || unavailable) && <><ErrorNotice result={op.result} zh={zh} /><OperationPublicationError operation={op} zh={zh} /></>}
    {!deleting && !renaming && unknown && <button className="button" type="button" disabled={loading || reconciling} onClick={() => { void load("reconcile", true); }}>{m.check}</button>}
    {team !== null && !unavailable && <div className="team-settings-page"><section className="panel"><header className="panel-heading"><div><h2>{m.basic}</h2><p>{m.description}</p></div><span className="badge">{roles[team.membership.role]}</span></header>
      <div className="panel-body settings-form"><dl className="team-settings-details"><div><dt>{m.name}</dt><dd className="team-settings-name"><span>{team.kind === "personal" ? m.personal : team.name}</span>{editable && <button ref={editButton} className="button" type="button" disabled={loading || op.pending || unknown || op.publicationError !== null || readError !== null} onClick={openRename}>{m.edit}</button>}</dd></div>
        <div><dt>{m.id}</dt><dd>{team.id === teamId ? <TeamIdCopy key={`${admission.userId}/${team.id}`} value={team.id} admission={admission} active={active} zh={zh} /> : null}</dd></div></dl>
        {!editable && <p className="settings-lock">{m.readOnly}</p>}{saved && <p role="status">{m.saved}</p>}
      </div></section><section className="panel danger-zone"><header className="panel-heading"><div><h2>{m.delete}</h2><p>{m.deleteHint}</p></div></header><div className="panel-body"><button ref={deleteButton} className="button danger" type="button" disabled={!editable || deleted || loading || reconciling || op.pending || unknown || op.publicationError !== null || readError !== null} onClick={openDelete}>{m.delete}</button></div></section></div>}
    {renaming && team !== null && <ManagementDialog title={m.editName} busy={op.pending} suspended={!active || unavailable} onClose={closeRename} footer={<><button className="button" type="button" disabled={op.pending} onClick={closeRename}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading || reconciling} onClick={() => { void load("reconcile", true); }}>{m.check}</button> : <button className="button primary" type="submit" form={renameFormId} disabled={op.pending || op.publicationError !== null || loading || reconciling || readError !== null || !editable || !edited}>{op.pending ? m.saving : m.save}</button>}</>}>
      <form id={renameFormId} onSubmit={save} noValidate><div className="field"><label htmlFor={nameId}>{m.name}</label><textarea id={nameId} rows={1} value={draft} disabled={loading || op.pending || unknown || readError !== null || !editable} onChange={(event) => { renameRevision.current++; setDraft(event.target.value); setEdited(true); setInvalid(false); setSaved(false); setChanged(false); }} />{invalid && <p className="hint error" role="alert">{m.invalid}</p>}</div></form>
      <ErrorNotice result={op.result} zh={zh} /><OperationPublicationError operation={op} zh={zh} />{changed && <div className="notice warning" role="alert"><p>{m.conflict}</p><p className="team-settings-current">{m.observed}: <strong>{team.name}</strong></p></div>}{readError !== null && <div role="alert"><p>{storageError ? m.storageError : readError instanceof ApiError && readError.kind === "server" && (readError.code === "not_found" || readError.code === "forbidden") ? m.unavailable : m.checkFailed}</p>{readError instanceof ApiError && readError.requestId !== null && <p>{m.idLabel}<code>{readError.requestId}</code></p>}<button type="button" className="button" onClick={() => { void load("reconcile"); }}>{m.retry}</button></div>}
    </ManagementDialog>}
    {deleting && team !== null && <ManagementDialog title={m.delete} busy={op.pending} suspended={!active || unavailable} onClose={closeDelete} footer={<><button className="button" type="button" disabled={op.pending} onClick={closeDelete}>{unknown || deleted ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={loading || reconciling} onClick={() => { void load("reconcile"); }}>{m.check}</button> : <button className="button danger" type="submit" form={deleteFormId} disabled={deleted || op.pending || op.publicationError !== null || loading || reconciling || readError !== null || !editable}>{op.pending ? m.saving : m.delete}</button>}</>}>
      <p>{m.deleteHint}</p><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>{team.name}</strong></p><form id={deleteFormId} onSubmit={remove} noValidate><div className="field"><label htmlFor={deleteNameId}>{m.confirm}</label><textarea id={deleteNameId} rows={1} value={typed} disabled={op.pending || unknown || loading} onChange={(event) => { deleteRevision.current++; setTyped(event.target.value); setMismatch(false); }} onPaste={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()} autoComplete="off" />{mismatch && <p className="hint error" role="alert">{m.mismatch}</p>}</div></form>
      {deleted && <p role="status">{zh ? "已删除 Team" : "Team deleted"}</p>}<ErrorNotice result={op.result} zh={zh} /><OperationPublicationError operation={op} zh={zh} />{changed && <div className="notice warning" role="alert">{m.conflict}</div>}{readError !== null && <div role="alert"><p>{storageError ? m.storageError : readError instanceof ApiError && readError.kind === "server" && (readError.code === "not_found" || readError.code === "forbidden") ? m.unavailable : m.checkFailed}</p>{readError instanceof ApiError && readError.requestId !== null && <p>{m.idLabel}<code>{readError.requestId}</code></p>}</div>}
    </ManagementDialog>}
  </div>;
};
