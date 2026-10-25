import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { ApiError } from "../../src/api/client";
import { WorkspaceSidebar } from "../../src/app/WorkspaceSidebar";
import { useSidebarPreference } from "../../src/app/useSidebarPreference";
import type { PersonalAccessToken } from "../../src/api/auth-types";
import { TokensPanel, type TokenManagementApi } from "../../src/features/management/TokensPanel";
import { LocaleProvider, useI18n } from "../../src/i18n/LocaleProvider";
import { LanguageSelector } from "../../src/i18n/LanguageSelector";
import { resolveInitialLocale } from "../../src/i18n/locale";
import "../../src/styles/app.css";
import "../../src/styles/auth.css";

const scenarios = [
  ["normal", "永不过期与指定到期时间"], ["empty", "空列表"], ["loading", "列表加载中"], ["load-error", "列表读取失败"],
  ["saving", "修改提交中"], ["conflict", "其他页面已修改有效期"], ["lost-applied", "修改成功但响应丢失"],
  ["lost-unchanged", "修改结果未知，核对后未改变"], ["readback-error", "修改结果未知且核对失败"], ["unavailable", "令牌被撤销"], ["long-name", "长令牌名称"],
] as const;
type Scenario = typeof scenarios[number][0];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const alice = { id: uuid(1), name: "Alice Chen", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const wait = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 350);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});
const stalled = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

const TokensMockup = () => {
  const { locale, messages: { auth: { management: { account: m }, shell }, workspace: { app } } } = useI18n();
  useEffect(() => { document.documentElement.lang = locale; document.title = shell.documentTitle.account; }, [locale, shell]);
  const requested = new URLSearchParams(window.location.search).get("scenario");
  const [scenario, setScenario] = useState<Scenario>(scenarios.some(([id]) => id === requested) ? requested as Scenario : "normal");
  const [revision, setRevision] = useState(0);
  const [user, setUser] = useState(alice);
  const connectionRestored = useRef(false);
  const workspace = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const sidebar = useSidebarPreference();
  const transport = useMemo<TokenManagementApi>(() => {
    let sequence = 10, attempted = false, conflict = false;
    let tokens: PersonalAccessToken[] = scenario === "empty" ? [] : [
      { id: uuid(2), name: scenario === "long-name" ? "Daynight CLI · Platform Infrastructure and Developer Experience · 跨团队协作与持续交付" : "Daynight CLI", createdAt: "2026-10-25T08:00:00Z", expiresAt: null },
      { id: uuid(3), name: "Build agent", createdAt: "2026-10-24T08:00:00Z", expiresAt: "2099-11-20T12:34:56.123456Z" },
    ];
    return {
      list: async (signal, expectedUserId, onMismatch) => {
        if (scenario === "loading") return stalled(signal);
        await wait(signal);
        if (expectedUserId !== user.id) { onMismatch(); throw new ApiError("protocol", 200, "principal_mismatch"); }
        if (scenario === "load-error" || scenario === "readback-error" && attempted && !connectionRestored.current) throw new ApiError("network");
        return [...tokens];
      },
      create: async (input, signal) => {
        await wait(signal);
        const token = { id: uuid(++sequence), name: input.name, createdAt: new Date().toISOString(), expiresAt: input.expiresAt };
        tokens = [token, ...tokens];
        return { ...token, token: "mockup-only-token-secret" };
      },
      revoke: async (id, signal) => { await wait(signal); tokens = tokens.filter((token) => token.id !== id); },
      update: async (id, input, signal) => {
        if (scenario === "saving") return stalled(signal);
        await wait(signal); attempted = true;
        const current = tokens.find((token) => token.id === id);
        if (current === undefined) throw new ApiError("server", 404, "not_found", "token-fixture-missing");
        if (input.expectedUserId !== user.id) throw new ApiError("server", 403, "forbidden", "token-fixture-account");
        if (scenario === "conflict" && !conflict) {
          conflict = true; tokens = tokens.map((token) => token.id === id ? { ...token, expiresAt: "2099-12-25T09:00:00Z" } : token);
          throw new ApiError("server", 409, "version_conflict", "token-fixture-conflict");
        }
        if (scenario === "unavailable") { tokens = tokens.filter((token) => token.id !== id); throw new ApiError("server", 404, "not_found", "token-fixture-missing"); }
        if (input.expectedExpiresAt !== current.expiresAt) throw new ApiError("server", 409, "version_conflict", "token-fixture-conflict");
        const saved = { ...current, expiresAt: input.expiresAt };
        if (scenario !== "lost-unchanged") tokens = tokens.map((token) => token.id === id ? saved : token);
        if (scenario === "lost-applied" || scenario === "lost-unchanged" || scenario === "readback-error") throw new ApiError("network");
        return saved;
      },
    };
  }, [scenario, revision, user.id]);
  const reset = (next: Scenario) => { connectionRestored.current = false; setScenario(next); setRevision((value) => value + 1); };
  return <>
    <div className={`shell auth-shell${sidebar.collapsed ? " sidebar-collapsed" : ""}`}>
      <WorkspaceSidebar collapsed={sidebar.collapsed} onToggle={sidebar.toggle} routeKey="account" projectsActive={false} accountActive identityChecking={false} workspaceRef={workspace} onNavigate={() => queueMicrotask(() => content.current?.focus())} />
      <div className="workspace" ref={workspace}>
        <a className="skip-link" href="#main-content">{app.skipToContent}</a>
        <header className="topbar">
          <nav className="crumb" aria-label={app.breadcrumb}><a href="/" onClick={(event) => event.preventDefault()}>{app.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current" aria-current="page">{shell.accountSettings}</span></nav>
          <div className="account-actions">
            <LanguageSelector />
            <a className="account-button" href="/account" onClick={(event) => event.preventDefault()} aria-label={shell.accountLink({ name: user.name })}><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="account-name">{user.name}</span></a>
            <button className="inline-link" type="button">{shell.signOut}</button>
          </div>
        </header>
        <main className="content" id="main-content" ref={content} tabIndex={-1}>
        {sidebar.issue !== null && <div className="notice warning sidebar-preference-notice" role="alert"><p>{shell.sidebar[`${sidebar.issue.kind}Error`]}</p><button className="button" type="button" onClick={sidebar.retrySave}>{shell.sidebar.retrySave}</button></div>}
          <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1>{m.title}</h1><p className="subtitle">{m.subtitle}</p></div></div>
          <div className="settings-grid">
            <nav className="settings-nav" aria-label={m.title}><button type="button" disabled>{m.profileTab}</button><button type="button" className="active" aria-current="page">{m.tokensTab}</button></nav>
            <div className="settings-main"><TokensPanel key={revision} user={user} transport={transport} onIdentityMismatch={() => setUser({ ...alice, id: uuid(9), name: "Bob Wang" })} /></div>
          </div>
        </main>
      </div>
    </div>
    {createPortal(<aside aria-label="Token management fixture controls" style={{ position: "fixed", zIndex: 100, bottom: 12, left: 12, maxWidth: "calc(100vw - 24px)", background: "#fffffff5", border: "1px solid #e2e4ed", borderRadius: 8, fontSize: 11, boxShadow: "0 4px 22px #25325312" }}><details><summary style={{ padding: "8px 12px", cursor: "pointer" }}>访问令牌 · 交互场景</summary><div style={{ display: "grid", gap: 9, padding: "4px 12px 12px", width: 320, maxWidth: "calc(100vw - 28px)" }}><label htmlFor="token-scenario">场景</label><select id="token-scenario" value={scenario} onChange={(event) => reset(event.currentTarget.value as Scenario)}>{scenarios.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button className="button" type="button" onClick={() => reset(scenario)}>重置当前场景</button><button className="button" type="button" onClick={() => { connectionRestored.current = true; }}>恢复核对读取</button><button className="button" type="button" onClick={() => setUser(user.id === alice.id ? { ...alice, id: uuid(9), name: "Bob Wang" } : alice)}>切换账户</button><p>令牌列表、创建、修改有效期与对话框使用正式组件。所有变化仅保存在此页面，无需后端。</p></div></details></aside>, document.body)}
  </>;
};
const container = document.getElementById("root");
if (container === null) throw new Error("The token management fixture root is required.");
const root = createRoot(container);
root.render(<LocaleProvider initial={resolveInitialLocale()}><TokensMockup /></LocaleProvider>);
import.meta.hot?.dispose(() => root.unmount());
