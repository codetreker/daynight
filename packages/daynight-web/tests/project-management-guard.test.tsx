import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useProjectManagementGuard } from "../src/features/management/ProjectManagementGuard";

it("serializes competing Project operations synchronously and releases only the owner", () => {
  const { result } = renderHook(() => useProjectManagementGuard());
  act(() => {
    expect(result.current.tryAcquire("settings")).toBe(true);
    expect(result.current.tryAcquire("delete")).toBe(false);
    expect(result.current.isBlocked("transfer")).toBe(true);
    result.current.release("transfer");
    expect(result.current.tryAcquire("delete")).toBe(false);
    result.current.release("settings");
    expect(result.current.tryAcquire("delete")).toBe(true);
  });
  expect(result.current.isBlocked("settings")).toBe(true);
  act(() => result.current.release("delete"));
  expect(result.current.isBlocked("settings")).toBe(false);
});
