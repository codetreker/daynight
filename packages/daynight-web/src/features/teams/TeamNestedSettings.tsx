import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, authRequestsPaused, readAuthRequestGeneration } from "../../api/client";
import { getTeamSettings, saveTeamSettings, type TeamSettings } from "../../api/team-settings";
import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useTeamForeground } from "./useTeamForeground";
import { OperationPublicationError, type useOperation } from "./TeamManagement";

type Props = {
  readonly teamId: string;
  readonly admission: TaskCacheScope;
  readonly active: boolean;
  readonly blocked: boolean;
  readonly denied?: boolean;
  readonly editable: boolean;
  readonly onIdentityMismatch: () => void;
  readonly onDenied: () => void;
  readonly onWrite: () => void;
  readonly onSaved: () => void;
  readonly onReconciled?: () => void;
  readonly operation: ReturnType<typeof useOperation>;
};

export const TeamNestedSettings = ({ teamId, admission, active, blocked, denied = false, editable, onIdentityMismatch, onDenied, onWrite, onSaved, onReconciled, operation }: Props) => {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const m = zh ? {
    title: "任务设置", label: "允许嵌套子任务", hint: "允许在子任务下继续创建子任务。关闭后，已有的子任务不会改变。", current: "已保存", enabled: "开启", disabled: "关闭", save: "保存修改", cancel: "取消", saving: "正在保存", loading: "正在读取设置", failed: "无法读取设置。", retry: "重试", unavailable: "当前服务不支持此设置。", readonly: "只有 Team 管理员可以修改此设置。", conflict: "设置已变化。请核对当前值后重新保存。", unknown: "保存结果未知。请核对当前状态；读回不能确认原操作是否成功。", check: "查看当前状态", rejected: "保存失败，请检查后重试。", saved: "已保存", unsaved: "有未保存的修改"
  } : {
    title: "Task settings", label: "Allow nested subtasks", hint: "Allow subtasks to have their own subtasks. Existing subtasks remain when this is turned off.", current: "Saved", enabled: "On", disabled: "Off", save: "Save changes", cancel: "Cancel", saving: "Saving", loading: "Loading settings", failed: "Unable to read settings.", retry: "Retry", unavailable: "This service does not support this setting.", readonly: "Only Team administrators can change this setting.", conflict: "The setting changed. Review the current value before saving again.", unknown: "The save result is unknown. Check the current state; readback cannot confirm the original operation.", check: "Check current state", rejected: "Unable to save. Check the details and try again.", saved: "Saved", unsaved: "Unsaved changes"
  };
  const [current, setCurrent] = useState<TeamSettings | null>(null), [draft, setDraft] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [unsupported, setUnsupported] = useState(false);
  const [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false), [recovering, setRecovering] = useState(false);
  const retryReason = useRef<"background" | "reconcile" | "conflict" | "refusal">("background");
  const pendingRefusal = useRef<"conflict" | "refusal" | null>(null);
  const floor = useRef<bigint | null>(null), authority = useRef(0);
  const latest = useRef<TeamSettings | null>(null), draftRef = useRef(false), epoch = useRef(0), fresh = useRef(false), reading = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDenied, onWrite, onSaved, onReconciled, onIdentityMismatch }); callbacks.current = { onDenied, onWrite, onSaved, onReconciled, onIdentityMismatch };
  const access = useRef({ active, blocked, denied }); access.current = { active, blocked, denied };
  const op = useRef(operation); op.current = operation;
  const previousDenied = useRef(false);
  if (denied && !previousDenied.current) { ++authority.current; ++epoch.current; fresh.current = false; }
  previousDenied.current = denied;
  useLayoutEffect(() => {
    if (denied) { reading.current?.abort(); latest.current = null; setCurrent(null); }
  }, [denied]);
  if (!active || blocked) fresh.current = false;
  const read = useCallback(async (reason: "background" | "reconcile" | "conflict" | "refusal") => {
    if (authRequestsPaused()) return;
    retryReason.current = reason;
    const generation = ++epoch.current, authGeneration = readAuthRequestGeneration();
    const controller = new AbortController(); reading.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    if (reason !== "background") fresh.current = false;
    if (latest.current === null || reason !== "background") setLoading(true);
    setError(null);
    try {
      await admission.ready(signal);
      const result = await getTeamSettings(teamId, admission.userId, signal, callbacks.current.onIdentityMismatch);
      await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated || generation !== epoch.current || authGeneration !== readAuthRequestGeneration()) return;
      if (result.kind === "unavailable") { setUnsupported(true); setCurrent(null); fresh.current = false; return; }
      if (floor.current !== null && result.settings.version < floor.current) { setError(new Error("The settings read is older than the confirmed version.")); return; }
      const previous = latest.current;
      floor.current = result.settings.version; latest.current = result.settings; setCurrent(result.settings); setUnsupported(false); fresh.current = true; setRecovering(false);
      if (previous === null || draftRef.current === previous.allowNestedSubtask) { draftRef.current = result.settings.allowNestedSubtask; setDraft(draftRef.current); }
      if (reason === pendingRefusal.current) pendingRefusal.current = null;
      if (reason === "reconcile") { op.current.clear(); callbacks.current.onReconciled?.(); }
      if (reason === "conflict") setConflict(draftRef.current !== result.settings.allowNestedSubtask);
    } catch (failure) {
      if (signal.aborted || admission.isInvalidated || generation !== epoch.current || authGeneration !== readAuthRequestGeneration()) return;
      try { await admission.ready(signal); } catch { return; }
      if (signal.aborted || admission.isInvalidated || generation !== epoch.current) return;
      if (failure instanceof ApiError && failure.kind === "server" && ((failure.status === 403 && failure.code === "forbidden") || (failure.status === 404 && failure.code === "not_found"))) {
        ++authority.current; latest.current = null; setCurrent(null); callbacks.current.onDenied();
      }
      setError(failure);
    } finally { if (generation === epoch.current) { reading.current = null; setLoading(false); } }
  }, [admission, teamId]);
  useEffect(() => {
    if (!active || blocked) { ++epoch.current; reading.current?.abort(); return; }
    void read(pendingRefusal.current ?? "background");
    return () => { ++epoch.current; reading.current?.abort(); };
  }, [active, blocked, read]);
  const previousEditable = useRef(editable);
  useEffect(() => {
    if (previousEditable.current === editable) return;
    previousEditable.current = editable;
    ++epoch.current; reading.current?.abort(); fresh.current = false;
    if (!editable) ++authority.current;
    if (!editable && latest.current !== null) { draftRef.current = latest.current.allowNestedSubtask; setDraft(draftRef.current); setConflict(false); }
    if (active && !blocked) void read(pendingRefusal.current ?? "background");
  }, [editable, active, blocked, read]);
  useTeamForeground(active && !blocked, () => { if (!op.current.guarded()) void read(pendingRefusal.current ?? "background"); });
  const unknown = operation.result?.kind === "unknown";
  const dirty = current !== null && draft !== current.allowNestedSubtask;
  const submit = () => {
    const base = latest.current, value = draftRef.current;
    if (!active || blocked || !editable || authRequestsPaused() || !fresh.current || base === null || value === base.allowNestedSubtask || operation.guarded() || operation.publishing()) return;
    setSaved(false); setConflict(false);
    const submittedAuthority = authority.current;
    void operation.run((signal, dispatched) => saveTeamSettings(teamId, admission.userId, base, value, signal, onIdentityMismatch, () => {
      ++epoch.current; reading.current?.abort(); fresh.current = false; setRecovering(true); callbacks.current.onWrite(); dispatched();
    }), result => {
      if (submittedAuthority !== authority.current) {
        if (floor.current === null || result.version > floor.current) floor.current = result.version;
        const stale = latest.current !== null && latest.current.version < floor.current;
        if (stale) { latest.current = null; setCurrent(null); fresh.current = false; }
        setSaved(true); callbacks.current.onSaved();
        if (stale && access.current.active && !access.current.blocked && !access.current.denied) void read("background");
        return;
      }
      if (floor.current === null || result.version >= floor.current) { floor.current = result.version; latest.current = result; setCurrent(result); }
      const observed = latest.current;
      if (observed !== null && draftRef.current === value && observed.allowNestedSubtask === value) { setSaved(true); }
      fresh.current = observed !== null; setRecovering(observed === null); callbacks.current.onSaved();
    }, failure => {
      if (failure instanceof ApiError && (failure.code === "forbidden" || failure.code === "not_found")) { ++authority.current; latest.current = null; setCurrent(null); callbacks.current.onDenied(); }
      else {
        const reason = failure instanceof ApiError && failure.code === "version_conflict" ? "conflict" : "refusal";
        pendingRefusal.current = reason; retryReason.current = reason;
        if (access.current.active && !access.current.blocked && !access.current.denied) void read(reason);
        callbacks.current.onReconciled?.();
      }
    });
  };
  return <section className="panel team-nested-settings"><header className="panel-heading"><div><h2>{m.title}</h2></div></header><div className="panel-body settings-form">
    {loading && current === null && <p role="status">{m.loading}</p>}
    {unsupported && <div><p>{m.unavailable}</p>{recovering && !unknown && <button className="button" type="button" disabled={loading || !active || blocked} onClick={() => { void read(pendingRefusal.current ?? retryReason.current); }}>{m.retry}</button>}</div>}
    {saved && current === null && <p role="status">{m.saved}</p>}
    <OperationPublicationError operation={operation} zh={zh} />
    {error !== null && <div className="notice error" role="alert"><p>{m.failed}</p><button className="button" type="button" disabled={loading} onClick={() => { void read(unknown ? "reconcile" : retryReason.current); }}>{unknown ? m.check : m.retry}</button></div>}
    {unknown && <div className="notice warning" role="alert"><p>{m.unknown}</p>{error === null && <button className="button" type="button" disabled={loading || !active || blocked} onClick={() => { void read("reconcile"); }}>{m.check}</button>}</div>}
    {current !== null && !unsupported && <>
      <div className="team-nested-setting"><div><strong>{m.label}</strong><p className="hint">{m.hint}</p><p className="hint">{m.current}: {current.allowNestedSubtask ? m.enabled : m.disabled}</p></div><button className="task-automation-switch" type="button" role="switch" aria-label={m.label} aria-checked={draft} disabled={!editable || !active || unknown || operation.pending || operation.publicationPending} onClick={() => { draftRef.current = !draftRef.current; setDraft(draftRef.current); setSaved(false); }}><span /></button></div>
      {!editable && <p className="settings-lock">{m.readonly}</p>}
      {conflict && <p className="notice warning" role="alert">{m.conflict}</p>}

      {operation.result?.kind === "rejected" && !conflict && <p className="notice error" role="alert">{m.rejected}</p>}
      {editable && !unknown && <div className="settings-actions"><button className="button primary" type="button" disabled={!dirty || !active || blocked || loading || recovering || operation.pending || operation.publicationPending || operation.publicationError !== null || error !== null} onClick={submit}>{operation.pending ? m.saving : m.save}</button><button className="button" type="button" disabled={!dirty || operation.pending} onClick={() => { draftRef.current = current.allowNestedSubtask; setDraft(draftRef.current); setConflict(false); operation.clear(); }}>{m.cancel}</button></div>}
      <p className="settings-state" role="status">{saved && !dirty ? m.saved : dirty ? m.unsaved : ""}</p>
    </>}
  </div></section>;
};
