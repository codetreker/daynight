import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import type { CurrentUser } from "../../api/auth-types";
import type { ProjectTransferReceipt } from "../../api/project-transfer";
import { getTeam } from "../../api/teams";
import { navigate } from "../../app/router";
import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

type TransferResult = {
  readonly receipt: ProjectTransferReceipt;
  readonly navigation: "none" | "checking" | "error" | "ready";
  readonly destination: string | null;
  readonly error: unknown;
};

// The receipt remains visible while the source Team is checked; this read does
// not determine whether the transfer committed.
export const useTransferNavigation = (admission: TaskCacheScope, user: CurrentUser, refreshProjects: () => void) => {
  const [result, setResult] = useState<TransferResult | null>(null);
  const current = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { ++current.current; active.current?.abort(); }, []);

  const resolveSource = (receipt: ProjectTransferReceipt, generation: number, location: string | null) => {
    if (active.current !== null || admission.isInvalidated || current.current !== generation) return;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const valid = () => !signal.aborted && !admission.isInvalidated && generation === current.current;
    setResult((previous) => previous === null ? null : { ...previous, navigation: "checking", error: null });
    void (async () => {
      let destination: string;
      try {
        await admission.ready(signal);
        await getTeam(receipt.sourceTeam.id, user.id, signal, admission.principalMismatch);
        await admission.ready(signal);
        destination = `/teams/${receipt.sourceTeam.id}`;
      } catch (error) {
        if (!valid()) return;
        try { await admission.ready(signal); } catch { return; }
        if (!valid()) return;
        if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") destination = `/teams/${user.personalTeam.id}`;
        else {
          setResult((previous) => previous === null ? null : { ...previous, navigation: "error", error });
          return;
        }
      } finally {
        if (active.current === controller) active.current = null;
      }
      if (!valid()) return;
      setResult((previous) => previous === null ? null : { ...previous, navigation: "ready", destination });
      if (location !== null && window.location.pathname + window.location.search + window.location.hash === location) navigate(destination);
    })();
  };

  const complete = (receipt: ProjectTransferReceipt) => {
    active.current?.abort(); active.current = null;
    const generation = ++current.current;
    const location = window.location.pathname === `/projects/${receipt.projectId}/settings` ? window.location.pathname + window.location.search + window.location.hash : null;
    refreshProjects();
    setResult({ receipt, navigation: receipt.actorAccess === null ? "checking" : "none", destination: null, error: null });
    if (receipt.actorAccess === null) resolveSource(receipt, generation, location);
  };
  const retry = () => {
    if (result === null || result.receipt.actorAccess !== null || result.navigation !== "error") return;
    resolveSource(result.receipt, current.current, window.location.pathname + window.location.search + window.location.hash);
  };
  const dismiss = () => { ++current.current; active.current?.abort(); active.current = null; setResult(null); };
  return { result, complete, retry, dismiss };
};

export const TransferResultNotice = ({ result, retry, dismiss }: {
  readonly result: TransferResult | null;
  readonly retry: () => void;
  readonly dismiss: () => void;
}) => {
  const { locale, messages: { auth: { roles }, common } } = useI18n();
  if (result === null) return null;
  const zh = locale === "zh-CN", target = result.receipt.ownerTeam.kind === "personal" ? (zh ? "个人" : "Personal") : result.receipt.ownerTeam.name;
  const role = result.receipt.actorAccess?.effectiveRole;
  return <div className="notice" role="status">
    <p>{result.receipt.changed ? (zh ? `项目已转移至 ${target}。` : `Project transferred to ${target}.`) : (zh ? `项目已归属 ${target}。` : `Project already belongs to ${target}.`)} {role === undefined ? (zh ? "你已失去该项目的访问权。" : "You no longer have access to this project.") : (zh ? `你的项目权限为 ${roles[role]}。` : `Your project role is ${roles[role]}.`)}</p>
    {result.navigation === "checking" && <p>{zh ? "正在检查原 Team。" : "Checking the source Team."}</p>}
    {result.navigation === "error" && <div role="alert"><p>{zh ? "无法检查原 Team；转移已成功。请重试导航。" : "Unable to check the source Team. The transfer succeeded; retry navigation."}</p>{result.error instanceof ApiError && result.error.requestId !== null && <p>{common.requestId}<code>{result.error.requestId}</code></p>}<button className="button" type="button" onClick={retry}>{zh ? "重试" : "Retry"}</button></div>}
    {result.navigation === "ready" && result.destination !== null && <a className="button" href={result.destination} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(result.destination!); }}>{zh ? "返回 Team 项目" : "Go to Team projects"}</a>}
    <button className="button quiet" type="button" onClick={dismiss}>{zh ? "关闭" : "Dismiss"}</button>
  </div>;
};
