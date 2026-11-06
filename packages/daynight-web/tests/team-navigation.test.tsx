import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { stringifyWireJson } from "./helpers/wireJson";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";

const render = createLocaleRender("en");
const userId = "00000000-0000-4000-8000-000000000001", personal = "00000000-0000-4000-8000-000000000002", a = "00000000-0000-4000-8000-000000000003", b = "00000000-0000-4000-8000-000000000004", projectId = "00000000-0000-4000-8000-000000000005";
const time = "2026-10-20T09:00:00Z";
const person = { id: userId, personalTeam: { id: personal, kind: "personal", name: null }, name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const team = (id: string, name: string | null, kind = "ordinary") => ({ id, kind, name, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } });
const project = { id: projectId, name: "Raw 项目", repoUrl: "git@example.com:repo.git", createdAt: time, updatedAt: time, ownership: { teamId: a, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
let focused = true;
const install = (extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const special = extra?.(url, init); if (special !== undefined) return Promise.resolve(special);
    if (url === "/api/v1/me") return Promise.resolve(json(person));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json({ items: [team(a, "  Alpha  "), team(b, "Beta")], nextCursor: null }));
    if (url === `/api/v1/teams/${a}`) return Promise.resolve(json(team(a, "  Alpha  ")));
    if (url === `/api/v1/teams/${b}`) return Promise.resolve(json(team(b, "Beta")));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
};
beforeEach(() => { focused = true; vi.spyOn(document, "hasFocus").mockImplementation(() => focused); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });

describe("Team workspace navigation", () => {
  it.each(["en", "zh-CN"] as const)("keeps empty project guidance specific to each workspace in %s", async (locale) => {
    window.history.replaceState(null, "", `/teams/${a}`);
    install();
    createLocaleRender(locale)(<AuthenticatedApp />);
    const chinese = locale === "zh-CN";
    const teamDetail = chinese ? "在这个 Team 中创建第一个项目，Team 成员都可以访问。" : "Create the first project in this Team. Team members can access it.";
    const personalDetail = chinese ? "创建私有项目来整理工作，或使用管理员发给你的邀请链接加入团队。" : "Create a private project to organize your work, or join your team using an administrator's invitation link.";
    const sharedDetail = chinese ? "其他人邀请你加入项目后，项目会出现在这里。" : "Projects appear here when someone grants you access.";
    const createFirst = chinese ? "创建第一个项目" : "Create your first project";

    expect(await screen.findByText(teamDetail)).toBeInTheDocument();
    expect(screen.queryByText(personalDetail)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: createFirst }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: chinese ? "关闭创建项目" : "Close create project" }));

    act(() => navigate(`/teams/${personal}`));
    expect(await screen.findByText(personalDetail)).toBeInTheDocument();
    expect(screen.queryByText(teamDetail)).toBeNull();
    expect(screen.getByRole("button", { name: createFirst })).toBeInTheDocument();

    act(() => navigate("/shared-projects"));
    expect(await screen.findByText(sharedDetail)).toBeInTheDocument();
    expect(screen.queryByText(teamDetail)).toBeNull();
    expect(screen.queryByText(personalDetail)).toBeNull();
    expect(screen.queryByRole("button", { name: createFirst })).toBeNull();
  });
  it.each(["/shared-projects", `/projects/${projectId}/tasks/00000000-0000-4000-8000-000000000006`])("preserves another tab's newer Team after a delayed self exit on %s", async (route) => {
    window.history.replaceState(null, "", `/teams/${a}/members`);
    const receipt = Promise.withResolvers<Response>();
    const fetcher = install((url, init) => {
      if (url === `/api/v1/teams/${a}`) return json({ ...team(a, "Alpha"), membership: { ...team(a, "Alpha").membership, role: "member" } });
      if (url === `/api/v1/teams/${a}/members`) return json({ items: [{ ...team(a, "Alpha").membership, role: "member", profile: { name: "Alice", email: null, avatarUrl: null } }] });
      if (url === `/api/v1/teams/${a}/members/${userId}` && init?.method === "DELETE") return receipt.promise;
      if (url.startsWith(`/api/v1/projects/${projectId}`)) return json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404);
      return undefined;
    });
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: "Leave Team" });
    await waitFor(() => expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a));
    fireEvent.click(screen.getByRole("button", { name: "Leave Team" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
    act(() => navigate(route));
    if (route === "/shared-projects") await screen.findByRole("heading", { name: "Projects shared with me" });
    else await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith(`/api/v1/projects/${projectId}`))).toBe(true));
    expect(screen.getByRole("dialog", { hidden: true })).toBeInTheDocument();
    localStorage.setItem(`daynight.selectedTeam:${userId}`, b);
    await act(async () => receipt.resolve(json({ teamId: a, userId, removed: true, actorRole: null })));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
    expect(window.location.pathname).toBe(route);
    if (route === "/shared-projects") {
      expect(screen.getByRole("heading", { name: "Projects shared with me" })).toBeInTheDocument();
      expect(screen.getByText(/You left the Team/)).toBeInTheDocument();
    }
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(b);
    act(() => navigate("/projects")); await screen.findByRole("heading", { name: "Beta" });
  });
  it("uses Personal initially, offers paginated Team links and preserves native navigation", async () => {
    const fetcher = install(); render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Personal" });
    expect(fetcher.mock.calls.some(([url]) => url === `/api/v1/teams/${personal}`)).toBe(false);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${personal}`))).toBe(true));
    const selector = screen.getByText("Personal", { selector: ".team-switch-text" }).closest<HTMLElement>(".team-selector")!;
    fireEvent.click(selector.querySelector(".team-switch")!);
    const link = await within(selector).findByRole("menuitemradio", { name: "Alpha" });
    expect(link).toHaveAttribute("href", `/teams/${a}`);
    fireEvent.click(link, { ctrlKey: true }); expect(window.location.pathname).toBe("/projects");
    await waitFor(() => expect(selector.querySelector(".team-switch")).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(selector.querySelector(".team-switch")!);
    fireEvent.click(within(selector).getByRole("menuitemradio", { name: "Alpha" })); await screen.findByRole("heading", { name: "Alpha" }); expect(window.location.pathname).toBe(`/teams/${a}`);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${a}`))).toBe(true));
    fireEvent.click(screen.getByRole("link", { name: "Shared with me" }));
    await screen.findByRole("heading", { name: "Projects shared with me" });
    expect(screen.queryByRole("button", { name: /Create project/ })).toBeNull();
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("shared=true"))).toBe(true));
  });
  it.each([`/teams/${a}`, "/projects"])("keeps a paginated Team menu and projects mounted through checks on %s", async (path) => {
    window.history.replaceState(null, "", path);
    if (path === "/projects") localStorage.setItem(`daynight.selectedTeam:${userId}`, a);
    const identity = Promise.withResolvers<Response>(), firstPage = Promise.withResolvers<Response>(), secondPage = Promise.withResolvers<Response>(), teamRead = Promise.withResolvers<Response>();
    let identities = 0, firstReads = 0, secondReads = 0, teamReads = 0, tailReads = 0;
    const ready = TaskCacheScope.prototype.ready;
    let listSignal: AbortSignal | undefined, teamSignal: AbortSignal | undefined;
    let hold: { signal: AbortSignal; reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | null = null;
    vi.spyOn(TaskCacheScope.prototype, "ready").mockImplementation(async function (this: TaskCacheScope, signal) {
      await ready.call(this, signal);
      if (hold !== null && hold.signal === signal) { const gate = hold; gate.reached.resolve(); await gate.release.promise; signal.throwIfAborted(); }
    });
    const observed = (body: unknown, consumed: PromiseWithResolvers<void>) => {
      const response = json(body), read = response.text.bind(response);
      response.text = async () => { const value = await read(); consumed.resolve(); return value; };
      return response;
    };
    const fetcher = install((url, init) => {
      if (url === "/api/v1/me") return ++identities === 2 ? identity.promise : json(person);
      if (url === `/api/v1/teams/${a}`) { if (++teamReads === 2) { teamSignal = init?.signal ?? undefined; return teamRead.promise; } return json(team(a, "Alpha")); }
      if (url === "/api/v1/teams?limit=50") { if (++firstReads === 2) { listSignal = init?.signal ?? undefined; return firstPage.promise; } return json({ items: [team(a, "Alpha")], nextCursor: "next" }); }
      if (url === "/api/v1/teams?limit=50&cursor=next") return ++secondReads === 2 ? secondPage.promise : json({ items: [team(b, "Beta")], nextCursor: "tail" });
      if (url === "/api/v1/teams?limit=50&cursor=tail-refreshed") { tailReads++; return json({ items: [], nextCursor: null }); }
      if (url.startsWith("/api/v1/projects?")) return json({ items: [project], nextCursor: null });
      return undefined;
    });
    render(<AuthenticatedApp />);
    const title = await screen.findByRole("heading", { name: "Alpha" }, { timeout: 20000 });
    const main = screen.getByRole("main");
    const grid = await within(main).findByRole("list", { name: "Project list" }, { timeout: 20000 });
    const card = within(grid).getByRole("link", { name: /Raw 项目/ });
    const selector = document.querySelector<HTMLElement>(".team-selector")!;
    fireEvent.click(selector.querySelector(".team-switch")!);
    const alpha = await within(selector).findByRole("menuitemradio", { name: "Alpha" }, { timeout: 20000 });
    fireEvent.click(within(selector).getByRole("menuitem", { name: "Load more Teams" }));
    const beta = await within(selector).findByRole("menuitemradio", { name: "Beta" }, { timeout: 20000 }); beta.focus();
    const check = () => {
      expect(selector.querySelector(".team-switch")).toHaveAttribute("aria-expanded", "true"); expect(selector).toBeVisible();
      expect(within(selector).getByRole("menuitemradio", { name: "Alpha" })).toBe(alpha);
      expect(within(selector).getByRole("menuitemradio", { name: "Beta" })).toBe(beta);
      expect(alpha).toBeVisible(); expect(beta).toBeVisible(); expect(document.activeElement).toBe(beta);
      expect(screen.getByRole("heading", { name: "Alpha" })).toBe(title); expect(title).toBeVisible();
      expect(within(main).getByRole("list", { name: "Project list" })).toBe(grid); expect(grid).toBeVisible();
      expect(within(grid).getByRole("link", { name: /Raw 项目/ })).toBe(card);
      expect(screen.queryByText("Loading Teams", { selector: "section" })).toBeNull();
      expect(within(selector).getByRole("menuitem", { name: "Load more Teams" })).toBeEnabled();
      expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a);
    };
    check();
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(identities).toBe(2), { timeout: 20000 }); check();
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    await waitFor(() => { expect(firstReads).toBe(2); expect(teamReads).toBe(2); }, { timeout: 20000 }); check();
    const firstConsumed = Promise.withResolvers<void>();
    expect(listSignal).toBeDefined(); expect(teamSignal).toBeDefined(); expect(listSignal).not.toBe(teamSignal);
    hold = { signal: listSignal!, reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const firstGate = hold;
    await act(async () => { firstPage.resolve(observed({ items: [team(a, "Alpha")], nextCursor: "next" }, firstConsumed)); await firstConsumed.promise; await firstGate.reached.promise; });
    expect(secondReads).toBe(1); check();
    hold = null; await act(async () => firstGate.release.resolve());
    await waitFor(() => expect(secondReads).toBe(2), { timeout: 20000 }); check();
    const secondConsumed = Promise.withResolvers<void>();
    await act(async () => { secondPage.resolve(observed({ items: [team(b, "Beta")], nextCursor: "tail-refreshed" }, secondConsumed)); await secondConsumed.promise; }); check();
    const teamConsumed = Promise.withResolvers<void>();
    hold = { signal: teamSignal!, reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const teamGate = hold;
    await act(async () => { teamRead.resolve(observed(team(a, "Alpha"), teamConsumed)); await teamConsumed.promise; await teamGate.reached.promise; }); check();
    hold = null; await act(async () => teamGate.release.resolve()); check();
    fireEvent.click(within(selector).getByRole("menuitem", { name: "Load more Teams" }));
    await waitFor(() => expect(tailReads).toBe(1), { timeout: 20000 });
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/teams?limit=50&cursor=tail-refreshed")).toHaveLength(1);
    expect(within(selector).getByRole("menuitemradio", { name: "Beta" })).toBe(beta);
  }, 90000);
  it("keeps creation bound to the Team at dialog opening even if the route changes", async () => {
    window.history.replaceState(null, "", `/teams/${a}`);
    let body: Record<string, unknown> | null = null;
    install((url, init) => { if (url === "/api/v1/projects" && init?.method === "POST") { body = JSON.parse(String(init.body)) as Record<string, unknown>; return json(project, 201); } return undefined; });
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Project name/), { target: { value: project.name } });
    fireEvent.change(within(dialog).getByLabelText(/Repository/), { target: { value: project.repoUrl } });
    act(() => navigate(`/teams/${b}`));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(body).toMatchObject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: userId, teamId: a }));
  });
  it("does not install a late Team result during identity revalidation", async () => {
    window.history.replaceState(null, "", `/teams/${a}`);
    const old = Promise.withResolvers<Response>(), identity = Promise.withResolvers<Response>(); let teamReads = 0, meReads = 0;
    install((url) => {
      if (url === "/api/v1/me" && ++meReads === 2) return identity.promise;
      if (url === `/api/v1/teams/${a}`) return ++teamReads === 1 ? old.promise : json(team(a, "Fresh Team"));
      return undefined;
    });
    render(<AuthenticatedApp />); await waitFor(() => expect(teamReads).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await act(async () => old.resolve(json(team(a, "Stale Team")))); expect(screen.queryByText("Stale Team")).toBeNull();
    await act(async () => identity.resolve(json(person)));
    await screen.findByRole("heading", { name: "Fresh Team" }); expect(screen.queryByText("Stale Team")).toBeNull();
  });
  it("does not replace Team B when an older Team A response arrives late", async () => {
    window.history.replaceState(null, "", `/teams/${a}`);
    const old = Promise.withResolvers<Response>(); let reads = 0;
    install((url) => { if (url === `/api/v1/teams/${a}`) { reads++; return old.promise; } return undefined; });
    render(<AuthenticatedApp />); await waitFor(() => expect(reads).toBe(1));
    act(() => navigate(`/teams/${b}`)); await screen.findByRole("heading", { name: "Beta" });
    await act(async () => old.resolve(json(team(a, "Stale Alpha"))));
    expect(screen.queryByText("Stale Alpha")).toBeNull(); expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
  });
  it("continues Team pages and retries the same cursor after a failure", async () => {
    let continuation = 0;
    const fetcher = install((url) => {
      if (url === "/api/v1/teams?limit=50") return json({ items: [team(a, "Alpha")], nextCursor: "next/+" });
      if (url === "/api/v1/teams?limit=50&cursor=next%2F%2B") return ++continuation === 1 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-more" } }, 500) : json({ items: [team(b, "Beta")], nextCursor: null });
      return undefined;
    });
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    const selector = document.querySelector<HTMLElement>(".team-selector")!; fireEvent.click(selector.querySelector(".team-switch")!);
    await within(selector).findByRole("menuitemradio", { name: "Alpha" });
    fireEvent.click(within(selector).getByRole("menuitem", { name: "Load more Teams" }));
    expect(await within(selector).findByRole("alert")).toHaveTextContent("rq-more");
    expect(within(selector).getByRole("menuitemradio", { name: "Alpha" })).toBeInTheDocument();
    fireEvent.click(within(selector).getByRole("menuitem", { name: "Retry" })); await within(selector).findByRole("menuitemradio", { name: "Beta" });
    expect(fetcher.mock.calls.filter(([url]) => url.includes("cursor=next%2F%2B"))).toHaveLength(2);
  });
  it("retains Personal and reports list errors with request ID and retry", async () => {
    let reads = 0;
    install((url) => url.startsWith("/api/v1/teams?") && ++reads === 1 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-team" } }, 500) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    const selector = document.querySelector<HTMLElement>(".team-selector")!; fireEvent.click(selector.querySelector(".team-switch")!);
    const alert = await within(selector).findByRole("alert"); expect(alert).toHaveTextContent("rq-team"); expect(alert).not.toHaveTextContent("private");
    expect(within(selector).getByRole("menuitemradio", { name: "Personal" })).toHaveAttribute("href", `/teams/${personal}`);
    fireEvent.click(within(selector).getByRole("menuitem", { name: "Retry" })); await within(selector).findByRole("menuitemradio", { name: "Beta" });
  });
  it("shows a usable Team control when the narrow sidebar is collapsed", async () => {
    mockSidebarMediaQuery(true); install(); render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Personal" });
    const control = screen.getByRole("button", { name: "Switch Team: Personal" });
    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).toBeNull();
    expect(await screen.findByRole("menuitemradio", { name: "Alpha" })).toBeInTheDocument();
  });
  it("restores a remembered Team by exact ID even when it is absent from the first picker page", async () => {
    localStorage.setItem(`daynight.selectedTeam:${userId}`, b);
    const fetcher = install((url) => url.startsWith("/api/v1/teams?") ? json({ items: [team(a, "Alpha")], nextCursor: "next" }) : undefined);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Beta" });
    expect(fetcher.mock.calls.some(([url]) => url === `/api/v1/teams/${b}`)).toBe(true);
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(b);
  });
  it("clears a confirmed missing Team, but preserves a failed read for retry", async () => {
    localStorage.setItem(`daynight.selectedTeam:${userId}`, a);
    let reads = 0;
    install((url) => url === `/api/v1/teams/${a}` ? ++reads === 1 ? json({ error: { code: "internal_error", message: "error", requestId: "rq" } }, 500) : json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404) : undefined);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Unable to load Teams" });
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Personal" });
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
  });
  it("reports storage read and write failures and retries without losing the current selection", async () => {
    let failRead = true, failWrite = true;
    const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) { if (key === `daynight.selectedTeam:${userId}` && failRead) throw new Error("denied"); return read.call(this, key); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (key === `daynight.selectedTeam:${userId}` && failWrite) throw new Error("denied"); return write.call(this, key, value); });
    install(); render(<AuthenticatedApp />);
    await screen.findByText(/Unable to read or clear the saved Team/);
    failRead = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Personal" });
    act(() => navigate(`/teams/${a}`)); await screen.findByRole("heading", { name: "Alpha" });
    await screen.findByText(/Unable to save the Team selection/);
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
    failWrite = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a));
  });

  it("does not clear a saved Team for an unverified 404 response", async () => {
    localStorage.setItem(`daynight.selectedTeam:${userId}`, a);
    install((url) => url === `/api/v1/teams/${a}` ? new Response("broken", { status: 404 }) : undefined);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Unable to load Teams" });
    expect(screen.getByText("Unable to read this data. Try again.")).toBeInTheDocument();
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a);
  });
  it("does not erase a newer selection when a remembered Team returns 404 late", async () => {
    localStorage.setItem(`daynight.selectedTeam:${userId}`, a);
    const old = Promise.withResolvers<Response>();
    install((url) => url === `/api/v1/teams/${a}` ? old.promise : undefined);
    render(<AuthenticatedApp />);
    await waitFor(() => expect(screen.getByText("Loading Teams", { selector: "section" })).toBeInTheDocument());
    localStorage.setItem(`daynight.selectedTeam:${userId}`, b);
    await act(async () => old.resolve(json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404)));
    await screen.findByRole("heading", { name: "Beta" });
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(b);
  });

  it("returns to Personal when a remembered selected Team is revoked on focus", async () => {
    let missing = false;
    install((url) => url === `/api/v1/teams/${a}` && missing ? json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    act(() => navigate(`/teams/${a}`)); await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a));
    missing = true; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await screen.findByRole("heading", { name: "Personal" });
    expect(window.location.pathname).toBe("/projects");
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
  });
  it("revalidates an unsaved selection on return to the default entry", async () => {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (key === `daynight.selectedTeam:${userId}`) throw new Error("denied"); return write.call(this, key, value); });
    let reads = 0;
    install((url) => url === `/api/v1/teams/${a}` ? ++reads === 1 ? json(team(a, "Alpha")) : json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    act(() => navigate(`/teams/${a}`)); await screen.findByRole("heading", { name: "Alpha" });
    act(() => navigate("/projects")); await screen.findByRole("heading", { name: "Personal" });
    expect(reads).toBe(2);
    expect(screen.getByText(/Unable to save the Team selection/)).toBeInTheDocument();
  });

  it("does not overwrite a newer tab selection when a focus revalidation succeeds late", async () => {
    const late = Promise.withResolvers<Response>(); let reads = 0;
    install((url) => url === `/api/v1/teams/${a}` && ++reads === 2 ? late.promise : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    act(() => navigate(`/teams/${a}`)); await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2));
    localStorage.setItem(`daynight.selectedTeam:${userId}`, b);
    await act(async () => late.resolve(json(team(a, "Alpha"))));
    await screen.findByRole("heading", { name: "Alpha" });
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(b);
  });

  it("does not install a late remembered Team after the account changes", async () => {
    const bob = "00000000-0000-4000-8000-000000000006", bobPersonal = "00000000-0000-4000-8000-000000000007";
    const late = Promise.withResolvers<Response>(); let current = userId;
    const reply = (body: unknown, principal: string) => new Response(stringifyWireJson(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
    localStorage.setItem(`daynight.selectedTeam:${userId}`, a);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/v1/me") return Promise.resolve(reply(current === userId ? person : { ...person, id: bob, name: "Bob", personalTeam: { id: bobPersonal, kind: "personal", name: null } }, current));
      if (url === `/api/v1/teams/${a}`) return late.promise;
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(reply({ items: [], nextCursor: null }, current));
      if (url.startsWith("/api/v1/projects?")) return Promise.resolve(reply({ items: [], nextCursor: null }, current));
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AuthenticatedApp />);
    await waitFor(() => expect(screen.getByText("Loading Teams", { selector: "section" })).toBeInTheDocument());
    current = bob; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await screen.findByRole("heading", { name: "Personal" });
    await act(async () => late.resolve(json(team(a, "Old account"))));
    expect(screen.queryByText("Old account")).toBeNull();
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a);
    expect(localStorage.getItem(`daynight.selectedTeam:${bob}`)).toBeNull();
  });

  it("retains a settings draft during same-account revalidation and reread", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const recheck = Promise.withResolvers<Response>(); let reads = 0;
    install((url, init) => url === `/api/v1/teams/${a}` && !init?.method && ++reads === 3 ? recheck.promise : undefined);
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ })); const name = screen.getByLabelText("Team name");
    fireEvent.change(name, { target: { value: "Unsaved draft" } });
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(4));
    await act(async () => recheck.resolve(json(team(a, "  Alpha  "))));
    await waitFor(() => expect(screen.getByLabelText("Team name")).toHaveValue("Unsaved draft"));
  });
  it("revalidates Team settings after a same-account check while retaining the open editor", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const identity = Promise.withResolvers<Response>(), reread = Promise.withResolvers<Response>();
    let meReads = 0, teamReads = 0;
    const fetcher = install((url, init) => {
      if (url === "/api/v1/me" && ++meReads === 2) return identity.promise;
      if (url === `/api/v1/teams/${a}` && !init?.method && ++teamReads === 3) return reread.promise;
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    const membersLink = screen.getByRole("link", { name: "Team members" });
    const settingsLink = screen.getByRole("link", { name: "Team settings" });
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    const name = within(dialog).getByLabelText("Team name") as HTMLTextAreaElement;
    fireEvent.change(name, { target: { value: "Unsaved draft" } }); name.focus(); name.setSelectionRange(2, 5);
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2)); expect(teamReads).toBe(2);
    expect(screen.getByRole("dialog", { name: "Edit Team name" })).toBe(dialog);
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    await waitFor(() => expect(teamReads).toBe(4));
    expect(screen.getByRole("link", { name: "Team members" })).toBe(membersLink);
    expect(screen.getByRole("link", { name: "Team settings" })).toBe(settingsLink);
    expect(screen.getByRole("dialog", { name: "Edit Team name" })).toBe(dialog); expect(dialog).toBeVisible();
    expect(document.activeElement).toBe(name); expect(name.selectionStart).toBe(2); expect(name.selectionEnd).toBe(5);
    expect(name).toHaveValue("Unsaved draft"); expect(name).not.toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await act(async () => reread.resolve(json(team(a, "  Alpha  "))));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Edit Team name" })).toBe(dialog);
    expect(screen.getByRole("link", { name: "Team members" })).toBe(membersLink);
    expect(screen.getByRole("link", { name: "Team settings" })).toBe(settingsLink);
    expect(document.activeElement).toBe(name); expect(name).toHaveValue("Unsaved draft");
  });
  it("retains Team members during recovery reads and rejects submissions until permissions are fresh", async () => {
    window.history.replaceState(null, "", `/teams/${a}/members`);
    const identity = Promise.withResolvers<Response>(), rosterRead = Promise.withResolvers<Response>();
    const other = "00000000-0000-4000-8000-000000000009";
    const membership = (id: string, role: "admin" | "member", version = 1n) => ({ teamId: a, userId: id, role, version, createdAt: time, updatedAt: time, profile: { name: id === userId ? "Alice" : "Other", email: null, avatarUrl: null } });
    let meReads = 0, rosterReads = 0;
    const fetcher = install((url) => {
      if (url === "/api/v1/me" && ++meReads === 2) return identity.promise;
      if (url === `/api/v1/teams/${a}/members`) return ++rosterReads === 2 ? rosterRead.promise : json({ items: [membership(userId, "admin"), membership(other, "member")] });
      if (url === `/api/v1/teams/${a}/invitations`) return json({ items: [] });
      return undefined;
    });
    render(<AuthenticatedApp />);
    const row = (await screen.findByText("Other", { selector: ".person-name" })).closest(".team-member-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    const submit = within(dialog).getByRole("button", { name: "Remove member" });
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2));
    expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(dialog);
    fireEvent.click(submit); expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    await waitFor(() => expect(rosterReads).toBe(2));
    expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(dialog); expect(row).toBeVisible();
    fireEvent.click(submit); expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await act(async () => rosterRead.resolve(json({ items: [membership(userId, "admin"), membership(other, "admin", 2n)] })));
    await waitFor(() => expect(submit).toBeDisabled());
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it.each([403, 404])("isolates a guarded roster on a preference %s and retains the unknown operation", async (status) => {
    window.history.replaceState(null, "", `/teams/${a}/members`);
    const receipt = Promise.withResolvers<Response>(), checks = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const member = (id: string, role: "admin" | "member") => ({ ...team(a, "Alpha").membership, userId: id, role, profile: { name: id === userId ? "Alice" : "Other", email: null, avatarUrl: null } });
    const other = "00000000-0000-4000-8000-000000000009"; let deletes = 0, reads = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}/members/${userId}` && init?.method === "DELETE") { deletes++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && deletes > 0 && ++reads <= 2) return checks[reads - 1]!.promise;
      if (url === `/api/v1/teams/${a}`) return json({ ...team(a, "Alpha"), membership: { ...team(a, "Alpha").membership, role: "member" } });
      if (url === `/api/v1/teams/${a}/members`) return json({ items: [member(userId, "member"), member(other, "admin")] });
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: "Leave Team" }, { timeout: 20000 }));
    const dialog = screen.getByRole("dialog", { name: "Leave Team" }); fireEvent.click(within(dialog).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(deletes).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2), { timeout: 20000 });
    await act(async () => checks[1]!.resolve(json({ error: { code: status === 403 ? "forbidden" : "not_found", message: "denied", requestId: "rq" } }, status)));
    const alert = (await screen.findByRole("heading", { name: "Unable to load Teams" })).closest("section")!;
    expect(dialog.closest("[hidden]")).not.toBeNull();
    expect(document.querySelector(".team-member-row")).toBeNull();
    expect(screen.getByText("Submitting", { selector: "[role=status]" })).toBeVisible();
    await act(async () => receipt.reject(new TypeError("connection lost")));
    await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest("[hidden]"))).toBe(true));
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Leave Team" })).toBe(dialog));
    await within(dialog).findByText(/result is unknown/); expect(deletes).toBe(1);
  }, 30000);

  it("registers an invitation guard before a pending preference 404 can publish", async () => {
    window.history.replaceState(null, "", `/teams/${a}/members`);
    const preference = Promise.withResolvers<Response>(), receipt = Promise.withResolvers<Response>();
    const membership = { ...team(a, "Alpha").membership, profile: { name: "Alice", email: null, avatarUrl: null } }; let reads = 0, writes = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}/invitations` && init?.method === "POST") { writes++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}/invitations`) return json({ items: [] });
      if (url === `/api/v1/teams/${a}/members`) return json({ items: [membership] });
      if (url === `/api/v1/teams/${a}` && !init?.method && ++reads === 4) return preference.promise;
      return undefined;
    });
    render(<AuthenticatedApp />); const invite = await screen.findByRole("button", { name: "Invite member" }, { timeout: 20000 });
    await waitFor(() => expect(invite).toBeEnabled());
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(4), { timeout: 20000 });
    await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation link" }));
      preference.resolve(json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404));
    });
    await waitFor(() => expect(writes).toBe(1));
    await screen.findByRole("heading", { name: "Unable to load Teams" });
    expect(window.location.pathname).toBe(`/teams/${a}/members`);
    expect(dialog.closest("[hidden]")).not.toBeNull();
    expect(document.querySelector(".team-member-row")).toBeNull();
    await act(async () => receipt.reject(new TypeError("connection lost")));
    expect(await screen.findByText(/invitation change is still unconfirmed/)).toBeVisible(); expect(writes).toBe(1);
  }, 30000);
  it("keeps the management dialog and focused draft visible while identity is pending", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const identity = Promise.withResolvers<Response>(); let meReads = 0;
    const readyGate = Promise.withResolvers<void>(); let holdReady = false, heldReads = 0;
    const teamReads: { signal: AbortSignal; result: PromiseWithResolvers<Response> }[] = [];
    const ready = TaskCacheScope.prototype.ready;
    vi.spyOn(TaskCacheScope.prototype, "ready").mockImplementation(async function (this: TaskCacheScope, signal) {
      await ready.call(this, signal);
      if (holdReady && teamReads.some((read) => read.signal === signal)) { heldReads++; await readyGate.promise; signal.throwIfAborted(); }
    });
    let deferTeam = false;
    const fetcher = install((url, init) => {
      if (url === "/api/v1/me" && ++meReads === 2) return identity.promise;
      if (deferTeam && url === `/api/v1/teams/${a}` && !init?.method) {
        const result = Promise.withResolvers<Response>(); teamReads.push({ signal: init!.signal as AbortSignal, result }); return result.promise;
      }
      return undefined;
    });
    render(<AuthenticatedApp />); const heading = await screen.findByRole("heading", { name: "Team settings" });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Team" });
    const confirmation = within(dialog).getByLabelText("Enter the Team name to confirm") as HTMLTextAreaElement;
    fireEvent.change(confirmation, { target: { value: "  Alpha  " } }); confirmation.focus(); confirmation.setSelectionRange(2, 5);
    const check = () => {
      expect(screen.getByRole("heading", { name: "Team settings", hidden: true })).toBe(heading);
      expect(screen.getByRole("dialog", { name: "Delete Team" })).toBe(dialog); expect(dialog).toBeVisible();
      expect(document.activeElement).toBe(confirmation); expect(confirmation.selectionStart).toBe(2); expect(confirmation.selectionEnd).toBe(5);
      expect(confirmation).toHaveValue("  Alpha  "); expect(confirmation).not.toBeDisabled();
      expect(document.querySelectorAll(".empty-inline")).toHaveLength(0);
      expect(fetcher.mock.calls.some(([, init]) => init?.method && init.method !== "GET")).toBe(false);
    };
    check(); deferTeam = true; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2)); check();
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    await waitFor(() => expect(teamReads.length).toBeGreaterThanOrEqual(2)); check();
    holdReady = true; await act(async () => { for (const read of teamReads) read.result.resolve(json(team(a, "  Alpha  "))); });
    await waitFor(() => expect(heldReads).toBeGreaterThanOrEqual(2)); check();
    holdReady = false; await act(async () => readyGate.resolve()); check();
  });
  it.each(["success", "lost"] as const)("keeps a pending delete through 404 on revalidation: %s", async (outcome) => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); const reply = Promise.withResolvers<Response>(); let reads = 0, deletes = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "DELETE") { deletes++; return reply.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && ++reads >= 4) return json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404);
      return undefined;
    });
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }); fireEvent.click(screen.getByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Team" }); fireEvent.change(within(dialog).getByLabelText("Enter the Team name to confirm"), { target: { value: "  Alpha  " } }); fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" }));
    await waitFor(() => expect(deletes).toBe(1)); focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(4)); expect(window.location.pathname).toBe(`/teams/${a}/settings`);
    if (outcome === "success") { await act(async () => reply.resolve(json({ teamId: a, deleted: true }))); await waitFor(() => expect(window.location.pathname).toBe(`/teams/${personal}`)); }
    else { await act(async () => reply.reject(new TypeError("connection lost"))); await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest('[hidden]'))).toBe(true)); expect(window.location.pathname).toBe(`/teams/${a}/settings`); expect(deletes).toBe(1); }
  });
  it.each(["success", "lost", "rejected"] as const)("keeps the delete owner when preference 404 arrives first: %s", async (outcome) => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const receipt = Promise.withResolvers<Response>(), checks = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const missing = () => json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404);
    let reads = 0, deletes = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "DELETE") { deletes++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && deletes > 0) {
        reads++;
        if (reads <= 2) return checks[reads - 1]!.promise;
        return missing();
      }
      return undefined;
    });
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 });
    fireEvent.click(screen.getByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Team" });
    fireEvent.change(within(dialog).getByLabelText("Enter the Team name to confirm"), { target: { value: "  Alpha  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" }));
    await waitFor(() => expect(deletes).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2), { timeout: 20000 });
    await act(async () => checks[1]!.resolve(missing()));
    await screen.findByRole("heading", { name: "Unable to load Teams" });
    expect(window.location.pathname).toBe(`/teams/${a}/settings`);
    expect(dialog.closest("[hidden]")).not.toBeNull();
    expect(screen.getByText("Submitting", { selector: "[role=status]" })).toBeVisible();
    expect(document.querySelector(".team-settings-page")).toBeNull();
    if (outcome === "success") {
      await act(async () => receipt.resolve(json({ teamId: a, deleted: true })));
      await waitFor(() => expect(window.location.pathname).toBe(`/teams/${personal}`));
    } else if (outcome === "lost") {
      await act(async () => receipt.reject(new TypeError("connection lost")));
      await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest("[hidden]"))).toBe(true));
      await act(async () => checks[0]!.resolve(missing()));
      expect(dialog.closest("[hidden]")).not.toBeNull();
      expect(window.location.pathname).toBe(`/teams/${a}/settings`);
      expect(deletes).toBe(1);
    } else {
      await act(async () => receipt.resolve(json({ error: { code: "invalid_request", message: "rejected", requestId: "rq" } }, 400)));
      await waitFor(() => expect(window.location.pathname).toBe("/projects"));
      expect(deletes).toBe(1);
    }
  }, 30000);
  it("does not replace a rename receipt with a late settings reread", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); const patch = Promise.withResolvers<Response>(), late = Promise.withResolvers<Response>(); let reads = 0, patches = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return patch.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && ++reads === 3) return late.promise;
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ })); const name = screen.getByLabelText("Team name"); fireEvent.change(name, { target: { value: "New name" } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1)); focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus")); await waitFor(() => expect(reads).toBe(4));
    await act(async () => patch.resolve(json({ ...team(a, "New name"), version: 2n }))); await screen.findByText("Saved");
    await act(async () => late.resolve(json(team(a, "  Alpha  ")))); expect(screen.getByText("New name", { selector: ".team-settings-name span" })).toBeInTheDocument();
  });
  it("keeps newer preference details in settings when an older rename receipt arrives", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const receipt = Promise.withResolvers<Response>(), panelRead = Promise.withResolvers<Response>(), fresh = Promise.withResolvers<Response>();
    let reads = 0, patches = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method) {
        reads++;
        if (reads === 3) return panelRead.promise;
        if (reads === 4) return json({ ...team(a, "Latest"), version: 3n });
        if (reads >= 5) return fresh.promise;
      }
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Older" } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(4), { timeout: 20000 });
    await waitFor(() => expect(document.querySelector("button.team-switch")).toHaveAttribute("aria-label", "Switch Team: Latest"));
    await act(async () => receipt.resolve(json({ ...team(a, "Older"), version: 2n })));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(5));
    expect(screen.getByText("Latest", { selector: ".team-settings-name span" })).toBeVisible();
    expect(document.querySelector("button.team-switch")).toHaveAttribute("aria-label", "Switch Team: Latest");
    await act(async () => { panelRead.resolve(json(team(a, "  Alpha  "))); fresh.resolve(json({ ...team(a, "Latest"), version: 3n })); });
  }, 30000);
  it.each([200, 404])("retains a confirmed rename after a guarded preference 404 and handles a new %s read", async (status) => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const receipt = Promise.withResolvers<Response>(), checks = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()], fresh = Promise.withResolvers<Response>();
    let reads = 0, patches = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && patches > 0) {
        reads++;
        return reads <= 2 ? checks[reads - 1]!.promise : fresh.promise;
      }
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2), { timeout: 20000 });
    await act(async () => checks[1]!.resolve(json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404)));
    await screen.findByRole("heading", { name: "Unable to load Teams" });
    expect(screen.getByRole("dialog", { name: "Edit Team name", hidden: true }).closest("[hidden]")).not.toBeNull();
    await act(async () => receipt.resolve(json({ ...team(a, "New name"), version: 2n })));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    expect(document.querySelector(".team-settings-page")).toBeNull();
    expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true);
    expect(screen.queryByText("Loading Teams", { selector: "[role=status]" })).toBeNull();
    await act(async () => fresh.resolve(status === 200 ? json({ ...team(a, "New name"), version: 2n }) : json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404)));
    if (status === 200) expect(await screen.findByText("New name", { selector: ".team-settings-name span" })).toBeVisible();
    else {
      await waitFor(() => expect(window.location.pathname).toBe("/projects"));
      expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
      expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true); expect(patches).toBe(1);
    }
  }, 30000);
  it("retains confirmed rename feedback when the settings read reports 404 first", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const receipt = Promise.withResolvers<Response>(), checks = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()], fresh = Promise.withResolvers<Response>();
    const missing = () => json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404);
    let reads = 0, patches = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && patches > 0) { reads++; return reads <= 2 ? checks[reads - 1]!.promise : fresh.promise; }
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 }));
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "New name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2), { timeout: 20000 });
    await act(async () => checks[0]!.resolve(missing()));
    await waitFor(() => expect(dialog.closest("[hidden]")).not.toBeNull());
    expect(screen.getByText("Submitting", { selector: "[role=status]" })).toBeVisible();
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(a);
    await act(async () => receipt.resolve(json({ ...team(a, "New name"), version: 2n })));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true);
    await act(async () => fresh.resolve(missing()));
    await waitFor(() => expect(window.location.pathname).toBe("/projects"));
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
    expect(screen.getByText("Team name saved.").closest("[role=status]")).toHaveTextContent(a); expect(patches).toBe(1);
  }, 30000);
  it.each([403, 404])("retains confirmed rename feedback when the later Team read returns %s", async (status) => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const fresh = Promise.withResolvers<Response>(); let patches = 0, readsAfterSave = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return json({ ...team(a, "New name"), version: 2n }); }
      if (url === `/api/v1/teams/${a}` && !init?.method && patches > 0) { readsAfterSave++; return readsAfterSave === 1 ? fresh.promise : json({ ...team(a, "New name"), version: 2n }); }
      return undefined;
    });
    const view = render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(readsAfterSave).toBe(1));
    expect(screen.getByText("Saved")).toBeVisible();
    expect(screen.queryByText("Team name saved.")).toBeNull();
    expect(screen.getByText("New name", { selector: ".team-settings-name span" })).toBeVisible();
    await act(async () => fresh.resolve(json({ error: { code: status === 403 ? "forbidden" : "not_found", message: "unavailable", requestId: "rq" } }, status)));
    if (status === 404) {
      await waitFor(() => expect(window.location.pathname).toBe("/projects"));
      expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull();
      const notice = screen.getByText("Team name saved.").closest<HTMLElement>("[role=status]")!;
      expect(notice).toBeVisible(); expect(notice).toHaveTextContent(a);
      view.setLocale("zh-CN");
      expect(within(notice).getByText("Team 名称已保存。")).toBeVisible(); expect(notice).toHaveTextContent(a);
      view.setLocale("en");
    } else {
      const alert = (await screen.findByRole("heading", { name: "Unable to load Teams" })).closest("section")!;
      expect(window.location.pathname).toBe(`/teams/${a}/settings`);
      expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true);
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("New name", { selector: ".team-settings-name span" })).toBeVisible();
    }
    expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true); expect(patches).toBe(1);
  }, 30000);
  it.each(["lost", "success"] as const)("isolates a guarded editor when preference confirms a 403: %s", async (outcome) => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const receipt = Promise.withResolvers<Response>(), checks = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()], fresh = Promise.withResolvers<Response>();
    let reads = 0, patches = 0;
    install((url, init) => {
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return receipt.promise; }
      if (url === `/api/v1/teams/${a}` && !init?.method && patches > 0) { reads++; if (reads <= 2) return checks[reads - 1]!.promise; if (outcome === "success") return fresh.promise; }
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }, { timeout: 20000 }));
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Draft" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1));
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2), { timeout: 20000 });
    await act(async () => checks[1]!.resolve(json({ error: { code: "forbidden", message: "denied", requestId: "rq" } }, 403)));
    const alert = (await screen.findByRole("heading", { name: "Unable to load Teams" })).closest("section")!;
    expect(dialog.closest("[hidden]")).not.toBeNull();
    expect(within(dialog).getByLabelText("Team name")).not.toBeVisible();
    expect(screen.getByText("Submitting", { selector: "[role=status]" })).toBeVisible();
    if (outcome === "lost") {
      await act(async () => receipt.reject(new TypeError("connection lost")));
      await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest("[hidden]"))).toBe(true));
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByRole("dialog", { name: "Edit Team name" })).toBe(dialog));
      expect(within(dialog).getByLabelText("Team name")).toHaveValue("Draft");
      await within(dialog).findByText(/result is unknown/);
    } else {
      await act(async () => receipt.resolve(json({ ...team(a, "Draft"), version: 2n })));
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
      expect(screen.queryAllByText(/^(Saved|Team name saved\.)$/).some((node) => !node.closest("[hidden]"))).toBe(true);
      expect(screen.getByRole("heading", { name: "Unable to load Teams" })).toBeVisible();
      expect(document.querySelector(".team-settings-page")).toBeNull();
      await act(async () => fresh.resolve(json({ ...team(a, "Draft"), version: 2n })));
      expect(await screen.findByText("Draft", { selector: ".team-settings-name span" })).toBeVisible();
    }
  }, 30000);
  it("returns to Personal for a confirmed unavailable Team without a pending operation", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); let reads = 0;
    install((url, init) => url === `/api/v1/teams/${a}` && !init?.method && ++reads >= 3 ? json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }); focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(window.location.pathname).toBe("/projects")); await waitFor(() => expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBeNull());
  });

  it("ignores a previous account's late Team 404 while identity is revalidated", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`);
    const bob = "00000000-0000-4000-8000-000000000011", bobPersonal = "00000000-0000-4000-8000-000000000012";
    const old = Promise.withResolvers<Response>(), nextIdentity = Promise.withResolvers<Response>(); let current = userId, reads = 0, meReads = 0;
    const response = (body: unknown, principal: string, status = 200) => new Response(stringifyWireJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/me") return ++meReads === 1 ? Promise.resolve(json(person)) : nextIdentity.promise;
      if (url === `/api/v1/teams/${a}` && !init?.method) {
        if (current === bob) return Promise.resolve(response({ error: { code: "not_found", message: "missing", requestId: "rq-b" } }, bob, 404));
        if (++reads === 3) return old.promise;
        return Promise.resolve(json(team(a, "  Alpha  ")));
      }
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(response({ items: [], nextCursor: null }, current));
      if (url.startsWith("/api/v1/projects?")) return Promise.resolve(response({ items: [], nextCursor: null }, current));
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }); fireEvent.click(screen.getByRole("button", { name: "Delete Team" })); await waitFor(() => expect(reads).toBe(3));
    current = bob; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await act(async () => old.resolve(response({ error: { code: "not_found", message: "missing", requestId: "rq-a" } }, userId, 404)));
    await act(async () => nextIdentity.resolve(response({ ...person, id: bob, name: "Bob", personalTeam: { id: bobPersonal, kind: "personal", name: null } }, bob)));
    await waitFor(() => expect(screen.queryByText("Alice")).toBeNull());
    expect(window.location.pathname).not.toBe(`/teams/${personal}`); expect(screen.queryByRole("dialog", { name: "Delete Team" })).toBeNull();
  });

  it("publishes a confirmed rename receipt received during identity revalidation", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); const patch = Promise.withResolvers<Response>(), identity = Promise.withResolvers<Response>(); let patches = 0, meReads = 0;
    install((url, init) => {
      if (url === "/api/v1/me" && ++meReads === 2) return identity.promise;
      if (url === `/api/v1/teams/${a}` && init?.method === "PATCH") { patches++; return patch.promise; }
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ })); const name = screen.getByLabelText("Team name"); fireEvent.change(name, { target: { value: "New name" } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toBe(1)); focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2)); await act(async () => patch.resolve(json({ ...team(a, "New name"), version: 2n })));
    await act(async () => identity.resolve(json(person)));
    await screen.findByText("Saved"); expect(document.querySelector("button.team-switch")).toHaveAttribute("aria-label", "Switch Team: New name");
  });

  it("does not erase another tab's newer selection when a settings reread returns 404", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); const late = Promise.withResolvers<Response>(); let reads = 0;
    install((url, init) => url === `/api/v1/teams/${a}` && !init?.method && ++reads === 3 ? late.promise : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }); focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(4)); localStorage.setItem(`daynight.selectedTeam:${userId}`, b);
    await act(async () => late.resolve(json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404)));
    await screen.findByText("This Team is unavailable or you do not have access."); expect(window.location.pathname).toBe(`/teams/${a}/settings`); expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(b);
  });

  it("reports a storage failure when clearing a confirmed unavailable settings Team and retries", async () => {
    window.history.replaceState(null, "", `/teams/${a}/settings`); let reads = 0, failStorage = false;
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) { if (failStorage && key === `daynight.selectedTeam:${userId}`) throw new Error("denied"); return getItem.call(this, key); });
    install((url, init) => url === `/api/v1/teams/${a}` && !init?.method && ++reads >= 3 ? json({ error: { code: "not_found", message: "missing", requestId: "rq" } }, 404) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("button", { name: /^Edit$/ }); failStorage = true;
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    const alert = (await screen.findByRole("heading", { name: "Unable to load Teams" })).closest("section")!;
    expect(within(alert).getByText("Unable to read or clear the saved Team selection. Try again.")).toBeVisible(); expect(window.location.pathname).toBe(`/teams/${a}/settings`);
    failStorage = false; fireEvent.click(within(alert).getByRole("button", { name: "Retry" })); await waitFor(() => expect(window.location.pathname).toBe("/projects"));
  });

  it("keeps the mobile drawer and its focus trap through a pending same-account check", async () => {
    mockSidebarMediaQuery(true);
    const identity = Promise.withResolvers<Response>(); let meReads = 0;
    install((url) => url === "/api/v1/me" && ++meReads === 2 ? identity.promise : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
    const focus = within(drawer).getByRole("link", { name: "My Workers" }); focus.focus();
    const workspace = document.querySelector(".workspace")!;
    expect(workspace).toHaveAttribute("inert"); expect(document.body.style.overflow).toBe("hidden");
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2));
    expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBe(drawer);
    expect(drawer).toBeVisible(); expect(document.activeElement).toBe(focus);
    expect(workspace).toHaveAttribute("inert"); expect(document.body.style.overflow).toBe("hidden");
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBe(drawer);
    expect(document.activeElement).toBe(focus); expect(workspace).toHaveAttribute("inert");
  });
  it("keeps the create dialog, selection, and focus throughout same-account identity revalidation", async () => {
    const identity = Promise.withResolvers<Response>(); let meReads = 0;
    const fetcher = install((url) => url === "/api/v1/me" && ++meReads === 2 ? identity.promise : undefined);
    render(<AuthenticatedApp />); const page = await screen.findByRole("heading", { name: "Personal" });
    const selector = document.querySelector<HTMLElement>(".team-selector")!; fireEvent.click(selector.querySelector(".team-switch")!); fireEvent.click(within(selector).getByRole("menuitem", { name: "Create Team" }));
    const dialog = screen.getByRole("dialog", { name: "Create Team" });
    const name = within(dialog).getByLabelText(/Team name/) as HTMLTextAreaElement;
    fireEvent.change(name, { target: { value: "Draft Team" } }); name.focus(); name.setSelectionRange(1, 5);
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(meReads).toBe(2));
    expect(screen.getByRole("dialog", { name: "Create Team" })).toBe(dialog);
    expect(dialog).toBeVisible(); expect(screen.getByRole("heading", { name: "Personal", hidden: true })).toBe(page);
    expect(document.activeElement).toBe(name); expect(name.selectionStart).toBe(1); expect(name.selectionEnd).toBe(5);
    expect(name).toHaveValue("Draft Team"); expect(name).not.toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await act(async () => identity.resolve(json({ ...person, personalTeam: { ...person.personalTeam } })));
    expect(screen.getByRole("dialog", { name: "Create Team" })).toBe(dialog);
    expect(document.activeElement).toBe(name); expect(name.selectionStart).toBe(1); expect(name.selectionEnd).toBe(5);
    expect(name).toHaveValue("Draft Team");
  });
  it("discards a create dialog's late unknown-state read when the account changes", async () => {
    const bob = "00000000-0000-4000-8000-000000000011", bobPersonal = "00000000-0000-4000-8000-000000000012";
    const old = Promise.withResolvers<Response>(), identity = Promise.withResolvers<Response>(); let current = userId, meReads = 0, listReads = 0;
    const response = (body: unknown, principal: string) => new Response(stringifyWireJson(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/me") return ++meReads === 1 ? Promise.resolve(json(person)) : identity.promise;
      if (url === "/api/v1/teams" && init?.method === "POST") return Promise.reject(new TypeError("lost"));
      if (url.startsWith("/api/v1/teams?")) { if (current === userId && ++listReads === 2) return old.promise; return Promise.resolve(response({ items: [], nextCursor: null }, current)); }
      if (url.startsWith("/api/v1/projects?")) return Promise.resolve(response({ items: [], nextCursor: null }, current));
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" }); const selector = document.querySelector<HTMLElement>(".team-selector")!; fireEvent.click(selector.querySelector(".team-switch")!); fireEvent.click(within(selector).getByRole("menuitem", { name: "Create Team" }));
    const dialog = screen.getByRole("dialog", { name: "Create Team" }); fireEvent.change(within(dialog).getByLabelText(/Team name/), { target: { value: "Draft" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Create Team" }));
    await within(dialog).findByText(/result is unknown/); fireEvent.click(within(dialog).getByRole("button", { name: "Check current state" })); await waitFor(() => expect(listReads).toBe(2));
    current = bob; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await act(async () => old.resolve(response({ items: [team(a, "Old account Team")], nextCursor: null }, userId)));
    await act(async () => identity.resolve(response({ ...person, id: bob, name: "Bob", personalTeam: { id: bobPersonal, kind: "personal", name: null } }, bob)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create Team" })).toBeNull()); expect(screen.queryByText("Old account Team")).toBeNull();
  });

});

describe("Team selection at cold workspace entries", () => {
  const savedKey = `daynight.selectedTeam:${userId}`;
  const missing = () => json({ error: { code: "not_found", message: "missing", requestId: "rq-resource" } }, 404);
  const resourceFallback = (url: string) => url === "/api/v1/me" || url.startsWith("/api/v1/teams?") || url === `/api/v1/teams/${a}` || url === `/api/v1/teams/${b}` || url.startsWith("/api/v1/projects?") ? undefined : missing();
  const selector = () => document.querySelector("button.team-switch");

  it.each([`/projects/${projectId}`, "/shared-projects", "/workers", "/account"])("omits Personal management links on %s", async (path) => {
    window.history.replaceState(null, "", path);
    install(resourceFallback); render(<AuthenticatedApp />);
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team: Personal"));
    expect(screen.queryByRole("link", { name: "Team members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Team settings" })).toBeNull();
    expect(window.location.pathname).toBe(path);
  });

  it("keeps Personal management links absent throughout a same-navigation recheck", async () => {
    window.history.replaceState(null, "", "/projects"); localStorage.setItem(savedKey, personal);
    const reread = Promise.withResolvers<Response>(); let reads = 0;
    install((url) => url === `/api/v1/teams/${personal}` ? ++reads === 1 ? json(team(personal, null, "personal")) : reread.promise : undefined);
    render(<AuthenticatedApp />);
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team: Personal"));
    const shared = screen.getByRole("link", { name: "Shared with me" }); shared.focus();
    focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole("link", { name: "Team members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Team settings" })).toBeNull();
    expect(document.activeElement).toBe(shared);
    await act(async () => reread.resolve(json(team(personal, null, "personal"))));
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team: Personal"));
    expect(screen.queryByRole("link", { name: "Team members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Team settings" })).toBeNull();
    expect(document.activeElement).toBe(shared);
  });

  it.each([`/projects/${projectId}`, `/projects/${projectId}/members`, `/projects/${projectId}/settings`, "/shared-projects", "/workers", "/account", "/bots", "/test-sessions"])("restores the sidebar Team independently of %s", async (path) => {
    window.history.replaceState(null, "", path); localStorage.setItem(savedKey, a);
    const fetcher = install(resourceFallback); render(<AuthenticatedApp />);
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team:   Alpha  "));
    expect(screen.getByRole("link", { name: "Team members" })).toHaveAttribute("href", `/teams/${a}/members`);
    expect(screen.getByRole("link", { name: "Team settings" })).toHaveAttribute("href", `/teams/${a}/settings`);
    expect(window.location.pathname).toBe(path);
    expect(localStorage.getItem(savedKey)).toBe(a);
    expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${personal}`))).toBe(false);
  });

  it("keeps resource reads independent while dependent sidebar links and projects wait for restoration", async () => {
    const path = `/projects/${projectId}`; window.history.replaceState(null, "", path); localStorage.setItem(savedKey, a);
    const pending = Promise.withResolvers<Response>();
    const fetcher = install((url) => url === `/api/v1/teams/${a}` ? pending.promise : resourceFallback(url));
    render(<AuthenticatedApp />);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith(`/api/v1/projects/${projectId}`))).toBe(true));
    expect(selector()).toHaveAttribute("aria-label", "Switch Team: Loading Teams");
    for (const name of ["My projects", "Team members", "Team settings"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("aria-disabled", "true"); expect(link).not.toHaveAttribute("href");
      fireEvent.click(link); expect(window.location.pathname).toBe(path);
    }
    expect(fetcher.mock.calls.some(([url]) => url.startsWith("/api/v1/projects?"))).toBe(false);
    await act(async () => pending.resolve(json(team(a, "  Alpha  "))));
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team:   Alpha  "));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${a}`))).toBe(true));
    expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${personal}`))).toBe(false);
    expect(window.location.pathname).toBe(path);
  });

  it("keeps Shared content available during a failed restoration and retries without losing the saved Team", async () => {
    window.history.replaceState(null, "", "/shared-projects"); localStorage.setItem(savedKey, a); let status = 500;
    const fetcher = install((url) => url === `/api/v1/teams/${a}` && status === 500 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-restore" } }, 500) : undefined);
    render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Projects shared with me" });
    const notice = (await screen.findByRole("heading", { name: "Unable to load Teams" })).closest("section")!;
    expect(notice).toHaveTextContent("rq-restore"); expect(notice).not.toHaveTextContent("private");
    expect(localStorage.getItem(savedKey)).toBe(a);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("shared=true"))).toBe(true));
    expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${personal}`))).toBe(false);
    status = 200; fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", "Switch Team:   Alpha  "));
    expect(screen.queryByRole("heading", { name: "Unable to load Teams" })).toBeNull();
    expect(window.location.pathname).toBe("/shared-projects");
  });

  it.each([a, personal])("honors the explicit Team %s on a members reload", async (teamId) => {
    const path = `/teams/${teamId}/members`; window.history.replaceState(null, "", path); localStorage.setItem(savedKey, b);
    install((url) => {
      if (url === `/api/v1/teams/${personal}`) return json(team(personal, null, "personal"));
      if (url === `/api/v1/teams/${teamId}/members`) return json({ items: [{ ...team(teamId, null).membership, profile: { name: "Alice", email: null, avatarUrl: null } }] });
      if (url.startsWith(`/api/v1/teams/${teamId}/invitations?`)) return json({ items: [], nextCursor: null });
      return resourceFallback(url);
    });
    render(<AuthenticatedApp />);
    await waitFor(() => expect(selector()).toHaveAttribute("aria-label", teamId === personal ? "Switch Team: Personal" : "Switch Team:   Alpha  "));
    await screen.findByRole("heading", { name: "Team members" });
    if (teamId === personal) {
      expect(screen.queryByRole("link", { name: "Team members" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Team settings" })).toBeNull();
    } else expect(screen.getByRole("link", { name: "Team members" })).toHaveAttribute("href", path);
    expect(window.location.pathname).toBe(path); expect(localStorage.getItem(savedKey)).toBe(teamId);
  });
});
