// GitHub settings has its own component and route-lifecycle coverage.
vi.mock('../src/features/github-integration/GitHubSettings', () => ({ GitHubSettings: () => null }));

import { directAccessFixture } from "./helpers/taskSync";
import { TestTaskCacheBoundary } from "./helpers/taskCache";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, assertResponsePrincipal, cancelAuthNetworkRequests, getTask, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { getProject, saveProjectSettings } from "../src/api/project-settings";
import * as settingsApi from "../src/api/project-settings";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { ProjectSettingsPanel } from "../src/features/management/ProjectSettingsPanel";
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { createTaskCacheScope, TaskCacheLifecycleChanged, TaskCacheScope } from "../src/features/task-cache/project-cache";
import { parseWarningDraft, useProjectSettings } from "../src/features/management/useProjectSettings";
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
const json = (body: unknown, status = 200) => wireResponse(body, { status, headers: { "Daynight-User-ID": serverActor } });
const fail = (status: number, code = "internal_error") => json({ error: { code, message: "private server diagnostic", requestId: "safe-request" } }, status);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const install = (handler: (url: string, init: RequestInit) => Response | Promise<Response> = (url) => url.endsWith("/members") ? json(members()) : json(project())) => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === `/api/v1/me/projects/${id}/worker-prompt`) return wireResponse({ scope: 'project', scopeId: id, revision: '0', text: '', updatedAt: null }, { headers: { 'Daynight-User-ID': serverActor } });
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
  it("admits project metadata only for the requested account when admission is supplied", async () => {
    const mismatch = vi.fn(), signal = new AbortController().signal;
    const fetcher = install(() => wireResponse(project(), { headers: { 'Daynight-User-ID': userId } }));
    expect((await getProject(id, signal, { userId, onPrincipalMismatch: mismatch })).name).toBe(project().name);
    fetcher.mockImplementation(() => Promise.resolve(wireResponse(project(), { headers: { 'Daynight-User-ID': other } })));
    await expect(getProject(id, signal, { userId, onPrincipalMismatch: mismatch })).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
    fetcher.mockImplementation(() => Promise.resolve(wireResponse(project())));
    await expect(getProject(id, signal, { userId, onPrincipalMismatch: mismatch })).rejects.toMatchObject({ kind: 'protocol' });
  });

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

  it("saves a newer draft against the confirmed snapshot without duplicate writes", async () => {
    const saving = deferred<Response>(); let writes = 0;
    const fetcher = install((url, init) => init.method === "PATCH" ? ++writes === 1 ? saving.promise : json(project(110, 9_007_199_254_740_995n)) : url.endsWith("/members") ? json(members()) : json(project()));
    mount(); await ready(); change(); submit(); fireEvent.submit(screen.getByRole("button", { name: "正在保存…" }).closest("form")!);
    const field = screen.getByLabelText("提醒阈值");
    expect(field).toBeEnabled(); expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await waitFor(() => expect(writes).toBe(1));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")[0]![1].body).toBe('{"version":9007199254740993,"executionWarningMinutes":90}');
    change("110");
    await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
    expect(field).toHaveValue(110);
    expect(screen.getByText(/存在未保存的修改/)).toBeVisible();
    expect(screen.queryByText("设置已保存。")).toBeNull();
    submit();
    await waitFor(() => expect(writes).toBe(2));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")[1]![1].body).toBe('{"version":9007199254740994,"executionWarningMinutes":110}');
    await screen.findByText("设置已保存。");
    expect(field).toHaveValue(110);
  });

  it("keeps a later draft conflicted when a return read observes a newer external version", async () => {
    const saving = deferred<Response>(); let external = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(external ? project(120, 9_007_199_254_740_995n) : project()));
    const view = mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1));
    change("110");
    view.rerender(<ProjectSettingsPanel projectId={id} user={user} active={false} onRoute={false} />);
    external = true;
    await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    view.rerender(<ProjectSettingsPanel projectId={id} user={user} active onRoute />);
    expect(await screen.findByText(/离开期间设置已变更/)).toBeVisible();
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(110);
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("keeps an unsubmitted draft editable while identity and permissions are checked", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    install((url) => url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change("95");
    const field = screen.getByLabelText("提醒阈值") as HTMLInputElement;
    field.focus();
    const resume = pauseAuthRequests(); holdPermission = true; fireEvent(window, new Event("focus"));
    expect(field).not.toBeDisabled(); expect(document.activeElement).toBe(field);
    expect(screen.getByRole("button", { name: "保存设置" })).not.toBeDisabled();
    change("96"); expect(field).toHaveValue(96);
    resume(); await act(async () => permission.resolve(json(members())));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).not.toBeDisabled());
    expect(screen.getByLabelText("提醒阈值")).toBe(field); expect(document.activeElement).toBe(field); expect(field).toHaveValue(96);
  });

  it("waits for fresh access before saving exactly once", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(95, 9_007_199_254_740_994n)) : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change("95");
    const field = screen.getByLabelText("提醒阈值"); field.focus();
    const initialProjectReads = fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/projects/${id}`) && !init.method).length;
    const initialAccessReads = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
    holdPermission = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(initialAccessReads));
    expect(screen.getByLabelText("提醒阈值")).toBe(field); expect(document.activeElement).toBe(field);
    const form = screen.getByRole("button", { name: "保存设置" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/projects/${id}`) && !init.method)).toHaveLength(initialProjectReads);
    await act(async () => permission.resolve(json(members())));
    await screen.findByText("设置已保存。");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    expect(fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1].body).toBe('{"version":9007199254740993,"executionWarningMinutes":95}');
  });

  it("waits for the new access check after a blocked identity recovery", async () => {
    const old = deferred<Response>(), fresh = deferred<Response>(); let phase: "initial" | "old" | "fresh" = "initial";
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(95, 9_007_199_254_740_994n)) : url.endsWith("/members") ? phase === "old" ? old.promise : phase === "fresh" ? fresh.promise : json(members()) : json(project()));
    const view = mount(); await ready(); change("95");
    phase = "old"; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access"))).toHaveLength(2));
    const resume = pauseAuthRequests(); submit();
    view.rerender(<ProjectSettingsPanel projectId={id} user={user} active={false} />);
    await act(async () => { old.resolve(json(members())); });
    phase = "fresh"; resume();
    await act(async () => { await Promise.resolve(); });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
    view.rerender(<ProjectSettingsPanel projectId={id} user={user} active />);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access"))).toHaveLength(3));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
    await act(async () => fresh.resolve(json(members("member"))));
    await screen.findByText(/只有项目管理员可以修改/);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
  });

  it.each(["member", "missing"])("does not save after a pending access check reports %s", async (result) => {
    const permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(90, 9_007_199_254_740_994n)) : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change();
    holdPermission = true; fireEvent(window, new Event("focus"));
    submit();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
    await act(async () => permission.resolve(result === "member" ? json(members("member")) : fail(404, "not_found")));
    if (result === "member") await screen.findByText(/只有项目管理员可以修改/);
    else await screen.findAllByText("项目不存在或你没有访问权限。");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
  });

  it("cancels a save waiting for access when requests pause without dispatch or replay", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(90, 9_007_199_254_740_994n)) : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    mount(); await ready(); change();
    const before = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
    holdPermission = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(before));
    submit(); expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    const resume = pauseAuthRequests();
    try {
      await waitFor(() => expect(screen.queryByRole("button", { name: "正在保存…" })).toBeNull());
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
      expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
      holdPermission = false; await act(async () => permission.resolve(json(members())));
      resume(); await act(async () => { await Promise.resolve(); });
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
    } finally { resume(); }
  });

  it("does not dispatch a queued save after its project generation ends", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(90, 9_007_199_254_740_994n)) : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    const view = mount(); await ready(); change();
    holdPermission = true; fireEvent(window, new Event("focus")); submit();
    view.unmount();
    await act(async () => permission.resolve(json(members())));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
  });

  it("retains a confirmed save when permission recovery fails and reads before enabling another save", async () => {
    const saving = deferred<Response>(), permission = deferred<Response>(); let holdPermission = false, saved = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project(saved ? 90 : 60, saved ? 9_007_199_254_740_994n : 9_007_199_254_740_993n)));
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(true));
    const resume = pauseAuthRequests(); holdPermission = true; fireEvent(window, new Event("focus"));
    saved = true; await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
    resume(); await act(async () => permission.resolve(fail(503)));
    await screen.findByText("设置已保存。"); const alert = (await screen.findByRole("alert")).closest('[role="alert"]') as HTMLElement;
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    holdPermission = false; fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("resolves the original save promise while receipt publication is paused", async () => {
    const saving = deferred<Response>();
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project()));
    let completion: Promise<void> | undefined;
    const Probe = () => {
      const state = useProjectSettings(id, userId, true, true);
      return <><input aria-label="draft" value={state.draft} onChange={(event) => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? "pending" : "idle"}</span></>;
    };
    render(<ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary>);
    await waitFor(() => expect(screen.getByLabelText("draft")).toHaveValue("60"));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "90" } }); fireEvent.click(screen.getByRole("button", { name: "submit" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1));
    const resolved = vi.fn(); void completion!.then(resolved);
    const resume = pauseAuthRequests();
    try {
      await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
      await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
      expect(screen.getByText("idle")).toBeInTheDocument();
      expect(screen.getByLabelText("draft")).toHaveValue("90");
    } finally { resume(); }
  });

  it.each(["returned", "interrupted", "resumed-before-catch"] as const)("resumes receipt publication across scope admission: %s", async (admission) => {
    const saving = deferred<Response>();
    const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project()));
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1));
    let resume: (() => void) | undefined;
    const originalReady = TaskCacheScope.prototype.ready;
    const barrier = vi.spyOn(TaskCacheScope.prototype, "ready").mockImplementationOnce(async function (this: TaskCacheScope, signal) {
      await originalReady.call(this, signal);
      resume = pauseAuthRequests();
      if (admission === "resumed-before-catch") resume();
      if (admission !== "returned") throw new TaskCacheLifecycleChanged();
    });
    try {
      await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n))));
      await waitFor(() => expect(resume).toBeDefined());
      await waitFor(() => expect(screen.queryByRole("button", { name: "正在保存…" })).toBeNull());
      if (admission === "resumed-before-catch") {
        await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toBeDisabled());
        expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
      } else {
        expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
        change("110");
        act(() => resume!());
        await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
        expect(screen.getByLabelText("提醒阈值")).toHaveValue(110);
      }
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    } finally { barrier.mockRestore(); resume?.(); }
  });

  it("waits for a new access check begun after the first fresh observation before dispatch", async () => {
    const permission = deferred<Response>(); let holdPermission = false;
    const fetcher = install((url, init) => init.method === "PATCH" ? json(project(90, 9_007_199_254_740_994n)) : url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project()));
    let session: ProjectAccessSession;
    let completion: Promise<void> | undefined;
    const Probe = () => {
      session = useProjectAccess(id).session;
      const state = useProjectSettings(id, userId, true, true);
      return <><input aria-label="draft" value={state.draft} onChange={(event) => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button></>;
    };
    render(<ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary>);
    await waitFor(() => expect(screen.getByLabelText("draft")).toHaveValue("60"));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "90" } });
    const before = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
    const originalReady = TaskCacheScope.prototype.ready;
    const originalSnapshot = session!.snapshot;
    const barrier = vi.spyOn(TaskCacheScope.prototype, "ready").mockImplementationOnce(async function (this: TaskCacheScope, signal) {
      await originalReady.call(this, signal);
      session.snapshot = () => {
        session.snapshot = originalSnapshot;
        const observed = originalSnapshot();
        holdPermission = true; void session.revalidate();
        return observed;
      };
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "submit" }));
      await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(before));
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
      holdPermission = false; await act(async () => permission.resolve(json(members("member"))));
      await act(async () => completion);
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(0);
      expect(screen.getByLabelText("draft")).toHaveValue("90");
    } finally { barrier.mockRestore(); session!.snapshot = originalSnapshot; }
  });

  it("retains a newer draft when an unknown save is reconciled after a pause", async () => {
    const saving = deferred<Response>(); let reads = 0;
    const fetcher = install((url, init) => {
      if (init.method === "PATCH") return saving.promise;
      if (url.endsWith("/members")) return json(members());
      reads++; return json(project(reads === 1 ? 60 : 90, reads === 1 ? 9_007_199_254_740_993n : 9_007_199_254_740_994n));
    });
    let completion: Promise<void> | undefined;
    const Probe = () => {
      const state = useProjectSettings(id, userId, true, true);
      return <><input aria-label="draft" value={state.draft} onChange={(event) => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? "pending" : "idle"}</span><span>{state.uncertain ? "unknown" : "known"}</span></>;
    };
    render(<ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary>);
    await waitFor(() => expect(screen.getByLabelText("draft")).toHaveValue("60"));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "90" } }); fireEvent.click(screen.getByRole("button", { name: "submit" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1));
    const resume = pauseAuthRequests();
    try {
      await act(async () => { saving.reject(new TypeError("response lost")); await completion; });
      expect(screen.getByText("unknown")).toBeInTheDocument(); expect(screen.getByText("idle")).toBeInTheDocument();
      const before = reads;
      fireEvent.change(screen.getByLabelText("draft"), { target: { value: "110" } });
      expect(reads).toBe(before);
      resume();
      await waitFor(() => expect(reads).toBeGreaterThan(before));
      await waitFor(() => expect(screen.getByText("known")).toBeInTheDocument());
      expect(screen.getByLabelText("draft")).toHaveValue("110");
      expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    } finally { resume(); }
  });

  it("settles a confirmed save during a pause and preserves a newer draft when it publishes", async () => {
    const saving = deferred<Response>(), permission = deferred<Response>(); let holdPermission = false, writes = 0, saved = false;
    const fetcher = install((url, init) => {
      if (init.method === "PATCH") return ++writes === 1 ? saving.promise : json(project(110, 9_007_199_254_740_995n));
      return url.endsWith("/members") ? holdPermission ? permission.promise : json(members()) : json(project(saved ? 90 : 60, saved ? 9_007_199_254_740_994n : 9_007_199_254_740_993n));
    });
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(writes).toBe(1));
    const reads = fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/projects/${id}`) && !init.method).length;
    const resume = pauseAuthRequests(); holdPermission = true;
    fireEvent(window, new Event("focus"));
    await act(async () => { saved = true; saving.resolve(json(project(90, 9_007_199_254_740_994n))); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "正在保存…" })).toBeNull());
    expect(screen.queryByText("设置已保存。")).toBeNull();
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
    expect(screen.getByLabelText("提醒阈值")).toBeEnabled();
    change("110");
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/projects/${id}`) && !init.method)).toHaveLength(reads);
    expect(writes).toBe(1);
    resume();
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(1));
    expect(screen.queryByText("设置已保存。")).toBeNull();
    holdPermission = false; await act(async () => permission.resolve(json(members())));
    await screen.findByText(/存在未保存的修改/);
    expect(screen.queryByText("设置已保存。")).toBeNull();
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(110);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
    submit();
    await waitFor(() => expect(writes).toBe(2));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")[1]![1].body).toBe('{"version":9007199254740994,"executionWarningMinutes":110}');
  });

  it.each([new TypeError("response lost"), new DOMException("network cancelled", "AbortError")])("settles a dispatched unknown save after %s without automatically reading or replaying", async (failure) => {
    const saving = deferred<Response>(), permission = deferred<Response>(); let holdPermission = false, reads = 0;
    const fetcher = install((url, init) => {
      if (init.method === "PATCH") return saving.promise;
      if (url.endsWith("/members")) return holdPermission ? permission.promise : json(members());
      reads++; return json(project(reads === 1 ? 60 : 90, reads === 1 ? 9_007_199_254_740_993n : 9_007_199_254_740_994n));
    });
    mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1));
    const initialReads = reads;
    const resume = pauseAuthRequests(); holdPermission = true; fireEvent(window, new Event("focus"));
    await act(async () => saving.reject(failure));
    await waitFor(() => expect(screen.queryByRole("button", { name: "正在保存…" })).toBeNull());
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(90);
    expect(reads).toBe(initialReads);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    resume();
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(1));
    holdPermission = false; await act(async () => permission.resolve(json(members())));
    await screen.findByText(/已读取当前保存设置/);
    expect(reads).toBeGreaterThan(initialReads);
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
    const view = render(<TestTaskCacheBoundary viewerId={userId} key={userId}><ProjectSettingsPanel projectId={id} user={user} /></TestTaskCacheBoundary>); await waitFor(() => expect(projectReads).toBe(1)); serverActor = other; view.rerender(<TestTaskCacheBoundary viewerId={other} key={other}><ProjectSettingsPanel projectId={id} user={{ ...user, id: other }} /></TestTaskCacheBoundary>); await ready(); expect(screen.getByLabelText("提醒阈值")).toHaveValue(75);
    await act(async () => stale.resolve(json(project(20)))); expect(screen.getByLabelText("提醒阈值")).toHaveValue(75);
  });

  it("aborts a pending mutation on project navigation and ignores its late response", async () => {
    const saving = deferred<Response>(); const fetcher = install((url, init) => init.method === "PATCH" ? saving.promise : url.endsWith("/members") ? json(members()) : json(project())); const view = mount(); await ready(); change(); submit();
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(true));
    const signal = fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1].signal as AbortSignal;
    view.rerender(<ProjectSettingsPanel projectId={other} user={user} />); expect(signal.aborted).toBe(true); expect(screen.queryByDisplayValue("90")).toBeNull(); await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n)))); expect(screen.queryByText("设置已保存。")).toBeNull();
  });
});

describe("settings navigation and authenticated identity", () => {
  it("parses canonical sibling routes and rejects malformed identifiers", () => {
    expect(parseAuthRoute(`/projects/${id}/settings`)).toEqual({ kind: "settings", projectId: id, selection: { kind: "tab", tab: "execution" } }); expect(parseAuthRoute("/projects/invalid/settings")).toEqual({ kind: "notFound" }); expect(parseAuthRoute(`/projects/${id}/settings/extra`)).toEqual({ kind: "notFound" });
  });

  it("renders localized route title, breadcrumbs and active project navigation", async () => {
    window.history.replaceState(null, "", `/projects/${id}/settings`); install((url) => url === "/api/v1/me" ? json(user) : url.endsWith("/members") ? json(members()) : json(project())); render(<AuthenticatedApp />); await ready();
    expect(document.title).toBe("项目设置 · Daynight"); const nav = screen.getByRole("navigation", { name: "项目设置" }); expect(within(nav).getAllByRole("link")).toHaveLength(1); expect(within(nav).getByRole("link", { name: "项目任务" })).toHaveAttribute("href", `/projects/${id}`); expect(screen.getByRole("navigation", { name: "面包屑" })).toHaveTextContent("项目设置");
  });

  it("preserves drafts through focus and an account change until refresh", async () => {
    let focused = true; vi.mocked(document.hasFocus).mockImplementation(() => focused);
    window.history.replaceState(null, "", `/projects/${id}/settings`); const fetcher = install((url) => url === "/api/v1/me" ? json(user) : url.endsWith("/members") ? json(members()) : json(project())); render(<AuthenticatedApp />); await ready(); change("95");
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    localStorage.setItem("daynight.activeUser", JSON.stringify(other));
    fireEvent(window, new StorageEvent("storage", { key: "daynight.activeUser" }));
    await screen.findByText("账户已变化");
    expect(screen.getByLabelText("提醒阈值")).toHaveValue(95);
    expect(screen.getByText(/存在未保存的修改/)).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("renders the English form without untranslated feedback", async () => {
    install(); createLocaleRender("en")(<ProjectSettingsPanel projectId={id} user={user} />, { taskCache: { viewerId: userId } }); const field = await screen.findByLabelText("Alert threshold"); await waitFor(() => expect(field).not.toBeDisabled()); fireEvent.change(field, { target: { value: "0" } }); fireEvent.submit(screen.getByRole("button", { name: "Save settings" }).closest("form")!); expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of minutes");
  });
});


it.each(["confirmed", "conflict", "unknown"] as const)("settles a %s settings write without publication after real principal mismatch", async outcome => {
  const saving = deferred<Response>(), mismatch = deferred<Response>(); let resume = () => {};
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  const fetcher = install((url, init) => {
    if (url.includes('/tasks/')) return mismatch.promise;
    if (init.method === 'PATCH') return saving.promise;
    return url.endsWith('/members') ? json(members()) : json(project());
  });
  let completion: Promise<void> | undefined;
  const Probe = () => { const state = useProjectSettings(id, userId, true, true); return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? 'pending' : 'idle'}</span><span>{state.uncertain ? 'unknown' : 'known'}</span><span>{state.project?.settings.executionWarningMinutes}</span><span>{state.notice ?? 'no notice'}</span><span>{state.reconciliation ?? 'no conflict'}</span></>; };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
  const observation = getTask(id, '20000000-0000-4000-8000-000000000001', new AbortController().signal, { userId, onPrincipalMismatch: scope.principalMismatch });
  const denied = expect(observation).rejects.toMatchObject({ code: 'principal_mismatch' });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/tasks/'))).toBe(true)); const foreground = pauseAuthRequests();
  try {
    if (outcome === 'confirmed') { await act(async () => saving.resolve(json(project(90, 9_007_199_254_740_994n)))); await act(async () => completion); }
    else if (outcome === 'conflict') { await act(async () => saving.resolve(fail(409, 'version_conflict'))); await act(async () => completion); }
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '110' } });
    await act(async () => { mismatch.resolve(wireResponse({}, { headers: { 'Daynight-User-ID': other } })); await denied; await completion; });
    expect(screen.getByText('idle')).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('110');
    expect(screen.getByText('60')).toBeInTheDocument(); expect(screen.getByText('no notice')).toBeInTheDocument();
    expect(screen.getByText(outcome === 'unknown' ? 'unknown' : 'known')).toBeInTheDocument();
    expect(screen.getByText(outcome === 'conflict' ? 'conflict' : 'no conflict')).toBeInTheDocument();
    const calls = fetcher.mock.calls.length; foreground(); resume(); await act(async () => { await Promise.resolve(); });
    expect(fetcher.mock.calls.length).toBe(calls); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { foreground(); resume(); view.unmount(); scope.dispose(); }
});


it.each(['confirmed', 'conflict', 'unknown'] as const)('retains a %s settings outcome at the decoded-response mismatch boundary', async outcome => {
  let resume = () => {}; const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  const mismatch = wireResponse({}, { headers: { 'Daynight-User-ID': other } });
  const trigger = () => { try { assertResponsePrincipal(mismatch, userId, scope.principalMismatch); } catch { /* The other principal is rejected. */ } };
  const save = settingsApi.saveProjectSettings; const spy = vi.spyOn(settingsApi, 'saveProjectSettings').mockImplementation((projectId, input, signal, onDispatch, admission) => save(projectId, input, signal, onDispatch, admission === undefined ? undefined : {
    ...admission, onConfirmed: value => { admission.onConfirmed?.(value); trigger(); }, onRejected: error => { admission.onRejected?.(error); trigger(); },
  }));
  const fetcher = install((url, init) => init.method === 'PATCH' ? outcome === 'confirmed' ? json(project(90, 9_007_199_254_740_994n)) : fail(outcome === 'conflict' ? 409 : 500, outcome === 'conflict' ? 'version_conflict' : 'internal_error') : url.endsWith('/members') ? json(members()) : json(project()));
  let completion: Promise<void> | undefined;
  const Probe = () => { const state = useProjectSettings(id, userId, true, true); return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? 'pending' : 'idle'}</span><span>{state.uncertain ? 'unknown' : 'known'}</span><span>{state.reconciliation ?? 'no conflict'}</span><span>{state.project?.settings.executionWarningMinutes}</span></>; };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60')); fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' })); await act(async () => completion);
    expect(scope.hasIdentityMismatch).toBe(true); expect(screen.getByText('idle')).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    expect(screen.getByText('60')).toBeInTheDocument(); expect(screen.getByText(outcome === 'unknown' ? 'unknown' : 'known')).toBeInTheDocument();
    expect(screen.getByText(outcome === 'conflict' ? 'conflict' : 'no conflict')).toBeInTheDocument(); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { spy.mockRestore(); resume(); view.unmount(); scope.dispose(); }
});

it.each([
  [403, null], [404, null], [403, 'malformed'], [404, 'malformed'],
] as const)('retains displayed settings and draft after a %i read with principal %s', async (status, principal) => {
  let reads = 0;
  const fetcher = install((url, init) => {
    if (init.method === 'PATCH') return fail(500);
    if (url.endsWith('/members')) return json(members());
    if (++reads === 1) return json(project());
    return wireResponse({ error: { code: 'not_found', message: 'Denied', requestId: 'read-error' } }, {
      status, headers: principal === null ? {} : { 'Daynight-User-ID': principal },
    });
  });
  const Probe = () => {
    const state = useProjectSettings(id, userId, true, true);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => void state.save()}>submit</button><span>{state.project?.name}</span><span>{state.unavailable ? 'unavailable' : 'retained'}</span><span>{state.error instanceof ApiError ? state.error.kind : 'no error'}</span></>;
  };
  render(<ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary>);
  await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
  await screen.findByText('protocol');
  expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(screen.getByText('retained')).toBeInTheDocument();
  expect(screen.getByLabelText('draft')).toHaveValue('90');
  expect(reads).toBe(2); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
});

it('ends an in-flight settings read after principal mismatch without issuing another read', async () => {
  const held = deferred<Response>(); let reads = 0;
  const mismatch = vi.fn(); const scope = createTaskCacheScope({ userId, onIdentityMismatch: mismatch });
  const fetcher = install((url, init) => {
    if (url.includes('/tasks/')) return wireResponse({}, { headers: { 'Daynight-User-ID': other } });
    if (init.method === 'PATCH') return fail(500);
    if (url.endsWith('/members')) return json(members());
    return ++reads === 1 ? json(project()) : held.promise;
  });
  const Probe = () => {
    const state = useProjectSettings(id, userId, true, true);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => void state.save()}>submit</button><span>{state.project?.name}</span><span>{state.loading ? 'loading' : 'idle'}</span></>;
  };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(reads).toBe(2)); expect(screen.getByText('loading')).toBeInTheDocument();
    await act(async () => { await expect(getTask(id, '20000000-0000-4000-8000-000000000001', new AbortController().signal, { userId, onPrincipalMismatch: scope.principalMismatch })).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' }); });
    await screen.findByText('idle');
    expect(mismatch).toHaveBeenCalledOnce(); expect(scope.signal.aborted).toBe(false); expect(scope.isInvalidated).toBe(false);
    expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    await act(async () => held.resolve(json(project(120, 9_007_199_254_740_994n))));
    expect(reads).toBe(2); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
    expect(screen.getByLabelText('draft')).toHaveValue('90'); expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument();
  } finally { view.unmount(); scope.dispose(); }
});

it.each([400, 404] as const)('retains a decoded %i settings rejection and draft across navigation after principal mismatch', async status => {
  let resume = () => {};
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  const mismatch = wireResponse({}, { headers: { 'Daynight-User-ID': other } });
  const save = settingsApi.saveProjectSettings;
  const spy = vi.spyOn(settingsApi, 'saveProjectSettings').mockImplementation((projectId, input, signal, onDispatch, admission) => save(projectId, input, signal, onDispatch, admission === undefined ? undefined : {
    ...admission, onRejected: error => {
      admission.onRejected?.(error);
      try { assertResponsePrincipal(mismatch, userId, scope.principalMismatch); } catch { /* The other principal is rejected. */ }
    },
  }));
  const fetcher = install((url, init) => init.method === 'PATCH' ? fail(status, status === 404 ? 'not_found' : 'invalid_input') : url.endsWith('/members') ? json(members()) : json(project()));
  const retention = vi.fn(); let completion: Promise<void> | undefined;
  const Probe = ({ onRoute }: { onRoute: boolean }) => {
    const state = useProjectSettings(id, userId, onRoute, true, retention);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? 'pending' : 'idle'}</span><span>{state.uncertain ? 'unknown' : 'known'}</span><span>{state.project?.name}</span><span>{state.writeError instanceof ApiError ? `rejected ${state.writeError.status}` : 'no rejection'}</span></>;
  };
  const tree = (onRoute: boolean) => <TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe onRoute={onRoute} /></ProjectAccessBoundary></TestTaskCacheBoundary>;
  const view = render(tree(true));
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await act(async () => completion);
    expect(scope.hasIdentityMismatch).toBe(true); expect(scope.signal.aborted).toBe(false);
    expect(screen.getByText('idle')).toBeInTheDocument(); expect(screen.getByText('known')).toBeInTheDocument();
    expect(screen.getByText(`rejected ${status}`)).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(retention).toHaveBeenLastCalledWith(true);
    const count = fetcher.mock.calls.length;
    act(() => resume()); view.rerender(tree(false)); view.rerender(tree(true));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(`rejected ${status}`)).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(retention).toHaveBeenLastCalledWith(true);
    expect(fetcher.mock.calls.length).toBe(count); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { spy.mockRestore(); resume(); view.unmount(); scope.dispose(); }
});

it.each([400, 404] as const)('retains a decoded %i rejection when mismatch interrupts its paused publication', async status => {
  const saving = deferred<Response>(), observed = deferred<Response>();
  const mismatch = vi.fn(); const scope = createTaskCacheScope({ userId, onIdentityMismatch: mismatch });
  const fetcher = install((url, init) => {
    if (url.includes('/tasks/')) return observed.promise;
    if (init.method === 'PATCH') return saving.promise;
    return url.endsWith('/members') ? json(members()) : json(project());
  });
  const retention = vi.fn(); let completion: Promise<void> | undefined;
  const Probe = () => {
    const state = useProjectSettings(id, userId, true, true, retention);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><button type="button" onClick={state.retry}>retry</button><span>{state.pending ? 'pending' : 'idle'}</span><span>{state.uncertain ? 'unknown' : 'known'}</span><span>{state.project?.name}</span><span>{state.writeError instanceof ApiError ? `rejected ${state.writeError.status}` : 'no rejection'}</span></>;
  };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  let resume = () => {};
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
    const observation = getTask(id, '20000000-0000-4000-8000-000000000001', new AbortController().signal, { userId, onPrincipalMismatch: scope.principalMismatch });
    const denied = expect(observation).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/tasks/'))).toBe(true));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { saving.resolve(fail(status, status === 404 ? 'not_found' : 'invalid_input')); await completion; });
    expect(screen.getByText('idle')).toBeInTheDocument(); expect(screen.getByText('no rejection')).toBeInTheDocument();
    expect(screen.getByLabelText('draft')).toHaveValue('90'); expect(retention).toHaveBeenLastCalledWith(true);
    await act(async () => { observed.resolve(wireResponse({}, { headers: { 'Daynight-User-ID': other } })); await denied; });
    await screen.findByText(`rejected ${status}`); expect(mismatch).toHaveBeenCalledOnce();
    expect(screen.getByText('known')).toBeInTheDocument(); expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument();
    expect(screen.getByLabelText('draft')).toHaveValue('90'); expect(retention).toHaveBeenLastCalledWith(true);
    const calls = fetcher.mock.calls.length; act(() => resume()); fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(`rejected ${status}`)).toBeInTheDocument(); expect(fetcher.mock.calls).toHaveLength(calls);
  } finally { resume(); view.unmount(); scope.dispose(); }
});

it('applies a trusted 404 after an ordinary pause resumes', async () => {
  const saving = deferred<Response>(); const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const fetcher = install((url, init) => init.method === 'PATCH' ? saving.promise : url.endsWith('/members') ? json(members()) : json(project()));
  let completion: Promise<void> | undefined;
  const Probe = () => {
    const state = useProjectSettings(id, userId, true, true);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.project?.name}</span><span>{state.unavailable ? 'unavailable' : 'available'}</span></>;
  };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  let resume = () => {};
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { saving.resolve(fail(404, 'not_found')); await completion; });
    expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    act(() => resume()); await screen.findByText('unavailable');
    expect(screen.queryByText('私有项目 Alpha')).toBeNull(); expect(screen.getByLabelText('draft')).toHaveValue('');
    expect(scope.hasIdentityMismatch).toBe(false); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { resume(); view.unmount(); scope.dispose(); }
});

it('does not publish an old paused rejection into a replacement settings owner', async () => {
  const saving = deferred<Response>(), observed = deferred<Response>();
  const oldScope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const newScope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const fetcher = install((url, init) => {
    if (url.includes('/tasks/')) return observed.promise;
    if (init.method === 'PATCH') return saving.promise;
    return url.endsWith('/members') ? json(members()) : json(project());
  });
  const oldRetention = vi.fn(); let completion: Promise<void> | undefined;
  const Probe = ({ retention }: { retention?: ((value: boolean) => void) | undefined }) => {
    const state = useProjectSettings(id, userId, true, true, retention);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.writeError instanceof ApiError ? `rejected ${state.writeError.status}` : 'no rejection'}</span><span>{state.project?.name}</span></>;
  };
  const tree = (scope: TaskCacheScope, key: string, retention?: (value: boolean) => void) => <TestTaskCacheBoundary scope={scope} key={key}><ProjectAccessBoundary projectId={id} initialRead active><Probe retention={retention} /></ProjectAccessBoundary></TestTaskCacheBoundary>;
  const view = render(tree(oldScope, 'old', oldRetention)); let resume = () => {};
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
    const observation = getTask(id, '20000000-0000-4000-8000-000000000001', new AbortController().signal, { userId, onPrincipalMismatch: oldScope.principalMismatch });
    const denied = expect(observation).rejects.toMatchObject({ code: 'principal_mismatch' });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/tasks/'))).toBe(true));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { saving.resolve(fail(404, 'not_found')); await completion; });
    view.rerender(tree(newScope, 'new')); const retentionCalls = oldRetention.mock.calls.length;
    await act(async () => { observed.resolve(wireResponse({}, { headers: { 'Daynight-User-ID': other } })); await denied; });
    act(() => resume()); await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    expect(screen.getByText('no rejection')).toBeInTheDocument(); expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument();
    expect(oldRetention.mock.calls).toHaveLength(retentionCalls); expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { resume(); view.unmount(); oldScope.dispose(); newScope.dispose(); }
});

it('treats a cancelled dispatched settings write as unknown even if a late 404 arrives', async () => {
  const saving = deferred<Response>();
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const fetcher = install((url, init) => init.method === 'PATCH' ? saving.promise : url.endsWith('/members') ? json(members()) : json(project()));
  let completion: Promise<void> | undefined;
  const Probe = () => {
    const state = useProjectSettings(id, userId, true, true);
    return <><input aria-label="draft" value={state.draft} onChange={event => state.change(event.target.value)} /><button type="button" onClick={() => { completion = state.save(); }}>submit</button><span>{state.pending ? 'pending' : 'idle'}</span><span>{state.uncertain ? 'unknown' : 'known'}</span><span>{state.unavailable ? 'unavailable' : 'available'}</span><span>{state.project?.name}</span></>;
  };
  const view = render(<TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={id} initialRead active><Probe /></ProjectAccessBoundary></TestTaskCacheBoundary>);
  let resume = () => {};
  try {
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
    const network = fetcher.mock.calls.find(([, init]) => init.method === 'PATCH')![1].signal as AbortSignal;
    act(() => { resume = pauseAuthRequests(); cancelAuthNetworkRequests(); }); expect(network.aborted).toBe(true);
    await act(async () => { saving.resolve(fail(404, 'not_found')); await completion; });
    expect(screen.getByText('idle')).toBeInTheDocument(); expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('available')).toBeInTheDocument(); expect(screen.getByText('私有项目 Alpha')).toBeInTheDocument(); expect(screen.getByLabelText('draft')).toHaveValue('90');
    act(() => resume()); await act(async () => { await Promise.resolve(); });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  } finally { resume(); view.unmount(); scope.dispose(); }
});
