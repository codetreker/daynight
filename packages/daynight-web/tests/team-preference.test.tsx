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
