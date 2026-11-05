import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, TeamMember } from "../../src/api/index.js";

const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = "2026-11-04T00:00:00Z";
const member = (userId = actor): TeamMember => ({ teamId, userId, role: "admin", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time });
const profile = { name: null, email: null, avatarUrl: null };
const response = (value: unknown, principal = actor, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("Team member protocol", () => {
  it("reads the scoped directory with nullable profiles and precise relationship versions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [{ ...member(), profile }, { ...member(other), role: "member", profile: { ...profile, name: "Member" } }] }));
    const items = await client(fetch).listTeamMembers(actor, teamId);
    expect(items).toEqual([{ ...member(), profile }, { ...member(other), role: "member", profile: { ...profile, name: "Member" } }]);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/teams/${teamId}/members`);
    expect(fetch.mock.calls[0]![1]?.method).toBe("GET");
  });
  it.each([
    { items: [{ ...member(), profile }, { ...member(), profile }] },
    { items: [{ ...member(other), profile }] },
    { items: [{ ...member(), teamId: other, profile }] },
    { items: [{ ...member(), profile: { name: null, email: null } }] },
    { items: [{ ...member(), version: "9007199254740993", profile }] },
  ])("rejects malformed or inconsistent directories %#", async (body) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body))).listTeamMembers(actor, teamId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("sends observed membership version and expected identity and validates a self-demotion receipt", async () => {
    const updated = { ...member(), role: "member", version: 9_007_199_254_741_011n };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ membership: updated, actorRole: "member" }));
    expect(await client(fetch).setTeamMemberRole(actor, member(), "member", "request-id")).toEqual({ membership: updated, actorRole: "member" });
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/teams/${teamId}/members/${actor}`);
    expect(options?.method).toBe("PATCH");
    expect(options?.body).toBe('{"version":9007199254740993,"role":"member","expectedUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}');
    expect((options?.headers as Record<string, string>)["X-Request-ID"]).toBe("request-id");
  });
  it("accepts an unchanged role only with an unchanged membership version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ membership: member(other), actorRole: "admin" })).mockResolvedValueOnce(response({ membership: { ...member(other), version: member().version + 1n }, actorRole: "admin" }));
    const api = client(fetch);
    await expect(api.setTeamMemberRole(actor, member(other), "admin", "request-id")).resolves.toEqual({ membership: member(other), actorRole: "admin" });
    await expect(api.setTeamMemberRole(actor, member(other), "admin", "request-id")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it.each([
    { membership: { ...member(), role: "member", version: member().version + 1n }, actorRole: "admin" },
    { membership: { ...member(other), role: "member", version: member().version + 1n }, actorRole: "member" },
    { membership: { ...member(), role: "member", version: member().version }, actorRole: "member" },
  ])("rejects inconsistent role receipts %#", async (body) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body))).setTeamMemberRole(actor, member(), "member", "request-id")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("returns self-exit directly from its receipt, without a follow-up read", async () => {
    const receipt = { teamId, userId: actor, removed: true, actorRole: null };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    expect(await client(fetch).removeTeamMember(actor, member(), "request-id")).toEqual(receipt);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.method).toBe("DELETE");
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"version":9007199254740993,"expectedUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}');
  });
  it.each([
    { teamId, userId: actor, removed: true, actorRole: "admin" },
    { teamId, userId: other, removed: true, actorRole: null },
    { teamId, userId: actor, removed: false, actorRole: null },
  ])("rejects inconsistent removal receipts %#", async (body) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body))).removeTeamMember(actor, member(), "request-id")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("rejects another principal and never replays an unknown mutation", async () => {
    const changed = { ...member(), role: "member", version: member().version + 1n };
    const wrongPrincipal = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ membership: changed, actorRole: "member" }, other));
    await expect(client(wrongPrincipal).setTeamMemberRole(actor, member(), "member", "request-id")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(wrongPrincipal).toHaveBeenCalledOnce();
    const lost = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connection lost"));
    await expect(client(lost).removeTeamMember(actor, member(), "request-id")).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true });
    expect(lost).toHaveBeenCalledOnce();
  });
  it("preserves a confirmed identity mismatch refusal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "identity_mismatch", message: "identity changed", requestId: "request-id" } }, actor, 409));
    await expect(client(fetch).removeTeamMember(actor, member(), "request-id")).rejects.toMatchObject({ phase: "response", code: "identity_mismatch", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
