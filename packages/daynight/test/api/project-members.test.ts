import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, ProjectGrant, ProjectParticipant } from "../../src/api/index.js";

const projectId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const time = "2026-10-27T00:00:00Z";
const grant: ProjectGrant = { projectId, userId, role: "member", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const participant: ProjectParticipant = { userId, profile: { name: null, email: null, avatarUrl: null }, effectiveRole: "admin", directGrant: grant };
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation();
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
};
const response = (value: unknown, principal = userId) => new Response(stringifyApiJson(value), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("project participants", () => {
  it("reads scoped participants through the existing route with independent roles and exact grant versions", async () => {
    const participants: readonly ProjectParticipant[] = [participant, {
      userId: otherId,
      profile: { name: "  Display name\n", email: "", avatarUrl: "https://example.test/avatar" },
      effectiveRole: "member",
      directGrant: { ...grant, userId: otherId, version: 9_223_372_036_854_775_807n },
    }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: participants }));
    await expect(api(fetch).listProjectMembers(projectId.toUpperCase())).resolves.toEqual(participants);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(`http://localhost:8787/api/v1/projects/${projectId}/members`), expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("keeps nullable profile fields and an explicitly absent grant without creating writable fields", async () => {
    const participants: readonly ProjectParticipant[] = [{ ...participant, directGrant: null }];
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: participants }))).listProjectMembers(projectId)).resolves.toEqual(participants);
  });

  it("accepts an empty complete roster", async () => {
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [] }))).listProjectMembers(projectId)).resolves.toEqual([]);
  });

  it.each([
    null, [], {}, { items: null }, { items: [], nextCursor: "partial" },
    { items: [participant], actorAccess: { effectiveRole: "admin", directGrant: grant } },
    { items: [participant, { ...participant, profile: { name: "Same user", email: null, avatarUrl: null } }] },
    { items: [{ ...participant, userId: "invalid" }] }, { items: [{ ...participant, userId: userId.toUpperCase() }] },
    { items: [{ ...participant, effectiveRole: "owner" }] }, { items: [{ ...participant, effectiveRole: undefined }] },
    { items: [{ ...participant, directGrant: undefined }] }, { items: [{ ...participant, extra: true }] },
    { items: [{ ...grant, name: null, email: null, avatarUrl: null }] },
    { items: [{ ...participant, role: "admin", version: 1 }] },
  ])("rejects obsolete, duplicate or incomplete roster evidence case %#", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
    await expect(api(fetch).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    null, undefined, [], {},
    { email: null, avatarUrl: null }, { name: null, avatarUrl: null }, { name: null, email: null },
    { name: 7, email: null, avatarUrl: null }, { name: null, email: false, avatarUrl: null },
    { name: null, email: null, avatarUrl: {} }, { name: null, email: null, avatarUrl: null, userId },
  ])("requires a complete nonnull profile object with nullable text fields case %#", async (profile) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [{ ...participant, profile }] }));
    await expect(api(fetch).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each([
    { ...grant, projectId: otherId }, { ...grant, userId: otherId }, { ...grant, role: "owner" },
    { ...grant, version: 0 }, { ...grant, version: "9007199254740993" }, { ...grant, version: 1.5 },
    { ...grant, version: 9_223_372_036_854_776_000 }, { ...grant, createdAt: "invalid" },
    { ...grant, updatedAt: undefined }, { ...grant, email: null },
  ])("rejects invalid grants or grants outside the requested participant scope case %#", async (directGrant) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [{ ...participant, directGrant }] }));
    await expect(api(fetch).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each([undefined, "invalid", otherId, `${userId}, ${userId}`])("rejects roster provenance %s before publishing participants", async (principal) => {
    const result = response({ items: [participant] });
    if (principal === undefined) result.headers.delete("Daynight-User-ID");
    else result.headers.set("Daynight-User-ID", principal);
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(result)).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
  });
});
