import { useEffect, useRef, useState } from "react";
import { navigate } from "../../app/router";
import { browserNavigation, type BrowserLocation } from "../../app/navigation";
import { useI18n } from "../../i18n/LocaleProvider";
import { ApiError, authRequestsPaused } from "../../api/client";
import type { ProjectDeletionReceipt } from "../../api/project-deletion";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

type Outcome = { readonly id: string; readonly kind: "unknown" | "rejected"; readonly error: unknown; readonly check: () => Promise<"available" | "unavailable">; readonly checked: "available" | "unavailable" | "error" | null; readonly checking: boolean };

type DeletionResult = { readonly id: string; readonly cleanup: "pending" | "done" | "error" | "skipped"; readonly navigation: "done" | "error" };

// The receipt and each local follow-up remain independent of the settings route.
export const useDeletionNavigation = (admission: TaskCacheScope, refresh: () => void) => {
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [results, setResults] = useState<readonly DeletionResult[]>([]);
  const running = useRef(new Set<AbortController>());
  const receipts = useRef(new Map<string, { controller: AbortController; finish: (signal?: AbortSignal) => Promise<void | "skipped"> }>());
  useEffect(() => () => { for (const receipt of receipts.current.values()) receipt.controller.abort(); receipts.current.clear(); }, []);
  useEffect(() => browserNavigation().subscribe(() => {
    if (browserNavigation().snapshot().pathname === "/projects") setResults((previous) => previous.map((item) => item.navigation === "error" ? { ...item, navigation: "done" } : item));
  }), []);
  const update = (id: string, patch: Partial<DeletionResult>) => setResults((previous) => previous.map((item) => item.id === id ? { ...item, ...patch } : item));
  const cleanup = (id: string, finish: (signal?: AbortSignal) => Promise<void | "skipped">, controller: AbortController) => {
    if (running.current.has(controller)) return Promise.resolve("cancelled" as const);
    running.current.add(controller);
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const current = () => !signal.aborted && !admission.isInvalidated && receipts.current.get(id)?.controller === controller;
    update(id, { cleanup: "pending" });
    return (async () => {
      try {
        await admission.ready(signal);
        if (!current()) return "cancelled" as const;
        const result = await finish(signal);
        await admission.ready(signal);
        if (!current()) return "cancelled" as const;
        const status = result === "skipped" ? "skipped" : "done";
        update(id, { cleanup: status });
        return status;
      } catch {
        try { await admission.ready(signal); } catch { return "cancelled" as const; }
        if (!current()) return "cancelled" as const;
        update(id, { cleanup: "error" });
        return "error" as const;
      } finally { running.current.delete(controller); }
    })();
  };
  const go = (id: string) => {
    if (authRequestsPaused() || admission.isInvalidated) return;
    try { navigate("/projects"); update(id, { navigation: browserNavigation().snapshot().pathname === "/projects" ? "done" : "error" }); }
    catch { update(id, { navigation: "error" }); }
  };
  const complete = (value: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">, location: BrowserLocation = browserNavigation().snapshot(), canFinalize: () => boolean = () => browserNavigation().snapshot() === location) => {
    const id = value.projectId;
    receipts.current.get(id)?.controller.abort();
    const controller = new AbortController();
    receipts.current.set(id, { controller, finish });
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    void (async () => {
      try {
        await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated || receipts.current.get(id)?.controller !== controller) return;
        setOutcomes((previous) => previous.filter((item) => item.id !== id));
        setResults((previous) => [...previous.filter((item) => item.id !== id), { id, cleanup: "pending", navigation: "done" }]);
        const cleanupResult = await cleanup(id, finish, controller);
        if (cleanupResult === "skipped" || cleanupResult === "cancelled") return;
        await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated || authRequestsPaused() || receipts.current.get(id)?.controller !== controller) return;
        if (canFinalize() && browserNavigation().snapshot() === location) {
          try { refresh(); } catch { /* Navigation and confirmed cleanup remain independent. */ }
          if (!authRequestsPaused() && canFinalize() && browserNavigation().snapshot() === location) go(id);
        }
      } catch { /* Cancellation retires this publication with its owner. */ }
    })();
  };
  const outcome = (id: string, kind: Outcome["kind"], error: unknown, check: Outcome["check"]) => setOutcomes((previous) => [...previous.filter((item) => item.id !== id), { id, kind, error, check, checked: null, checking: false }]);
  const checkOutcome = (item: Outcome) => {
    if (item.checking) return;
    setOutcomes((previous) => previous.map((entry) => entry === item ? { ...entry, checking: true } : entry));
    void item.check().then((checked) => setOutcomes((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, checking: false, checked } : entry)), () => setOutcomes((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, checking: false, checked: "error" } : entry)));
  };
  return { outcomes, outcome, checkOutcome, dismissOutcome: (id: string) => setOutcomes((previous) => previous.filter((item) => item.id !== id)), results, complete, retryCleanup: (item: DeletionResult) => { const receipt = receipts.current.get(item.id); if (receipt !== undefined) void cleanup(item.id, receipt.finish, receipt.controller); }, retryNavigation: (item: DeletionResult) => go(item.id), dismiss: (id: string) => { receipts.current.get(id)?.controller.abort(); receipts.current.delete(id); setResults((previous) => previous.filter((item) => item.id !== id)); } };
};

export const DeletionResultNotices = ({ state }: { readonly state: ReturnType<typeof useDeletionNavigation> }) => {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  return <>{state.outcomes.map((item) => <div className="notice warning" role="alert" key={`outcome:${item.id}`}>
    <p>{item.kind === "unknown" ? (zh ? "项目删除结果未确认。核对当前状态不能证明原操作成功，也不会再次删除。" : "The project deletion result is unknown. Checking current state cannot prove the original operation succeeded and will not resend it.") : item.error instanceof ApiError && item.error.code === "active_worker_claims" ? (zh ? "活跃的 Worker 认领阻止了删除。" : "Active Worker claims prevented deletion.") : item.error instanceof ApiError && item.error.code === "forbidden" ? (zh ? "当前没有项目删除权限。" : "You do not have permission to delete this project.") : (zh ? "项目删除被拒绝，项目未被此次操作删除。" : "Project deletion was rejected; this operation did not delete it.")} <code>{item.id}</code></p>
    {item.error instanceof ApiError && item.error.requestId !== null && <p>{zh ? "请求 ID：" : "Request ID: "}<code>{item.error.requestId}</code></p>}
    {item.kind === "rejected" && item.error instanceof ApiError && item.error.code === "active_worker_claims" && <a className="button" href={`/projects/${item.id}/settings`} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(`/projects/${item.id}/settings`); }}>{zh ? "查看阻塞项" : "View blockers"}</a>}
    {item.kind === "unknown" && <><button className="button" type="button" disabled={item.checking} onClick={() => state.checkOutcome(item)}>{zh ? "核对当前状态" : "Check current state"}</button>{item.checked !== null && <p>{item.checked === "available" ? (zh ? "项目当前可访问；原结果仍未确认。" : "The project is currently accessible; the original result remains unknown.") : item.checked === "unavailable" ? (zh ? "项目当前不可访问；原结果仍未确认。" : "The project is currently unavailable; the original result remains unknown.") : (zh ? "无法核对当前状态。" : "Unable to check current state.")}</p>}</>}
    {item.kind === "rejected" ? <button className="button quiet" type="button" onClick={() => state.dismissOutcome(item.id)}>{zh ? "关闭" : "Dismiss"}</button> : <a className="button" href="/projects" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate("/projects"); }}>{zh ? "返回项目列表" : "Return to projects"}</a>}
  </div>)}{state.results.map((item) => <div className="notice" role="status" key={item.id}>
    <p>{zh ? "项目已删除。" : "Project deleted."} <code>{item.id}</code></p>
    {item.cleanup === "error" && <div role="alert"><p>{zh ? "删除已成功，但本地缓存清理失败。" : "Deletion succeeded, but local cache cleanup failed."}</p><button className="button" type="button" onClick={() => state.retryCleanup(item)}>{zh ? "重试清理" : "Retry cleanup"}</button></div>}
    {item.navigation === "error" && <div role="alert"><p>{zh ? "删除已成功，但无法返回项目列表。" : "Deletion succeeded, but navigation to projects failed."}</p><button className="button" type="button" onClick={() => state.retryNavigation(item)}>{zh ? "重试导航" : "Retry navigation"}</button></div>}
    {(item.cleanup === "done" || item.cleanup === "skipped") && item.navigation === "done" && <button className="button quiet" type="button" onClick={() => state.dismiss(item.id)}>{zh ? "关闭" : "Dismiss"}</button>}
  </div>)}</>;
};
