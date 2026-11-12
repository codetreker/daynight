import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../src/app/Application";
import { navigate } from "../src/app/router";
import { browserNavigation } from "../src/app/navigation";
import { invitationStorageKey, teamInvitationStorageKey } from "../src/features/auth/invitation";
import { renderWithLocale } from "./helpers/renderWithLocale";
import { personalTeamPage } from "./helpers/team";

vi.mock("../src/features/landing/LandingPage", () => ({ LandingPage: () => <main><h1>Public product introduction</h1></main> }));

const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(status === 401 ? {} : { "Daynight-User-ID": user.id }) } });
const anonymous = () => json({ error: { code: "unauthenticated", message: "Sign in", requestId: "entry-login" } }, 401);
const mount = (navigateToLogin = vi.fn()) => renderWithLocale(<Application navigateToLogin={navigateToLogin} />, { locale: "en" });
const defaultResponse = (url: string) => {
  if (url === "/api/v1/me") return json(user);
  if (url.startsWith("/api/v1/teams?")) return json(personalTeamPage(user.id));
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url.startsWith("/api/v1/projects")) return json({ items: [], nextCursor: null });
  throw new Error(`Unexpected entry request: ${url}`);
};
const historyMove = async (direction: "back" | "forward") => act(async () => new Promise<void>((resolve) => {
  window.addEventListener("popstate", () => resolve(), { once: true });
  window.history[direction]();
}));

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

describe("public and authenticated entry ownership", () => {
  it("routes the completion document to its own account initialization", () => {
    window.history.replaceState(null, "", "/auth/complete?returnPath=%2Fsetup%3Ffrom%3Dlogin%23guide&callbackPath=%2Fauth%2Fcallback");
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = mount();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/v1/me");
    expect(window.location.pathname).toBe("/auth/complete");
    expect(screen.queryByRole("heading", { name: "Public product introduction" })).toBeNull();
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("shows a local bilingual OAuth error without logging in or retaining request parameters", () => {
    window.history.replaceState(null, "", "/oauth/authorize?client_id=bad&state=private&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback");
    const fetcher = vi.fn((_url: string) => Promise.resolve(anonymous()));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(screen.getByRole("heading", { name: "Cannot authorize this client" })).toBeVisible();
    expect(screen.getByText("No authorization information was sent to this return address.")).toBeVisible();
    expect(window.location.pathname).toBe("/oauth/authorize");
    expect(window.location.search).toBe("");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zh-CN" } });
    expect(screen.getByRole("heading", { name: "无法授权此客户端" })).toBeVisible();
    expect(screen.getByText("未向此返回地址发送授权信息。")).toBeVisible();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me"]);
  });
  it("shares one account initialization across public navigation and history", async () => {
    window.history.replaceState(null, "", "/");
    const fetcher = vi.fn((_url: string) => Promise.resolve(anonymous()));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await act(async () => navigate("/setup?ref=public"));
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    await historyMove("back");
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await historyMove("forward");
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me"]);
  });

  it.each(["/", "/setup"])("clears an invitation on deliberate public departure to %s while retaining account initialization", async (path) => {
    window.history.replaceState(null, "", "/invitations#pending-invitation");
    const writes = vi.spyOn(history, "replaceState");
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(window.location.hash).toBe("");
    expect(writes.mock.calls.every(([state]) => !JSON.stringify(state).includes("pending-invitation"))).toBe(true);
    expect(browserNavigation().snapshot()).toMatchObject({ pathname: "/invitations", search: "", hash: "" });
    expect(window.sessionStorage.getItem(invitationStorageKey)).not.toBeNull();
    await act(async () => navigate(path));
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(json(user)));
    expect(screen.queryByText("Alice")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await historyMove("back");
    expect(location.pathname).toBe("/invitations");
    expect(location.hash).toBe("");
    expect(JSON.stringify(history.state)).not.toContain("pending-invitation");
    expect(sessionStorage.getItem(invitationStorageKey)).toBeNull();
  });

  it("keeps invitation cleanup errors visible after the authenticated branch unmounts", async () => {
    window.history.replaceState(null, "", "/invitations#pending-invitation");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    mount();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => navigate("/"));
    expect(screen.getByRole("alert")).toHaveTextContent("could not clear the temporary invitation");
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
  });

  it('retains the initial invitation in memory when session storage cannot be used', async () => {
    history.replaceState(null, '', '/invitations#memory-only-invitation');
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    // Team preferences still need localStorage when invitation sessionStorage is blocked.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage) throw new Error("blocked");
      return originalGetItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new Error("blocked");
      return originalSetItem.call(this, key, value);
    });
    const fetcher = vi.fn((url: string) => Promise.resolve(url === '/api/v1/invitations/inspect'
      ? json({ projectId: '00000000-0000-4000-8000-000000000010', projectName: 'Invited project', directGrant: null, access: null }) : defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher);
    mount();
    await screen.findByRole('button', { name: 'Accept invitation and join' });
    expect(fetcher).toHaveBeenCalledWith('/api/v1/invitations/inspect', expect.objectContaining({ body: JSON.stringify({ token: 'memory-only-invitation' }) }));
    expect(location.hash).toBe('');
    expect(JSON.stringify(history.state)).not.toContain('memory-only-invitation');
    expect(browserNavigation().snapshot().hash).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'No projects yet' })).toBeVisible();
    await historyMove('back');
    await screen.findByRole('heading', { name: 'Invitation unavailable' });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/inspect'))).toHaveLength(1);
    expect(JSON.stringify(history.state)).not.toContain('memory-only-invitation');
  });

  it("does not recover a cancelled invitation from history", async () => {
    history.replaceState(null, "", "/invitations#cancelled-invitation");
    const fetcher = vi.fn((url: string) => Promise.resolve(url.endsWith("/inspect")
      ? json({ projectId: "00000000-0000-4000-8000-000000000010", projectName: "Invited project", directGrant: null, access: null }) : defaultResponse(url)));
    vi.stubGlobal("fetch", fetcher);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("heading", { level: 2, name: "No projects yet" })).toBeVisible();
    expect(sessionStorage.getItem(invitationStorageKey)).toBeNull();
    await historyMove("back");
    await screen.findByRole("heading", { name: "Invitation unavailable" });
    expect(location.hash).toBe("");
    expect(JSON.stringify(history.state)).not.toContain("cancelled-invitation");
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
  });

  it("scrubs an application invitation without serializing its fragment and keeps indexed Back admission", async () => {
    history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    mount();
    const writes = vi.spyOn(history, "pushState");
    await act(async () => navigate("/invitations#incoming-invitation"));
    expect(location.hash).toBe("");
    expect(browserNavigation().snapshot().hash).toBe("");
    expect(writes.mock.calls.every(([state]) => !JSON.stringify(state).includes("incoming-invitation"))).toBe(true);
    const discard = vi.fn();
    const release = browserNavigation().register({ scope: { identity: {}, projectId: "project", taskId: "task" }, isDirty: () => true, discard, survives: () => false });
    await historyMove("back");
    expect(browserNavigation().decision()?.kind).toBe("history");
    expect(browserNavigation().snapshot().pathname).toBe("/invitations");
    await act(async () => browserNavigation().cancel());
    await waitFor(() => expect(location.pathname).toBe("/invitations"));
    expect(discard).not.toHaveBeenCalled();
    expect(JSON.stringify(history.state)).not.toContain("incoming-invitation");
    release();
  });

  it.each(["hashchange", "popstate"])("keeps a copied native invitation entry unindexed after cleanup on %s", async (eventName) => {
    history.replaceState({ reader: { offset: 7 } }, "", "/invitations#first-invitation");
    const fetcher = vi.fn((url: string, _options?: RequestInit) => {
      expect(location.hash).toBe("");
      return Promise.resolve(url.endsWith("/inspect")
        ? json({ projectId: "00000000-0000-4000-8000-000000000010", projectName: "Invited project", directGrant: null, access: null }) : defaultResponse(url));
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("button", { name: "Accept invitation and join" });
    history.pushState(history.state, "", "/invitations#native-invitation");
    fireEvent(window, new Event(eventName));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/v1/invitations/inspect", expect.objectContaining({ body: JSON.stringify({ token: "native-invitation" }) })));
    expect(location.hash).toBe("");
    expect(browserNavigation().snapshot().hash).toBe("");
    expect(history.state).toEqual({ reader: { offset: 7 } });
    expect(sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(2);
  });

  it("removes a Team secret from navigation state and captures the same link reopened in this tab", async () => {
    const secret = "dnteam_reopened";
    const teamId = "00000000-0000-4000-8000-000000000010";
    const team = { id: teamId, kind: "ordinary", name: "Example Team" };
    const membership = { teamId, userId: user.id, role: "member", version: 1, createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
    window.history.replaceState(null, "", `/team-invitations#${secret}`);
    let inspections = 0;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(++inspections === 1 ? json({ team, membership: null }) : json({ error: { code: "invitation_unavailable", message: "unavailable", requestId: "entry" } }, 404));
      if (url === "/api/v1/team-invitations/accept") return Promise.resolve(json({ team, membership, joined: true, consumed: true }));
      return Promise.resolve(defaultResponse(url));
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(window.location.hash).toBe("");
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(secret);
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation and join" }));
    await screen.findByRole("heading", { name: "You joined this Team" });
    window.location.hash = secret;
    await screen.findByRole("heading", { name: "Invitation unavailable" });
    expect(inspections).toBe(2);
    expect(window.location.hash).toBe("");
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(secret);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(1);
  });

  it("keeps a Team invitation in memory with blocked storage and retires it before Back", async () => {
    history.replaceState(null, "", "/team-invitations#memory-only-team");
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    // Team preferences still need localStorage when invitation sessionStorage is blocked.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage) throw new Error("blocked");
      return originalGetItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new Error("blocked");
      return originalSetItem.call(this, key, value);
    });
    const team = { id: "00000000-0000-4000-8000-000000000010", kind: "ordinary", name: "Invited Team" };
    const fetcher = vi.fn((url: string) => {
      expect(location.hash).toBe("");
      expect(browserNavigation().snapshot().hash).toBe("");
      expect(JSON.stringify(history.state ?? null)).not.toContain("memory-only-team");
      return Promise.resolve(url === "/api/v1/team-invitations/inspect" ? json({ team, membership: null }) : defaultResponse(url));
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("button", { name: "Accept invitation and join" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/team-invitations/inspect", expect.objectContaining({ body: JSON.stringify({ token: "memory-only-team" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("heading", { level: 2, name: "No projects yet" })).toBeVisible();
    await historyMove("back");
    await screen.findByRole("heading", { name: "Invitation unavailable" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
  });

  it("captures a native Team entry without numbering copied state or retaining a temporary copy", async () => {
    history.replaceState({ reader: { offset: 7 } }, "", "/team-invitations#initial-team");
    const team = { id: "00000000-0000-4000-8000-000000000010", kind: "ordinary", name: "Invited Team" };
    const fetcher = vi.fn((url: string) => {
      expect(location.hash).toBe("");
      expect(browserNavigation().snapshot().hash).toBe("");
      return Promise.resolve(url === "/api/v1/team-invitations/inspect" ? json({ team, membership: null }) : defaultResponse(url));
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("button", { name: "Accept invitation and join" });
    history.pushState(history.state, "", "/team-invitations#native-team");
    fireEvent(window, new Event("popstate"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/v1/team-invitations/inspect", expect.objectContaining({ body: JSON.stringify({ token: "native-team" }) })));
    expect(history.state).toEqual({ reader: { offset: 7 } });
    expect(sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect"))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
  });

  it("replaces the pending invitation when entering another scope and never mixes request secrets", async () => {
    history.replaceState(null, "", "/invitations#first-project");
    const team = { id: "00000000-0000-4000-8000-000000000010", kind: "ordinary", name: "Invited Team" };
    const fetcher = vi.fn((url: string, _init?: RequestInit) => {
      expect(location.hash).toBe("");
      expect(browserNavigation().snapshot().hash).toBe("");
      if (url === "/api/v1/invitations/inspect") return Promise.resolve(json({ projectId: team.id, projectName: "Invited project", directGrant: null, access: null }));
      if (url === "/api/v1/team-invitations/inspect") return Promise.resolve(json({ team, membership: null }));
      return Promise.resolve(defaultResponse(url));
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("heading", { name: "Invited project" });
    await act(async () => navigate("/team-invitations#next-team"));
    await screen.findByRole("heading", { name: "Invited Team" });
    await act(async () => navigate("/invitations#next-project"));
    await screen.findByRole("heading", { name: "Invited project" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/inspect")).map(([url, init]) => [url, JSON.parse(String(init!.body)).token])).toEqual([
      ["/api/v1/invitations/inspect", "first-project"],
      ["/api/v1/team-invitations/inspect", "next-team"],
      ["/api/v1/invitations/inspect", "next-project"],
    ]);
    expect(sessionStorage.getItem(teamInvitationStorageKey)).toBeNull();
    expect(sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
    expect(Object.keys(history.state.__daynightNavigation).sort()).toEqual(["entryId", "index", "session"]);
  });

  it("preserves a direct attachment and selected tab through the independent login entry", async () => {
    const destination = "/projects/00000000-0000-4000-8000-000000000010/tasks/00000000-0000-4000-8000-000000000011/attachments/docs/guide.md?tab=overview";
    window.history.replaceState(null, "", destination);
    const length = window.history.length;
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? anonymous() : defaultResponse(url))));
    const login = vi.fn(); mount(login);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect(window.location.pathname).toBe("/login");
    expect(window.history.length).toBe(length);
    expect(new URLSearchParams(window.location.search).get("returnPath")).toBe(destination);
    expect(new URL(login.mock.calls[0]![0], window.location.origin).searchParams.get("returnPath")).toBe(destination);
  });

  it("defaults an explicit login to the workspace without treating supplied invalid destinations as absent", async () => {
    window.history.replaceState(null, "", "/login");
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? anonymous() : defaultResponse(url)));
    vi.stubGlobal("fetch", fetcher);
    const login = vi.fn(); mount(login);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect(new URL(login.mock.calls[0]![0], window.location.origin).searchParams.get("returnPath")).toBe("/projects");
    await act(async () => navigate("/login?returnPath=%2Flogin"));
    expect(screen.getByRole("alert")).toHaveTextContent("destination is invalid");
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open sign-in" })).toHaveAttribute("href", "/login");
    await act(async () => navigate("/projects?control=%0A"));
    expect(screen.getByRole("alert")).toHaveTextContent("destination is invalid");
  });

  it("replaces an authenticated login entry and keeps the public homepage reachable through history", async () => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(defaultResponse(url))));
    mount();
    await act(async () => navigate("/login"));
    await screen.findByRole("heading", { name: "Personal" });
    expect(window.location.pathname).toBe("/projects");
    await historyMove("back");
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await historyMove("forward");
    await screen.findByRole("heading", { name: "Personal" });
  });

  it("retains invitation context after a failed callback reaches the explicit login page", async () => {
    window.sessionStorage.setItem(invitationStorageKey, "pending-invitation");
    window.history.replaceState(null, "", "/login?authError=login_failed&returnPath=%2Finvitations");
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? anonymous() : defaultResponse(url))));
    const login = vi.fn(); mount(login);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect(screen.getByText("Sign in through UniAuth to review your invitation.")).toBeVisible();
    expect(screen.getByText(/Sign-in was not completed/)).toBeVisible();
    expect(window.sessionStorage.getItem(invitationStorageKey)).not.toBeNull();
    expect(window.location.search).not.toContain("authError");
    expect(new URL(login.mock.calls[0]![0], window.location.origin).searchParams.get("returnPath")).toBe("/invitations");
  });

  it("returns successful normal logout to the public homepage", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/auth/logout" ? new Response(null, { status: 204 }) : defaultResponse(url))));
    mount();
    await screen.findByRole("heading", { name: "Personal" });
    fireEvent.click(screen.getByRole("button", { name: /^Account menu:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Public product introduction" });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Personal" })).toBeNull();
  });

  it.each(["invitation", "device"])("keeps the %s target and temporary context while switching accounts", async (flow) => {
    const destination = flow === "invitation" ? "/invitations" : "/device?user_code=BCDFG-HJKLM";
    window.history.replaceState(null, "", destination + (flow === "invitation" ? "#pending-invitation" : ""));
    const fetcher = vi.fn((url: string) => Promise.resolve(
      url === "/api/v1/auth/logout" ? new Response(null, { status: 204 })
        : url === "/api/v1/invitations/inspect" ? json({ projectId: "00000000-0000-4000-8000-000000000010", projectName: "Invited project", directGrant: null, access: null })
          : url === "/api/v1/auth/device/inspect" ? json({ userCode: "BCDFG-HJKLM", expiresAt: new Date(Date.now() + 600_000).toISOString(), status: "pending" })
            : defaultResponse(url)
    ));
    vi.stubGlobal("fetch", fetcher);
    const login = vi.fn(); mount(login);
    fireEvent.click(await screen.findByRole("button", { name: "Switch account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("returnPath")).toBe(destination);
    expect(new URL(login.mock.calls[0]![0], window.location.origin).searchParams.get("returnPath")).toBe(destination);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/decision") || url.endsWith("/accept"))).toBe(false);
    if (flow === "invitation") expect(window.sessionStorage.getItem(invitationStorageKey)).not.toBeNull();
    expect(window.location.href).not.toContain("pending-invitation");
  });
});
