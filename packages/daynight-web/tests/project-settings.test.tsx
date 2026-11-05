import { directAccessFixture } from "./helpers/taskSync";
import { TestTaskCacheBoundary } from "./helpers/taskCache";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { getProject, saveProjectSettings } from "../src/api/project-settings";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { ProjectSettingsPanel } from "../src/features/management/ProjectSettingsPanel";
import { parseWarningDraft } from "../src/features/management/useProjectSettings";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { wireResponse } from "./helpers/wireJson";

const localeRender = createLocaleRender("zh-CN");
const render: typeof localeRender = (ui, options) => localeRender(ui, { taskCache: { viewerId: userId }, ...options });
const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const now = "2026-10-23T10:00:00Z";
let serverActor = userId;
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: userId, name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const project = (minutes = 60, version = 9_007_199_254_740_993n) => ({ ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id, name: "私有项目 Alpha", repoUrl: "https://github.com/example/repo", createdAt: now, updatedAt: now, settings: { version, executionWarningMinutes: minutes } });
const members = (role = "admin", actor = userId) => ({ items: [{ inheritedFrom: null, userId: actor, profile: { name: "Alice", email: "alice@example.com", avatarUrl: null }, effectiveRole: role, directGrant: { projectId: id, userId: actor, role, version: 1n, createdAt: now, updatedAt: now } }] });
const json = (body: unknown, status = 200) => wireResponse(body, { status });
const fail = (status: number, code = "internal_error") => json({ error: { code, message: "private server diagnostic", requestId: "safe-request" } }, status);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const install = (handler: (url: string, init: RequestInit) => Response | Promise<Response> = (url) => url.endsWith("/members") ? json(members()) : json(project())) => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const response = await handler(url.endsWith("/access") ? url.replace(/access$/, "members") : url, init);
    if (!url.endsWith("/access")) { if (url === "/api/v1/me" && response.ok) serverActor = (await response.clone().json()).id; return response; }
    if (!response.ok) { response.headers.set("Daynight-User-ID", userId); return response; }
    const row = (await response.json()).items.find((item: { userId: string }) => item.userId === serverActor);
    return row === undefined ? wireResponse({ error: { code: "not_found", message: "Denied", requestId: "missing-project-access" } }, { status: 404, headers: { "Daynight-User-ID": serverActor } }) : wireResponse({ ...directAccessFixture(id, row.userId, row.effectiveRole), effectiveRole: row.effectiveRole, directGrant: { ...row.directGrant, version: BigInt(row.directGrant.version) } }, { headers: { "Daynight-User-ID": row.userId } });
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
};
const mount = () => render(<ProjectSettingsPanel projectId={id} user={user} />);
const ready = async () => { await screen.findByLabelText("提醒阈值"); await waitFor(() => expect(screen.getByLabelText("提醒阈值")).not.toBeDisabled()); };
const change = (value = "90") => fireEvent.change(screen.getByLabelText("提醒阈值"), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole("button", { name: "保存设置" }).closest("form")!);

beforeEach(() => { serverActor = userId; invalidateAuthRequests(); vi.spyOn(document, "hasFocus").mockReturnValue(true); });

describe("project settings transport", () => {
  it("reads exact nested versions, sends exact PATCH digits, and permits a same-version no-op", async () => {
    const fetcher = install(); const signal = new AbortController().signal;
    expect((await getProject(id, signal)).settings.version).toBe(9_007_199_254_740_993n);
    expect((await saveProjectSettings(id, { version: 9_007_199_254_740_993n, executionWarningMinutes: 60 }, signal)).settings.version).toBe(9_007_199_254_740_993n);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "PATCH", body: '{"version":9007199254740993,"executionWarningMinutes":60}', cache: "no-store", credentials: "same-origin" });
  });

  it("rejects mismatched project, unexpected status/value/version and invalid outgoing input", async () => {
    const signal = new AbortController().signal;
    const fetcher = install(() => json({ ...project(), id: other }));
    await expect(getProject(id, signal)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockImplementation(() => Promise.resolve(json(project(90), 201)));
    await expect(saveProjectSettings(id, { version: 9_007_199_254_740_993n, executionWarningMinutes: 90 }, signal)).rejects.toBeInstanceOf(ApiError);
    fetcher.mockImplementation(() => Promise.resolve(json(project(60))));
    await expect(saveProjectSettings(id, { version: 9_007_199_254_740_993n, executionWarningMinutes: 90 }, signal)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockImplementation(() => Promise.resolve(json(project(90, 3n))));
    await expect(saveProjectSettings(id, { version: 1n, executionWarningMinutes: 90 }, signal)).rejects.toMatchObject({ kind: "protocol" });
    await expect(saveProjectSettings(id, { version: 0n, executionWarningMinutes: 90 }, signal)).rejects.toMatchObject({ kind: "protocol" });
    await expect(saveProjectSettings(id, { version: 1n, executionWarningMinutes: 2_147_483_648 }, signal)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("queues both reads and PATCH behind the shared identity guard and aborts obsolete requests", async () => {
    const fetcher = install(); const resume = pauseAuthRequests(); const controller = new AbortController();
    const read = getProject(id, controller.signal); const patch = saveProjectSettings(id, { version: 9_007_199_254_740_993n, executionWarningMinutes: 60 }, controller.signal);
    await Promise.resolve(); expect(fetcher).not.toHaveBeenCalled(); resume(); await Promise.all([read, patch]); expect(fetcher).toHaveBeenCalledTimes(2);
    const release = pauseAuthRequests(); const abandoned = new AbortController(); const request = getProject(id, abandoned.signal); abandoned.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" }); release(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("project settings form", () => {
  it("loads the server value, keeps drafts separate, cancels, and saves with the observed version", async () => {
    const fetcher = install((url, init) => url.endsWith("/members") ? json(members()) : json(project(init.method === "PATCH" ? 90 : 60, init.method === "PATCH" ? 9_007_199_254_740_994n : 9_007_199_254_740_993n)));
    mount(); expect(screen.queryByLabelText("提醒阈值")).toBeNull(); await ready();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled(); change(); expect(screen.getByText(/存在未保存的修改/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(screen.getByLabelText("提醒阈值")).toHaveValue(60); expect(screen.getByText("修改已取消。")).toBeInTheDocument();
    change(); submit(); await screen.findByText("设置已保存。"); expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
    expect(fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1].body).toBe('{"version":9007199254740993,"executionWarningMinutes":90}');
  });

  it.each(["", "0", "-1", "1.5", "1e2", "2147483648"])("rejects invalid draft %j without a write", async (draft) => {
    const fetcher = install(); mount(); await ready(); change(draft); submit(); await screen.findByRole("alert"); expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(false);
  });

  it("waits for explicit membership before displaying a usable form", async () => {
    const permission = deferred<Response>(); install((url) => url.endsWith("/members") ? permission.promise : json(project())); mount();
    await act(async () => { await Promise.resolve(); }); expect(screen.queryByLabelText("提醒阈值")).toBeNull(); expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
    await act(async () => permission.resolve(json(members("member")))); await screen.findByLabelText("提醒阈值"); expect(screen.getByLabelText("提醒阈值")).toBeDisabled();
  });

  it("validates the full int32 domain without exponent or fallback semantics", () => {
    expect(parseWarningDraft("2147483647")).toBe(2147483647); expect(parseWarningDraft("1")).toBe(1); expect(parseWarningDraft(" 60 ")).toBeNull(); expect(parseWarningDraft("NaN")).toBeNull();
  });

  it("disables controls while loading and guards synchronous duplicate submissions", async () => {
    const saving = deferred<Response>(); const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project()));
    mount(); await ready(); change(); submit(); fireEvent.submit(screen.getByRole("button", { name: "正在保存…" }).closest("form")!);
    expect(screen.getByLabelText("提醒阈值")).toBeDisabled(); expect(screen.getByRole("button", { name: "取消" })).toBeDisabled(); expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n)))); await screen.findByText("设置已保存。");
  });

  it("keeps an unsubmitted draft editable while identity and permissions are checked", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    install((url) => url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change("95");
    const field = screen.getByLabelText("提醒阈值") as HTMLInputElement;
    field.focus();
    const resume = pauseAuthRequests(); holdPermission = true; fireEvent(window, new Event("focus"));
    expect(field).not.toBeDisabled(); expect(document.activeElement).toBe(field);
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    change("96"); expect(field).toHaveValue(96);
    resume(); await act(async () => permission.resolve(json(members())));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).not.toBeDisabled());
    expect(field).toHaveValue(96);
  });

  it("retains a confirmed save when permission recovery fails and reads before enabling another save", async () => {
    const saving = deferred<Response>(), permission = deferred<Response>(); let holdPermission = false, saved = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project(saved ? 90 : 60, saved ? 9_007_199_254_740_994n : 9_007_199_254_740_993n)));
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(true));
    const resume = pauseAuthRequests(); holdPermission = true; fireEvent(window, new Event("focus"));
    saved = true; await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    resume(); await act(async () => permission.resolve(fail(503)));
    await screen.findByText("设置已保存。"); await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    holdPermission = false; fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("holds a dispatched settings receipt until identity and project access are confirmed", async () => {
    const saving = deferred<Response>(), permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(true));
    const resume = pauseAuthRequests(); holdPermission = true;
    fireEvent(window, new Event("focus"));
    await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    expect(screen.queryByText("设置已保存。")).toBeNull();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    resume();
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(1));
    expect(screen.queryByText("设置已保存。")).toBeNull();
    await act(async () => permission.resolve(json(members())));
    await screen.findByText("设置已保存。");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("does not publish an in-flight settings receipt after the identity generation changes", async () => {
    const saving = deferred<Response>();
    install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project()));
    mount(); await ready(); change(); submit();
    const resume = pauseAuthRequests();
    await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    expect(screen.queryByText("设置已保存。")).toBeNull();
    act(() => invalidateAuthRequests()); resume();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("设置已保存。")).toBeNull();
  });

  it("shows members a read-only saved threshold and rejects missing self membership", async () => {
    install((url) => url.endsWith("/members") ? json(members("member")) : json(project(45))); const view = mount();
    await screen.findByText(/只有项目管理员可以修改/); expect(screen.getByLabelText("提醒阈值")).toHaveValue(45); expect(screen.getByLabelText("提醒阈值")).toBeDisabled(); expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull(); view.unmount();
    install((url) => url.endsWith("/members") ? json(members("admin", other)) : json(project())); mount();
    const denials = await screen.findAllByText("项目不存在或你没有访问权限。");
    expect(denials.some((message) => message.closest('[role="alert"]') !== null)).toBe(true);
    expect(screen.queryByLabelText("提醒阈值")).toBeNull(); expect(screen.queryByText("私有项目 Alpha")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  });

  it("rereads a conflict without replaying the draft, then permits a deliberate new edit", async () => {
    let reads = 0; const fetcher = install((url, init) => init.method === "PATCH" ? fail(409, "version_conflict") : url.endsWith("/members") ? json(members()) : json(project(++reads === 1 ? 60 : 75, BigInt(reads))));
    mount(); await ready(); change(); submit(); await screen.findByText(/设置已被其他人修改/); expect(screen.getByLabelText("提醒阈值")).toHaveValue(75); expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1); change("80"); expect(screen.getByRole("button", { name: "保存设置" })).not.toBeDisabled();
  });

  it("removes editing after denied saves and clears private state when access is lost", async () => {
    let reads = 0; install((url, init) => init.method === "PATCH" ? fail(403, "forbidden") : url.endsWith("/members") ? json(members(++reads === 1 ? "admin" : "member")) : json(project()));
    const view = mount(); await ready(); change(); submit(); await screen.findByText(/项目权限已变化/); expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull(); expect(screen.getByLabelText("提醒阈值")).toBeDisabled(); view.unmount();
    install((url, init) => init.method === "PATCH" ? fail(404, "not_found") : url.endsWith("/members") ? json(members()) : json(project())); mount(); await ready(); change(); submit(); await screen.findByRole("alert"); expect(screen.queryByLabelText("提醒阈值")).toBeNull(); expect(screen.queryByText("私有项目 Alpha")).toBeNull();
  });

  it.each(["network", "protocol", "server"])("reconciles %s save uncertainty using reads before another write", async (kind) => {
    let reads = 0; const fetcher = install((url, init) => {
      if (init.method === "PATCH") { if (kind === "network") return Promise.reject(new Error("connection lost")); if (kind === "protocol") return new Response("bad json", { headers: { "Content-Type": "application/json" } }); return fail(500); }
      return url.endsWith("/members") ? json(members()) : json(project(++reads === 1 ? 60 : 90));
    });
    mount(); await ready(); change(); submit(); await screen.findByText(/已读取当前保存设置/); expect(screen.getByLabelText("提醒阈值")).toHaveValue(90); expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1); expect(reads).toBe(2);
  });

  it("blocks save after failed reconciliation and retries only the authoritative read", async () => {
    let reads = 0; const fetcher = install((url, init) => init.method === "PATCH" ? fail(500) : url.endsWith("/members") ? json(members()) : ++reads === 2 ? fail(503) : json(project(reads === 1 ? 60 : 90)));
    mount(); await ready(); change(); submit(); await screen.findByRole("button", { name: "读取当前设置" }); expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled(); expect(screen.getByLabelText("提醒阈值")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "读取当前设置" })); await screen.findByText(/已读取当前保存设置/); expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1); expect(reads).toBe(3);
  });

  it("preserves a rejected draft, exposes safe failure metadata, and retries initial reads", async () => {
    let reads = 0; install((url, init) => init.method === "PATCH" ? fail(400, "invalid_input") : url.endsWith("/members") ? json(members()) : ++reads === 1 ? fail(500) : json(project())); mount();
    await screen.findByRole("alert"); expect(screen.queryByLabelText("提醒阈值")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "重试" })); await ready(); change(); submit(); await screen.findByRole("alert"); expect(screen.getByLabelText("提醒阈值")).toHaveValue(90); expect(screen.queryByText("private server diagnostic")).toBeNull(); expect(screen.getByRole("alert")).toHaveTextContent("safe-request");
  });

  it("clears private data if access disappears during uncertain-save reconciliation", async () => {
    let reads = 0; const fetcher = install((url, init) => init.method === "PATCH" ? fail(503) : url.endsWith("/members") ? json(members()) : ++reads === 1 ? json(project()) : fail(404, "not_found"));
    mount(); await ready(); change(); submit(); await screen.findByText("项目不存在或你没有访问权限。"); expect(screen.queryByLabelText("提醒阈值")).toBeNull(); expect(screen.queryByText("私有项目 Alpha")).toBeNull(); expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("ignores a late initial read after the actor changes", async () => {
    const stale = deferred<Response>(); let projectReads = 0;
    install((url) => url.endsWith("/members") ? json(members("admin", projectReads <= 1 ? userId : other)) : ++projectReads === 1 ? stale.promise : json(project(75)));
    const view = render(<TestTaskCacheBoundary viewerId={userId} key={userId}><ProjectSettingsPanel projectId={id} user={user} /></TestTaskCacheBoundary>); serverActor = other; view.rerender(<TestTaskCacheBoundary viewerId={other} key={other}><ProjectSettingsPanel projectId={id} user={{ ...user, id: other }} /></TestTaskCacheBoundary>); await ready(); expect(screen.getByLabelText("提醒阈值")).toHaveValue(75);
    await act(async () => stale.resolve(json(project(20)))); expect(screen.getByLabelText("提醒阈值")).toHaveValue(75);
  });

  it("aborts a pending mutation on project navigation and ignores its late response", async () => {
    const saving = deferred<Response>(); const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project())); const view = mount(); await ready(); change(); submit();
    const signal = fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1].signal as AbortSignal;
    view.rerender(<ProjectSettingsPanel projectId={other} user={user} />); expect(signal.aborted).toBe(true); expect(screen.queryByDisplayValue("90")).toBeNull(); await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n)))); expect(screen.queryByText("设置已保存。")).toBeNull();
  });
});

describe("settings navigation and authenticated identity", () => {
  it("parses canonical sibling routes and rejects malformed identifiers", () => {
    expect(parseAuthRoute(`/projects/${id}/settings`)).toEqual({ kind: "settings", projectId: id }); expect(parseAuthRoute("/projects/invalid/settings")).toEqual({ kind: "notFound" }); expect(parseAuthRoute(`/projects/${id}/settings/extra`)).toEqual({ kind: "notFound" });
  });

  it("renders localized route title, breadcrumbs and active project navigation", async () => {
    window.history.replaceState(null, "", `/projects/${id}/settings`); install((url) => url === "/api/v1/me" ? json(user) : url.endsWith("/members") ? json(members()) : json(project())); render(<AuthenticatedApp />); await ready();
    expect(document.title).toBe("项目设置 · Daynight"); const nav = screen.getByRole("navigation", { name: "项目设置" }); expect(within(nav).getByRole("link", { name: "项目设置" })).toHaveAttribute("aria-current", "page"); expect(screen.getByRole("navigation", { name: "面包屑" })).toHaveTextContent("项目设置");
  });

  it("preserves drafts on same-account foreground confirmation and resets them for a changed account", async () => {
    let actor = userId; let focused = true; vi.mocked(document.hasFocus).mockImplementation(() => focused);
    window.history.replaceState(null, "", `/projects/${id}/settings`); const fetcher = install((url) => url === "/api/v1/me" ? json({ ...user, id: actor }) : url.endsWith("/members") ? json(members("admin", actor)) : json(project())); render(<AuthenticatedApp />); await ready(); change("95");
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus")); await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(2)); await act(async () => { await Promise.resolve(); }); expect(screen.getByLabelText("提醒阈值")).toHaveValue(95);
    actor = other; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus")); await waitFor(() => expect(screen.getByLabelText("提醒阈值")).toHaveValue(60)); expect(screen.queryByText(/存在未保存的修改/)).toBeNull();
  });

  it("renders the English form without untranslated feedback", async () => {
    install(); createLocaleRender("en")(<ProjectSettingsPanel projectId={id} user={user} />, { taskCache: { viewerId: userId } }); const field = await screen.findByLabelText("Alert threshold"); await waitFor(() => expect(field).not.toBeDisabled()); fireEvent.change(field, { target: { value: "0" } }); fireEvent.submit(screen.getByRole("button", { name: "Save settings" }).closest("form")!); expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of minutes");
  });
});
