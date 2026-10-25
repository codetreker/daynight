import { afterEach, describe, expect, it, vi } from "vitest";
import { createToken, listTokens, updateTokenExpiry } from "../src/api/auth";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";

const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000003";
const token = { id: "00000000-0000-4000-8000-000000000002", name: "Daynight CLI", createdAt: "2026-10-25T10:00:00Z", expiresAt: null };
const exact = "2099-10-25T12:34:56.123456789Z";
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200, principal: string | null = userId) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const install = (value: Response) => { const fetcher = vi.fn().mockResolvedValue(value); vi.stubGlobal("fetch", fetcher); return fetcher; };
afterEach(() => invalidateAuthRequests());

describe("editable nullable token expiration API", () => {
  it("reads unlimited metadata only for the reviewed account", async () => {
    const fetcher = install(response({ items: [token] }));
    await expect(listTokens(signal(), userId, vi.fn())).resolves.toEqual([token]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me/tokens", expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }));
  });

  it.each([null, exact])("creates a token with explicit nullable expiry %s", async (expiresAt) => {
    const fetcher = install(response({ ...token, expiresAt, token: "one-time-token" }, 201));
    await expect(createToken({ name: token.name, expiresAt }, signal())).resolves.toMatchObject({ expiresAt });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me/tokens", expect.objectContaining({ body: JSON.stringify({ name: token.name, expiresAt }) }));
  });

  it.each([[null, exact], [exact, null]] as const)("updates %s to %s with exact observed expiry and reviewed account", async (expectedExpiresAt, expiresAt) => {
    const fetcher = install(response({ ...token, expiresAt }));
    const input = { expiresAt, expectedExpiresAt, expectedUserId: userId };
    await expect(updateTokenExpiry(token.id, input, signal(), vi.fn())).resolves.toEqual({ ...token, expiresAt });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/me/tokens/${token.id}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify(input), credentials: "same-origin", redirect: "error" }));
  });

  it.each(["missing", "different"])("keeps initial and reconciliation reads unconfirmed for %s response identity", async (identity) => {
    const changed = vi.fn(); install(response({ items: [] }, 200, identity === "missing" ? null : otherId));
    await expect(listTokens(signal(), userId, changed)).rejects.toMatchObject({ kind: "protocol" });
    expect(changed).toHaveBeenCalledTimes(identity === "missing" ? 0 : 1);
  });

  it("rejects an identity replacement during delayed reconciliation before publishing a missing-token result", async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn(); const pending = listTokens(signal(), userId, changed);
    finish(response({ items: [] }, 200, otherId));
    await expect(pending).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong-token metadata and changed response identity after an update", async () => {
    const fetcher = install(response({ ...token, id: otherId }));
    const input = { expiresAt: exact, expectedExpiresAt: null, expectedUserId: userId };
    await expect(updateTokenExpiry(token.id, input, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValue(response(token, 200, otherId));
    const changed = vi.fn(); await expect(updateTokenExpiry(token.id, input, signal(), changed)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("preserves sanitized conflict metadata and never retries the update", async () => {
    const fetcher = install(response({ error: { code: "version_conflict", message: "hidden-private-data", details: { secret: "hidden-private-data" }, requestId: "expiry-rq" } }, 409));
    const failure = await updateTokenExpiry(token.id, { expiresAt: exact, expectedExpiresAt: null, expectedUserId: userId }, signal(), vi.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, code: "version_conflict", requestId: "expiry-rq" });
    expect(JSON.stringify(failure)).not.toContain("hidden-private-data");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, malformed or nonnullable expiry fields rather than synthesizing defaults", async () => {
    const fetcher = install(response({ items: [{ ...token, expiresAt: undefined }] }));
    await expect(listTokens(signal(), userId, vi.fn())).rejects.toBeInstanceOf(ApiError);
    fetcher.mockResolvedValue(response({ items: [{ ...token, expiresAt: "bad" }] }));
    await expect(listTokens(signal(), userId, vi.fn())).rejects.toBeInstanceOf(ApiError);
    expect(() => createToken({ name: "CLI", expiresAt: "bad" }, signal())).toThrow(Error);
    expect(() => updateTokenExpiry(token.id, { expiresAt: null, expectedExpiresAt: "bad", expectedUserId: userId }, signal(), vi.fn())).toThrow(Error);
  });

  it("holds the update behind foreground identity checking and cancels it on account replacement", async () => {
    const fetcher = install(response(token)); pauseAuthRequests();
    const pending = updateTokenExpiry(token.id, { expiresAt: exact, expectedExpiresAt: null, expectedUserId: userId }, signal(), vi.fn());
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled(); invalidateAuthRequests(); await cancelled;
    expect(fetcher).not.toHaveBeenCalled();
  });
});
