import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamGitHubApps } from "../src/features/teams/TeamGitHubApps";
import { createLocaleRender } from "./helpers/renderWithLocale";

const userId = "00000000-0000-4000-8000-000000000001", teamId = "00000000-0000-4000-8000-000000000002", otherTeam = "00000000-0000-4000-8000-000000000003";
const item = (id: string, name: string) => ({ grantId: `00000000-0000-4000-8000-0000000000${id}`, app: { id: `00000000-0000-4000-8000-0000000001${id}`, githubAppId: "9223372036854775807", name, githubSlug: "long-app-slug", version: "9223372036854775807" }, createdAt: "2026-10-20T09:00:00Z" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const page = (items: unknown[], nextCursor: string | null = null) => json({ items, nextCursor });
const failed = (status: number, code: string) => json({ error: { code, message: "private error", requestId: "rq-team" } }, status);
const render = createLocaleRender("en");
const setup = (fetcher: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  vi.stubGlobal("fetch", vi.fn(fetcher));
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const app = (team = teamId, blocked = false, preferenceDenied = false) => <TeamGitHubApps teamId={team} admission={scope} admissionBlocked={blocked} preferenceDenied={preferenceDenied} onIdentityMismatch={vi.fn()} />;
  return { ...render(app()), app, scope };
};

it("shows the safe projection, loads more, and supports both languages", async () => {
  const view = setup(url => url.includes("cursor=") ? page([item("02", "Second")]) : page([item("01", "First")], "next"));
  expect(await screen.findByText("First")).toBeInTheDocument();
  expect(screen.getByText(/9223372036854775807/)).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Second")).toBeInTheDocument();
  expect(screen.getByText("First")).toBeInTheDocument();
  view.setLocale("zh-CN");
  expect(screen.getByText("可用的 GitHub Apps")).toBeInTheDocument();
  expect(screen.getAllByText("接入配置由 App 管理员维护。", { selector: "p" })).toHaveLength(2);
  view.unmount(); view.scope.dispose();
});

it("keeps the loaded pages and focus during background checks, then publishes changed data", async () => {
  const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>(); let firstReads = 0, secondReads = 0;
  const view = setup(url => {
    if (url.includes("cursor=")) return ++secondReads === 1 ? page([item("02", "Second")], "tail") : second.promise;
    return ++firstReads === 1 ? page([item("01", "First")], "next") : first.promise;
  });
  const before = await screen.findByText("First");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Second"); const more = screen.getByRole("button", { name: "Load more" }); more.focus();
  view.rerender(view.app(teamId, true)); view.rerender(view.app());
  await waitFor(() => expect(firstReads).toBe(2));
  expect(screen.getByText("First")).toBe(before); expect(document.activeElement).toBe(more);
  await act(async () => first.resolve(page([item("01", "Renamed")], "next")));
  await waitFor(() => expect(secondReads).toBe(2));
  expect(screen.getByText("First")).toBe(before); expect(document.activeElement).toBe(more);
  await act(async () => second.resolve(page([item("02", "Second")], "tail")));
  expect(await screen.findByText("Renamed")).toBeInTheDocument(); expect(screen.getByText("Second")).toBeInTheDocument(); expect(document.activeElement).toBe(more);
  view.unmount(); view.scope.dispose();
});

it("retains content after a continuation failure and retries that continuation", async () => {
  let tail = 0;
  const view = setup(url => url.includes("cursor=") ? ++tail === 1 ? failed(500, "internal_error") : page([item("02", "Second")]) : page([item("01", "First")], "next"));
  await screen.findByText("First"); fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("rq-team"); expect(screen.getByText("First")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Second")).toBeInTheDocument(); expect(screen.queryByRole("alert")).toBeNull(); expect(tail).toBe(2);
  view.unmount(); view.scope.dispose();
});

it("clears content on confirmed loss of permission and isolates late results after Team changes", async () => {
  const old = Promise.withResolvers<Response>(); let reads = 0;
  const view = setup(url => url.includes(otherTeam) ? page([]) : ++reads === 1 ? page([item("01", "Private")]) : old.promise);
  await screen.findByText("Private"); view.rerender(view.app(teamId, true)); view.rerender(view.app());
  await waitFor(() => expect(reads).toBe(2)); view.rerender(view.app(otherTeam));
  expect(screen.queryByText("Private")).toBeNull(); expect(await screen.findByText("No authorized Apps")).toBeInTheDocument();
  await act(async () => old.resolve(page([item("01", "Late private")])));
  expect(screen.queryByText("Late private")).toBeNull();
  view.rerender(view.app(otherTeam, false, true)); expect(screen.queryByText("No authorized Apps")).toBeNull(); expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
  view.unmount(); view.scope.dispose();
});

it("withdraws already displayed grants after server denies the Team", async () => {
  let reads = 0;
  const view = setup(() => ++reads === 1 ? page([item("01", "Private")]) : failed(403, "forbidden"));
  await screen.findByText("Private"); view.rerender(view.app(teamId, true)); view.rerender(view.app());
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable"); expect(screen.queryByText("Private")).toBeNull();
  view.unmount(); view.scope.dispose();
});
