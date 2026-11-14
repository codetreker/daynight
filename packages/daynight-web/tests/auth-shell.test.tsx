import { selectTaskList } from './helpers/projectViews';
import { detailFixture, graphFixture, withDetailResources as withTestDetailResources } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, taskSyncQuery, taskSyncResponse, viewerHeaders, fixtureTaskEpoch } from './helpers/taskSync';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { createTaskCacheScope, TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import type { TaskGraph } from '../src/api/types';
import { stringifyWireJson } from "./helpers/wireJson";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { waitForState } from "./helpers/waitForState";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/api/auth";
import { retryImageDraftScopeCleanup } from '../src/features/task-agent-session/drafts/draft-store-cleanup';
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import * as taskGraphHook from '../src/features/projects/useTaskGraph';
import { navigate, parseRoute } from "../src/app/router";
import userEvent from "@testing-library/user-event";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { invitationStorageKey, teamInvitationStorageKey } from "../src/features/auth/invitation";
import { SIDEBAR_STORAGE_KEY } from "../src/app/useSidebarPreference";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import { personalTeamPage } from "./helpers/team";

afterEach(async () => { vi.restoreAllMocks(); await retryImageDraftScopeCleanup(); });

const render = createLocaleRender("zh-CN");
const tokenPanel = () => within(screen.getByRole("region", { name: "个人访问令牌" }));
let topLevelFocused = true;
let visibility: DocumentVisibilityState = "visible";
const returnFromAnotherWindow = () => {
  topLevelFocused = false;
  fireEvent(window, new Event("blur"));
  topLevelFocused = true;
  fireEvent(window, new Event("focus"));
};

const accountChange = (id: string | null) => act(() => {
  localStorage.setItem("daynight.activeUser", JSON.stringify(id));
  window.dispatchEvent(new StorageEvent("storage", { key: "daynight.activeUser" }));
});

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
const json = (body: unknown, status = 200, principal = serverUserId) => {
  const headers = status === 401 ? new Headers({ "Content-Type": "application/json" }) : viewerHeaders(principal, { "Content-Type": "application/json" });
  if (typeof body === 'object' && body !== null && 'projectId' in body && 'version' in body && typeof body.projectId === 'string') headers.set('Daynight-Task-Epoch', fixtureTaskEpoch(body.projectId));
  return new Response(stringifyWireJson(body), { status, headers });
};
const isTaskSync = (url: string) => new URL(url, window.location.origin).pathname.endsWith('/task-sync');
const graphResponse = (value: TaskGraph, url: string, version = 1n) => taskSyncResponse(value, { query: taskSyncQuery(new URL(url, window.location.origin)), versionForTask: () => version, propertiesForTask: () => ({ pullRequests: [] }), viewerId: serverUserId, actorAccess: directAccessFixture(value.project.id, serverUserId, "admin") });
const withDetailResources = (project: string, task: string, fallback: (url: string, options?: RequestInit) => Response | Promise<Response>) => withTestDetailResources(project, task, fallback, {}, () => serverUserId);
const fail = (status: number, code: string) => json({ error: { code, message: "hidden server details", requestId: "rq-safe" } }, status);
const graph = (url: string) => graphResponse({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [], summary: { proposed: 0, total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 } }, url);
const defaults = (url: string): Response => {
  if (url === "/api/v1/me") return json(user(serverUserId, serverUserId === userId ? "Alice" : "Bob"));
  if (url.startsWith("/api/v1/teams?")) return json(personalTeamPage(serverUserId));
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url.endsWith("/access")) return serverUserId === userId ? json(directAccessFixture(projectId, userId, "admin")) : fail(404, "not_found");
  if (url.endsWith("/members")) return json({ actorAccess: directAccessFixture(projectId, serverUserId, "admin"), items: [participant()] });
  if (isTaskSync(url)) return graph(url);
  if (url === `/api/v1/projects/${projectId}`) return json(project());
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
  it("binds direct-entry and retained member subtitles to their project through settings navigation", async () => {
    const second = "00000000-0000-4000-8000-000000000004";
    const secondProject = { ...project("Project Beta"), id: second };
    window.history.replaceState(null, "", `/projects/${second}/members`);
    install((url) => {
      if (url === `/api/v1/projects/${second}`) return json(secondProject);
      if (url === `/api/v1/projects/${second}/access`) return json(directAccessFixture(second, userId, "admin"));
      if (url === `/api/v1/projects/${second}/members`) return json({ actorAccess: directAccessFixture(second, userId, "admin"), items: [] });
      if (url.endsWith("/invitations")) return json({ items: [] });
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByText("Project Beta · 管理协作成员与加入邀请");
    act(() => navigate(`/projects/${projectId}`));
    fireEvent.click(await screen.findByRole("link", { name: "项目设置" }));
    fireEvent.click(await screen.findByRole("link", { name: "成员与邀请" }));
    await screen.findByText("私有项目 · 管理协作成员与加入邀请");
    act(() => navigate(`/projects/${second}/settings`));
    await screen.findByRole("heading", { name: "Project Beta" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "项目设置分组" })).getByRole("link", { name: "成员与邀请" }));
    await waitFor(() => expect(screen.getByText("Project Beta · 管理协作成员与加入邀请")).toBeVisible());
    const previous = screen.queryByText("私有项目 · 管理协作成员与加入邀请");
    if (previous !== null) expect(previous).not.toBeVisible();
  });

  it("retains a project invitation and stops remote work after account change", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}/members`);
    const secret = "dninvite_identity_secret";
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === `/api/v1/projects/${projectId}/invitations`) return Promise.resolve(options?.method === "POST" ? json({ id: otherId, projectId, createdBy: userId, createdAt: now, expiresAt: "2099-10-29T10:00:00Z", consumedAt: null, consumedBy: null, revokedAt: null, link: `${window.location.origin}/invitations#${secret}` }, 201) : json({ items: [] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    const invite = await screen.findByRole("button", { name: "邀请成员" });
    await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "创建邀请链接" });
    await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
    const value = await screen.findByDisplayValue(`${window.location.origin}/invitations#${secret}`);
    accountChange(otherId);
    expect(await within(screen.getByRole("dialog")).findByText("账户已变化")).toBeVisible();
    expect(screen.getByDisplayValue(`${window.location.origin}/invitations#${secret}`)).toBe(value);
    expect(fetcher.mock.calls.filter(([url, options]) => url.endsWith("/invitations") && options?.method === "POST")).toHaveLength(1);
  });

  it("loads project navigation once with the project page and keeps the selected project across management routes", async () => {
    const fetcher = install((url) => url === `/api/v1/projects/${projectId}` ? json(project()) : url.endsWith("/invitations") ? json({ items: [] }) : defaults(url));
    render(<AuthenticatedApp />);
    const sidebar = await screen.findByRole("complementary", { name: "工作空间导航" });
    const nav = within(sidebar);
    const link = await nav.findByRole("link", { name: "私有项目" });
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects?"))).toHaveLength(1);
    expect(nav.getByRole("link", { name: "项目" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(link);
    await screen.findByRole("link", { name: "项目设置" });
    expect(nav.getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
    expect(nav.getByRole("link", { name: "项目" })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("link", { name: "项目设置" }));
    fireEvent.click(await screen.findByRole("link", { name: "成员与邀请" }));
    await screen.findByRole("heading", { name: "项目成员" });
    expect(nav.getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("link", { name: "执行与提醒" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(nav.getByRole("link", { name: "私有项目" })).toHaveAttribute("aria-current", "true");
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
    await waitForState(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith("/api/v1/projects?"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "New project" } });
    fireEvent.change(screen.getByLabelText(/仓库地址/), { target: { value: "https://github.com/example/new-project" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    const nav = within(screen.getByRole("complementary", { name: "工作空间导航" }));
    expect(await nav.findByRole("link", { name: "New project" })).toHaveAttribute("aria-current", "true");
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    await waitForState(() => expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects?"))).toHaveLength(2));
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

  it("retains the workspace and sidebar preference after an account change", async () => {
    const fetcher = install(); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    accountChange(otherId); await screen.findByText("账户已变化");
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
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

  it("keeps mobile navigation open after account change", async () => {
    mockSidebarMediaQuery(true); window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    const fetcher = install(); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    const drawer = screen.getByRole("dialog", { name: "工作空间导航" });
    accountChange(otherId);
    expect(screen.getByRole("dialog", { name: "工作空间导航" })).toBe(drawer);
    expect(heading.isConnected).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
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
    await interaction.click(await screen.findByRole("heading", { name: "私有项目" }));
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

  it("passes the authenticated profile avatar to the account menu", async () => {
    const avatarUrl = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E";
    const fetcher = install((url) => url === "/api/v1/me" ? json({ ...user(), avatarUrl }) : defaults(url));
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    const avatar = trigger.querySelector(".avatar")!;
    const image = avatar.querySelector("img")!;
    expect(image).toHaveAttribute("src", avatarUrl);
    expect(image).toHaveAttribute("alt", "");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveTextContent("A");
    fireEvent.load(image);
    expect(image).toHaveClass("loaded");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
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

  it("keeps sign out behind the account menu and supports two-item keyboard navigation", async () => {
    install();
    const interaction = userEvent.setup();
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    trigger.focus();
    await interaction.keyboard("{ArrowDown}");
    const settings = screen.getByRole("menuitem", { name: "账户设置" });
    const signOut = screen.getByRole("menuitem", { name: "退出登录" });
    expect(settings).toHaveFocus();
    expect(within(screen.getByRole("menu")).getByRole("separator")).toBeVisible();
    await interaction.keyboard("{ArrowDown}");
    expect(signOut).toHaveFocus();
    await interaction.keyboard("{ArrowDown}");
    expect(settings).toHaveFocus();
    await interaction.keyboard("{ArrowUp}");
    expect(signOut).toHaveFocus();
    await interaction.keyboard("{Home}");
    expect(settings).toHaveFocus();
    await interaction.keyboard("{End}");
    expect(signOut).toHaveFocus();
    await interaction.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    await interaction.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toHaveFocus();
    await interaction.tab();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["{Enter}", " "])("signs out from the account menu with %s", async (key) => {
    install((url) => url === "/api/v1/auth/logout" ? new Response(null, { status: 204 }) : defaults(url));
    const interaction = userEvent.setup();
    render(<AuthenticatedApp />);
    const trigger = await screen.findByRole("button", { name: "账户菜单：Alice" });
    trigger.focus();
    await interaction.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toHaveFocus();
    await interaction.keyboard(key);
    await waitForState(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
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
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
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
      await waitForState(() => expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/v1/projects")).length).toBe(2));
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
      expect(document.body).not.toHaveClass("auth-session-checking");
      expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    } finally { frame.remove(); }
  });

  it.each(["focus-first", "visibility-first"])("keeps the workspace without another identity read on external return (%s)", async (order) => {
    const fetcher = install(); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    topLevelFocused = false; visibility = "hidden"; fireEvent(document, new Event("visibilitychange")); fireEvent(window, new Event("blur"));
    if (order === "focus-first") { topLevelFocused = true; fireEvent(window, new Event("focus")); visibility = "visible"; fireEvent(document, new Event("visibilitychange")); }
    else { visibility = "visible"; fireEvent(document, new Event("visibilitychange")); topLevelFocused = true; fireEvent(window, new Event("focus")); }
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    expect(screen.queryByText("账户已变化")).toBeNull();
  });

  it("keeps a direct project visible and suppresses new reads after a shared account change", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const fetcher = install(); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    accountChange(otherId); await screen.findByText("账户已变化");
    const before = fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it('syncs and persists Tasks in the background until an actual account change pauses requests', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    window.history.replaceState(null, '', `/projects/${projectId}`);
    const taskId = '00000000-0000-4000-8000-000000000005';
    const initial = detailFixture(projectId, taskId, { title: 'Initial background task' });
    const changed = { ...initial, title: 'Updated background task', version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
    let updated = false;
    const fetcher = install((url) => isTaskSync(url)
      ? graphResponse({ ...graphFixture([updated ? changed : initial]), project: project() }, url, updated ? 2n : 1n)
      : defaults(url));
    const originalHook = taskGraphHook.useTaskGraph;
    let current: ReturnType<typeof originalHook> | undefined;
    vi.spyOn(taskGraphHook, 'useTaskGraph').mockImplementation((id) => { current = originalHook(id); return current; });
    await act(async () => { render(<AuthenticatedApp />); });
    await waitForState(() => expect(current?.snapshot?.summaries.get(taskId)?.version).toBe(1n));
    const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    try {
      visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
      const initialReads = fetcher.mock.calls.filter(([url]) => isTaskSync(url)).length;
      updated = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      await waitForState(() => expect(current?.snapshot?.summaries.get(taskId)?.version).toBe(2n));
      expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(initialReads + 1);
      expect(current?.snapshot?.index.nodes.get(taskId)?.titlePreview).toBe('Updated background task');
      expect((await database.get('summaries', [userId, projectId, taskId]))?.summary).toMatchObject({ titlePreview: 'Updated background task', version: 2n });
      expect(fetcher.mock.calls.filter(([url]) => url === '/api/v1/me')).toHaveLength(1);
      accountChange(otherId); await screen.findByText('账户已变化');
      const before = fetcher.mock.calls.length;
      serverUserId = otherId;
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(current?.snapshot?.summaries.get(taskId)?.version).toBe(2n);
      expect((await database.get('summaries', [userId, projectId, taskId]))?.summary).toMatchObject({ titlePreview: 'Updated background task', version: 2n });
      expect(await database.get('summaries', [otherId, projectId, taskId])).toBeUndefined();
    } finally { database.close(); }
  });

  it("retains the project when a refresh response proves another principal", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`); let mismatch = false;
    const fetcher = install(url => {
      if (isTaskSync(url) && mismatch) { serverUserId = otherId; return graph(url); }
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "私有项目" });
    mismatch = true; fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("账户已变化");
    expect(screen.getByRole("heading", { name: "私有项目" })).toBe(heading);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it.each([null, 'invalid-principal'])("retains the authorized view and stored rows for an untrusted 404 principal header (%s)", async (principal) => {
    const taskId = '00000000-0000-4000-8000-000000000005';
    const initial = { ...graphFixture([detailFixture(projectId, taskId)]), project: project() };
    let responseMode: 'valid' | 'untrusted' | 'not-found' = 'valid';
    install((url) => {
      if (responseMode === 'not-found' && (url === `/api/v1/projects/${projectId}` || url === `/api/v1/projects/${projectId}/access`)) return fail(404, 'not_found');
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
      await waitForState(async () => expect((await database.get('projects', [userId, projectId]))?.state).toBe('active'));
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
      await waitForState(async () => expect((await database.get('projects', [userId, projectId]))?.state).toBe('invalidated'));
      expect(await database.getAllFromIndex('summaries', 'by-project', [userId, projectId])).toEqual([]);
    } finally { database.close(); }
  });

  it.each(["hidden", "unfocused"])("does not gate initial identity on window state (%s)", async (away) => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    visibility = away === "hidden" ? "hidden" : "visible"; topLevelFocused = false;
    const fetcher = install(); render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    await waitForState(() => expect(fetcher.mock.calls.some(([url]) => isTaskSync(url))).toBe(true));
  });



  it("preserves a project draft, selection and focus on account change", async () => {
    const fetcher = install(); render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    const dialog = screen.getByRole("dialog", { name: "创建私有项目" });
    const name = screen.getByLabelText(/项目名称/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Unsubmitted project" } }); name.focus(); name.setSelectionRange(2, 8);
    accountChange(otherId);
    expect(await within(dialog).findByText("账户已变化")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "创建私有项目" })).toBe(dialog);
    expect(name).toHaveFocus(); expect(name.selectionStart).toBe(2); expect(name.selectionEnd).toBe(8);
    fireEvent.change(name, { target: { value: "Continued locally" } }); expect(name).toHaveValue("Continued locally");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("does not dispatch token metadata reads after an account change", async () => {
    window.history.replaceState(null, "", "/account");
    const fetcher = install(url => url === "/api/v1/me/tokens" ? json({ items: [] }) : defaults(url));
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: "账户菜单：Alice" });
    accountChange(otherId); await screen.findByText("账户已变化");
    fireEvent.click(screen.getByRole("button", { name: "访问凭据" })); await act(async () => {});
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
  });













  it("keeps a one-time PAT reveal mounted after account change", async () => {
    window.history.replaceState(null, "", "/account");
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(url === "/api/v1/me/tokens" ? options?.method === "POST" ? json({ id: otherId, name: "Device", lastUsedAt: null, createdAt: now, expiresAt: "2099-10-22T10:00:00Z", token: "once-only-secret" }, 201) : json({ items: [] }) : defaults(url)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "访问凭据" }));
    await waitFor(() => expect(tokenPanel().getByRole("button", { name: "创建令牌" })).not.toBeDisabled());
    fireEvent.click(tokenPanel().getByRole("button", { name: "创建令牌" }));
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "Device" } }); fireEvent.submit(document.getElementById("create-token-form")!);
    const reveal = await screen.findByRole("dialog", { name: "访问令牌已创建" });
    accountChange(otherId);
    expect(screen.getByRole("dialog", { name: "访问令牌已创建" })).toBe(reveal);
    expect(screen.getByLabelText("一次性访问令牌")).toHaveValue("once-only-secret");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("cancels a pending project creation network request on account change while retaining its dialog", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string, options?: RequestInit) => url === "/api/v1/projects" && options?.method === "POST" ? pending.promise : Promise.resolve(defaults(url)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 创建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/), { target: { value: "Pending" } });
    fireEvent.change(screen.getByLabelText(/仓库地址/), { target: { value: "git@github.com:example/repo.git" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建项目" }).closest("form")!);
    await waitForState(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const dialog = screen.getByRole("dialog", { name: "创建私有项目" });
    const signal = fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!.signal!;
    accountChange(otherId); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(json(createdProject("Pending", "git@github.com:example/repo.git"), 201)));
    expect(screen.getByRole("dialog", { name: "创建私有项目" })).toBe(dialog);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("retains private project navigation after a shared account change", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const fetcher = install(); render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("link", { name: "项目设置" }));
    fireEvent.click(await screen.findByRole("link", { name: "成员与邀请" }));
    const heading = await screen.findByRole("heading", { name: "项目成员" });
    await screen.findByText("私有项目");
    accountChange(otherId); await screen.findByText("账户已变化");
    expect(screen.getByRole("heading", { name: "项目成员" })).toBe(heading);
    expect(document.body.textContent).toContain("私有项目");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("clears all workspace data on a real resource401 while keeping project404 local", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let denied = false;
    install((url) => denied && (isTaskSync(url) || url === `/api/v1/projects/${projectId}` || url === `/api/v1/projects/${projectId}/access`) ? fail(404, "not_found") : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("heading", { name: "项目不存在" });
    expect(screen.getByRole("button", { name: "账户菜单：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(isTaskSync(url) ? fail(401, "unauthenticated") : defaults(url))));
    fireEvent.click(within(screen.getByRole("tabpanel", { name: "概览" })).getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(screen.getByText("登录状态已过期。重新登录后可继续访问项目。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "账户菜单：Alice" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "项目不存在" })).toBeNull();
  });

  it("reports failed image draft cleanup after logout and retries its original blocked records", async () => {
    const { IDBObjectStore } = await import('fake-indexeddb');
    const { SessionDraftStore } = await import('../src/features/task-agent-session/drafts/draft-store');
    const drafts = new SessionDraftStore();
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: { sessionId: 'draft-session', claimId: 'draft-claim', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'task' as const, projectId, taskId: 'draft-task' } };
    await drafts.openOwner(identity);
    let failing = true; const remove = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: InstanceType<typeof IDBObjectStore>, ...args: Parameters<typeof remove>) { if (this.name === 'drafts' && failing) throw new DOMException('cleanup failed', 'UnknownError'); return remove.apply(this, args); });
    install(url => url === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : defaults(url));
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole('button', { name: '账户菜单：Alice' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByText('无法清理本地恢复记录。');
    await expect(drafts.readExisting(identity)).rejects.toMatchObject({ code: 'blocked' });
    failing = false; fireEvent.click(screen.getByRole('button', { name: '重试清理' }));
    await waitFor(() => expect(screen.queryByText('无法清理本地恢复记录。')).toBeNull());
    expect((await drafts.reauthorizeOwner(identity)).editable?.text).toBe(''); drafts.close();
  });

  it("shows a cold Session deletion cleanup failure through the existing retry notice", async () => {
    const { IDBObjectStore } = await import('fake-indexeddb');
    const { SessionDraftStore } = await import('../src/features/task-agent-session/drafts/draft-store');
    const { clearBotStoredSessionState } = await import('../src/features/bots/session-cache');
    const drafts = new SessionDraftStore();
    const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: { sessionId: 'cold-session', testExecutionId: 'cold-execution', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'session' as const, sessionId: 'cold-session', testExecutionId: 'cold-execution' } };
    await drafts.openOwner(identity);
    install(defaults); render(<AuthenticatedApp />); await screen.findByRole('button', { name: '账户菜单：Alice' });
    let failing = true; const remove = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: InstanceType<typeof IDBObjectStore>, ...args: Parameters<typeof remove>) { if (this.name === 'drafts' && failing) throw new DOMException('cleanup failed', 'UnknownError'); return remove.apply(this, args); });
    await act(async () => { expect(await clearBotStoredSessionState(userId, 'cold-bot', 'cold-session', null, 'deleted')).toBeInstanceOf(Error); });
    expect(screen.getByText('无法清理本地恢复记录。')).toBeInTheDocument();
    failing = false; fireEvent.click(screen.getByRole('button', { name: '重试清理' }));
    await waitFor(() => expect(screen.queryByText('无法清理本地恢复记录。')).toBeNull());
    await expect(drafts.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' }); drafts.close();
  });

  it("clears projects immediately when logout fails and offers an explicit retry", async () => {
    let failed = true;
    install((url) => url === "/api/v1/auth/logout" ? failed ? fail(503, "internal") : new Response(null, { status: 204 }) : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" });
    fireEvent.click(screen.getByRole("button", { name: "账户菜单：Alice" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    failed = false;
    fireEvent.click(await screen.findByRole("button", { name: "重试退出登录" }));
    await waitForState(() => expect(window.location.pathname).toBe("/"));
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

  it.each([
    { role: "admin", locale: "zh-CN", settings: "项目设置" },
    { role: "member", locale: "zh-CN", settings: "项目设置" },
    { role: "admin", locale: "en", settings: "Project settings" },
    { role: "member", locale: "en", settings: "Project settings" },
  ] as const)("shows project actions without a role for $role in $locale", async ({ role, locale, settings }) => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const snapshot: TaskGraph = { observedAt: now, project: project(), tasks: [], summary: { proposed: 0, total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 } };
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const signal = new AbortController().signal;
    const ticket = await scope.beginSync(projectId, signal);
    await scope.applySync(ticket, taskSyncFromGraph(snapshot, { versionForTask: () => 1n }), signal);
    scope.dispose();
    const pending = Promise.withResolvers<Response>();
    let syncUrl = "";
    install((url) => { if (isTaskSync(url)) { syncUrl = url; return pending.promise; } return defaults(url); });
    createLocaleRender(locale)(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "私有项目" }, { timeout: 5000 });
    const actions = document.querySelector<HTMLElement>(".project-title-actions")!;
    expect(within(actions).getAllByRole("link")).toHaveLength(1);
    expect(within(actions).getByRole("link", { name: settings })).toHaveAttribute("href", `/projects/${projectId}/settings`);
    await waitForState(() => expect(syncUrl).not.toBe(""));
    await act(async () => pending.resolve(taskSyncResponse(snapshot, { viewerId: userId, query: taskSyncQuery(new URL(syncUrl, window.location.origin)), versionForTask: () => 1n, actorAccess: directAccessFixture(projectId, userId, role) })));
    expect(await within(actions).findAllByRole("link")).toHaveLength(1);
    expect(within(actions).getByRole("link", { name: settings })).toHaveAttribute("href", `/projects/${projectId}/settings`);
    for (const view of ["overview", "tasks"]) {
      if (view === "tasks") await selectTaskList();
      expect(document.querySelector(".project-heading .badge, .project-heading .project-title-role, .project-heading .project-title-role-measure")).toBeNull();
      expect([...actions.children].map(element => element.textContent)).not.toContain(locale === "zh-CN" ? (role === "admin" ? "管理员" : "成员") : (role === "admin" ? "Administrator" : "Member"));
      expect(within(actions).getAllByRole("link")).toHaveLength(1);
      expect(within(actions).getByRole("link", { name: settings })).toBeVisible();
    }
  });

  it("retains project links and focus through access revalidation, failure and retry", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let failing = false;
    const fetcher = install((url) => url.endsWith("/access") && failing ? fail(503, "internal") : defaults(url));
    render(<AuthenticatedApp />);
    const settings = await screen.findByRole("link", { name: "项目设置" });
    await screen.findByRole("heading", { name: "概览" });
    settings.focus(); failing = true;
    returnFromAnotherWindow();
    expect(await screen.findByText("暂时无法读取项目权限。", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByRole("link", { name: "项目设置" })).toBe(settings);
    expect(settings).toHaveFocus();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "重试读取权限" }));
    await waitFor(() => expect(screen.queryByText("暂时无法读取项目权限。")).toBeNull());
    expect(screen.getByRole("link", { name: "项目设置" })).toBe(settings);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(1);
  });

  it("submits task status through the core API and retains pending ownership across standalone attachment navigation", async () => {
    const taskId = "00000000-0000-4000-8000-000000000005";
    const taskUrl = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    let started = false;
    let finishStatus!: (response: Response) => void;
    let reopening = false, reopenedReads = 0;
    let reopenedSessions: TaskDetailSessions | undefined;
    const requireOpeningRead = TaskDetailSessions.prototype.requireOpeningRead;
    vi.spyOn(TaskDetailSessions.prototype, "requireOpeningRead").mockImplementation(function (this: TaskDetailSessions, currentProject, currentTask) {
      if (reopening && currentProject === projectId && currentTask === taskId) reopenedSessions = this;
      requireOpeningRead.call(this, currentProject, currentTask);
    });
    const detail = () => ({ type: 'task', parentId: null, assignedTo: null, tags: [], requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, cancelledAt: null, id: taskId, projectId, title: "Lifecycle task", description: "Reviewed lifecycle content", properties: { pullRequests: [] },
      status: started ? "in_progress" : "todo", version: started ? 8 : 7, dependsOn: [], blockedBy: [], ready: !started, createdAt: now, updatedAt: now });
    const taskGraph = (): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [{ type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, cancelledAt: null, id: taskId, titlePreview: "Lifecycle task", titleTruncated: false,
      status: started ? "in_progress" : "todo", dependsOn: [], blockedBy: [], ready: !started, createdAt: now, updatedAt: now }],
      summary: { proposed: 0, total: 1, todo: started ? 0 : 1, inProgress: started ? 1 : 0, done: 0, cancelled: 0, ready: started ? 0 : 1, blocked: 0 } });
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === `${taskUrl}/status`) return new Promise<Response>((done) => { finishStatus = done; });
      if (url === `${taskUrl}/attachments?limit=100`) return Promise.resolve(json({ items: [{ path: "docs/guide.md", contentType: "text/markdown", sizeBytes: 12, createdAt: now, updatedAt: now }], nextCursor: null }));
      if (url === `${taskUrl}/attachments/files/docs/guide.md`) return Promise.resolve(new Response("# Status reference"));
      if (url === taskUrl) { if (reopening) reopenedReads++; return Promise.resolve(json(detail())); }
      return Promise.resolve(isTaskSync(url) ? graphResponse(taskGraph(), url, started ? 8n : 7n) : defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState(null, "", `/projects/${projectId}`);
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const view = render(<AuthenticatedApp />, { container: root });
    try {
      await screen.findByRole("heading", { name: "私有项目" });
      await selectTaskList();
      fireEvent.click(await screen.findByRole("tab", { name: "独立任务" }));
      fireEvent.click(await screen.findByRole("button", { name: /Lifecycle task/ }));
      let dialog = screen.getByRole("dialog");
      await within(dialog).findByRole("heading", { name: "Lifecycle task" });
      fireEvent.click(within(dialog).getByRole("button", { name: "待处理" }));
      fireEvent.click(within(dialog).getByRole("menuitemradio", { name: "进行中" }));
      fireEvent.click(within(screen.getByRole("alertdialog", { name: "设置任务状态" })).getByRole("button", { name: "确认设置" }));
      await waitForState(() => expect(finishStatus).toBeTypeOf("function"));
      const submitted = fetcher.mock.calls.find(([url]) => url === `${taskUrl}/status`)![1]!;
      expect(submitted).toMatchObject({ method: "PUT", body: '{"version":7,"status":"in_progress"}', credentials: "same-origin", redirect: "error" });
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭任务详情" }));
      act(() => { window.history.pushState(null, "", `/projects/${projectId}/tasks/${taskId}/attachments/docs/guide.md`); window.dispatchEvent(new PopStateEvent("popstate")); });
      await screen.findByRole("heading", { name: "Status reference" });
      act(() => { window.history.pushState(null, "", `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent("popstate")); });
      await screen.findByRole("heading", { name: "私有项目" });
      await selectTaskList();
      fireEvent.click(await screen.findByRole("tab", { name: "独立任务" }));
      reopening = true;
      fireEvent.click(await screen.findByRole("button", { name: /Lifecycle task/ }));
      dialog = screen.getByRole("dialog");
      // This opening's live read is admitted before its pending write is settled.
      await waitFor(() => {
        expect(reopenedReads).toBeGreaterThan(0);
        expect(reopenedSessions).toBeDefined();
        expect(reopenedSessions!.snapshot(projectId, taskId)).toMatchObject({ status: "ready", refreshing: false, requiresFreshRead: false, error: null, detail: { id: taskId, version: 7n, status: "todo" } });
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(within(dialog).getByRole("button", { name: "待处理" })).toBeVisible();
        expect(within(dialog).getByRole("button", { name: "待处理" })).toBeDisabled();
        expect(submitted.signal!.aborted).toBe(false);
        expect(fetcher.mock.calls.filter(([url]) => url === `${taskUrl}/status`)).toHaveLength(1);
      });
      expect(fetcher.mock.calls.filter(([url]) => url === taskUrl).length).toBeGreaterThanOrEqual(2);
      expect(fetcher.mock.calls.filter(([url]) => url === `${taskUrl}/status`)).toHaveLength(1);
      started = true;
      await act(async () => finishStatus(json(detail())));
      // Admission is checked before semantic queries so sampling does not delay its I/O.
      await waitFor(() => {
        expect(reopenedSessions!.summaryVersion(projectId, taskId)).toBe(8n);
        expect(reopenedSessions!.snapshot(projectId, taskId)).toMatchObject({ status: "ready", refreshing: false, requiresFreshRead: false, error: null, detail: { id: taskId, version: 8n, status: "in_progress" } });
        expect(dialog.isConnected).toBe(true);
        const status = within(dialog.querySelector<HTMLElement>(".task-status-picker")!).getByRole("button", { name: "进行中" });
        expect(status).toBeVisible();
        expect(status).toBeEnabled();
      });
    } finally { view.unmount(); root.remove(); }
  });

  it("handles valid account, membership and malformed routes", () => {
    expect(parseAuthRoute("/account")).toEqual({ kind: "account" });
    expect(parseAuthRoute(`/projects/${projectId}/members`)).toEqual({ kind: "settings", projectId, selection: { kind: "tab", tab: "members" } });
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
    expect(parseAuthRoute(`/projects/${projectId}/members`)).toEqual({ kind: "settings", projectId, selection: { kind: "tab", tab: "members" } });
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
    await waitForState(() => expect(fetcher.mock.calls.filter(([url]) => url.includes("/sessions?"))).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox", { name: "语言 / Language" }), { target: { value: "en" } });
    expect(document.title).toBe("Task details · Daynight");
    expect(screen.getByRole("main")).toBe(reader);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/files/docs/guide.md`);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/sessions?"))).toHaveLength(1);
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

  it("retains the loaded HTML frame through focus and an account change", async () => {
    window.history.replaceState(null, "", location("site/index.html"));
    const fetcher = vi.fn(withDetailResources(projectId, taskId, (url: string, options?: RequestInit) => {
      if (url === "/api/v1/me") return Promise.resolve(json(user()));
      if (url.includes("/attachments?")) return Promise.resolve(inventory("site/index.html", "text/html"));
      if (options?.method === "HEAD") return Promise.resolve(new Response(null));
      throw new Error(`Unexpected request ${url}`);
    }));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    const frame = await screen.findByTitle("HTML 预览：site/index.html");
    returnFromAnotherWindow(); accountChange(otherId); await screen.findByText("账户已变化");
    expect(screen.getByTitle("HTML 预览：site/index.html")).toBe(frame);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "HEAD")).toHaveLength(1);
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
  it("retains an invitation and blocks acceptance after account change", async () => {
    window.history.replaceState(null, "", "/invitations#pending-account-secret");
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/invitations/inspect" ? json({ projectId, projectName: "受邀项目", directGrant: null, access: null }) : defaults(url)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "受邀项目" });
    accountChange(otherId); await screen.findByText("账户已变化");
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" })); await act(async () => {});
    expect(screen.getByRole("heading", { name: "受邀项目" })).toBe(heading);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
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
    await waitForState(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(true));
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

describe("invitation session expiry", () => {
  const team = { id: "00000000-0000-4000-8000-000000000004", kind: "ordinary", name: "协作团队" };
  const cases = [
    { path: "invitations", key: invitationStorageKey, secret: "project-expiry-secret", inspection: { projectId, projectName: "受邀项目", directGrant: null, access: null }, heading: "受邀项目" },
    { path: "team-invitations", key: teamInvitationStorageKey, secret: "dnteam-expiry-secret", inspection: { team, membership: null }, heading: "协作团队" },
  ];
  for (const invitation of cases) for (const phase of ["inspect", "accept"] as const) {
    it(`retains ${invitation.path} through current-session ${phase} 401 and restores it after login`, async () => {
      window.history.replaceState(null, "", `/${invitation.path}#${invitation.secret}`);
      let finish!: (response: Response) => void;
      const held = new Promise<Response>(resolve => { finish = resolve; });
      const fetcher = vi.fn((url: string, options?: RequestInit) => {
        if (url === `/api/v1/${invitation.path}/${phase}`) return held;
        if (url === `/api/v1/${invitation.path}/inspect`) return Promise.resolve(json(invitation.inspection));
        return Promise.resolve(defaults(url));
      });
      vi.stubGlobal("fetch", fetcher);
      const login = vi.fn();
      const view = render(<AuthenticatedApp navigateToLogin={login} />);
      if (phase === "accept") fireEvent.click(await screen.findByRole("button", { name: "接受邀请并加入" }));
      await waitForState(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith(`/${phase}`))).toBe(true));
      expect(window.sessionStorage.getItem(invitation.key)).toBeNull();
      expect(window.location.hash).toBe("");
      await act(async () => finish(fail(401, "unauthenticated")));
      await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(window.sessionStorage.getItem(invitation.key)).toBe(invitation.secret);
      fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
      expect(login).toHaveBeenCalledWith(`/api/v1/auth/login?provider=github&returnPath=%2F${invitation.path}`);
      view.unmount();
      window.history.replaceState(null, "", `/${invitation.path}`);
      serverUserId = otherId;
      const returned = vi.fn((url: string, options?: RequestInit) => {
        if (url === `/api/v1/${invitation.path}/inspect`) return Promise.resolve(json(invitation.inspection));
        return Promise.resolve(defaults(url));
      });
      vi.stubGlobal("fetch", returned);
      render(<AuthenticatedApp />);
      await screen.findByRole("heading", { name: invitation.heading });
      expect(screen.getByText("Bob", { selector: ".person-name" })).toBeVisible();
      expect(window.sessionStorage.getItem(invitation.key)).toBeNull();
      expect(returned.mock.calls.find(([url]) => url.endsWith("/inspect"))?.[1]?.body).toBe(JSON.stringify({ token: invitation.secret }));
      expect(returned.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(false);
    });
  }
  for (const invitation of cases) {
    it(`reports ${invitation.path} storage failure on session expiry`, async () => {
      window.history.replaceState(null, "", `/${invitation.path}#${invitation.secret}`);
      let finish!: (response: Response) => void;
      const held = new Promise<Response>(resolve => { finish = resolve; });
      const fetcher = vi.fn((url: string) => url.endsWith("/inspect") ? held : Promise.resolve(defaults(url)));
      vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
      await waitForState(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/inspect"))).toBe(true));
      expect(window.sessionStorage.getItem(invitation.key)).toBeNull();
      const originalSetItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (this === window.sessionStorage && key === invitation.key) throw new DOMException("blocked");
        return originalSetItem.call(this, key, value);
      });
      await act(async () => finish(fail(401, "unauthenticated")));
      await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(screen.getByText("浏览器无法保存邀请。登录后请重新打开邀请链接。")).toBeVisible();
      expect(window.sessionStorage.getItem(invitation.key)).toBeNull();
    });
    it(`does not persist ${invitation.path} for a rejected stale 401`, async () => {
      window.history.replaceState(null, "", `/${invitation.path}#${invitation.secret}`);
      let finish!: (response: Response) => void;
      const held = new Promise<Response>(resolve => { finish = resolve; });
      const fetcher = vi.fn((url: string) => url.endsWith("/accept") ? held : Promise.resolve(url.endsWith("/inspect") ? json(invitation.inspection) : defaults(url)));
      vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
      fireEvent.click(await screen.findByRole("button", { name: "接受邀请并加入" }));
      await waitForState(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(true));
      localStorage.setItem("daynight.activeUser", JSON.stringify(otherId));
      await act(async () => finish(fail(401, "unauthenticated")));
      await screen.findByText("账户已变化");
      expect(screen.getByRole("heading", { name: invitation.heading })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "登录你的工作空间" })).toBeNull();
      expect(window.sessionStorage.getItem(invitation.key)).toBeNull();
      expect(localStorage.getItem("daynight.activeUser")).toBe(JSON.stringify(otherId));
    });
  }
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
    await screen.findByText("协作团队", { selector: ".project-list-information .eyebrow" });
    expect(screen.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
    expect(window.location.pathname).toBe(`/teams/${teamId}`);
    await waitForState(() => expect(window.localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(teamId));
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

  it("retains a Team invitation after a shared account change", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_changed");
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/team-invitations/inspect" ? json({ team, membership: null }) : defaults(url)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    const heading = await screen.findByRole("heading", { name: "协作团队" });
    accountChange(otherId); await screen.findByText("账户已变化");
    expect(screen.getByRole("heading", { name: "协作团队" })).toBe(heading);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
  });

  it("stops a Team invitation inspection that proves a different response principal", async () => {
    window.history.replaceState(null, "", "/team-invitations#dnteam_identity");
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/team-invitations/inspect" ? json({ team, membership: null }, 200, otherId) : defaults(url)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    await screen.findByText("账户已变化");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
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
    await waitForState(() => expect(window.location.pathname).toBe(`/projects/${projectId}`));
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

it('retains cold Bot draft and receipt namespaces on an account change outside the Bot page', async () => {
  install(); render(<AuthenticatedApp />);
  await screen.findByRole('complementary', { name: '工作空间导航' });
  const key = `daynight:bot-session:${JSON.stringify([userId, 'bot', 'session', 'execution'])}:draft`;
  window.sessionStorage.setItem(key, 'private draft');
  const displayKey = `daynight.web.session.display.v1:${JSON.stringify([userId, 'session'])}`;
  window.localStorage.setItem(displayKey, '"standard"');
  const creationKey = `daynight.bot.creation:${userId}`;
  window.sessionStorage.setItem(creationKey, '20000000-0000-4000-8000-000000000001');
  accountChange(otherId); await screen.findByText('账户已变化');
  expect(window.sessionStorage.getItem(key)).toBe('private draft');
  expect(window.localStorage.getItem(displayKey)).toBe('\"standard\"');
  expect(window.sessionStorage.getItem(creationKey)).toBe('20000000-0000-4000-8000-000000000001');
});

it.each(['pending', 'failed'] as const)('recovers the project header through an independent retry when the task cache is %s', async mode => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.spyOn(TaskCacheScope.prototype, 'beginSync').mockImplementation(() => mode === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('cache unavailable')));
  let denied = true;
  install(url => url === `/api/v1/projects/${projectId}` && denied ? fail(404, 'not_found') : defaults(url));
  render(<AuthenticatedApp />);
  const unavailable = await screen.findByRole('heading', { name: '项目不存在或你没有访问权限' });
  expect(screen.queryByRole('heading', { name: '私有项目' })).toBeNull();
  denied = false;
  fireEvent.click(within(unavailable.closest('section')!).getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('heading', { name: '私有项目' })).toBeVisible();
  expect(screen.getByRole('link', { name: '项目设置' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeNull();
});

it('rejects a recovery response after a newer project withdrawal', async () => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.spyOn(TaskCacheScope.prototype, 'beginSync').mockImplementation(() => new Promise(() => {}));
  const suspend = TaskCacheScope.prototype.suspendProject;
  let current: TaskCacheScope | null = null;
  vi.spyOn(TaskCacheScope.prototype, 'suspendProject').mockImplementation(function (this: TaskCacheScope, id) { current = this; return suspend.call(this, id); });
  let denied = true, recoveryReads = 0; const pending = Promise.withResolvers<Response>(), newer = Promise.withResolvers<Response>();
  const fetcher = install(url => url === `/api/v1/projects/${projectId}` ? denied ? fail(404, 'not_found') : ++recoveryReads === 1 ? pending.promise : newer.promise : defaults(url));
  render(<AuthenticatedApp />);
  const unavailable = await screen.findByRole('heading', { name: '项目不存在或你没有访问权限' });
  denied = false;
  fireEvent.click(within(unavailable.closest('section')!).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/projects/${projectId}`)).toHaveLength(2));
  act(() => current!.suspendProject(projectId));
  await waitFor(() => expect(recoveryReads).toBe(2));
  await act(async () => pending.resolve(json(project())));
  expect(screen.queryByRole('heading', { name: '私有项目' })).toBeNull();
  expect(screen.queryByRole('link', { name: '项目设置' })).toBeNull();
  expect(screen.getByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeVisible();
  await act(async () => newer.resolve(json(project())));
  expect(await screen.findByRole('heading', { name: '私有项目' })).toBeVisible();
});


it('recovers Project after its access recheck confirms denial and cache cleanup fails', async () => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  const beginSync = TaskCacheScope.prototype.beginSync;
  let cacheFailed = false, projectDenied = false, cleanupFailures = 0;
  vi.spyOn(TaskCacheScope.prototype, 'beginSync').mockImplementation(function (this: TaskCacheScope, ...args) {
    return cacheFailed ? Promise.reject(new Error('cache unavailable')) : beginSync.apply(this, args);
  });
  const originalPut = IDBObjectStore.prototype.put;
  const purge = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (cacheFailed && this.name === 'projects' && (args[0] as { state?: string }).state === 'invalidated') { cleanupFailures++; throw new DOMException('Injected cleanup failure', 'QuotaExceededError'); }
    return originalPut.apply(this, args);
  });
  const revoke = vi.spyOn(TaskCacheScope.prototype, 'revokeProject');
  const firstAccess = Promise.withResolvers<Response>();
  let projectAllowed = false;
  const fetcher = install(url => {
    if (url === `/api/v1/projects/${projectId}`) {
      if (projectAllowed) return json(project());
      projectDenied = true; return fail(404, 'not_found');
    }
    if (url === `/api/v1/projects/${projectId}/access`) {
      if (!projectDenied) return firstAccess.promise;
      cacheFailed = true; return fail(404, 'not_found');
    }
    return defaults(url);
  });
  render(<AuthenticatedApp />);
  const unavailable = await screen.findByRole('heading', { name: '项目不存在或你没有访问权限' });
  await waitFor(() => expect(revoke).toHaveBeenCalled());
  await waitFor(() => expect(cleanupFailures).toBeGreaterThan(0));
  projectAllowed = true;
  fireEvent.click(within(unavailable.closest('section')!).getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('heading', { name: '私有项目' })).toBeVisible();
  expect(screen.getByRole('link', { name: '项目设置' })).toBeVisible();
  expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/projects/${projectId}`).length).toBeGreaterThan(1);
  purge.mockRestore();
});

it('automatically rereads Project after task sync denial even when the cache becomes unavailable', async () => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  const beginSync = TaskCacheScope.prototype.beginSync;
  let cacheFailed = false, graphDenied = false;
  vi.spyOn(TaskCacheScope.prototype, 'beginSync').mockImplementation(function (this: TaskCacheScope, ...args) {
    return cacheFailed ? Promise.reject(new Error('cache unavailable')) : beginSync.apply(this, args);
  });
  const pending = Promise.withResolvers<Response>();
  const fetcher = install(url => {
    if (isTaskSync(url) && graphDenied) { cacheFailed = true; return fail(404, 'not_found'); }
    if (url === `/api/v1/projects/${projectId}` && graphDenied) return pending.promise;
    return defaults(url);
  });
  render(<AuthenticatedApp />);
  await screen.findByRole('heading', { name: '私有项目' });
  await screen.findByRole('heading', { name: '概览' });
  const projectReads = fetcher.mock.calls.filter(([url]) => url === `/api/v1/projects/${projectId}`).length;
  graphDenied = true;
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByRole('heading', { name: '项目不存在' });
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/projects/${projectId}`).length).toBeGreaterThan(projectReads));
  expect(screen.queryByRole('heading', { name: '私有项目' })).toBeNull();
  await act(async () => pending.resolve(json(project())));
  expect(await screen.findByRole('heading', { name: '私有项目' })).toBeVisible();
  expect(screen.getByRole('link', { name: '项目设置' })).toBeVisible();
});
