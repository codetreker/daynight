import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
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
  it("uses Personal initially, offers paginated Team links and preserves native navigation", async () => {
    const fetcher = install(); render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Personal" });
    expect(fetcher.mock.calls.some(([url]) => url === `/api/v1/teams/${personal}`)).toBe(false);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${personal}`))).toBe(true));
    const selector = screen.getByText("Personal", { selector: "summary .team-switch-text" }).closest("details")!;
    fireEvent.click(selector.querySelector("summary")!);
    const link = await within(selector).findByRole("link", { name: "Alpha" });
    expect(link).toHaveAttribute("href", `/teams/${a}`);
    fireEvent.click(link, { ctrlKey: true }); expect(window.location.pathname).toBe("/projects");
    fireEvent.click(link); await screen.findByRole("heading", { name: "Alpha" }); expect(window.location.pathname).toBe(`/teams/${a}`);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`teamId=${a}`))).toBe(true));
    fireEvent.click(screen.getByRole("link", { name: "Shared with me" }));
    await screen.findByRole("heading", { name: "Projects shared with me" });
    expect(screen.queryByRole("button", { name: /Create project/ })).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url.includes("shared=true"))).toBe(true);
  });
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
    const selector = document.querySelector<HTMLDetailsElement>("details.team-selector")!; fireEvent.click(selector.querySelector("summary")!);
    await within(selector).findByRole("link", { name: "Alpha" });
    fireEvent.click(within(selector).getByRole("button", { name: "Load more Teams" }));
    expect(await within(selector).findByRole("alert")).toHaveTextContent("rq-more");
    expect(within(selector).getByRole("link", { name: "Alpha" })).toBeInTheDocument();
    fireEvent.click(within(selector).getByRole("button", { name: "Retry" })); await within(selector).findByRole("link", { name: "Beta" });
    expect(fetcher.mock.calls.filter(([url]) => url.includes("cursor=next%2F%2B"))).toHaveLength(2);
  });
  it("retains Personal and reports list errors with request ID and retry", async () => {
    let reads = 0;
    install((url) => url.startsWith("/api/v1/teams?") && ++reads === 1 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-team" } }, 500) : undefined);
    render(<AuthenticatedApp />); await screen.findByRole("heading", { name: "Personal" });
    const selector = document.querySelector<HTMLDetailsElement>("details.team-selector")!; fireEvent.click(selector.querySelector("summary")!);
    const alert = await within(selector).findByRole("alert"); expect(alert).toHaveTextContent("rq-team"); expect(alert).not.toHaveTextContent("private");
    expect(within(selector).getByRole("link", { name: "Personal" })).toHaveAttribute("href", "/projects");
    fireEvent.click(within(selector).getByRole("button", { name: "Retry" })); await within(selector).findByRole("link", { name: "Beta" });
  });
  it("shows a usable Team control when the narrow sidebar is collapsed", async () => {
    mockSidebarMediaQuery(true); install(); render(<AuthenticatedApp />);
    await screen.findByRole("heading", { name: "Personal" });
    const control = screen.getByRole("button", { name: "Switch Team: Personal" });
    expect(control.textContent).toBe("P"); fireEvent.click(control);
    expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBeInTheDocument();
  });
});
