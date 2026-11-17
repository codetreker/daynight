import { act, fireEvent, renderHook, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { ApiError } from "../src/api/client";
import { useTeamMemberSearch } from "../src/features/teams/member-search/useTeamMemberSearch";
import { TeamMemberSearch } from "../src/features/teams/member-search/TeamMemberSearch";
import { createLocaleRender } from "./helpers/renderWithLocale";

const search = vi.hoisted(() => vi.fn());
vi.mock("../src/api/team-member-search", () => ({ searchTeamMemberCandidates: search }));
const userId = "00000000-0000-4000-8000-000000000001", teamId = "00000000-0000-4000-8000-000000000002";
const id1 = "00000000-0000-4000-8000-000000000003", id2 = "00000000-0000-4000-8000-000000000004";
const item = (userId: string, name: string | null = "Alex") => ({ userId, profile: { name, email: "alex@example.com", avatarUrl: null as string | null } });
const page = (items: ReturnType<typeof item>[], nextCursor: string | null = null) => ({ items, nextCursor, actorRole: "admin" as const });
const base = () => {
  const admission = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as unknown as TaskCacheScope;
  return { teamId, admission, active: true, admissionBlocked: false, permissionReady: true, permissionRevision: 1, getPermissionRevision: () => 1 as number | null, onIdentityMismatch: vi.fn(), onPermissionChange: vi.fn() };
};
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => {
  search.mockReset(); vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

describe("Team member search", () => {
  it("debounces input and fences late results from an older query", async () => {
    const old = Promise.withResolvers<ReturnType<typeof page>>(), next = Promise.withResolvers<ReturnType<typeof page>>();
    search.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const options = base(), view = renderHook(() => useTeamMemberSearch(options));
    act(() => view.result.current.setDraft("  AL  "));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(search).toHaveBeenCalledWith(teamId, userId, "al", null, expect.any(AbortSignal), expect.any(Function));
    act(() => view.result.current.setDraft("new"));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => old.resolve(page([item(id1)])));
    expect(view.result.current.items).toEqual([]);
    await act(async () => next.resolve(page([item(id2)])));
    expect(view.result.current.items).toEqual([item(id2)]);
  });
  it("retains loaded pages and resumes an interrupted cursor after permission recheck", async () => {
    const firstMore = Promise.withResolvers<ReturnType<typeof page>>(), retryMore = Promise.withResolvers<ReturnType<typeof page>>();
    search.mockResolvedValueOnce(page([item(id1)], "cursor-1")).mockReturnValueOnce(firstMore.promise).mockReturnValueOnce(retryMore.promise);
    let revision: number | null = 1;
    const options = { ...base(), getPermissionRevision: () => revision };
    const view = renderHook((props) => useTeamMemberSearch(props), { initialProps: options });
    act(() => view.result.current.setDraft("alex")); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await flush();
    act(() => view.result.current.more()); await flush();
    revision = null; view.rerender({ ...options, permissionReady: false });
    expect(view.result.current.items).toEqual([item(id1)]);
    await act(async () => firstMore.resolve(page([item(id2)])));
    expect(view.result.current.items).toEqual([item(id1)]);
    revision = 2; view.rerender({ ...options, permissionReady: true, permissionRevision: 2 }); await flush();
    expect(search).toHaveBeenCalledTimes(3); expect(search.mock.calls[2]?.[3]).toBe("cursor-1");
    await act(async () => retryMore.resolve(page([item(id2)])));
    expect(view.result.current.items).toEqual([item(id1), item(id2)]);
  });
  it("reports malformed traversal without losing earlier results", async () => {
    search.mockResolvedValueOnce(page([item(id1)], "cursor-1")).mockResolvedValueOnce(page([item(id1)], "cursor-2"));
    const options = base(), view = renderHook(() => useTeamMemberSearch(options));
    act(() => view.result.current.setDraft("alex")); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await flush();
    act(() => view.result.current.more()); await flush();
    expect(view.result.current.moreError).toBe(true); expect(view.result.current.items).toEqual([item(id1)]);
  });
  it("keeps an unavailable search route as an error while asking for a Team recheck", async () => {
    search.mockRejectedValueOnce(new ApiError("server", 404, "not_found"));
    const options = base(), view = renderHook(() => useTeamMemberSearch(options));
    act(() => view.result.current.setDraft("alex")); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await flush();
    expect(view.result.current.status).toBe("error");
    expect(view.result.current.draft).toBe("alex"); expect(options.onPermissionChange).toHaveBeenCalledOnce();
  });
  it("resumes an interrupted query after identity checking without publishing its old response", async () => {
    const old = Promise.withResolvers<ReturnType<typeof page>>(), next = Promise.withResolvers<ReturnType<typeof page>>();
    search.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const options = base(), view = renderHook((props) => useTeamMemberSearch(props), { initialProps: options });
    act(() => view.result.current.setDraft("alex")); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await flush();
    view.rerender({ ...options, admissionBlocked: true });
    await act(async () => old.resolve(page([item(id1)])));
    expect(view.result.current.items).toEqual([]); expect(search).toHaveBeenCalledTimes(1);
    view.rerender({ ...options, admissionBlocked: false }); await flush(); expect(search).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(page([item(id2)])));
    expect(view.result.current.items).toEqual([item(id2)]); expect(view.result.current.draft).toBe("alex");
  });
  it("exposes full account identities and never adds on input Enter", async () => {
    search.mockResolvedValue(page([item(id1, null), { ...item(id2), profile: { ...item(id2).profile, avatarUrl: "https://example.test/avatar.png" } }]));
    const add = vi.fn(), render = createLocaleRender("en");
    const props = { ...base(), members: [], addition: { targetId: null, pending: false, unknown: false, checking: false, error: null, observed: false, locked: false }, onAdd: add, onCheck: vi.fn() };
    const view = render(<TeamMemberSearch {...props} />);
    const input = screen.getByRole("searchbox", { name: "Search and add members" });
    fireEvent.focus(input); fireEvent.change(input, { target: { value: "alex" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await flush();
    fireEvent.keyDown(input, { key: "Enter" }); expect(add).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Search users and add to team" });
    expect(within(dialog).getByText("Name not set")).toBeVisible();
    const avatar = dialog.querySelector(".member-search-avatar img")!;
    fireEvent.error(avatar); expect(dialog.querySelectorAll(".member-search-avatar")[1]).toHaveTextContent("A");
    expect(within(dialog).getAllByText(/Account 00000000/)).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: `Add Name not set, alex@example.com, Account ${id1}` }));
    expect(add).toHaveBeenCalledOnce(); expect(add).toHaveBeenCalledWith(id1);
    view.rerender(<TeamMemberSearch {...props} addition={{ ...props.addition, targetId: id1, pending: true, locked: true }} />);
    expect(within(dialog).getByRole("button", { name: `Adding Name not set, alex@example.com, Account ${id1}` })).toHaveAttribute("aria-disabled", "true");
    view.rerender(<TeamMemberSearch {...props} addition={{ ...props.addition, targetId: id1, unknown: true, locked: true }} />);
    expect(within(dialog).getByRole("button", { name: `Check status Name not set, alex@example.com, Account ${id1}` })).toHaveAttribute("aria-disabled", "true");
    view.rerender(<TeamMemberSearch {...props} members={[{ teamId, userId: id1, role: "member", version: 1n, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", profile: item(id1).profile }]} />);
    expect(within(dialog).getByRole("button", { name: `Joined Name not set, alex@example.com, Account ${id1}` })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(dialog, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(input).toHaveFocus();
  });
});
