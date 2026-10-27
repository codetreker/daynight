import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, User } from "../../src/api/index.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user: User = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null };
const operations: Operation[] = [];
const response = (value: unknown, principal?: string): Response => new Response(stringifyApiJson(value), {
  headers: { "Content-Type": "application/json", ...(principal === undefined ? {} : { "Daynight-User-ID": principal }) },
});
const client = (fetch: typeof globalThis.fetch, expectedUserId?: string) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch, ...(expectedUserId === undefined ? {} : { expectedUserId }) });
};
afterEach(() => { for (const operation of operations.splice(0)) operation.dispose(); });

describe("authenticated API identity", () => {
  it("reads the existing current-user DTO with the frozen Bearer and no cache", async () => {
    const value = { ...user, email: "account@example.test", emailVerified: true, name: "Account", avatarUrl: "https://example.test/avatar" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value, userId));
    await expect(client(fetch, userId.toUpperCase()).getCurrentUser()).resolves.toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8787/api/v1/me");
    expect(options).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store", headers: { Accept: "application/json", Authorization: "Bearer fixture-token" } });
    expect(new Headers(options!.headers).get("Daynight-User-ID")).toBeNull();
  });

  it("keeps principal validation opt-in for existing callers", async () => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(user))).getCurrentUser()).resolves.toEqual(user);
  });

  it.each([
    null, [], { id: userId }, { ...user, id: "invalid" }, { ...user, id: userId.toUpperCase() },
    { ...user, email: 42 }, { ...user, emailVerified: "true" }, { ...user, name: false },
    { ...user, avatarUrl: {} }, { ...user, extra: "unexpected" },
  ])("refuses a malformed or incomplete current-user DTO %j", async (value) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value))).getCurrentUser()).rejects.toMatchObject({ operation: "auth.me", phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each([undefined, "invalid", otherId, `${userId}, ${userId}`])("rejects successful identity provenance %s", async (principal) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(user, principal)), userId).getCurrentUser()).rejects.toMatchObject({ operation: "auth.me", phase: "protocol", outcomeUnconfirmed: false });
  });

  it("rejects empty inventory pages from another authenticated principal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [], nextCursor: null }, otherId));
    await expect(client(fetch, userId).listTaskPage(userId, { workerId: otherId, limit: 100 })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it("rejects an empty mutation success with unconfirmed identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204, headers: { "Daynight-User-ID": otherId } }));
    await expect(client(fetch, userId).removeTaskAttachment(userId, otherId, "evidence.txt")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks identity before exposing binary response bytes to a consumer", async () => {
    const consume = vi.fn(async () => {});
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/octet-stream", "Daynight-User-ID": otherId } }));
    await expect(client(fetch, userId).readTaskAttachment(userId, otherId, "evidence.bin", consume)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(consume).not.toHaveBeenCalled();
  });

  it("preserves confirmed service refusal when an unsuccessful response has no identity header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ error: { code: "version_conflict", message: "Changed.", requestId: "identity-test" } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(client(fetch, userId).updateWorkerClaim(userId, otherId, { version: 1n, claimId: userId, phase: "waiting" })).rejects.toMatchObject({ phase: "response", status: 409, code: "version_conflict", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates an expected user before dispatch without exposing credentials in errors", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch, "invalid")).toThrow("Resource ID must be a hyphenated UUID");
    expect(fetch).not.toHaveBeenCalled();
    try { client(fetch, "invalid"); }
    catch (error) { expect(String(error)).not.toContain("fixture-token"); }
  });
});
