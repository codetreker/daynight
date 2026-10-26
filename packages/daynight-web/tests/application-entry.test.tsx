import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../src/app/Application";
import { navigate } from "../src/app/router";
import { invitationStorageKey } from "../src/features/auth/invitation";
import { renderWithLocale } from "./helpers/renderWithLocale";

vi.mock("../src/features/landing/LandingPage", () => ({ LandingPage: () => <main><h1>Public product introduction</h1></main> }));

const user = { id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(status === 401 ? {} : { "Daynight-User-ID": user.id }) } });
const anonymous = () => json({ error: { code: "unauthenticated", message: "Sign in", requestId: "entry-login" } }, 401);
const mount = (navigateToLogin = vi.fn()) => renderWithLocale(<Application navigateToLogin={navigateToLogin} />, { locale: "en" });
const defaultResponse = (url: string) => {
  if (url === "/api/v1/me") return json(user);
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
  it("reacts to public navigation and history without mounting an authenticated lifecycle", async () => {
    window.history.replaceState(null, "", "/");
    const fetcher = vi.fn(() => { throw new Error("Public reading must not mount the authenticated application"); });
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await act(async () => navigate("/setup?ref=public"));
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    await historyMove("back");
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await historyMove("forward");
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["/", "/setup"])("clears an invitation on deliberate public departure to %s and aborts old identity work", async (path) => {
    window.history.replaceState(null, "", "/invitations#pending-invitation");
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(invitationStorageKey)).not.toBeNull();
    await act(async () => navigate(path));
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => pending.resolve(json(user)));
    expect(screen.queryByText("Alice")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    await screen.findByRole("heading", { name: "Projects" });
    expect(window.location.pathname).toBe("/projects");
    await historyMove("back");
    expect(screen.getByRole("heading", { name: "Public product introduction" })).toBeVisible();
    await historyMove("forward");
    await screen.findByRole("heading", { name: "Projects" });
  });

  it("retains invitation context after a failed callback reaches the explicit login page", async () => {
    window.sessionStorage.setItem(invitationStorageKey, "pending-invitation");
    window.history.replaceState(null, "", "/login?authError=login_failed&returnPath=%2Finvitations");
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? anonymous() : defaultResponse(url))));
    const login = vi.fn(); mount(login);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect(screen.getByText("Sign in through UniAuth to review your project invitation.")).toBeVisible();
    expect(screen.getByText(/Sign-in was not completed/)).toBeVisible();
    expect(window.sessionStorage.getItem(invitationStorageKey)).not.toBeNull();
    expect(window.location.search).not.toContain("authError");
    expect(new URL(login.mock.calls[0]![0], window.location.origin).searchParams.get("returnPath")).toBe("/invitations");
  });

  it("returns successful normal logout to the public homepage", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/auth/logout" ? new Response(null, { status: 204 }) : defaultResponse(url))));
    mount();
    await screen.findByRole("heading", { name: "Projects" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Public product introduction" });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  it.each(["invitation", "device"])("keeps the %s target and temporary context while switching accounts", async (flow) => {
    const destination = flow === "invitation" ? "/invitations" : "/device?user_code=BCDFG-HJKLM";
    window.history.replaceState(null, "", destination + (flow === "invitation" ? "#pending-invitation" : ""));
    const fetcher = vi.fn((url: string) => Promise.resolve(
      url === "/api/v1/auth/logout" ? new Response(null, { status: 204 })
        : url === "/api/v1/invitations/inspect" ? json({ projectId: "00000000-0000-4000-8000-000000000010", projectName: "Invited project" })
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
