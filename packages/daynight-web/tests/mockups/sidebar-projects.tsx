import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthenticatedApp } from "../../src/app/AuthenticatedApp";
import { navigate } from "../../src/app/router";
import type { Project } from "../../src/api/types";
import { LocaleProvider } from "../../src/i18n/LocaleProvider";
import { taskSyncQuery, taskSyncResponse, viewerHeaders } from "../helpers/taskSync";
import { wireResponse } from "../helpers/wireJson";
import "../../src/styles/app.css";

const scenarios = [
  ["normal", "项目切换与长名称"], ["many", "多页项目与滚动"],
  ["loading", "首次加载中"], ["empty", "没有项目"],
  ["error", "首屏失败 · 重试恢复"], ["more-error", "续页失败 · 重试恢复"],
] as const;
type Scenario = typeof scenarios[number][0];
let scenario: Scenario = "normal";
let failed = false;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const user = { id: id(900), name: "Alice Chen", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const timestamp = "2026-10-27T09:00:00Z";
const project = (index: number): Project => ({
  id: id(index), name: index === 1 ? "Daynight" : index === 2 ? "SocietasApp" : index === 3 ? "跨团队基础设施与开发者体验 · Platform Infrastructure" : `项目 ${String(index).padStart(2, "0")}`,
  repoUrl: `https://github.com/example/project-${index}`, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: timestamp, updatedAt: timestamp,
});
let items = [project(1), project(2), project(3)];
const json = (value: unknown, status = 200) => wireResponse(value, { status, headers: viewerHeaders(user.id) });
const failure = () => json({ error: { code: "internal_error", message: "Preview request failed", requestId: "preview-projects-request" } }, 500);
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);
  if (url.pathname === "/api/v1/me") return json(user);
  if (url.pathname === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url.pathname === "/api/v1/projects") {
    if (init?.method === "POST") {
      const created = { ...project(items.length + 1), ...JSON.parse(String(init.body)) as { name: string; repoUrl: string } };
      items = [...items, created];
      return json(created, 201);
    }
    if (scenario === "loading") return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    if (!failed && (scenario === "error" || scenario === "more-error" && url.searchParams.has("cursor"))) { failed = true; return failure(); }
    if (scenario === "empty") return json({ items: [], nextCursor: null });
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const page = items.slice(offset, offset + 50);
    return json({ items: page, nextCursor: offset + 50 < items.length ? String(offset + 50) : null });
  }
  const match = /^\/api\/v1\/projects\/([^/]+)(.*)$/.exec(url.pathname);
  if (match !== null) {
    const selected = items.find((item) => item.id === match[1]);
    if (selected === undefined) return json({ error: { code: "not_found", message: "Project missing", requestId: "preview-project-missing" } }, 404);
    if (match[2] === "/members") return json({ items: [{ projectId: selected.id, userId: user.id, ...user, role: "admin", version: 1n, createdAt: timestamp, updatedAt: timestamp }] });
    if (match[2] === "/invitations") return json({ items: [] });
    if (match[2] === "") return json(selected);
    if (match[2] === "/task-sync") return taskSyncResponse({ project: selected, observedAt: timestamp, summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 }, tasks: [] }, { query: taskSyncQuery(url), versionForTask: () => 1n, viewerId: user.id });
  }
  return json({ error: { code: "not_found", message: "Preview endpoint unavailable", requestId: "preview-endpoint" } }, 404);
};

const Mockup = () => {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Scenario>(scenario);
  return <>
    <AuthenticatedApp key={revision} />
    <aside aria-label="项目导航预览控件" style={{ position: "fixed", zIndex: 100, bottom: 12, right: 12, maxWidth: "calc(100vw - 24px)", padding: "8px 12px", background: "#fffffff5", border: "1px solid #e2e4ed", borderRadius: 8, fontSize: 11 }}>
      <details><summary style={{ cursor: "pointer" }}>项目导航 · 交互预览</summary>
        <div style={{ display: "grid", gap: 8, paddingTop: 10 }}>
          <label htmlFor="sidebar-scenario">场景</label>
          <select id="sidebar-scenario" value={selected} onChange={(event) => {
            scenario = event.currentTarget.value as Scenario;
            failed = false;
            items = Array.from({ length: scenario === "many" || scenario === "more-error" ? 55 : 3 }, (_, index) => project(index + 1));
            setSelected(scenario);
            navigate("/projects");
            setRevision((value) => value + 1);
          }}>{scenarios.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <p>正式组件与样式；项目、创建及分页均由页面内数据提供。可切换项目、语言、侧栏和手机导航。</p>
        </div>
      </details>
    </aside>
  </>;
};
history.replaceState(null, "", "/projects");
const container = document.getElementById("root");
if (container === null) throw new Error("The project navigation preview root is required.");
const root = createRoot(container);
root.render(<LocaleProvider initial={{ locale: "zh-CN", issue: null }}><Mockup /></LocaleProvider>);
import.meta.hot?.dispose(() => { window.fetch = originalFetch; root.unmount(); });
