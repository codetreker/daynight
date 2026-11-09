import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getWebhookCatalog, type WebhookCatalog } from "../api/webhooks";
import { ApiError, isAbortError } from "../api/client";
import { useTaskCacheScope } from "../features/task-cache/TaskCacheProvider";
import { useCurrentAccount } from "./CurrentAccountContext";
import { useI18n } from "../i18n/LocaleProvider";

type CatalogState = { readonly catalog: WebhookCatalog | null; readonly error: unknown; readonly checking: boolean };
type CatalogAdmission = CatalogState & { readonly admitted: boolean; readonly retry: () => void };
const Context = createContext<CatalogAdmission | null>(null);

export const WebhookCatalogProvider = ({ active = true, children }: { readonly active?: boolean; readonly children: ReactNode }) => {
  const { admissionBlocked } = useCurrentAccount();
  const admission = useTaskCacheScope();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CatalogState>({ catalog: null, error: null, checking: true });
  const generation = useRef(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!active || admissionBlocked || admission.isInvalidated) return;
    const controller = new AbortController();
    const current = ++generation.current;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    setState((previous) => ({ ...previous, checking: true }));
    void getWebhookCatalog(signal, { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch }).then((catalog) => {
      if (signal.aborted || current !== generation.current) return;
      setState({ catalog, error: null, checking: false });
    }).catch((error: unknown) => {
      if (signal.aborted || current !== generation.current || isAbortError(error)) return;
      setState((previous) => ({ ...previous, error, checking: false }));
    });
    return () => { ++generation.current; controller.abort(); };
  }, [active, admission, admissionBlocked, attempt]);
  return <Context value={{ ...state, admitted: active && state.catalog !== null && state.error === null && !state.checking && !admissionBlocked && !admission.isInvalidated, retry }}>{children}</Context>;
};

export const useWebhookCatalog = (): CatalogAdmission => {
  const value = useContext(Context);
  if (value === null) throw new Error("Webhook catalog requires an authenticated provider.");
  return value;
};

export const WebhookCatalogStatus = () => {
  const { locale } = useI18n();
  const { catalog, checking, error, retry } = useWebhookCatalog();
  if (catalog !== null && error === null) return null;
  const zh = locale === "zh-CN";
  if (error === null) return <section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{zh ? "正在读取 Webhook 能力" : "Loading Webhook capabilities"}</h1></section>;
  return <section className={catalog === null ? "state-box" : "notice error"} role="alert"><h1>{zh ? "无法读取 Webhook 能力" : "Webhook capabilities unavailable"}</h1><p>{error instanceof ApiError && error.kind === "network" ? (zh ? "网络请求失败。" : "The network request failed.") : (zh ? "服务未返回当前账号可用的 Webhook 目录。" : "The service did not return a valid Webhook catalog for this account.")}</p><button className="button" type="button" disabled={checking} onClick={retry}>{zh ? "重试" : "Retry"}</button></section>;
};
