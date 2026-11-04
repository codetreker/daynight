import { selectTaskList } from './helpers/projectViews';
import { detailFixture, graphFixture, withDetailResources as withTestDetailResources } from './helpers/taskDetail';
import { directAccessFixture, taskSyncQuery, taskSyncResponse, viewerHeaders } from './helpers/taskSync';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { performance as nodePerformance } from 'node:perf_hooks';
import { openDB } from 'idb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import type { TaskGraph } from '../src/api/types';
import { stringifyWireJson } from "./helpers/wireJson";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/api/auth";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { navigate, parseRoute } from "../src/app/router";
import userEvent from "@testing-library/user-event";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { invitationStorageKey, teamInvitationStorageKey } from "../src/features/auth/invitation";
import { SIDEBAR_STORAGE_KEY } from "../src/app/useSidebarPreference";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import { personalTeamPage } from "./helpers/team";

const render = createLocaleRender("zh-CN");
let topLevelFocused = true;
let visibility: DocumentVisibilityState = "visible";
const returnFromAnotherWindow = () => {
  topLevelFocused = false;
  fireEvent(window, new Event("blur"));
  topLevelFocused = true;
  fireEvent(window, new Event("focus"));
};

const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const now = "2026-10-22T10:00:00Z";
const user = (id = userId, name = "Alice") => ({ personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id, name, email: `${name}@example.com`, emailVerified: true, avatarUrl: null });
const project = (name = "私有项目") => ({ ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name, repoUrl: "https://github.com/example/repo", createdAt: now, updatedAt: now });
const createdProject = (name = "私有项目", repoUrl = "https://github.com/example/repo") => ({ ...project(name), repoUrl, access: { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin", canTransfer: true } });
const member = (id = userId, role = "admin") => ({ projectId, userId: id, name: "Alice", email: "alice@example.com", avatarUrl: null, role, version: 12, createdAt: now, updatedAt: now });
const participant = (id = userId, role = "admin", name = "Alice") => ({ inheritedFrom: null, userId: id, profile: { name, email: "alice@example.com", avatarUrl: null }, effectiveRole: role, directGrant: { projectId, userId: id, role, version: 12, createdAt: now, updatedAt: now } });
let serverUserId = userId;
const json = (body: unknown, status = 200, principal = serverUserId) => new Response(stringifyWireJson(body), { status, headers: status === 401 ? { "Content-Type": "application/json" } : viewerHeaders(principal, { "Content-Type": "application/json" }) });
const isTaskSync = (url: string) => new URL(url, window.location.origin).pathname.endsWith('/task-sync');
const graphResponse = (value: TaskGraph, url: string, version = 1n) => taskSyncResponse(value, { query: taskSyncQuery(new URL(url, window.location.origin)), versionForTask: () => version, propertiesForTask: () => ({ pullRequests: [] }), viewerId: serverUserId, actorAccess: directAccessFixture(value.project.id, serverUserId, "admin") });
const withDetailResources = (project: string, task: string, fallback: (url: string, options?: RequestInit) => Response | Promise<Response>) => withTestDetailResources(project, task, fallback, {}, () => serverUserId);
const fail = (status: number, code: string) => json({ error: { code, message: "hidden server details", requestId: "rq-safe" } }, status);
const graph = (url: string) => graphResponse({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }, url);
const defaults = (url: string): Response => {
  if (url === "/api/v1/me") return json(user(serverUserId, serverUserId === userId ? "Alice" : "Bob"));
  if (url.startsWith("/api/v1/teams?")) return json(personalTeamPage(serverUserId));
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url.endsWith("/access")) return serverUserId === userId ? json(directAccessFixture(projectId, userId, "admin")) : fail(404, "not_found");
  if (url.endsWith("/members")) return json({ actorAccess: directAccessFixture(projectId, serverUserId, "admin"), items: [participant()] });
  if (isTaskSync(url)) return graph(url);
  if (url.startsWith("/api/v1/projects")) return json({ items: [project()], nextCursor: null });
  throw new Error(`Unexpected request ${url}`);
};
const install = (handler: (url: string) => Response | Promise<Response> = defaults) => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(handler(url)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

beforeEach(() => {
  window.sessionStorage.clear();
  serverUserId = userId;
  topLevelFocused = true; visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => topLevelFocused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
});

describe("sidebar integration with the authenticated workspace", () => {
  it("loads project navigation once with the project page and keeps the selected project across management routes", async () => {
    const fetcher = install((url) => url === `/api/v1/projects/${projectId}` ? json(project()) : url.endsWith("/invitations") ? json({ items: [] }) : defaults(url));
    render(<AuthenticatedApp />);
    const nav = () => within(screen.getByRole("complementary", { name: "工作空间导航" }));
    await screen.findByRole("complementary", { name: "工作空间导航" });
    const link = await nav().findByRole("link", { name: "私有项目" });
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects?"))).toHaveLength(1);
    expect(nav().getByRole("link", { name: "我的项目" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(link);
    await screen.findByRole("link", { name: "项目成员" });
    expect(nav().getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
    expect(nav().getByRole("link", { name: "我的项目" })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("link", { name: "项目成员" }));
    await screen.findByRole("heading", { name: "项目成员" });
    expect(nav().getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("link", { name: "项目设置" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(nav().getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects?"))).toHaveLength(1);
  });

  it("refreshes the shared navigation after creating a project", async () => {
    let created = false;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === "/api/v1/projects" && options?.method === "POST") { created = true; return Promise.resolve(json(createdProject("New project", "https://github.com/example/new-project"), 201)); }
      if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: created ? [project("New project")] : [], nextCursor: null }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "New project" } });
    fireEvent.change(screen.getByLabelText(/仓库地址/), { target: { value: "https://github.com/example/new-project" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    const nav = within(screen.getByRole("complementary", { name: "工作空间导航" }));
    expect(await nav.findByRole("link", { name: "New project" })).toHaveAttribute("aria-current", "true");
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects?"))).toHaveLength(2);
  });

  it("removes a project from navigation after its own direct grant is removed and access is lost", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}/members`);
    let removed = false;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === `/api/v1/projects/${projectId}/grants/${userId}` && options?.method === "DELETE") { removed = true; return Promise.resolve(json({ projectId, userId, deleted: true, actorAccess: null })); }
      if (url.endsWith("/access")) return !removed && serverUserId === userId ? json(directAccessFixture(projectId, userId, "admin")) : fail(404, "not_found");
      if (url.endsWith("/members")) return Promise.resolve(json({ actorAccess: directAccessFixture(projectId, serverUserId, "admin"), items: [participant(), participant(otherId, "admin", "Bob")] }));
      if (url.endsWith("/invitations")) return Promise.resolve(json({ items: [] }));
      if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: removed ? [] : [project()], nextCursor: null }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 Alice 的单独授权" }));
    const dialog = screen.getByRole("dialog", { name: "移除 Alice 的单独授权？" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "移除授权" })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "移除授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回项目" }));
    await screen.findByRole("heading", { name: "还没有项目" });
    expect(window.location.pathname).toBe("/projects");
    expect(within(screen.getByRole("complementary", { name: "工作空间导航" })).queryByRole("link", { name: "私有项目" })).toBeNull();
  });

  it("preserves the mounted project and requests while toggling the origin preference", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const fetcher = install();
    const initialSync = Promise.withResolvers<void>();
    const applySync = TaskCacheScope.prototype.applySync;
    vi.spyOn(TaskCacheScope.prototype, "applySync").mockImplementation(function (this: TaskCacheScope, ...args) {
      const result = applySync.apply(this, args);
      void result.then(() => initialSync.resolve(), initialSync.reject);
      return result;
    });
    render(<AuthenticatedApp />);
    // Authentication commits before the project effect can start the cache synchronization.
    await act(async () => {});
    await act(async () => initialSync.promise);
    const heading = screen.getByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.some(([url]) => isTaskSync(url))).toBe(true);
    const main = screen.getByRole("main");
    const before = fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    expect(screen.getByRole("main")).toBe(main);
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("false");
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it("retains the stored appearance after account replacement while discarding the previous identity's workspace", async () => {
    install();
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    serverUserId = otherId;
    returnFromAnotherWindow();
    await screen.findByRole("button", { name: "账户菜单：Bob" });
    expect(heading.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
  });

  it.each(["read", "invalid", "write"] as const)("shows a localized %s issue and recovers only after an explicit save", async (failure) => {
    const originalRead = Storage.prototype.getItem;
    const originalWrite = Storage.prototype.setItem;
    let unavailable = true;
    if (failure === "invalid") window.localStorage.setItem(SIDEBAR_STORAGE_KEY, '"true"');
    if (failure === "read") vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (key === SIDEBAR_STORAGE_KEY && unavailable) throw new Error("private storage cause");
      return originalRead.call(this, key);
    });
    if (failure === "write") vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === SIDEBAR_STORAGE_KEY && unavailable) throw new Error("private storage cause");
      return originalWrite.call(this, key, value);
    });
    install();
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    if (failure === "write") fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    const message = failure === "read" ? "无法读取侧栏偏好，当前使用展开布局。你仍可切换侧栏并重试保存。" : failure === "invalid" ? "保存的侧栏偏好无效，当前使用展开布局。请重新选择并保存。" : "侧栏偏好尚未保存。当前布局仍可使用，请重试保存。";
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("private storage cause")).toBeNull();
    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "重试保存侧栏偏好" }));
    expect(screen.queryByText(message)).toBeNull();
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe(failure === "write" ? "true" : "false");
  });

  it("closes mobile navigation for identity verification and preserves the interactive workspace until an actual failure", async () => {
    mockSidebarMediaQuery(true);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    install((url) => url === "/api/v1/me" && ++meCalls > 1
      ? new Promise<Response>((done) => { finishCheck = done; })
      : defaults(url));
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    const shell = document.querySelector(".shell")!;
    const workspace = document.querySelector(".workspace")!;
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("dialog", { name: "工作空间导航" })).toHaveAttribute("aria-modal", "true");
    expect(workspace).toHaveAttribute("inert");
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(workspace).not.toHaveAttribute("inert");
    expect(shell).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => finishCheck(fail(503, "internal")));
    expect(screen.getByRole("dialog", { name: "重新确认当前账户" })).toBeInTheDocument();
    expect(shell).toHaveAttribute("inert");
    expect(heading.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新确认账户" }));
    await waitFor(() => expect(meCalls).toBe(3));
    await act(async () => finishCheck(json(user())));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(shell).not.toHaveAttribute("inert");
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("dialog", { name: "工作空间导航" })).toBeInTheDocument();
  });
});

describe("authenticated application shell", () => {
  it("waits for identity before requesting project data and renders the real project list", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => url === "/api/v1/me" ? new Promise<Response>((done) => { resolve = done; }) : Promise.resolve(defaults(url)));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    expect(screen.getByRole("heading", { name: "正在确认登录状态" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(user())));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toHaveAttribute("aria-label", "账户菜单：Alice");
  });

  it("opens the account menu, dismisses it, and navigates using keyboard", async () => {
    install();
    const interaction = userEvent.setup();
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    const sidebar = screen.getByRole("complementary", { name: "工作空间导航" });
    expect(within(sidebar).queryByRole("link", { name: "账户设置" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await interaction.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "账户设置" })).toHaveFocus();
    await interaction.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    await interaction.click(trigger);
    await interaction.click(screen.getByRole("heading", { name: "私有项目" }));
    expect(screen.queryByRole("menu")).toBeNull();
    trigger.focus();
    await interaction.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "账户设置" })).toHaveFocus();
    await interaction.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    await interaction.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "账户设置" })).toHaveFocus();
    await interaction.keyboard("{Enter}");
    expect(window.location.pathname).toBe("/account");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it.each(["pointer", "keyboard"] as const)("returns focus to the trigger when selecting the current account page with %s", async (method) => {
    window.history.replaceState(null, "", "/account");
    install();
    const interaction = userEvent.setup();
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    await interaction.click(trigger);
    const item = screen.getByRole("menuitem", { name: "账户设置" });
    expect(item).toHaveFocus();
    if (method === "keyboard") await interaction.keyboard("{Enter}");
    else await interaction.click(item);
    expect(window.location.pathname).toBe("/account");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes the account menu on route changes and updates both languages", async () => {
    install();
    const interaction = userEvent.setup();
    const view = render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    await interaction.click(trigger);
    view.setLocale("en");
    expect(screen.getByRole("button", { name: "Account menu: Alice" })).toBe(trigger);
    expect(screen.getByRole("menuitem", { name: "Account settings" })).toBeVisible();
    act(() => navigate("/workers"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the account menu accessible with the default identity label", async () => {
    install((url) => url === "/api/v1/me" ? json({ ...user(), name: null, email: null }) : defaults(url));
    const interaction = userEvent.setup();
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：当前账户" });
    expect(trigger.querySelector(".avatar")).toHaveTextContent("当");
    await interaction.click(trigger);
    expect(screen.getByRole("menuitem", { name: "账户设置" })).toBeVisible();
  });

  it("only shows configured login providers and sends a local return path", async () => {
    install((url) => url === "/api/v1/me" ? fail(401, "unauthenticated") : defaults(url));
    const login = vi.fn();
    window.history.replaceState(null, "", `/projects/${projectId}`);
    render(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
    expect(screen.queryByRole("button", { name: "使用 Google 登录" })).toBeNull();
    expect(screen.queryByText("登录状态已过期。重新登录后可继续访问项目。")).toBeNull();
    expect(login).toHaveBeenCalledWith(`/api/v1/auth/login?provider=github&returnPath=%2Fprojects%2F${projectId}`);
    expect(screen.getByRole("button", { name: "正在前往 UniAuth…" })).toBeDisabled();
  });

  it("keeps provider loading failures distinct from an empty configured provider set", async () => {
    let providerCalls = 0;
    install((url) => url === "/api/v1/me" ? fail(401, "unauthenticated") : ++providerCalls === 1 ? fail(503, "internal") : json({ providers: [] }));
    render(<AuthenticatedApp />);
    await screen.findByText("暂时无法读取登录方式，请重试。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("当前没有可用的登录方式。请联系部署管理员。");
    expect(screen.queryByRole("button", { name: /使用 .* 登录/ })).toBeNull();
  });

  it("retries an identity server failure without displaying projects or a signed-out state", async () => {
    let first = true;
    install((url) => { if (url === "/api/v1/me" && first) { first = false; return fail(500, "internal"); } return defaults(url); });
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "暂时无法确认登录状态" });
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "私有项目" });
  });

  it("keeps an iframe-to-parent pointer gesture intact without revalidating the account", async () => {
    const fetcher = install();
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    const refresh = screen.getByRole("button", { name: "刷新" });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      frame.focus();
      fireEvent(window, new Event("blur"));
      expect(document.hasFocus()).toBe(true);
      fireEvent.pointerDown(refresh);
      frame.blur();
      expect(document.activeElement).toBe(document.body);
      fireEvent(window, new Event("focus"));
      fireEvent.pointerUp(refresh);
      fireEvent.click(refresh);
      await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects")).length).toBe(2));
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
      expect(document.body).not.toHaveClass("auth-session-checking");
      expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    } finally { frame.remove(); }
  });

  it.each(["focus-first", "visibility-first"])("checks once without interrupting the workspace on an external tab return (%s)", async (order) => {
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; });
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    topLevelFocused = false; visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("blur"));
    if (order === "focus-first") {
      topLevelFocused = true;
      fireEvent(window, new Event("focus"));
      expect(meCalls).toBe(1);
      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
    } else {
      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(meCalls).toBe(1);
      topLevelFocused = true;
      fireEvent(window, new Event("focus"));
    }
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    await waitFor(() => expect(meCalls).toBe(2));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    expect(meCalls).toBe(2);
    serverUserId = otherId;
    await act(async () => finishCheck(json(user(otherId, "Bob"))));
    await screen.findByRole("button", { name: "账户菜单：Bob" });
    expect(screen.queryByRole("button", { name: "账户菜单：Alice" })).toBeNull();
  });

  it.each([
    { order: "focus-first", changed: false }, { order: "visibility-first", changed: false },
    { order: "focus-first", changed: true }, { order: "visibility-first", changed: true },
  ])("holds direct-project foreground reads until identity is confirmed ($order, changed=$changed)", async ({ order, changed }) => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    let cookieAccount = "Alice";
    const dispatchedGraphs: Array<{ cookie: string; label: string | null }> = [];
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; });
      if (isTaskSync(url)) {
        dispatchedGraphs.push({ cookie: cookieAccount, label: document.querySelector(".account-name")?.textContent ?? null });
        return Promise.resolve(graphResponse({ observedAt: now, project: project(`${cookieAccount} 的项目`), tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }, url));
      }
      if (url.endsWith("/access")) return serverUserId === userId ? json(directAccessFixture(projectId, userId, "admin")) : fail(404, "not_found");
  if (url.endsWith("/members")) return Promise.resolve(json({ actorAccess: directAccessFixture(projectId, serverUserId, "admin"), items: [participant(cookieAccount === "Alice" ? userId : otherId)] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    const oldHeading = await screen.findByRole("heading", { name: "Alice 的项目" });
    topLevelFocused = false; visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("blur"));
    cookieAccount = changed ? "Bob" : "Alice";
    serverUserId = changed ? otherId : userId;
    if (order === "focus-first") {
      topLevelFocused = true;
      fireEvent(window, new Event("focus"));
      expect(meCalls).toBe(1);
      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
    } else {
      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
      await act(async () => {});
      expect(meCalls).toBe(1);
      expect(dispatchedGraphs).toEqual([{ cookie: "Alice", label: "Alice" }]);
      topLevelFocused = true;
      fireEvent(window, new Event("focus"));
    }
    await waitFor(() => expect(meCalls).toBe(2));
    expect(dispatchedGraphs).toEqual([{ cookie: "Alice", label: "Alice" }]);
    expect(screen.getByRole("heading", { name: "Alice 的项目" })).toBe(oldHeading);
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(document.body).not.toHaveClass("auth-session-checking");
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => finishCheck(json(changed ? user(otherId, "Bob") : user())));
    const name = changed ? "Bob" : "Alice";
    await screen.findByRole("heading", { name: `${name} 的项目` });
    await waitFor(() => expect(dispatchedGraphs).toEqual([{ cookie: "Alice", label: "Alice" }, { cookie: name, label: name }]));
    expect(meCalls).toBe(2);
    if (changed) {
      expect(oldHeading.isConnected).toBe(false);
      expect(screen.queryByRole("button", { name: "账户菜单：Alice" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Alice 的项目" })).toBeNull();
    } else expect(screen.getByRole("heading", { name: "Alice 的项目" })).toBe(oldHeading);
  });

  it("evicts the old project and open detail as soon as a sync response proves another principal while identity is pending", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const waitForCacheUi = async (assertion: () => void) => {
      const deadline = nodePerformance.now() + 5_000;
      for (;;) {
        await act(async () => { await nextEventLoopTurn(); });
        try { assertion(); return; }
        catch (error) { if (nodePerformance.now() >= deadline) throw error; }
      }
    };
    const taskId = '00000000-0000-4000-8000-000000000005';
    const detail = detailFixture(projectId, taskId, { title: 'Alice-only task', description: 'Alice-only private detail' });
    const aliceGraph = { ...graphFixture([detail]), project: project('Alice 的项目') };
    let meCalls = 0;
    let finishIdentity!: (response: Response) => void;
    let identityFinished = false;
    const recheckViews: Array<{ authenticatedShell: boolean; privateDetail: boolean }> = [];
    const fetcher = vi.fn((url: string) => {
      if (url === '/api/v1/me') {
        if (++meCalls === 1) return Promise.resolve(json(user()));
        recheckViews.push({ authenticatedShell: document.querySelector('.auth-shell') !== null, privateDetail: document.body.textContent!.includes('Alice-only private detail') });
        return new Promise<Response>((resolve) => { finishIdentity = resolve; });
      }
      if (url.endsWith('/members')) return Promise.resolve(json({ actorAccess: directAccessFixture(projectId, serverUserId, "admin"), items: [participant(serverUserId)] }));
      if (isTaskSync(url)) return Promise.resolve(graphResponse(serverUserId === userId ? aliceGraph : { ...aliceGraph, project: project('Bob 的项目'), tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }, url));
      if (url === `/api/v1/projects/${projectId}/tasks/${taskId}`) return Promise.resolve(json(detail));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', `/projects/${projectId}`);
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const view = render(<AuthenticatedApp />, { container: root });
    try {
      await waitForCacheUi(() => expect(screen.getByRole('heading', { name: 'Alice 的项目' })).toBeInTheDocument());
      const heading = screen.getByRole('heading', { name: 'Alice 的项目' });
      await selectTaskList();
      fireEvent.click(screen.getByRole('tab', { name: '独立任务' }));
      fireEvent.click(screen.getByRole('button', { name: /Alice-only task/ }));
      const dialog = screen.getByRole('dialog');
      await waitForCacheUi(() => expect(within(dialog).getByText('Alice-only private detail')).toBeInTheDocument());
      serverUserId = otherId;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await waitForCacheUi(() => expect(meCalls).toBe(2));
      expect(identityFinished).toBe(false);
      expect(recheckViews).toEqual([{ authenticatedShell: false, privateDetail: false }]);
      expect(heading.isConnected).toBe(false);
      expect(dialog.isConnected).toBe(false);
      expect(document.querySelector('.auth-shell')).toBeNull();
      expect(screen.queryByText('Alice-only private detail')).toBeNull();
      expect(screen.queryByRole('button', { name: '账户菜单：Alice' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Bob 的项目' })).toBeNull();
      expect(screen.getByRole('heading', { name: '正在确认登录状态' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(2);
      expect(meCalls).toBe(2);
      await act(async () => { identityFinished = true; finishIdentity(json(user(otherId, 'Bob'))); });
      await waitForCacheUi(() => expect(screen.getByRole('heading', { name: 'Bob 的项目' })).toBeInTheDocument());
      expect(screen.queryByText('Alice-only private detail')).toBeNull();
    } finally { view.unmount(); root.remove(); }
  }, 20_000);

  it.each([null, 'invalid-principal'])("retains the authorized view and stored rows for an untrusted 404 principal header (%s)", async (principal) => {
    const taskId = '00000000-0000-4000-8000-000000000005';
    const initial = { ...graphFixture([detailFixture(projectId, taskId)]), project: project() };
    let responseMode: 'valid' | 'untrusted' | 'not-found' = 'valid';
    install((url) => {
      if (!isTaskSync(url)) return defaults(url);
      if (responseMode === 'valid') return graphResponse(initial, url);
      if (responseMode === 'not-found') return fail(404, 'not_found');
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (principal !== null) headers.set('Daynight-User-ID', principal);
      return new Response(stringifyWireJson({ error: { code: 'not_found', message: 'Untrusted resource absence.', requestId: 'untrusted-404' } }), { status: 404, headers });
    });
    window.history.replaceState(null, '', `/projects/${projectId}`);
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole('heading', { name: '私有项目' });
    const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    try {
      const before = await database.get('projects', [userId, projectId]);
      const summaries = await database.getAllFromIndex('summaries', 'by-project', [userId, projectId]);
      expect(before?.state).toBe('active');
      expect(summaries).toHaveLength(1);
      responseMode = 'untrusted';
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await screen.findByRole('heading', { name: '刷新失败' });
      expect(screen.getByText('任务图数据不完整或不一致，请重试。')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '私有项目' })).toBe(heading);
      expect(screen.queryByRole('heading', { name: '项目不存在' })).toBeNull();
      expect(await database.get('projects', [userId, projectId])).toEqual(before);
      expect(await database.getAllFromIndex('summaries', 'by-project', [userId, projectId])).toEqual(summaries);
      responseMode = 'not-found';
      fireEvent.click(screen.getByRole('button', { name: '重试刷新' }));
      await screen.findByRole('heading', { name: '项目不存在' });
      expect(screen.queryByRole('heading', { name: '私有项目' })).toBeNull();
      await waitFor(async () => expect((await database.get('projects', [userId, projectId]))?.state).toBe('invalidated'));
      expect(await database.getAllFromIndex('summaries', 'by-project', [userId, projectId])).toEqual([]);
    } finally { database.close(); }
  });

  it.each(["hidden", "unfocused"])("pauses direct-project reads when the authenticated workspace first mounts %s", async (away) => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    visibility = away === "hidden" ? "hidden" : "visible";
    topLevelFocused = false;
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => url === "/api/v1/me" && ++meCalls > 1
      ? new Promise<Response>((done) => { finishCheck = done; }) : Promise.resolve(defaults(url)));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "账户菜单：Alice" });
    await act(async () => {});
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects"))).toHaveLength(0);
    expect(meCalls).toBe(1);
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects"))).toHaveLength(0);
    topLevelFocused = true;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meCalls).toBe(2));
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects"))).toHaveLength(0);
    await act(async () => finishCheck(json(user())));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(1);
  });

  it("supersedes an identity check on departure before its response can release queued project reads", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const checks: Array<{ signal: AbortSignal; resolve: (value: ReturnType<typeof user>) => void }> = [];
    let meCalls = 0;
    vi.spyOn(auth, "me").mockImplementation((signal) => ++meCalls === 1 ? Promise.resolve(user())
      : new Promise((resolve) => { checks.push({ signal, resolve }); }));
    const fetcher = install();
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    topLevelFocused = false; visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("blur"));
    topLevelFocused = true; visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(checks).toHaveLength(1));
    topLevelFocused = false; visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    expect(checks[0]!.signal.aborted).toBe(true);
    fireEvent(window, new Event("blur"));
    await act(async () => checks[0]!.resolve(user()));
    expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(1);
    expect(meCalls).toBe(2);
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(1);
    topLevelFocused = true;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(checks).toHaveLength(2));
    await act(async () => checks[1]!.resolve(user()));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(2));
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
  });

  it("preserves the active project draft and focus throughout a delayed same-user identity check", async () => {
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => url === "/api/v1/me" && ++meCalls > 1
      ? new Promise<Response>((done) => { finishCheck = done; })
      : Promise.resolve(defaults(url)));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    const dialog = screen.getByRole("dialog", { name: "创建私有项目" });
    const name = screen.getByLabelText(/项目名称/);
    fireEvent.change(name, { target: { value: "Unsubmitted project" } });
    name.focus();
    const shell = document.querySelector(".auth-shell")!;
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(shell).toHaveAttribute("aria-hidden", "false");
    expect(shell).not.toHaveAttribute("inert");
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "创建私有项目" })).toBe(dialog);
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Continued while checking" } });
    await act(async () => finishCheck(json(user())));
    expect(document.querySelector(".auth-shell")).toBe(shell);
    expect(screen.getByRole("dialog", { name: "创建私有项目" })).toBe(dialog);
    expect(screen.getByLabelText(/项目名称/)).toBe(name);
    expect(name).toHaveValue("Continued while checking");
    expect(document.activeElement).toBe(name);
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects"))).toHaveLength(1);
  });

  it.each(["same", "changed", "expired"])("holds token metadata reads until revalidation confirms the %s session", async (outcome) => {
    window.history.replaceState(null, "", "/account");
    const projects = Promise.withResolvers<Response>();
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; });
      if (url.startsWith("/api/v1/projects?") && serverUserId === userId) return projects.promise;
      if (url === "/api/v1/me/tokens") return Promise.resolve(json({ items: [{ id: otherId, name: "Confirmed account token", createdAt: now, expiresAt: "2099-10-22T10:00:00Z" }] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "账户菜单：Alice" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "访问令牌" })); });
    expect(within(screen.getByRole("complementary", { name: "工作空间导航" })).getByText("正在加载项目")).toHaveAttribute("role", "status");
    expect(within(screen.getByRole("region", { name: "个人访问令牌" })).getByRole("status")).toHaveTextContent("正在加载访问令牌…");
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
    await act(async () => projects.resolve(defaults("/api/v1/projects")));
    serverUserId = outcome === "changed" ? otherId : userId;
    await act(async () => finishCheck(outcome === "same" ? json(user()) : outcome === "changed" ? json(user(otherId, "Bob")) : fail(401, "unauthenticated")));
    if (outcome === "same") {
      await screen.findByText("Confirmed account token");
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    } else {
      if (outcome === "changed") await screen.findByRole("button", { name: "账户菜单：Bob" });
      else await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
      expect(screen.queryByText("Confirmed account token")).toBeNull();
    }
  });

  it("holds queued reads through a failed check, retry and superseded response until the latest identity succeeds", async () => {
    window.history.replaceState(null, "", "/account");
    let meCalls = 0;
    const checks: Array<(response: Response) => void> = [];
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { checks.push(done); });
      if (url === "/api/v1/me/tokens") return Promise.resolve(json({ items: [] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "账户菜单：Alice" });
    returnFromAnotherWindow();
    await waitFor(() => expect(checks).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "访问令牌" })); });
    await act(async () => checks[0]!(fail(503, "internal")));
    await screen.findByRole("heading", { name: "暂时无法重新确认当前账户" });
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "重新确认账户" }));
    await waitFor(() => expect(checks).toHaveLength(2));
    returnFromAnotherWindow();
    await waitFor(() => expect(checks).toHaveLength(3));
    await act(async () => checks[1]!(json(user())));
    expect(document.body).toHaveClass("auth-session-checking");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
    await act(async () => checks[2]!(json(user())));
    await screen.findByText("还没有访问令牌。创建后可用于 CLI 或 Agent。");
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(1);
  });

  it("logs out during a pending identity check without dispatching queued old-account reads", async () => {
    window.history.replaceState(null, "", "/account");
    let meCalls = 0;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>(() => {});
      if (url === "/api/v1/auth/logout") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "账户菜单：Alice" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "访问令牌" })); });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/auth/logout")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
  });

  it("synchronously supersedes a pending identity check on a second external return and discards the old account when the latest check confirms Bob", async () => {
    window.history.replaceState(null, "", "/account");
    const checks: Array<{ readonly signal: AbortSignal; readonly resolve: (value: ReturnType<typeof user>) => void }> = [];
    let identityCalls = 0;
    vi.spyOn(auth, "me").mockImplementation((signal) => {
      if (++identityCalls === 1) return Promise.resolve(user());
      return new Promise<ReturnType<typeof user>>((resolve) => { checks.push({ signal, resolve }); });
    });
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(url === "/api/v1/me/tokens"
      ? options?.method === "POST" ? json({ id: otherId, name: "Device", createdAt: now, expiresAt: "2099-10-22T10:00:00Z", token: "alice-once-only" }, 201) : json({ items: [] })
      : defaults(url)));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "访问令牌" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建令牌" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "Device" } });
    fireEvent.submit(document.getElementById("create-token-form")!);
    const reveal = await screen.findByRole("dialog", { name: "访问令牌已创建" });
    returnFromAnotherWindow();
    await waitFor(() => expect(checks).toHaveLength(1));
    const stale = checks[0]!;
    let abortedDuringReturn = false;
    const finishStaleDuringReturn = () => {
      abortedDuringReturn = stale.signal.aborted;
      stale.resolve(user());
    };
    window.addEventListener("focus", finishStaleDuringReturn);
    try { returnFromAnotherWindow(); }
    finally { window.removeEventListener("focus", finishStaleDuringReturn); }
    expect(abortedDuringReturn).toBe(true);
    await waitFor(() => expect(checks).toHaveLength(2));
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "访问令牌已创建" })).toBe(reveal);
    expect(reveal.isConnected).toBe(true);
    serverUserId = otherId;
    await act(async () => checks[1]!.resolve(user(otherId, "Bob")));
    await screen.findByRole("button", { name: "账户菜单：Bob" });
    expect(reveal.isConnected).toBe(false);
    expect(screen.queryByLabelText("一次性访问令牌")).toBeNull();
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(identityCalls).toBe(3);
  });

  it("starts a fresh identity check on a qualified external return after revalidation failed", async () => {
    let identityCalls = 0;
    let finishRetry!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/v1/me" && ++identityCalls > 1
      ? identityCalls === 2 ? Promise.resolve(fail(503, "internal")) : new Promise<Response>((done) => { finishRetry = done; })
      : Promise.resolve(defaults(url))));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    returnFromAnotherWindow();
    await screen.findByRole("heading", { name: "暂时无法重新确认当前账户" });
    expect(document.body).toHaveClass("auth-session-checking");
    returnFromAnotherWindow();
    await waitFor(() => expect(identityCalls).toBe(3));
    expect(document.body).toHaveClass("auth-session-checking");
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "重新确认当前账户" })).toBeInTheDocument();
    serverUserId = otherId;
    await act(async () => finishRetry(json(user(otherId, "Bob"))));
    await screen.findByRole("button", { name: "账户菜单：Bob" });
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(identityCalls).toBe(3);
  });

  it("replaces the workspace when revalidation confirms a different identity and ignores late old data", async () => {
    let currentUser = user();
    let pendingProject!: (response: Response) => void;
    let pendingMe!: (response: Response) => void;
    let projectCalls = 0;
    const fetcher = vi.fn((url: string, _options?: RequestInit) => {
      if (url === "/api/v1/me") return currentUser.id === userId ? Promise.resolve(json(currentUser)) : new Promise<Response>((done) => { pendingMe = done; });
      if (url.startsWith("/api/v1/projects")) {
        projectCalls++;
        if (projectCalls === 1) return new Promise<Response>((done) => { pendingProject = done; });
        return Promise.resolve(json({ items: [project("Bob 的项目")], nextCursor: null }));
      }
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "账户菜单：Alice" });
    await waitFor(() => expect(projectCalls).toBe(1));
    const oldSignal = fetcher.mock.calls.find(([url]) => url.startsWith("/api/v1/projects"))![1]!.signal!;
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(oldSignal.aborted).toBe(false);
    expect(pendingProject).toBeTypeOf("function");
    expect(screen.getByRole("status", { name: "正在加载项目" })).toBeInTheDocument();

    currentUser = user(otherId, "Bob");
    serverUserId = otherId;
    returnFromAnotherWindow();
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(document.body).not.toHaveClass("auth-session-checking");
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(2));
    expect(pendingMe).toBeTypeOf("function");
    await act(async () => pendingMe(json(currentUser)));
    await screen.findByRole("heading", { name: "Bob 的项目" });
    await act(async () => pendingProject(json({ items: [project("Alice 的旧项目")], nextCursor: null }, 200, userId)));
    expect(screen.queryByRole("heading", { name: "Alice 的旧项目" })).toBeNull();
    expect(screen.getByRole("button", { name: "账户菜单：Bob" })).toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
  });

  it("clears the workspace when a background identity check confirms an expired session", async () => {
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/v1/me" && ++meCalls > 1
      ? new Promise<Response>((done) => { finishCheck = done; })
      : Promise.resolve(defaults(url))));
    render(<AuthenticatedApp />);
    const project = await screen.findByRole("heading", { name: "私有项目" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(project);
    await act(async () => finishCheck(fail(401, "unauthenticated")));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(screen.getByText("登录状态已过期。重新登录后可继续访问项目。")).toBeInTheDocument();
    expect(project.isConnected).toBe(false);
    expect(screen.queryByRole("button", { name: "账户菜单：Alice" })).toBeNull();
    expect(document.body).not.toHaveClass("auth-session-checking");
  });

  it("keeps a one-time PAT reveal mounted through same-user focus revalidation", async () => {
    window.history.replaceState(null, "", "/account");
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === "/api/v1/me") { meCalls++; return meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; }); }
      if (url === "/api/v1/me/tokens") return Promise.resolve(options?.method === "POST"
        ? json({ id: otherId, name: "Device", createdAt: now, expiresAt: "2099-10-22T10:00:00Z", token: "once-only-secret" }, 201)
        : json({ items: [] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "访问令牌" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建令牌" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "Device" } });
    fireEvent.submit(document.getElementById("create-token-form")!);
    const reveal = await screen.findByRole("dialog", { name: "访问令牌已创建" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "访问令牌已创建" })).toBe(reveal);
    expect(document.activeElement).toBe(screen.getByLabelText("一次性访问令牌"));
    expect(reveal.isConnected).toBe(true);
    await act(async () => finishCheck(fail(503, "internal")));
    expect(document.body).toHaveClass("auth-session-checking");
    const overlay = screen.getByRole("dialog", { name: "重新确认当前账户" });
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(screen.queryByText("关闭后无法恢复这份令牌。请确认你已保存。")).toBeNull();
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(overlay, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(reveal.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新确认账户" }));
    await waitFor(() => expect(meCalls).toBe(3));
    expect(document.body).toHaveClass("auth-session-checking");
    expect(document.querySelector(".auth-shell")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".auth-shell")).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "重新确认当前账户" })).toBe(overlay);
    await act(async () => finishCheck(json(user())));
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(screen.getByRole("dialog", { name: "访问令牌已创建" })).toBe(reveal);
    expect(screen.getByLabelText("一次性访问令牌")).toHaveValue("once-only-secret");
    expect(document.activeElement).toBe(screen.getByLabelText("一次性访问令牌"));
  });

  it("preserves a pending project creation on same-user focus and surfaces revalidation failure", async () => {
    let complete!: (response: Response) => void;
    let meCalls = 0;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === "/api/v1/me") return Promise.resolve(++meCalls === 2 ? fail(503, "internal") : json(user()));
      if (url === "/api/v1/projects" && options?.method === "POST") return new Promise<Response>((done) => { complete = done; });
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "Pending" } });
    fireEvent.change(screen.getByLabelText(/仓库地址/), { target: { value: "git@github.com:example/repo.git" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const dialog = screen.getByRole("dialog", { name: "创建私有项目" });
    const signal = fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!.signal!;
    returnFromAnotherWindow();
    await screen.findByRole("heading", { name: "暂时无法重新确认当前账户" });
    expect(document.body).toHaveClass("auth-session-checking");
    expect(screen.queryByRole("dialog", { name: "创建私有项目" })).toBeNull();
    expect(dialog.isConnected).toBe(true);
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "重新确认账户" }));
    await waitFor(() => expect(meCalls).toBe(3));
    await waitFor(() => expect(document.body).not.toHaveClass("auth-session-checking"));
    expect(screen.getByRole("dialog", { name: "创建私有项目" })).toBe(dialog);
    await act(async () => complete(json(createdProject("Pending", "git@github.com:example/repo.git"), 201)));
    await screen.findByRole("heading", { name: "私有项目" });
  });

  it("drops private project navigation context when another account is confirmed", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let switched = false;
    install((url) => {
      if (url === "/api/v1/me") return json(switched ? user(otherId, "Bob") : user());
      if (switched && url.endsWith("/members")) return fail(404, "not_found");
      if (switched && url.startsWith("/api/v1/projects?")) return json({ items: [], nextCursor: null });
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("link", { name: "项目成员" }));
    await screen.findByRole("heading", { name: "项目成员" });
    expect(document.body.textContent).toContain("私有项目");
    switched = true;
    serverUserId = otherId;
    returnFromAnotherWindow();
    await screen.findByRole("button", { name: "账户菜单：Bob" });
    await waitFor(() => expect(document.body.textContent).not.toContain("私有项目"));
    expect(document.body.textContent).not.toContain("私有项目");
  });

  it("clears all workspace data on a real resource401 while keeping project404 local", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let denied = false;
    install((url) => isTaskSync(url) && denied ? fail(404, "not_found") : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("heading", { name: "项目不存在" });
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(isTaskSync(url) ? fail(401, "unauthenticated") : defaults(url))));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(screen.getByText("登录状态已过期。重新登录后可继续访问项目。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "账户菜单：Alice" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "项目不存在" })).toBeNull();
  });

  it("clears projects immediately when logout fails and offers an explicit retry", async () => {
    let failed = true;
    install((url) => url === "/api/v1/auth/logout" ? failed ? fail(503, "internal") : new Response(null, { status: 204 }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    failed = false;
    fireEvent.click(await screen.findByRole("button", { name: "重试退出登录" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("clears the workspace and stops automatic graph reads after a resource401", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let expired = false;
    const fetcher = install((url) => expired && isTaskSync(url) ? fail(401, "unauthenticated") : defaults(url));
    const initialSync = Promise.withResolvers<void>();
    const applySync = TaskCacheScope.prototype.applySync;
    vi.spyOn(TaskCacheScope.prototype, "applySync").mockImplementation(function (this: TaskCacheScope, ...args) {
      const result = applySync.apply(this, args);
      void result.then(() => initialSync.resolve(), initialSync.reject);
      return result;
    });
    await act(async () => { render(<AuthenticatedApp />); });
    await act(async () => initialSync.promise);
    expect(screen.getByRole("heading", { name: "私有项目" })).toBeInTheDocument();
    expired = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    const graphReads = () => fetcher.mock.calls.filter(([url]) => isTaskSync(url)).length;
    expect(graphReads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(graphReads()).toBe(2);
  });

  it("shows the authoritative live access independently of the member roster", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    install((url) => isTaskSync(url) ? taskSyncResponse({ observedAt: now, project: project(), tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }, { viewerId: userId, versionForTask: () => 1n, actorAccess: directAccessFixture(projectId, userId, "member") }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    expect(await screen.findByText("成员", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "项目成员" })).toHaveAttribute("href", `/projects/${projectId}/members`);
  });

  it("submits task status through the core API and retains pending ownership across standalone attachment navigation", async () => {
    const taskId = "00000000-0000-4000-8000-000000000005";
    const taskUrl = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    let started = false;
    let finishStatus!: (response: Response) => void;
    const detail = () => ({ assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, id: taskId, projectId, title: "Lifecycle task", description: "Reviewed lifecycle content", properties: { pullRequests: [] },
      status: started ? "in_progress" : "todo", version: started ? 8 : 7, dependsOn: [], blockedBy: [], ready: !started, createdAt: now, updatedAt: now });
    const taskGraph = (): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [{ assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, id: taskId, titlePreview: "Lifecycle task", titleTruncated: false,
      status: started ? "in_progress" : "todo", dependsOn: [], blockedBy: [], ready: !started, createdAt: now, updatedAt: now }],
      summary: { total: 1, todo: started ? 0 : 1, inProgress: started ? 1 : 0, done: 0, ready: started ? 0 : 1, blocked: 0 } });
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === `${taskUrl}/status`) return new Promise<Response>((done) => { finishStatus = done; });
      if (url === `${taskUrl}/attachments?limit=100`) return Promise.resolve(json({ items: [{ path: "docs/guide.md", contentType: "text/markdown", sizeBytes: 12, createdAt: now, updatedAt: now }], nextCursor: null }));
      if (url === `${taskUrl}/attachments/files/docs/guide.md`) return Promise.resolve(new Response("# Status reference"));
      if (url === taskUrl) return Promise.resolve(json(detail()));
      return Promise.resolve(isTaskSync(url) ? graphResponse(taskGraph(), url, started ? 8n : 7n) : defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const view = render(<AuthenticatedApp />, { container: root });
    try {
      await screen.findByRole("heading", { name: "私有项目" });
      await selectTaskList();
      fireEvent.click(screen.getByRole("tab", { name: "独立任务" }));
      fireEvent.click(screen.getByRole("button", { name: /Lifecycle task/ }));
      let dialog = screen.getByRole("dialog");
      await within(dialog).findByRole("heading", { name: "Lifecycle task" });
      fireEvent.click(within(dialog).getByRole("button", { name: "待处理" }));
      fireEvent.click(within(dialog).getByRole("menuitemradio", { name: "进行中" }));
      fireEvent.click(within(screen.getByRole("alertdialog", { name: "设置任务状态" })).getByRole("button", { name: "确认设置" }));
      await waitFor(() => expect(finishStatus).toBeTypeOf("function"));
      const submitted = fetcher.mock.calls.find(([url]) => url === `${taskUrl}/status`)![1]!;
      expect(submitted).toMatchObject({ method: "PUT", body: '{"version":7,"status":"in_progress"}', credentials: "same-origin", redirect: "error" });
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭任务详情" }));
      act(() => { window.history.pushState(null, "", `/projects/${projectId}/tasks/${taskId}/attachments/docs/guide.md`); window.dispatchEvent(new PopStateEvent("popstate")); });
      await screen.findByRole("heading", { name: "Status reference" });
      act(() => { window.history.pushState(null, "", `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent("popstate")); });
      await screen.findByRole("heading", { name: "私有项目" });
      await selectTaskList();
      fireEvent.click(screen.getByRole("tab", { name: "独立任务" }));
      fireEvent.click(screen.getByRole("button", { name: /Lifecycle task/ }));
      dialog = screen.getByRole("dialog");
      expect(await within(dialog).findByRole("button", { name: "待处理" })).toBeDisabled();
      expect(fetcher.mock.calls.filter(([url]) => url === taskUrl)).toHaveLength(1);
      expect(fetcher.mock.calls.filter(([url]) => url === `${taskUrl}/status`)).toHaveLength(1);
      started = true;
      await act(async () => finishStatus(json(detail())));
      await within(dialog).findByRole("button", { name: "进行中" });
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "进行中" })).toBeEnabled());
    } finally { view.unmount(); root.remove(); }
  });

  it("handles valid account, membership and malformed routes", () => {
    expect(parseAuthRoute("/account")).toEqual({ kind: "account" });
    expect(parseAuthRoute(`/projects/${projectId}/members`)).toEqual({ kind: "members", projectId });
    expect(parseAuthRoute("/projects/%E0%A4%A")).toEqual({ kind: "notFound" });
    expect(parseAuthRoute("/projects/no/members")).toEqual({ kind: "notFound" });
    expect(parseAuthRoute("/unknown")).toEqual({ kind: "notFound" });
  });
});

describe("authenticated standalone attachment reader", () => {
  const taskId = "00000000-0000-4000-8000-000000000004";
  const location = (path: string) => `/projects/${projectId}/tasks/${taskId}/attachments/${path}`;
  const inventory = (path: string, contentType = "text/markdown") => json({ items: [{ path, contentType, sizeBytes: 12, createdAt: now, updatedAt: now }], nextCursor: null });

  it("uses canonical resource routing while retaining account, invitation and member extensions", () => {
    const valid = location("docs/%E6%8C%87%E5%8D%97%20v1.md");
    expect(parseAuthRoute(valid)).toEqual(parseRoute(valid));
    expect(parseAuthRoute(valid)).toMatchObject({ kind: "attachment", projectId, taskId, path: "docs/指南 v1.md" });
    for (const malformed of [location("docs%2Fguide.md"), location("../secret.md"), location("%E0%A4%A"), `/projects/no/tasks/${taskId}/attachments/a.md`]) {
      expect(parseAuthRoute(malformed)).toEqual({ kind: "notFound" });
    }
    expect(parseAuthRoute("/account")).toEqual({ kind: "account" });
    expect(parseAuthRoute("/invitations")).toEqual({ kind: "invitations" });
    expect(parseAuthRoute(`/projects/${projectId}/members`)).toEqual({ kind: "members", projectId });
  });

  it("checks the session before opening a deep link outside workspace chrome and keeps the reader on a locale change", async () => {
    window.history.replaceState(null, "", location("docs/guide.md"));
    let identify!: (response: Response) => void;
    const fetcher = vi.fn(withDetailResources(projectId, taskId, (url: string) => url === "/api/v1/me" ? new Promise<Response>((done) => { identify = done; })
      : Promise.resolve(url.includes("/attachments?") ? inventory("docs/guide.md") : new Response("# Authenticated document"))));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => identify(json(user())));
    await screen.findByRole("heading", { name: "Authenticated document" });
    expect(document.querySelector(".shell")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.title).toBe("任务详情 · Daynight");
    const reader = screen.getByRole("main");
    fireEvent.change(screen.getByRole("combobox", { name: "语言 / Language" }), { target: { value: "en" } });
    expect(document.title).toBe("Task details · Daynight");
    expect(screen.getByRole("main")).toBe(reader);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/files/docs/guide.md`);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("keeps the authenticated attachment controller and panel mounted through same-task history", async () => {
    window.history.replaceState(null, "", location("docs/guide.md"));
    const items = ["docs/guide.md", "next.txt"].map((path) => ({ path, contentType: "text/plain", sizeBytes: 12, createdAt: now, updatedAt: now }));
    const fetcher = install(withDetailResources(projectId, taskId, (url) => url.includes("/attachments?") ? json({ items, nextCursor: null }) : url.endsWith("/attachments/files/docs/guide.md") ? new Response("First authenticated file") : url.endsWith("/attachments/files/next.txt") ? new Response("Next authenticated file") : defaults(url)));
    render(<AuthenticatedApp />);
    await screen.findByText("First authenticated file");
    const panel = document.querySelector(".task-attachments");
    fireEvent.click(screen.getByRole("button", { name: /^next\.txt/ }));
    await screen.findByText("Next authenticated file");
    expect(window.location.pathname).toBe(location("next.txt"));
    expect(document.querySelector(".task-attachments")).toBe(panel);
    await act(async () => { window.history.back(); });
    await screen.findByText("First authenticated file");
    expect(document.querySelector(".task-attachments")).toBe(panel);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/attachments?"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("retains the same-origin HTML frame through same-user revalidation and removes it on an account change", async () => {
    window.history.replaceState(null, "", location("site/index.html"));
    let identify!: (response: Response) => void;
    let meCalls = 0;
    let bob = false;
    const fetcher = vi.fn(withDetailResources(projectId, taskId, (url: string, options?: RequestInit) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { identify = done; });
      if (url.includes("/attachments?")) return Promise.resolve(bob ? fail(404, "not_found") : inventory("site/index.html", "text/html"));
      if (options?.method === "HEAD") return Promise.resolve(new Response(null));
      throw new Error(`Unexpected request ${url}`);
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    const frame = await screen.findByTitle("HTML 预览：site/index.html");
    expect(frame).toHaveAttribute("src", `/api/v1/projects/${projectId}/tasks/${taskId}/preview/site/index.html`);
    returnFromAnotherWindow();
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(frame.isConnected).toBe(true);
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => identify(json(user())));
    expect(screen.getByTitle("HTML 预览：site/index.html")).toBe(frame);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "HEAD")).toHaveLength(1);
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(3));
    bob = true;
    serverUserId = otherId;
    await act(async () => identify(json(user(otherId, "Bob"))));
    await within(await screen.findByRole("group", { name: "附件预览" })).findByRole("alert");
    expect(frame.isConnected).toBe(false);
    expect(screen.queryByTitle("HTML 预览：site/index.html")).toBeNull();
    expect(screen.queryByRole("heading", { name: "登录你的工作空间" })).toBeNull();
  });

  it.each([404, 401])("keeps resource404 local and applies the global boundary to resource401 (%i)", async (status) => {
    window.history.replaceState(null, "", location("docs/guide.md"));
    install(withDetailResources(projectId, taskId, (url) => url.includes("/attachments?") ? fail(status, status === 401 ? "unauthenticated" : "not_found") : defaults(url)));
    render(<AuthenticatedApp />);
    if (status === 401) {
      await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(screen.queryByRole("heading", { name: "docs/guide.md" })).toBeNull();
      expect(document.querySelector(".task-detail-page")).toBeNull();
    } else {
      await within(await screen.findByRole("group", { name: "附件预览" })).findByRole("alert");
      expect(screen.getByRole("heading", { name: "完整任务详情" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "登录你的工作空间" })).toBeNull();
      expect(document.title).toBe("任务详情 · Daynight");
    }
  });
});

describe("invitation handoff", () => {
  it.each(["same", "changed", "expired"])("holds invitation acceptance until revalidation confirms the %s session", async (outcome) => {
    window.history.replaceState(null, "", "/invitations#pending-account-secret");
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; });
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId, projectName: "受邀项目", directGrant: null, access: null }));
      if (url === "/api/v1/invitations/accept") return Promise.resolve(json({ projectId, directGrant: directAccessFixture(projectId, userId).directGrant, access: directAccessFixture(projectId, userId), joined: true, consumed: true }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "受邀项目" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" })); });
    expect(screen.getByRole("button", { name: "正在加入…" })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
    expect(document.body).not.toHaveClass("auth-session-checking");
    serverUserId = outcome === "changed" ? otherId : userId;
    await act(async () => finishCheck(outcome === "same" ? json(user()) : outcome === "changed" ? json(user(otherId, "Bob")) : fail(401, "unauthenticated")));
    if (outcome === "same") {
      await screen.findByRole("heading", { name: "私有项目" });
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(1);
    } else {
      if (outcome === "changed") {
        await screen.findByRole("heading", { name: "邀请已不可用" });
        expect(screen.queryByText("Bob", { selector: ".person-name" })).toBeNull();
      } else await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(window.location.pathname).toBe(outcome === "expired" ? "/login" : "/invitations");
      if (outcome === "expired") expect(new URLSearchParams(window.location.search).get("returnPath")).toBe("/invitations");
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
      expect(window.sessionStorage.getItem(invitationStorageKey)).toBe(outcome === "expired" ? "pending-account-secret" : null);
    }
  });

  it("clears the fragment before any fetch and only accepts after explicit confirmation", async () => {
    window.history.replaceState(null, "", "/invitations#secret-one");
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      expect(window.location.hash).toBe("");
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId, projectName: "受邀项目", directGrant: null, access: null }));
      if (url === "/api/v1/invitations/accept") return Promise.resolve(json({ projectId, directGrant: directAccessFixture(projectId, userId).directGrant, access: directAccessFixture(projectId, userId), joined: true, consumed: true }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "受邀项目" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url.includes("accept"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    const accept = fetcher.mock.calls.find(([url]) => url.endsWith("/accept"))!;
    expect(accept[1]?.body).toBe(JSON.stringify({ token: 'secret-one', expectedUserId: userId }));
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("secret-one");
  });

  it.each(["hashchange", "popstate"])("captures a second invitation synchronously on %s and cancels prior acceptance", async (eventName) => {
    window.history.replaceState(null, "", "/invitations#first-secret");
    let finishOld!: (response: Response) => void;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      const body = options?.body === undefined ? null : JSON.parse(String(options.body)) as { token: string };
      if (url.endsWith("/inspect")) return Promise.resolve(json({ projectId, projectName: body?.token === "first-secret" ? "第一个项目" : "第二个项目", directGrant: null, access: null }));
      if (url.endsWith("/accept")) return body?.token === "first-secret" ? new Promise<Response>((done) => { finishOld = done; }) : Promise.resolve(json({ projectId, directGrant: directAccessFixture(projectId, userId).directGrant, access: directAccessFixture(projectId, userId), joined: true, consumed: true }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "第一个项目" });
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(true));
    const previousSignal = fetcher.mock.calls.find(([url]) => url.endsWith("/accept"))![1]!.signal!;
    window.history.pushState(null, "", "/invitations#second-secret");
    fireEvent(window, new Event(eventName));
    expect(window.location.hash).toBe("");
    expect(previousSignal.aborted).toBe(true);
    await screen.findByRole("heading", { name: "第二个项目" });
    await act(async () => finishOld(json({ projectId, directGrant: directAccessFixture(projectId, userId).directGrant, access: directAccessFixture(projectId, userId), joined: true, consumed: true })));
    expect(window.location.pathname).toBe("/invitations");
    expect(screen.getByRole("heading", { name: "第二个项目" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept")).map(([, options]) => options?.body)).toEqual([JSON.stringify({ token: 'first-secret', expectedUserId: userId }), JSON.stringify({ token: 'second-secret', expectedUserId: userId })]);
  });

  it("keeps an unknown acceptance result visible after reading current access without replaying it", async () => {
    window.history.replaceState(null, "", "/invitations#unknown-secret");
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId, projectName: "受邀项目", directGrant: null, access: null }));
      if (url === "/api/v1/invitations/accept") return Promise.reject(new Error("unknown-secret"));
      if (url.endsWith("/access")) return Promise.resolve(json(directAccessFixture(projectId, userId)));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "接受邀请并加入" }));
    await screen.findByText(/尚未确认加入结果/);
    expect(screen.getByRole("button", { name: "接受邀请并加入" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "检查项目访问权限" }));
    await screen.findByRole("button", { name: "打开项目" });
    expect(screen.getByText(/尚未确认加入结果/)).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(1);
    expect(document.body.textContent).not.toContain("unknown-secret");
  });

  it("retains an unknown result when access and invitation are now unavailable", async () => {
    window.history.replaceState(null, "", "/invitations#unknown-unavailable");
    let inspections = 0;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(++inspections === 1 ? json({ projectId, projectName: "受邀项目", directGrant: null, access: null }) : fail(404, "invitation_unavailable"));
      if (url === "/api/v1/invitations/accept") return Promise.reject(new Error("network"));
      if (url.endsWith("/access")) return Promise.resolve(fail(404, "not_found"));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "接受邀请并加入" }));
    await screen.findByText(/尚未确认加入结果/);
    fireEvent.click(screen.getByRole("button", { name: "检查项目访问权限" }));
    await screen.findByText(/邀请目前不可用；原操作结果仍未确认/);
    expect(screen.getByText(/尚未确认加入结果/)).toBeVisible();
    expect(screen.getByRole("button", { name: "接受邀请并加入" })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(1);
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
  });

  it("does not discard a secret for an untrusted 404 response", async () => {
    window.history.replaceState(null, "", "/invitations#untrusted-secret");
    install((url) => url.endsWith("/inspect") ? new Response(JSON.stringify({ error: { code: "invitation_unavailable", message: "hidden", requestId: "safe" } }), { status: 404, headers: { "Content-Type": "application/json" } }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "邀请暂时无法加载" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
  });

  it("restores the tab invitation after login, supports cancellation, and drops unavailable secrets", async () => {
    window.sessionStorage.setItem(invitationStorageKey, "secret-persisted");
    window.history.replaceState(null, "", "/invitations");
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "待确认项目", directGrant: null, access: null }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "待确认项目" });
    fireEvent.click(screen.getByRole("button", { name: "暂不加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
  });

  it("shows unavailable invitations without leaking or retaining their secret", async () => {
    window.history.replaceState(null, "", "/invitations#expired-secret");
    install((url) => url.endsWith("/inspect") ? fail(410, "invitation_unavailable") : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "邀请已不可用" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("expired-secret");
    expect(document.body.textContent).not.toContain("hidden server details");
  });

  it("does not consume an invitation for an existing member", async () => {
    window.history.replaceState(null, "", "/invitations#existing-secret");
    const fetcher = install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目", directGrant: directAccessFixture(projectId, userId).directGrant, access: directAccessFixture(projectId, userId) }) : defaults(url));
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "打开项目" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(false);
  });

  it("erases a retained invitation value when removeItem is unavailable", async () => {
    window.history.replaceState(null, "", "/invitations#cleanup-secret");
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目", directGrant: null, access: null }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "受邀项目" });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked removal"); });
    fireEvent.click(screen.getByRole("button", { name: "暂不加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBe("");
    expect(document.body.textContent).not.toContain("cleanup-secret");
  });

  it("exposes a blocked terminal cleanup while clearing the in-memory invitation", async () => {
    window.history.replaceState(null, "", "/invitations#blocked-secret");
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目", directGrant: null, access: null }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "受邀项目" });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked removal"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked writes"); });
    fireEvent.click(screen.getByRole("button", { name: "暂不加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(screen.getByText("浏览器无法清除邀请临时数据。请关闭此标签页以清除邀请。")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("blocked-secret");
  });

  it("reports storage restrictions while preserving a clean login return URL", async () => {
    window.history.replaceState(null, "", "/invitations#tab-secret");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked"); });
    install((url) => url === "/api/v1/me" ? fail(401, "unauthenticated") : defaults(url));
    const login = vi.fn();
    render(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
    expect(screen.getByText("浏览器无法保存邀请。登录后请重新打开邀请链接。")).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith("/api/v1/auth/login?provider=github&returnPath=%2Finvitations");
    expect(window.location.hash).toBe("");
  });
});

describe("Team invitation handoff", () => {
  const teamId = "00000000-0000-4000-8000-000000000004";
  const team = { id: teamId, kind: "ordinary", name: "协作团队" };
  const membership = { teamId, userId, role: "member", version: 9_007_199_254_740_993n, createdAt: now, updatedAt: now };

  it("captures a Team secret, confirms the current account and retains the actual acceptance receipt", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_secret");
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      expect(window.location.hash).toBe("");
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(json({ team, membership: null }));
      if (url === "/api/v1/team-invitations/accept") return Promise.resolve(json({ team, membership, joined: true, consumed: true }));
      if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(json({ ...team, version: 1n, createdAt: now, updatedAt: now, membership }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "协作团队" });
    expect(screen.getByText("Alice", { selector: ".person-name" })).toBeVisible();
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "你已加入此 Team" });
    expect(screen.getByText(`Team ID: ${teamId}`)).toBeVisible();
    expect(fetcher.mock.calls.find(([url]) => url.endsWith("/accept"))?.[1]?.body).toBe(JSON.stringify({ token: "dnteam_secret", expectedUserId: userId }));
    expect(window.location.pathname).toBe("/team-invitations");
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("dnteam_secret");
    const open = screen.getByRole("link", { name: "打开 Team" });
    expect(open).toHaveAttribute("href", `/teams/${teamId}`);
    fireEvent.click(open);
    await screen.findByRole("heading", { name: "协作团队" });
    expect(window.location.pathname).toBe(`/teams/${teamId}`);
    await waitFor(() => expect(window.localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(teamId));
  });

  it("preserves an existing admin role in the confirmed no-consume receipt", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_existing");
    const admin = { ...membership, role: "admin" };
    install((url) => url.endsWith("/inspect") ? json({ team, membership: admin }) : url.endsWith("/accept") ? json({ team, membership: admin, joined: false, consumed: false }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "你已经是 Team 成员" });
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "你已经是此 Team 的成员" });
    expect(screen.getByText("当前角色: 管理员")).toBeVisible();
  });

  it("keeps an uncertain result and never replays or presents a success", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_unknown");
    let inspections = 0;
    const fetcher = install((url) => url.endsWith("/inspect") ? ++inspections === 1 ? json({ team, membership: null }) : json({ team, membership }) : url.endsWith("/accept") ? Promise.reject(new Error("dnteam_unknown")) : defaults(url));
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "接受邀请并加入" }));
    await screen.findByText(/加入结果尚未确认/);
    fireEvent.click(screen.getByRole("button", { name: "查看邀请状态" }));
    await screen.findByRole("heading", { name: "你已经是 Team 成员" });
    expect(screen.getByText(/加入结果尚未确认/)).toBeVisible();
    expect(screen.getByRole("button", { name: "接受邀请并加入" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "你已加入此 Team" })).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(1);
  });

  it("discards a Team invitation when foreground identity revalidation finds another user", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_changed");
    let meCount = 0;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return Promise.resolve(json(++meCount === 1 ? user() : user(otherId, "Bob")));
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(json({ team, membership: null }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "协作团队" });
    returnFromAnotherWindow();
    await screen.findByRole("heading", { name: "邀请已不可用" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("dnteam_changed");
  });

  it("discards the Team secret when an inspection proves a different response principal", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_identity");
    let meCount = 0;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return Promise.resolve(json(++meCount === 1 ? user() : user(otherId, "Bob")));
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(json({ team, membership: null }, 200, otherId));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "邀请已不可用" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("dnteam_identity");
  });

  it("retains a Team invitation across account switching and clears the login copy on return", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_switch");
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(json({ team, membership: null }));
      if (url === "/api/v1/auth/logout") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "协作团队" });
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "切换账户" }));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBe("dnteam_switch");
    view.unmount();
    window.history.replaceState(null, "", "/team-invitations");
    serverUserId = otherId;
    render(<AuthenticatedApp />);
    await screen.findByText("Bob", { selector: ".person-name" });
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
  });

  it("retains the Team secret through an anonymous login return without mixing project secrets", async () => {
    window.sessionStorage.setItem(invitationStorageKey, "project-secret");
    window.history.replaceState(null, "", "/team-invitations#dnteam_login");
    install((url) => url === "/api/v1/me" ? fail(401, "unauthenticated") : defaults(url));
    const login = vi.fn();
    render(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
    expect(login).toHaveBeenCalledWith("/api/v1/auth/login?provider=github&returnPath=%2Fteam-invitations");
    expect(window.sessionStorage.getItem(teamInvitationStorageKey)).toBe("dnteam_login");
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

describe("private project creation", () => {
  it("submits required fields, navigates to the created project, and restores native dialog cancellation", async () => {
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(url === "/api/v1/projects" && options?.method === "POST" ? json(createdProject("  新项目  ", "git@github.com:example/repo.git"), 201) : defaults(url)));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    const dialog = screen.getByRole("dialog", { name: "创建私有项目" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "项目名称 *" }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "  新项目  " } });
    const repository = screen.getByLabelText(/仓库地址/) as HTMLInputElement;
    expect(repository.checkValidity()).toBe(false);
    fireEvent.change(repository, { target: { value: "git@github.com:example/repo.git" } });
    expect(repository.checkValidity()).toBe(true);
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    await waitFor(() => expect(window.location.pathname).toBe(`/projects/${projectId}`));
    expect(fetcher.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.body).toBe(JSON.stringify({ name: "  新项目  ", repoUrl: "git@github.com:example/repo.git", expectedUserId: userId, teamId: user().personalTeam.id }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a failed submission recoverable and handles whitespace input without an unhandled rejection", async () => {
    install();
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText(/仓库地址/), { target: { value: "https://github.com/example/repo" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    await screen.findByText("项目创建失败，请检查输入后重试。");
    expect(screen.getByRole("button", { name: "创建项目" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it('clears cold Bot draft and receipt namespaces on an account change outside the Bot page', async () => {
  install(); render(<AuthenticatedApp />);
  await screen.findByRole('complementary', { name: '工作空间导航' });
  const key = `daynight:bot-session:${JSON.stringify([userId, 'bot', 'session', 'execution'])}:draft`;
  window.sessionStorage.setItem(key, 'private draft');
  const displayKey = `daynight.web.session.display.v1:${JSON.stringify([userId, 'session'])}`;
  window.localStorage.setItem(displayKey, '"standard"');
  const creationKey = `daynight.bot.creation:${userId}`;
  window.sessionStorage.setItem(creationKey, '20000000-0000-4000-8000-000000000001');
  serverUserId = otherId; returnFromAnotherWindow();
  await screen.findByText('Bob');
  await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  expect(window.localStorage.getItem(displayKey)).toBeNull();
  expect(window.sessionStorage.getItem(creationKey)).toBeNull();
});
