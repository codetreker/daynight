import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { useCredentialPanel } from "../src/features/management/useCredentialPanel";
const record = { id: "00000000-0000-4000-8000-000000000002", lastUsedAt: null, description: "before" };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => invalidateAuthRequests());
describe("credential panel admission", () => {
  it("queues full reads until a write publishes and prevents a new write throughout the read", async () => {
    const list = vi.fn().mockResolvedValue([record]);
    const { result } = renderHook(() => useCredentialPanel<typeof record>("00000000-0000-4000-8000-000000000001", list, vi.fn()));
    await act(async () => {});
    const commit = deferred<void>(), reading = deferred<readonly typeof record[]>(); list.mockReturnValueOnce(reading.promise);
    const operation = vi.fn(async () => { await commit.promise; result.current.setItems([{ ...record, description: "confirmed write" }]); });
    let write!: Promise<void>, read!: Promise<void>;
    await act(async () => { write = result.current.write(operation); read = result.current.read(); });
    expect(list).toHaveBeenCalledTimes(1); expect(result.current.pending).toBe(true);
    await act(async () => { commit.resolve(); await write; });
    expect(list).toHaveBeenCalledTimes(2); expect(result.current.items?.[0]?.description).toBe("confirmed write");
    const blocked = vi.fn(); await act(async () => { await result.current.write(blocked); }); expect(blocked).not.toHaveBeenCalled();
    await act(async () => { reading.resolve([{ ...record, description: "read after write" }]); await read; });
    expect(result.current.items?.[0]?.description).toBe("read after write");
  });
  it("holds an existing read during account verification and discards its result after invalidation", async () => {
    const response = deferred<readonly typeof record[]>(), list = vi.fn().mockReturnValue(response.promise);
    const { result } = renderHook(() => useCredentialPanel<typeof record>("00000000-0000-4000-8000-000000000001", list, vi.fn()));
    const resume = pauseAuthRequests(); await act(async () => response.resolve([record]));
    expect(result.current.items).toBeNull();
    await act(async () => { invalidateAuthRequests(); resume(); });
    expect(result.current.items).toBeNull(); expect(list).toHaveBeenCalledTimes(1);
  });
});
