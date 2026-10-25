import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_STORAGE_KEY, resolveInitialSidebarPreference, useSidebarPreference } from "../src/app/useSidebarPreference";

type SidebarStorage = Pick<Storage, "getItem" | "setItem">;
const storageWith = (saved: string | null): SidebarStorage => ({ getItem: vi.fn(() => saved), setItem: vi.fn() });

describe("sidebar browser preference", () => {
  it("starts expanded when missing without persisting an implicit choice", () => {
    const storage = storageWith(null);
    const { result } = renderHook(() => useSidebarPreference(() => storage));
    expect(result.current.collapsed).toBe(false);
    expect(result.current.issue).toBeNull();
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(SIDEBAR_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([["true", true], ["false", false], [" true ", true]] as const)("restores JSON boolean %j without rewriting it", (saved, collapsed) => {
    const storage = storageWith(saved);
    expect(resolveInitialSidebarPreference(() => storage)).toEqual({ collapsed, issue: null });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["", "TRUE", '"true"', "1", "0", "null", "{}", "[]", "undefined"])("surfaces invalid saved value %j without rewriting it", (saved) => {
    const storage = storageWith(saved);
    const { result } = renderHook(() => useSidebarPreference(() => storage));
    expect(result.current.collapsed).toBe(false);
    expect(result.current.issue?.kind).toBe("invalid");
    expect(result.current.issue?.cause).toBeInstanceOf(Error);
    expect(storage.setItem).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(SIDEBAR_STORAGE_KEY, "true");
    expect(result.current.issue).toBeNull();
  });

  it.each(["access", "read"] as const)("retains the original %s failure until explicitly saving the current value", (failure) => {
    const cause = new DOMException("storage unavailable", "SecurityError");
    let unavailable = true;
    const storage: SidebarStorage = {
      getItem: () => { if (failure === "read" && unavailable) throw cause; return null; },
      setItem: vi.fn(),
    };
    const getStorage = () => { if (failure === "access" && unavailable) throw cause; return storage; };
    const { result } = renderHook(() => useSidebarPreference(getStorage));
    expect(result.current.collapsed).toBe(false);
    expect(result.current.issue).toEqual({ kind: "read", cause });
    expect(result.current.issue?.cause).toBe(cause);
    expect(storage.setItem).not.toHaveBeenCalled();
    unavailable = false;
    act(() => result.current.retrySave());
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(SIDEBAR_STORAGE_KEY, "false");
    expect(result.current.issue).toBeNull();
  });

  it("retains each memory choice and writes only on explicit selection or retry", () => {
    const cause = new DOMException("storage full", "QuotaExceededError");
    let unavailable = true;
    const storage: SidebarStorage = {
      getItem: () => "true",
      setItem: vi.fn(() => { if (unavailable) throw cause; }),
    };
    const { result, rerender } = renderHook(() => useSidebarPreference(() => storage));
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.issue?.cause).toBe(cause);
    expect(result.current.issue?.kind).toBe("write");
    rerender();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(storage.setItem).toHaveBeenLastCalledWith(SIDEBAR_STORAGE_KEY, "true");
    unavailable = false;
    act(() => result.current.retrySave());
    expect(storage.setItem).toHaveBeenLastCalledWith(SIDEBAR_STORAGE_KEY, "true");
    expect(storage.setItem).toHaveBeenCalledTimes(3);
    expect(result.current.issue).toBeNull();
  });

  it("restores the selected origin preference in a new mounted workspace", () => {
    const first = renderHook(() => useSidebarPreference());
    act(() => first.result.current.toggle());
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    first.unmount();
    const second = renderHook(() => useSidebarPreference());
    expect(second.result.current.collapsed).toBe(true);
    act(() => second.result.current.toggle());
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("false");
  });
});
