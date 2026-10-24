import { detailFixture, graphFixture, withDetailResources as withTestDetailResources } from './helpers/taskDetail';
import { taskSyncQuery, taskSyncResponse, viewerHeaders } from './helpers/taskSync';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { performance as nodePerformance } from 'node:perf_hooks';
import { openDB } from 'idb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import type { TaskGraph } from '../src/api/types';
import { stringifyWireJson } from "./helpers/wireJson";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/api/auth";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { parseRoute } from "../src/app/router";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { invitationStorageKey } from "../src/features/auth/invitation";

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
const user = (id = userId, name = "Alice") => ({ id, name, email: `${name}@example.com`, emailVerified: true, avatarUrl: null });
const project = (name = "私有项目") => ({ settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name, repoUrl: "https://github.com/example/repo", createdAt: now, updatedAt: now });
const member = (id = userId, role = "admin") => ({ projectId, userId: id, name: "Alice", email: "alice@example.com", avatarUrl: null, role, version: 12, createdAt: now, updatedAt: now });
let serverUserId = userId;
const json = (body: unknown, status = 200, principal = serverUserId) => new Response(stringifyWireJson(body), { status, headers: status === 401 ? { "Content-Type": "application/json" } : viewerHeaders(principal, { "Content-Type": "application/json" }) });
const isTaskSync = (url: string) => new URL(url, window.location.origin).pathname.endsWith('/task-sync');
const graphResponse = (value: TaskGraph, url: string, version = 1n) => taskSyncResponse(value, { query: taskSyncQuery(new URL(url, window.location.origin)), versionForTask: () => version, viewerId: serverUserId });
const withDetailResources = (project: string, task: string, fallback: (url: string, options?: RequestInit) => Response | Promise<Response>) => withTestDetailResources(project, task, fallback, {}, () => serverUserId);
const fail = (status: number, code: string) => json({ error: { code, message: "hidden server details", requestId: "rq-safe" } }, status);
const graph = (url: string) => graphResponse({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }, url);
const defaults = (url: string): Response => {
  if (url === "/api/v1/me") return json(user(serverUserId, serverUserId === userId ? "Alice" : "Bob"));
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url.endsWith("/members")) return json({ items: [member()] });
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
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toHaveAttribute("aria-label", "账户设置：Alice");
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
      expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    await waitFor(() => expect(meCalls).toBe(2));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    expect(meCalls).toBe(2);
    serverUserId = otherId;
    await act(async () => finishCheck(json(user(otherId, "Bob"))));
    await screen.findByRole("link", { name: "账户设置：Bob" });
    expect(screen.queryByRole("link", { name: "账户设置：Alice" })).toBeNull();
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
      if (url.endsWith("/members")) return Promise.resolve(json({ items: [member(cookieAccount === "Alice" ? userId : otherId)] }));
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
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
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
      expect(screen.queryByRole("link", { name: "账户设置：Alice" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Alice 的项目" })).toBeNull();
    } else expect(screen.getByRole("heading", { name: "Alice 的项目" })).toBe(oldHeading);
  });

  it("evicts the old project and open detail as soon as a sync response proves another principal while identity is pending", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const waitForCacheUi = async (assertion: () => void) => {
      const deadline = nodePerformance.now() + 1_000;
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
      if (url.endsWith('/members')) return Promise.resolve(json({ items: [member(serverUserId)] }));
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
      fireEvent.click(screen.getByRole('tab', { name: '独立任务' }));
      fireEvent.click(screen.getByRole('button', { name: /Alice-only task/ }));
      const dialog = screen.getByRole('dialog');
      await waitForCacheUi(() => expect(within(dialog).getByText('Alice-only private detail')).toBeInTheDocument());
      serverUserId = otherId;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await waitForCacheUi(() => expect(meCalls).toBe(2));
      expect(identityFinished).toBe(false);
      expect(recheckViews).toEqual([{ authenticatedShell: false, privateDetail: false }]);
      expect(heading.isConnected).toBe(false);
      expect(dialog.isConnected).toBe(false);
      expect(document.querySelector('.auth-shell')).toBeNull();
      expect(screen.queryByText('Alice-only private detail')).toBeNull();
      expect(screen.queryByRole('link', { name: '账户设置：Alice' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Bob 的项目' })).toBeNull();
      expect(screen.getByRole('heading', { name: '正在确认登录状态' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(fetcher.mock.calls.filter(([url]) => isTaskSync(url))).toHaveLength(2);
      expect(meCalls).toBe(2);
      await act(async () => { identityFinished = true; finishIdentity(json(user(otherId, 'Bob'))); });
      await waitForCacheUi(() => expect(screen.getByRole('heading', { name: 'Bob 的项目' })).toBeInTheDocument());
      expect(screen.queryByText('Alice-only private detail')).toBeNull();
    } finally { view.unmount(); root.remove(); }
  });

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
    await screen.findByRole("link", { name: "账户设置：Alice" });
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
    let meCalls = 0;
    let finishCheck!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return ++meCalls === 1 ? Promise.resolve(json(user())) : new Promise<Response>((done) => { finishCheck = done; });
      if (url === "/api/v1/me/tokens") return Promise.resolve(json({ items: [{ id: otherId, name: "Confirmed account token", createdAt: now, expiresAt: "2099-10-22T10:00:00Z" }] }));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("link", { name: "账户设置：Alice" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "访问令牌" })); });
    expect(screen.getByRole("status")).toHaveTextContent("正在加载访问令牌…");
    expect(document.body).not.toHaveClass("auth-session-checking");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(0);
    serverUserId = outcome === "changed" ? otherId : userId;
    await act(async () => finishCheck(outcome === "same" ? json(user()) : outcome === "changed" ? json(user(otherId, "Bob")) : fail(401, "unauthenticated")));
    if (outcome === "same") {
      await screen.findByText("Confirmed account token");
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(1);
      expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
    } else {
      if (outcome === "changed") await screen.findByRole("link", { name: "账户设置：Bob" });
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
    await screen.findByRole("link", { name: "账户设置：Alice" });
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
    await screen.findByRole("link", { name: "账户设置：Alice" });
    returnFromAnotherWindow();
    await waitFor(() => expect(meCalls).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "访问令牌" })); });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
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
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "重新确认当前账户" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "访问令牌已创建" })).toBe(reveal);
    expect(reveal.isConnected).toBe(true);
    serverUserId = otherId;
    await act(async () => checks[1]!.resolve(user(otherId, "Bob")));
    await screen.findByRole("link", { name: "账户设置：Bob" });
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
    await screen.findByRole("link", { name: "账户设置：Bob" });
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
    await screen.findByRole("link", { name: "账户设置：Alice" });
    await waitFor(() => expect(projectCalls).toBe(1));
    const oldSignal = fetcher.mock.calls.find(([url]) => url.startsWith("/api/v1/projects"))![1]!.signal!;
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(oldSignal.aborted).toBe(false);
    expect(pendingProject).toBeTypeOf("function");
    expect(screen.getByRole("status", { name: "正在加载项目" })).toBeInTheDocument();

    currentUser = user(otherId, "Bob");
    serverUserId = otherId;
    returnFromAnotherWindow();
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
    expect(document.body).not.toHaveClass("auth-session-checking");
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(2));
    expect(pendingMe).toBeTypeOf("function");
    await act(async () => pendingMe(json(currentUser)));
    await screen.findByRole("heading", { name: "Bob 的项目" });
    await act(async () => pendingProject(json({ items: [project("Alice 的旧项目")], nextCursor: null }, 200, userId)));
    expect(screen.queryByRole("heading", { name: "Alice 的旧项目" })).toBeNull();
    expect(screen.getByRole("link", { name: "账户设置：Bob" })).toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: "账户设置：Alice" })).toBeNull();
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
    await act(async () => complete(json(project(), 201)));
    await screen.findByRole("heading", { name: "私有项目" });
  });

  it("drops private project navigation context when another account is confirmed", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let switched = false;
    install((url) => {
      if (url === "/api/v1/me") return json(switched ? user(otherId, "Bob") : user());
      if (switched && url.endsWith("/members")) return fail(404, "not_found");
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("link", { name: "项目成员" }));
    await screen.findByRole("heading", { name: "项目成员" });
    expect(document.body.textContent).toContain("私有项目");
    switched = true;
    serverUserId = otherId;
    returnFromAnotherWindow();
    await screen.findByRole("link", { name: "账户设置：Bob" });
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
    expect(screen.getByRole("link", { name: "账户设置：Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(isTaskSync(url) ? fail(401, "unauthenticated") : defaults(url))));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "登录你的工作空间" });
    expect(screen.getByText("登录状态已过期。重新登录后可继续访问项目。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "账户设置：Alice" })).toBeNull();
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
    await screen.findByRole("heading", { name: "登录你的工作空间" });
  });

  it("clears the workspace and stops automatic graph reads after a resource401", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    window.history.replaceState(null, "", `/projects/${projectId}`);
    let expired = false;
    const fetcher = install((url) => expired && isTaskSync(url) ? fail(401, "unauthenticated") : defaults(url));
    await act(async () => { render(<AuthenticatedApp />); });
    await vi.waitFor(async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("heading", { name: "私有项目" })).toBeInTheDocument();
    });
    expired = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await vi.waitFor(async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("heading", { name: "登录你的工作空间" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "私有项目" })).toBeNull();
    const graphReads = () => fetcher.mock.calls.filter(([url]) => isTaskSync(url)).length;
    expect(graphReads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(graphReads()).toBe(2);
  });

  it("shows project membership access from the authoritative current membership", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}`);
    install((url) => url.endsWith("/members") ? json({ items: [member(userId, "member")] }) : defaults(url));
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
    const detail = () => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, id: taskId, projectId, title: "Lifecycle task", description: "Reviewed lifecycle content", properties: { worker: null, pullRequests: [] },
      status: started ? "in_progress" : "todo", version: started ? 8 : 7, dependsOn: [], blockedBy: [], ready: !started, createdAt: now, updatedAt: now });
    const taskGraph = (): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z", project: project(), tasks: [{ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: started ? now : null, completedAt: null, id: taskId, titlePreview: "Lifecycle task", titleTruncated: false,
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
      fireEvent.click(screen.getByRole("tab", { name: "独立任务" }));
      fireEvent.click(screen.getByRole("button", { name: /Lifecycle task/ }));
      dialog = screen.getByRole("dialog");
      expect(await within(dialog).findByRole("button", { name: "待处理" })).toBeDisabled();
      expect(fetcher.mock.calls.filter(([url]) => url === taskUrl)).toHaveLength(1);
      expect(fetcher.mock.calls.filter(([url]) => url === `${taskUrl}/status`)).toHaveLength(1);
      started = true;
      await act(async () => finishStatus(json(detail())));
      await within(dialog).findByRole("button", { name: "进行中" });
      expect(within(dialog).getByRole("button", { name: "进行中" })).toBeEnabled();
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
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId, projectName: "受邀项目" }));
      if (url === "/api/v1/invitations/accept") return Promise.resolve(json(member()));
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
        await screen.findByText("Bob", { selector: ".person-name" });
        expect(screen.getByRole("button", { name: "接受邀请并加入" })).not.toBeDisabled();
      } else await screen.findByRole("heading", { name: "登录你的工作空间" });
      expect(window.location.pathname).toBe("/invitations");
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
      expect(window.sessionStorage.getItem(invitationStorageKey)).toBe("pending-account-secret");
    }
  });

  it("clears the fragment before any fetch and only accepts after explicit confirmation", async () => {
    window.history.replaceState(null, "", "/invitations#secret-one");
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      expect(window.location.hash).toBe("");
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId, projectName: "受邀项目" }));
      if (url === "/api/v1/invitations/accept") return Promise.resolve(json(member()));
      return Promise.resolve(defaults(url));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "受邀项目" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBe("secret-one");
    expect(fetcher.mock.calls.some(([url]) => url.includes("accept"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    const accept = fetcher.mock.calls.find(([url]) => url.endsWith("/accept"))!;
    expect(accept[1]?.body).toBe('{"token":"secret-one"}');
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(document.body.textContent).not.toContain("secret-one");
  });

  it.each(["hashchange", "popstate"])("captures a second invitation synchronously on %s and cancels prior acceptance", async (eventName) => {
    window.history.replaceState(null, "", "/invitations#first-secret");
    let finishOld!: (response: Response) => void;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      const body = options?.body === undefined ? null : JSON.parse(String(options.body)) as { token: string };
      if (url.endsWith("/inspect")) return Promise.resolve(json({ projectId, projectName: body?.token === "first-secret" ? "第一个项目" : "第二个项目" }));
      if (url.endsWith("/accept")) return body?.token === "first-secret" ? new Promise<Response>((done) => { finishOld = done; }) : Promise.resolve(json(member()));
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
    await act(async () => finishOld(json(member())));
    expect(window.location.pathname).toBe("/invitations");
    expect(screen.getByRole("heading", { name: "第二个项目" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接受邀请并加入" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept")).map(([, options]) => options?.body)).toEqual(['{"token":"first-secret"}', '{"token":"second-secret"}']);
  });

  it("restores the tab invitation after login, supports cancellation, and drops unavailable secrets", async () => {
    window.sessionStorage.setItem(invitationStorageKey, "secret-persisted");
    window.history.replaceState(null, "", "/invitations");
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "待确认项目" }) : defaults(url));
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
    const fetcher = install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目", member: member() }) : defaults(url));
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole("button", { name: "打开项目" }));
    await screen.findByRole("heading", { name: "私有项目" });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/accept"))).toBe(false);
  });

  it("erases a retained invitation value when removeItem is unavailable", async () => {
    window.history.replaceState(null, "", "/invitations#cleanup-secret");
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目" }) : defaults(url));
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
    install((url) => url.endsWith("/inspect") ? json({ projectId, projectName: "受邀项目" }) : defaults(url));
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

describe("private project creation", () => {
  it("submits required fields, navigates to the created project, and restores native dialog cancellation", async () => {
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(url === "/api/v1/projects" && options?.method === "POST" ? json(project("新项目"), 201) : defaults(url)));
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
    expect(fetcher.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.body).toBe('{"name":"新项目","repoUrl":"git@github.com:example/repo.git"}');
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
