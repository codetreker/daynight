import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { teamPreferenceKey, useTeamPreference } from "../src/features/teams/useTeamPreference";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001";
const a = "00000000-0000-4000-8000-000000000002", b = "00000000-0000-4000-8000-000000000003";
const personal = { id: "00000000-0000-4000-8000-000000000004", kind: "personal" as const, name: null };
const key = teamPreferenceKey(userId), time = "2026-10-20T09:00:00Z";
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); });
const setup = async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const id = url.slice("/api/v1/teams/".length);
    return Promise.resolve(new Response(stringifyWireJson({ id, kind: id === personal.id ? "personal" : "ordinary", name: id === personal.id ? null : id === a ? "Alpha" : "Beta", version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "member", version: 1n, createdAt: time, updatedAt: time } }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  }));
  const fixture = renderHook(({ route }: { route: string | null }) => useTeamPreference(personal, route, scope, false), { initialProps: { route: a as string | null } });
  await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
  fixture.rerender({ route: null });
  return fixture;
};

describe("confirmed Team departure preference", () => {
  it("preserves another tab's newer stored Team and restores it at the default entry", async () => {
    const fixture = await setup(); expect(localStorage.getItem(key)).toBe(a);
    localStorage.setItem(key, b);
    act(() => fixture.result.current.leaveTeam(a));
    fixture.rerender({ route: null });
    expect(localStorage.getItem(key)).toBe(b);
    expect(fixture.result.current.detail.id).toBe(personal.id);
    fixture.rerender({ route: "default" });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
  });
  it("falls back to Personal when the saved choice is still the departed Team", async () => {
    const fixture = await setup();
    act(() => fixture.result.current.leaveTeam(a));
    fixture.rerender({ route: null });
    expect(localStorage.getItem(key)).toBe(personal.id);
    expect(fixture.result.current.detail.id).toBe(personal.id);
    expect(fixture.result.current.saveError).toBe(false);
  });
  it("keeps an absent saved choice absent", async () => {
    const fixture = await setup(); localStorage.removeItem(key);
    act(() => fixture.result.current.leaveTeam(a));
    fixture.rerender({ route: null });
    expect(localStorage.getItem(key)).toBeNull();
    expect(fixture.result.current.detail.id).toBe(personal.id);
  });
  it.each([null, b])("discards the departed Team's failed local save while preserving stored %s", async (saved) => {
    if (saved !== null) localStorage.setItem(key, saved);
    const write = Storage.prototype.setItem;
    const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("denied"); return write.call(this, name, value);
    });
    const fixture = await setup(); expect(fixture.result.current.saveError).toBe(true);
    denied.mockRestore();
    act(() => fixture.result.current.leaveTeam(a));
    act(() => fixture.result.current.retrySave());
    expect(localStorage.getItem(key)).toBe(saved);
    expect(fixture.result.current.saveError).toBe(false);
    fixture.rerender({ route: "default" });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: saved ?? personal.id, status: "ready" }));
  });
  it.each(["getItem", "setItem"] as const)("retries a failed %s without replacing a newer stored Team", async (method) => {
    const fixture = await setup();
    const denied = vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("denied"); });
    act(() => fixture.result.current.leaveTeam(a));
    fixture.rerender({ route: null });
    expect(fixture.result.current.detail.id).toBe(personal.id);
    expect(fixture.result.current.saveError).toBe(true);
    denied.mockRestore(); expect(localStorage.getItem(key)).toBe(a);
    localStorage.setItem(key, b);
    act(() => fixture.result.current.retrySave());
    expect(localStorage.getItem(key)).toBe(b);
    expect(fixture.result.current.saveError).toBe(false);
    fixture.rerender({ route: "default" });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
  });
  it.each(["getItem", "setItem"] as const)("recovers a failed %s when the saved choice remains the departed Team", async (method) => {
    const fixture = await setup();
    const denied = vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("denied"); });
    act(() => fixture.result.current.leaveTeam(a));
    denied.mockRestore();
    act(() => fixture.result.current.retrySave());
    expect(localStorage.getItem(key)).toBe(personal.id);
    expect(fixture.result.current.saveError).toBe(false);
  });
  it("preserves a newer local Team and its pending save", async () => {
    const fixture = await setup();
    const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    fixture.rerender({ route: b });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
    fixture.rerender({ route: null });
    act(() => fixture.result.current.leaveTeam(a));
    expect(fixture.result.current.detail.id).toBe(b);
    denied.mockRestore();
    act(() => fixture.result.current.retrySave());
    expect(localStorage.getItem(key)).toBe(b);
  });
});

describe("Team preference during background checks", () => {
  const reply = (id: string, status = 200, name = "Alpha") => new Response(stringifyWireJson(status === 200
    ? { id, kind: "ordinary", name, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "member", version: 1n, createdAt: time, updatedAt: time } }
    : { error: { code: status === 404 ? "not_found" : "internal_error", message: "unavailable", requestId: "request-1" } }), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });

  it.each([a, "default"])("keeps the confirmed %s snapshot while the exact GET is pending", async (route) => {
    localStorage.setItem(key, a);
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => fetcher.mock.calls.length === 2 ? pending.promise : Promise.resolve(reply(a)));
    vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, route, scope, blocked), { initialProps: { blocked: false } });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    const snapshot = fixture.result.current.detail;
    fixture.rerender({ blocked: true });
    expect(fixture.result.current.detail).toBe(snapshot);
    fixture.rerender({ blocked: false });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fixture.result.current.detail).toBe(snapshot);
    await act(async () => pending.resolve(reply(a)));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready", team: { name: "Alpha" } }));
  });

  it("publishes a changed Team and surfaces a real revalidation error", async () => {
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const pending = Promise.withResolvers<Response>();
    let next = Promise.resolve(reply(a));
    const fetcher = vi.fn(() => next); vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, a, scope, blocked), { initialProps: { blocked: false } });
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("ready"));
    next = pending.promise;
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fixture.result.current.detail.status).toBe("ready");
    await act(async () => pending.resolve(reply(a, 200, "Renamed")));
    await waitFor(() => expect(fixture.result.current.detail.team?.name).toBe("Renamed"));
    next = Promise.resolve(reply(a, 500));
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("error"));
    next = Promise.resolve(reply(a, 200, "Renamed"));
    act(() => fixture.result.current.retry());
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("ready"));
  });

  it.each([[200, false], [404, false], [404, true]] as const)("does not restore a choice replaced by another tab while GET returns %s (guard=%s)", async (status, guarded) => {
    localStorage.setItem(key, a);
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string) => fetcher.mock.calls.length === 2 ? pending.promise : Promise.resolve(reply(url.endsWith(b) ? b : a)));
    vi.stubGlobal("fetch", fetcher);
    const guard = () => guarded;
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, "default", scope, blocked, { guardUnavailable: guard }), { initialProps: { blocked: false } });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    localStorage.setItem(key, b);
    await act(async () => pending.resolve(reply(a, status)));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
    expect(localStorage.getItem(key)).toBe(b);
  });

  it("loads a newly selected target and retains the prior choice only until that navigation", async () => {
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith(b) ? pending.promise : Promise.resolve(reply(a)));
    vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ route }: { route: string }) => useTeamPreference(personal, route, scope, false), { initialProps: { route: a } });
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("ready"));
    fixture.rerender({ route: b });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fixture.result.current.detail).toMatchObject({ id: b, status: "loading" });
    await act(async () => pending.resolve(reply(b)));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
  });

  it.each([false, true])("handles an actual missing Team with guard=%s", async (guarded) => {
    localStorage.setItem(key, a);
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    let status = 200;
    const guard = vi.fn(() => guarded);
    const fetcher = vi.fn(() => Promise.resolve(reply(a, status))); vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, "default", scope, blocked, { guardUnavailable: guard }), { initialProps: { blocked: false } });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    status = 404;
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject(guarded ? { id: a, status: "error" } : { id: personal.id, status: "ready" }));
    expect(guard).toHaveBeenCalledWith(a);
    expect(localStorage.getItem(key)).toBe(guarded ? a : null);
  });

  it.each([200, 404])("does not publish an older GET result (%s) over a confirmed update, and checks again", async (oldStatus) => {
    localStorage.setItem(key, a);
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const old = Promise.withResolvers<Response>(), fresh = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => fetcher.mock.calls.length === 1 ? Promise.resolve(reply(a)) : fetcher.mock.calls.length === 2 ? old.promise : fresh.promise);
    vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, a, scope, blocked), { initialProps: { blocked: false } });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready", team: { name: "Alpha" } }));
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const confirmed = { id: a, kind: "ordinary" as const, name: "Renamed", version: 2n, createdAt: time, updatedAt: time, membership: { teamId: a, userId, role: "member" as const, version: 1n, createdAt: time, updatedAt: time } };
    act(() => fixture.result.current.acceptTeam(confirmed));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await act(async () => old.resolve(reply(a, oldStatus)));
    expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready", team: { name: "Renamed" } });
    expect(localStorage.getItem(key)).toBe(a);
    await act(async () => fresh.resolve(reply(a, 404)));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: personal.id, status: "ready" }));
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("restarts an interrupted first read and ignores its late result", async () => {
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => fetcher.mock.calls.length === 1 ? pending.promise : Promise.resolve(reply(a)));
    vi.stubGlobal("fetch", fetcher);
    const fixture = renderHook(({ blocked }: { blocked: boolean }) => useTeamPreference(personal, a, scope, blocked), { initialProps: { blocked: false } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fixture.result.current.detail.status).toBe("loading");
    fixture.rerender({ blocked: true }); fixture.rerender({ blocked: false });
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("ready"));
    await act(async () => pending.resolve(reply(a, 200, "Stale")));
    expect(fixture.result.current.detail.team?.name).toBe("Alpha");
  });
});

describe("Team restoration on workspace entry", () => {
  const entry = (fetcher: (url: string, init?: RequestInit) => Promise<Response>, enabled = true) => {
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    vi.stubGlobal("fetch", vi.fn(fetcher));
    return renderHook(({ route, visible }: { route: string | null; visible: boolean }) => useTeamPreference(personal, route, scope, false, { restoreOnEntry: visible }), { initialProps: { route: null as string | null, visible: enabled } });
  };
  const reply = (id: string, status = 200) => new Response(stringifyWireJson(status === 200
    ? { id, kind: "ordinary", name: id === a ? "Alpha" : "Beta", version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "member", version: 1n, createdAt: time, updatedAt: time } }
    : { error: { code: status === 404 ? "not_found" : "internal_error", message: "unavailable", requestId: "request-entry" } }), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });

  it("restores once on a non-Team entry and preserves the current choice until default re-entry", async () => {
    localStorage.setItem(key, a);
    const fetcher = vi.fn(async (url: string) => reply(url.split("/").at(-1)!));
    const fixture = entry(fetcher);
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    localStorage.setItem(key, b);
    fixture.rerender({ route: null, visible: true });
    expect(fixture.result.current.detail.id).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fixture.rerender({ route: "default", visible: true });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
  });

  it("waits for a visible workspace before restoring a standalone entry", async () => {
    localStorage.setItem(key, a);
    const fetcher = vi.fn(async () => reply(a));
    const fixture = entry(fetcher, false);
    expect(fetcher).not.toHaveBeenCalled();
    fixture.rerender({ route: null, visible: true });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses Personal without writing a preference when no selection exists", async () => {
    const fetcher = vi.fn(async () => reply(a));
    const fixture = entry(fetcher);
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: personal.id, status: "ready" }));
    expect(localStorage.getItem(key)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes a failed storage read until retry restores the saved selection", async () => {
    localStorage.setItem(key, a);
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const fixture = entry(async () => reply(a));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ status: "error", storageError: true }));
    denied.mockRestore();
    act(() => fixture.result.current.retry());
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
    expect(localStorage.getItem(key)).toBe(a);
  });

  it("retains a saved selection through a server failure and permits retry", async () => {
    localStorage.setItem(key, a); let status = 500;
    const fixture = entry(async () => reply(a, status));
    await waitFor(() => expect(fixture.result.current.detail.status).toBe("error"));
    expect(localStorage.getItem(key)).toBe(a);
    status = 200; act(() => fixture.result.current.retry());
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: a, status: "ready" }));
  });

  it("forgets a confirmed missing Team without changing an explicit resource URL", async () => {
    window.history.replaceState(null, "", "/workers"); localStorage.setItem(key, a);
    const fixture = entry(async () => reply(a, 404));
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: personal.id, status: "ready" }));
    expect(localStorage.getItem(key)).toBeNull();
    expect(window.location.pathname).toBe("/workers");
  });

  it("rereads a newer saved Team when default entry replaces an unfinished restoration", async () => {
    localStorage.setItem(key, a);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith(a) ? pending.promise : Promise.resolve(reply(b)));
    const fixture = entry(fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    localStorage.setItem(key, b);
    fixture.rerender({ route: "default", visible: true });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
    await act(async () => pending.resolve(reply(a)));
    expect(fixture.result.current.detail.id).toBe(b);
    expect(localStorage.getItem(key)).toBe(b);
  });

  it("lets explicit selection replace an unfinished restoration", async () => {
    localStorage.setItem(key, a);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith(a) ? pending.promise : Promise.resolve(reply(b)));
    const fixture = entry(fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fixture.result.current.detail.status).toBe("loading");
    fixture.rerender({ route: b, visible: true });
    await waitFor(() => expect(fixture.result.current.detail).toMatchObject({ id: b, status: "ready" }));
    await act(async () => pending.resolve(reply(a)));
    expect(fixture.result.current.detail.id).toBe(b);
    expect(localStorage.getItem(key)).toBe(b);
  });
});
