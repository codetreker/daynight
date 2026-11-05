import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamsProvider, useTeams } from "../src/features/teams/TeamsProvider";
import { TeamSelector } from "../src/features/teams/TeamSelector";
import type { TeamPreference } from "../src/features/teams/useTeamPreference";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001", personal = "00000000-0000-4000-8000-000000000002", a = "00000000-0000-4000-8000-000000000003", b = "00000000-0000-4000-8000-000000000004", c = "00000000-0000-4000-8000-000000000005";
const time = "2026-10-20T09:00:00Z";
const team = (id: string, name: string, role = "admin") => ({ id, kind: "ordinary", name, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role, version: 1n, createdAt: time, updatedAt: time } });
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const page = (items: unknown[], nextCursor: string | null) => json({ items, nextCursor });
const preference = { detail: { id: personal, status: "ready", team: { id: personal, kind: "personal", name: null } } } as TeamPreference;
const render = createLocaleRender("en");
let snapshot: ReturnType<typeof useTeams>["list"];
const View = () => { const teams = useTeams(); snapshot = teams.list; return <><TeamSelector personalId={personal} selectedId={personal} expanded onExpand={() => {}} onNavigate={() => {}} /><button onClick={teams.refreshList}>Refresh list</button></>; };
const setup = (fetcher: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  vi.stubGlobal("fetch", vi.fn(fetcher));
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { throw new Error("principal mismatch"); } });
  const app = (blocked: boolean) => <TeamsProvider preference={preference} admission={scope} admissionBlocked={blocked}><View /></TeamsProvider>;
  const view = render(app(false));
  const selector = document.querySelector<HTMLDetailsElement>("details.team-selector")!;
  fireEvent.click(selector.querySelector("summary")!);
  return { ...view, selector, app, scope };
};

it("retains the loaded prefix and focused links until every revalidation page succeeds", async () => {
  const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>(), tail = Promise.withResolvers<Response>(); let firstReads = 0, secondReads = 0, tailReads = 0;
  let revalidationSignal: AbortSignal | undefined;
  const view = setup((url, init) => {
    if (url === "/api/v1/teams?limit=50") return ++firstReads === 1 ? page([team(a, "Alpha")], "next") : first.promise;
    if (url.endsWith("cursor=next")) { if (++secondReads === 1) return page([team(b, "Beta")], "tail"); revalidationSignal = init?.signal ?? undefined; return second.promise; }
    if (url.endsWith("cursor=tail")) { tailReads++; return tail.promise; }
    throw new Error(url);
  });
  const alpha = await within(view.selector).findByRole("link", { name: "Alpha" });
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" }));
  const beta = await within(view.selector).findByRole("link", { name: "Beta" }); beta.focus();
  const before = snapshot;
  view.rerender(view.app(true)); view.rerender(view.app(false));
  await waitFor(() => expect(firstReads).toBe(2));
  expect(snapshot).toBe(before); expect(document.activeElement).toBe(beta); expect(view.selector.open).toBe(true);
  await act(async () => first.resolve(page([team(a, "Alpha")], "next")));
  await waitFor(() => expect(secondReads).toBe(2));
  expect(snapshot).toBe(before); expect(within(view.selector).getByRole("link", { name: "Alpha" })).toBe(alpha); expect(document.activeElement).toBe(beta);
  expect(revalidationSignal).toBeDefined();
  const ready = view.scope.ready.bind(view.scope), reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), consumed = Promise.withResolvers<void>();
  vi.spyOn(view.scope, "ready").mockImplementation(async (signal) => {
    await ready(signal);
    if (signal === revalidationSignal) { reached.resolve(); await release.promise; signal.throwIfAborted(); }
  });
  const response = page([team(b, "Beta")], "tail"), read = response.text.bind(response);
  response.text = async () => { const result = await read(); consumed.resolve(); return result; };
  await act(async () => { second.resolve(response); await consumed.promise; await reached.promise; });
  expect(snapshot).toBe(before); expect(document.activeElement).toBe(beta);
  await act(async () => { release.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  expect(snapshot).toBe(before); expect(snapshot.items).toBe(before.items); expect(snapshot.cursor).toBe("tail"); expect(document.activeElement).toBe(beta);
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" }));
  await waitFor(() => expect(tailReads).toBe(1));
  expect(revalidationSignal!.aborted).toBe(false);
  await act(async () => tail.resolve(page([], null)));
  view.unmount(); view.scope.dispose();
});

it("publishes a changed prefix only after the whole reread and exposes recoverable errors", async () => {
  let firstReads = 0, secondReads = 0; const changed = Promise.withResolvers<Response>();
  const view = setup((url) => {
    if (url === "/api/v1/teams?limit=50") return ++firstReads === 1 ? page([team(a, "Alpha")], "next") : firstReads === 3 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-bg" } }, 500) : page([team(a, "Renamed", "member")], "next");
    if (url.endsWith("cursor=next")) return ++secondReads === 1 ? page([team(b, "Beta")], null) : secondReads === 2 ? changed.promise : page([team(c, "Gamma")], "tail");
    throw new Error(url);
  });
  await within(view.selector).findByRole("link", { name: "Alpha" });
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" })); await within(view.selector).findByRole("link", { name: "Beta" });
  view.rerender(view.app(true)); view.rerender(view.app(false)); await waitFor(() => expect(secondReads).toBe(2));
  expect(within(view.selector).getByRole("link", { name: "Alpha" })).toBeInTheDocument();
  await act(async () => changed.resolve(page([team(c, "Gamma")], "tail")));
  await within(view.selector).findByRole("link", { name: "Renamed" }); expect(within(view.selector).getByRole("link", { name: "Gamma" })).toBeInTheDocument(); expect(snapshot.items[0]?.membership.role).toBe("member");
  view.rerender(view.app(true)); view.rerender(view.app(false));
  expect(await within(view.selector).findByRole("alert")).toHaveTextContent("rq-bg");
  const retainedItems = snapshot.items;
  expect(within(view.selector).getByRole("link", { name: "Gamma" })).toBeInTheDocument(); expect(snapshot.cursor).toBe("tail");
  expect(within(view.selector).getByRole("button", { name: "Load more Teams" })).toBeInTheDocument();
  fireEvent.click(within(view.selector).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(within(view.selector).queryByRole("alert")).toBeNull());
  expect(snapshot.items).toBe(retainedItems); expect(snapshot.cursor).toBe("tail"); expect(firstReads).toBe(4); expect(secondReads).toBe(3);
  view.unmount(); view.scope.dispose();
});

it("resumes an interrupted page and prevents a late reread from dropping a later page", async () => {
  const interrupted = Promise.withResolvers<Response>(), oldRefresh = Promise.withResolvers<Response>(); let firstReads = 0, secondReads = 0, thirdReads = 0;
  const view = setup((url) => {
    if (url === "/api/v1/teams?limit=50") return ++firstReads === 1 ? page([team(a, "Alpha")], "next") : firstReads === 2 ? oldRefresh.promise : page([team(a, "Alpha")], "next");
    if (url.endsWith("cursor=next")) return ++secondReads === 1 ? interrupted.promise : page([team(b, "Beta")], "tail");
    if (url.endsWith("cursor=tail")) { thirdReads++; return page([team(c, "Gamma")], null); }
    throw new Error(url);
  });
  await within(view.selector).findByRole("link", { name: "Alpha" });
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" })); await waitFor(() => expect(secondReads).toBe(1));
  view.rerender(view.app(true)); view.rerender(view.app(false)); await within(view.selector).findByRole("link", { name: "Beta" });
  await waitFor(() => expect(firstReads).toBe(2));
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" })); await within(view.selector).findByRole("link", { name: "Gamma" });
  await waitFor(() => expect(thirdReads).toBe(2));
  await act(async () => { interrupted.resolve(page([team(b, "Stale")], null)); oldRefresh.resolve(page([team(a, "Stale")], null)); });
  expect(firstReads).toBe(3); expect(thirdReads).toBe(2); expect(snapshot.items.map((item) => item.name)).toEqual(["Alpha", "Beta", "Gamma"]); expect(snapshot.cursor).toBeNull();
  view.unmount(); view.scope.dispose();
});


it("resumes an interrupted first read and revalidates a valid empty directory", async () => {
  const cancelled = Promise.withResolvers<Response>(); let reads = 0;
  const view = setup(() => ++reads === 1 ? cancelled.promise : page([], null));
  await waitFor(() => expect(reads).toBe(1)); view.rerender(view.app(true)); view.rerender(view.app(false));
  await waitFor(() => expect(snapshot.status).toBe("ready")); expect(reads).toBe(2);
  const before = snapshot;
  view.rerender(view.app(true)); view.rerender(view.app(false)); await waitFor(() => expect(reads).toBe(3));
  await act(async () => cancelled.resolve(page([team(a, "Stale")], null)));
  expect(snapshot).toBe(before); expect(snapshot.items).toEqual([]);
  view.unmount(); view.scope.dispose();
});

it("executes an explicit refresh requested during blocked admission", async () => {
  let reads = 0;
  const view = setup(() => ++reads === 1 ? page([team(a, "Alpha")], null) : page([team(b, "Beta")], null));
  await within(view.selector).findByRole("link", { name: "Alpha" });
  view.rerender(view.app(true)); fireEvent.click(screen.getByRole("button", { name: "Refresh list" })); expect(reads).toBe(1);
  view.rerender(view.app(false)); await within(view.selector).findByRole("link", { name: "Beta" }); expect(reads).toBe(2);
  view.unmount(); view.scope.dispose();
});

it("retains a failed continuation and its retry across a successful prefix reread", async () => {
  let firstReads = 0, secondReads = 0;
  const view = setup((url) => {
    if (url === "/api/v1/teams?limit=50") return page([team(a, ++firstReads === 1 ? "Alpha" : "Renamed")], "next");
    if (url.endsWith("cursor=next")) return ++secondReads === 1 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-page" } }, 500) : page([team(b, "Beta")], null);
    throw new Error(url);
  });
  await within(view.selector).findByRole("link", { name: "Alpha" });
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" }));
  expect(await within(view.selector).findByRole("alert")).toHaveTextContent("rq-page");
  view.rerender(view.app(true)); view.rerender(view.app(false));
  await within(view.selector).findByRole("link", { name: "Renamed" });
  expect(firstReads).toBe(2); expect(within(view.selector).getByRole("alert")).toHaveTextContent("rq-page");
  fireEvent.click(within(view.selector).getByRole("button", { name: "Retry" }));
  await within(view.selector).findByRole("link", { name: "Beta" }); expect(secondReads).toBe(2);
  view.unmount(); view.scope.dispose();
});


it("revalidates the retained prefix after an interrupted continuation fails", async () => {
  const pending = Promise.withResolvers<Response>(); let firstReads = 0, secondReads = 0;
  const view = setup((url) => {
    if (url === "/api/v1/teams?limit=50") return ++firstReads === 1 ? page([team(a, "Alpha")], "next") : page([team(a, "Renamed")], "next");
    if (url.endsWith("cursor=next")) return ++secondReads === 1 ? pending.promise : secondReads === 2 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-page" } }, 500) : page([team(b, "Beta")], null);
    throw new Error(url);
  });
  await within(view.selector).findByRole("link", { name: "Alpha" });
  fireEvent.click(within(view.selector).getByRole("button", { name: "Load more Teams" })); await waitFor(() => expect(secondReads).toBe(1));
  view.rerender(view.app(true)); view.rerender(view.app(false));
  await within(view.selector).findByRole("link", { name: "Renamed" });
  expect(firstReads).toBe(2); expect(within(view.selector).getByRole("alert")).toHaveTextContent("rq-page");
  fireEvent.click(within(view.selector).getByRole("button", { name: "Retry" })); await within(view.selector).findByRole("link", { name: "Beta" });
  await act(async () => pending.resolve(page([team(b, "Stale")], null))); expect(snapshot.items.map((item) => item.name)).toEqual(["Renamed", "Beta"]);
  view.unmount(); view.scope.dispose();
});
