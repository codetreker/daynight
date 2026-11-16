import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { listTeamGitHubApps, type TeamGitHubGrant } from "../../api/github-consumption";
import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useTeamForeground } from "./useTeamForeground";
import "./team-github-apps.css";

type Props = {
  readonly teamId: string;
  readonly admission: TaskCacheScope;
  readonly onIdentityMismatch: () => void;
  readonly active?: boolean;
  readonly admissionBlocked?: boolean;
  readonly preferenceDenied?: boolean;
};
type Snapshot = { readonly items: readonly TeamGitHubGrant[]; readonly cursor: string | null; readonly pages: number };
const sameItems = (a: readonly TeamGitHubGrant[], b: readonly TeamGitHubGrant[]) => a.length === b.length && a.every((item, index) => {
  const other = b[index];
  return other !== undefined && item.grantId === other.grantId && item.createdAt === other.createdAt && item.app.id === other.app.id && item.app.name === other.app.name && item.app.githubSlug === other.app.githubSlug && item.app.githubAppId === other.app.githubAppId && item.app.version === other.app.version;
});
const denied = (error: unknown) => error instanceof ApiError && error.kind === "server" && ((error.status === 403 && error.code === "forbidden") || (error.status === 404 && error.code === "not_found"));

// A distinct mount prevents another Team or account from rendering a prior snapshot.
export const TeamGitHubApps = (props: Props) => {
  const owner = useRef({ teamId: props.teamId, admission: props.admission, revision: 0 });
  if (owner.current.teamId !== props.teamId || owner.current.admission !== props.admission) owner.current = { teamId: props.teamId, admission: props.admission, revision: owner.current.revision + 1 };
  return props.preferenceDenied ? <Unavailable /> : <TeamGitHubAppsContent key={owner.current.revision} {...props} />;
};

const Unavailable = () => {
  const { locale } = useI18n();
  return <div role="alert" className="notice error">{locale === "zh-CN" ? "此 Team 不可用或你没有访问权限。" : "This Team is unavailable or you do not have access."}</div>;
};

const TeamGitHubAppsContent = ({ teamId, admission, onIdentityMismatch, active = true, admissionBlocked = false }: Props) => {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState<{ cause: unknown; more: boolean } | null>(null), [accessDenied, setAccessDenied] = useState(false), [loading, setLoading] = useState(false);
  const current = useRef<Snapshot | null>(null), read = useRef<AbortController | null>(null);
  const mismatch = useRef(onIdentityMismatch); mismatch.current = onIdentityMismatch;
  const load = useCallback(async (more: boolean) => {
    if (!active || admissionBlocked || admission.isInvalidated || admission.signal.aborted) return;
    const prior = current.current;
    if (more && (!prior || prior.cursor === null)) return;
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    setLoading(more || !prior);
    try {
      let items: readonly TeamGitHubGrant[] = more ? prior!.items : [], cursor: string | null = more ? prior!.cursor : null;
      let pages = more ? prior!.pages : 0;
      const target = more ? pages + 1 : Math.max(1, prior?.pages ?? 1);
      do {
        await admission.ready(signal);
        const page = await listTeamGitHubApps(teamId, cursor, signal, { userId: admission.userId, onPrincipalMismatch: () => mismatch.current() });
        await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated) return;
        const merged = [...items, ...page.items];
        if (new Set(merged.map(item => item.grantId)).size !== merged.length || new Set(merged.map(item => item.app.id)).size !== merged.length || page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError("protocol");
        items = merged; cursor = page.nextCursor; pages++;
      } while (pages < target && cursor !== null);
      const next = { items, cursor, pages };
      const old = current.current;
      current.current = old && old.cursor === next.cursor && old.pages === next.pages && sameItems(old.items, next.items) ? old : next;
      setSnapshot(current.current); setError(previous => !more && previous?.more && next.cursor !== null ? previous : null); setAccessDenied(false);
    } catch (failure) {
      if (signal.aborted || admission.isInvalidated) return;
      try { await admission.ready(signal); } catch { return; }
      if (signal.aborted || admission.isInvalidated) return;
      if (denied(failure)) { current.current = null; setSnapshot(null); setAccessDenied(true); }
      setError({ cause: failure, more: more && !denied(failure) });
    } finally {
      if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); }
    }
  }, [active, admissionBlocked, admission, teamId]);
  useEffect(() => {
    if (!active || admissionBlocked) return;
    void load(false);
    return () => { read.current?.abort(); read.current = null; };
  }, [active, admissionBlocked, load]);
  useTeamForeground(active && !admissionBlocked, () => { void load(false); });
  const errorText = denied(error?.cause) ? (zh ? "此 Team 不可用或你没有访问权限。" : "This Team is unavailable or you do not have access.") : (zh ? "无法读取获授权的 Apps。" : "Unable to read authorized Apps.");
  return <section className="panel team-github-apps">
    <header className="panel-heading"><div><h2>{zh ? "可用的 GitHub Apps" : "Available GitHub Apps"}</h2><p>{zh ? "由 App 管理员授权给这个 Team 使用。" : "Authorized for this Team by App administrators."}</p></div></header>
    {error !== null && <div className="notice error" role="alert"><p>{errorText}</p>{error.cause instanceof ApiError && error.cause.requestId !== null && <p>{zh ? "请求 ID：" : "Request ID: "}<code>{error.cause.requestId}</code></p>}<button type="button" className="button" disabled={!active || admissionBlocked || loading} onClick={() => void load(error.more)}>{zh ? "重试" : "Retry"}</button></div>}
    {!snapshot && !accessDenied && loading && <div className="empty-inline" role="status">{zh ? "正在读取" : "Loading"}</div>}
    {snapshot && (snapshot.items.length ? <ul className="team-github-app-list">{snapshot.items.map(({ grantId, app }) => <li key={grantId}><div className="team-github-app-icon" aria-hidden="true">⌘</div><div><h3>{app.name}</h3><p>App ID {app.githubAppId} · {app.githubSlug}</p><p>{zh ? "接入配置由 App 管理员维护。" : "Configuration is maintained by App administrators."}</p></div></li>)}</ul> : <div className="empty-inline"><strong>{zh ? "暂无获授权 App" : "No authorized Apps"}</strong><p>{zh ? "请将 Team ID 提供给 App 管理员，由其授予使用权。" : "Give this Team’s ID to an App administrator to request access."}</p></div>)}
    {snapshot?.cursor !== null && snapshot && <div className="team-github-app-more"><button type="button" className="button" disabled={!active || admissionBlocked || loading} onClick={() => void load(true)}>{loading ? (zh ? "正在读取" : "Loading") : (zh ? "加载更多" : "Load more")}</button></div>}
    {snapshot && <div className="team-github-app-hint">{zh ? "由当前 owner Team 的管理员为项目建立和维护连接。" : "The current owning Team’s administrators establish and maintain Project connections."}</div>}
  </section>;
};
