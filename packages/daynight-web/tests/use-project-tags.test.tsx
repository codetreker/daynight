import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { useProjectTags } from "../src/features/task-tags/useProjectTags";

const state = vi.hoisted(() => ({ list: vi.fn(), listeners: new Set<(event: { projectId: string; accessRevoked?: boolean; accessRestored?: boolean; directAccessUncertain?: boolean }) => void>(), scope: null as any, access: null as null | { revalidateAfterMutation: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> } }));
vi.mock("../src/api/task-tags", () => ({ listProjectTags: state.list }));
vi.mock("../src/features/task-cache/TaskCacheProvider", () => ({ useTaskCacheScope: () => state.scope }));
vi.mock("../src/features/projects/ProjectAccess", () => ({ useProjectAccessSession: () => state.access }));
const project = "project", epoch = "epoch", nextEpoch = "next";
const page = (name: string, catalogEpoch = epoch, nextCursor: string | null = null) => ({ items: [{ id: name, name }], catalogEpoch, nextCursor });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reset = () => {
  state.listeners.clear(); state.list.mockReset(); state.access = null;
  state.scope = { userId: "user", signal: new AbortController().signal, isInvalidated: false, principalMismatch: vi.fn(), isProjectSuspended: vi.fn().mockReturnValue(false), ready: vi.fn().mockResolvedValue(undefined), subscribe: (listener: (event: any) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } };
};
afterEach(() => { vi.useRealTimers(); });

describe("scoped project tag pages", () => {
  it("keeps the existing page while a background first-page revalidation waits, and replaces it on a new epoch", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockResolvedValueOnce(page("first", epoch, "cursor")).mockResolvedValueOnce(page("second")).mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("first"));
    act(() => view.result.current.next());
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("second"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(3));
    expect(view.result.current.page?.items[0]?.name).toBe("second");
    await act(async () => { pending.resolve(page("new", nextEpoch)); await pending.promise; });
    expect(view.result.current.page?.items[0]?.name).toBe("new");
  });
  it("refreshes the current page usage after an unchanged epoch", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockResolvedValueOnce(page("first", epoch, "cursor")).mockResolvedValueOnce(page("old usage")).mockResolvedValueOnce(page("first", epoch, "cursor")).mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("first"));
    act(() => view.result.current.next());
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("old usage"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(4));
    expect(state.list.mock.calls[3]![1]).toMatchObject({ cursor: "cursor" });
    expect(view.result.current.page?.items[0]?.name).toBe("old usage");
    await act(async () => { pending.resolve(page("new usage")); await pending.promise; });
    expect(view.result.current.page?.items[0]?.name).toBe("new usage");
  });
  it("retires an in-flight response when direct access becomes uncertain", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page("restored"));
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    const signal = state.list.mock.calls[0]![2] as AbortSignal;
    act(() => { for (const listener of state.listeners) listener({ projectId: project, directAccessUncertain: true }); });
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(page("retired")); await pending.promise; });
    expect(view.result.current.page).toBeNull();
    act(() => { for (const listener of state.listeners) listener({ projectId: project, accessRestored: true }); });
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("restored"));
  });
  it("retains the query and visible page across tab deactivation while refreshing in the background", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockResolvedValueOnce(page("first")).mockResolvedValueOnce(page("filtered")).mockReturnValueOnce(pending.promise);
    const view = renderHook(({ active }) => useProjectTags(project, active), { initialProps: { active: true } });
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("first"));
    act(() => view.result.current.setQuery("filter"));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("filtered"));
    view.rerender({ active: false });
    view.rerender({ active: true });
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(3));
    expect(state.list.mock.calls[2]![1]).toMatchObject({ query: "filter", cursor: null });
    expect(view.result.current.query).toBe("filter"); expect(view.result.current.page?.items[0]?.name).toBe("filtered");
    await act(async () => { pending.resolve(page("fresh")); await pending.promise; });
    expect(view.result.current.page?.items[0]?.name).toBe("fresh");
  });
  it("restarts an invalid cursor at the first page without publishing a failure as an empty result", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockResolvedValueOnce(page("first", epoch, "cursor")).mockRejectedValueOnce(new ApiError("server", 409, "catalog_changed")).mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("first"));
    act(() => view.result.current.next());
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(3));
    expect(view.result.current.page?.items[0]?.name).toBe("first");
    expect(state.list.mock.calls[2]![1]).toMatchObject({ cursor: null });
    await act(async () => { pending.resolve(page("updated", nextEpoch)); await pending.promise; });
    expect(view.result.current.page?.items[0]?.name).toBe("updated");
  });
  it("hides results for a prior query and retires a late response on scope switch", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockResolvedValueOnce(page("old")).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page("new account"));
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("old"));
    act(() => view.result.current.setQuery("different"));
    expect(view.result.current.page).toBeNull();
    const oldSignal = state.scope.signal;
    state.scope = { ...state.scope, userId: "other", signal: new AbortController().signal };
    view.rerender();
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("new account"));
    await act(async () => { pending.resolve(page("late")); await pending.promise; });
    expect(view.result.current.page?.items[0]?.name).toBe("new account"); expect(oldSignal.aborted).toBe(false);
  });
  it("revalidates access on retry after an initial denial check fails, then reloads the catalog", async () => {
    reset(); const first = deferred<object | null>(), retry = deferred<object | null>();
    const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    state.access = { revalidateAfterMutation: check, snapshot: vi.fn().mockReturnValue({ error: new ApiError("network") }) };
    state.list.mockRejectedValueOnce(new ApiError("server", 403, "forbidden")).mockResolvedValueOnce(page("recovered"));
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.error).toMatchObject({ status: 403 }));
    await act(async () => { first.resolve(null); await first.promise; });
    act(() => view.result.current.refresh());
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(state.list).toHaveBeenCalledTimes(1);
    await act(async () => { retry.resolve({}); await retry.promise; });
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("recovered"));
    expect(state.list).toHaveBeenCalledTimes(2);
  });
  it("does not publish an access retry after revocation", async () => {
    reset(); const retry = deferred<object | null>();
    const check = vi.fn().mockResolvedValueOnce(null).mockReturnValueOnce(retry.promise);
    state.access = { revalidateAfterMutation: check, snapshot: vi.fn().mockReturnValue({ error: new ApiError("network") }) };
    state.list.mockRejectedValueOnce(new ApiError("server", 404, "not_found"));
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.error).toMatchObject({ status: 404 }));
    act(() => view.result.current.refresh()); await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    act(() => { for (const listener of state.listeners) listener({ projectId: project, directAccessUncertain: true }); });
    await act(async () => { retry.resolve({}); await retry.promise; });
    expect(state.list).toHaveBeenCalledTimes(1); expect(view.result.current.page).toBeNull();
  });
  it("allows explicit access revalidation after an independent revocation and an unsuccessful check", async () => {
    reset(); const retry = deferred<object | null>();
    const check = vi.fn().mockResolvedValueOnce(null).mockReturnValueOnce(retry.promise);
    state.access = { revalidateAfterMutation: check, snapshot: vi.fn().mockReturnValue({ error: new ApiError("network") }) };
    state.list.mockResolvedValueOnce(page("first")).mockResolvedValueOnce(page("restored"));
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("first"));
    state.scope.isProjectSuspended.mockReturnValue(true);
    act(() => { for (const listener of state.listeners) listener({ projectId: project, accessRevoked: true }); });
    expect(view.result.current.page).toBeNull(); expect(view.result.current.error).not.toBeNull();
    act(() => view.result.current.refresh());
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(state.list).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh()); await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    state.scope.isProjectSuspended.mockReturnValue(false);
    await act(async () => { retry.resolve({}); await retry.promise; });
    await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("restored"));
  });
  it("retires an access retry on scope switch or deactivation", async () => {
    for (const mode of ["scope", "inactive"] as const) {
      reset(); const retry = deferred<object | null>();
      const check = vi.fn().mockResolvedValueOnce(null).mockReturnValueOnce(retry.promise);
      state.access = { revalidateAfterMutation: check, snapshot: vi.fn().mockReturnValue({ error: new ApiError("network") }) };
      state.list.mockRejectedValueOnce(new ApiError("server", 403, "forbidden")).mockResolvedValueOnce(page("new scope"));
      const view = renderHook(({ active }) => useProjectTags(project, active), { initialProps: { active: true } });
      await waitFor(() => expect(view.result.current.error).toMatchObject({ status: 403 }));
      act(() => view.result.current.refresh()); await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
      if (mode === "scope") {
        state.scope = { ...state.scope, userId: "other", signal: new AbortController().signal }; view.rerender({ active: true });
        await waitFor(() => expect(view.result.current.page?.items[0]?.name).toBe("new scope"));
      } else view.rerender({ active: false });
      await act(async () => { retry.resolve({}); await retry.promise; });
      expect(state.list).toHaveBeenCalledTimes(mode === "scope" ? 2 : 1);
      if (mode === "scope") expect(view.result.current.page?.items[0]?.name).toBe("new scope");
      else expect(view.result.current.loading).toBe(false);
      view.unmount();
    }
  });
  it("retains read errors and cancels in-flight reads on access revocation", async () => {
    reset(); const pending = deferred<ReturnType<typeof page>>();
    state.list.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useProjectTags(project));
    await waitFor(() => expect(view.result.current.error).toBeInstanceOf(Error));
    expect(view.result.current.page).toBeNull();
    act(() => view.result.current.refresh());
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    const signal = state.list.mock.calls[1]![2] as AbortSignal;
    act(() => { for (const listener of state.listeners) listener({ projectId: project, accessRevoked: true }); });
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(page("retired")); await pending.promise; });
    expect(view.result.current.page).toBeNull();
  });
});
