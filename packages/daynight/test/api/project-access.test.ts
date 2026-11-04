import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, ProjectAccess, ProjectGrant } from "../../src/api/index.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = "2026-10-27T00:00:00Z";
const grant: ProjectGrant = { projectId, userId, role: "member", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const ownerTeam = { id: otherId, kind: "personal" as const, name: null };
const access: ProjectAccess = { projectId, ownerTeam, ownership: { teamId: otherId, version: 9_007_199_254_740_995n }, teamRole: "admin", canTransfer: true, effectiveRole: "admin", directGrant: grant };
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation();
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
};
const response = (value: unknown, principal: string | undefined = userId) => new Response(stringifyApiJson(value), {
  headers: { "Content-Type": "application/json", ...(principal === undefined ? {} : { "Daynight-User-ID": principal }) },
});
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("current project access", () => {
  it("reads the scoped access route without caching and preserves independent roles and an exact grant version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(access));
    await expect(api(fetch).getProjectAccess(projectId.toUpperCase())).resolves.toEqual(access);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(`http://localhost:8787/api/v1/projects/${projectId}/access`), expect.objectContaining({
      method: "GET", cache: "no-store", redirect: "manual",
      headers: expect.objectContaining({ Authorization: "Bearer fixture-token" }),
    }));
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Daynight-User-ID")).toBeNull();
  });

  it("accepts an explicitly absent direct grant without inventing a mutation version", async () => {
    const inherited: ProjectAccess = { ...access, teamRole: "member", canTransfer: false, effectiveRole: "member", directGrant: null };
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(inherited))).getProjectAccess(projectId)).resolves.toEqual(inherited);
  });

  it.each([
    null, [], {}, { ...access, ownerTeam: null }, { ...access, projectId: otherId },
    { ...access, ownership: { teamId: userId, version: 1n } }, { ...access, ownership: { teamId: otherId, version: 0 } },
    { ...access, canTransfer: false }, { ...access, teamRole: null, canTransfer: false, effectiveRole: "admin" },
    { ...access, ownerTeam: { ...ownerTeam, name: "Personal" } }, { ...access, ownerTeam: { ...ownerTeam, kind: "ordinary" } },
    { effectiveRole: "admin" }, { directGrant: grant }, { ...access, effectiveRole: "none" },
    { ...access, directGrant: undefined }, { ...access, directGrant: [] }, { ...access, extra: true },
    { ...access, directGrant: { ...grant, projectId: otherId } }, { ...access, directGrant: { ...grant, userId: otherId } },
    { ...access, directGrant: { ...grant, projectId: "invalid" } }, { ...access, directGrant: { ...grant, userId: userId.toUpperCase() } },
    { ...access, directGrant: { ...grant, role: "owner" } }, { ...access, directGrant: { ...grant, version: 0 } },
    { ...access, directGrant: { ...grant, version: "9007199254740993" } }, { ...access, directGrant: { ...grant, version: 1.5 } },
    { ...access, directGrant: { ...grant, version: 9_223_372_036_854_776_000 } },
    { ...access, directGrant: { ...grant, createdAt: "invalid" } }, { ...access, directGrant: { ...grant, updatedAt: undefined } },
    { ...access, directGrant: { ...grant, email: null } },
  ])("rejects malformed, unbound or profile-bearing access case %#", async (value) => {
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value))).getProjectAccess(projectId)).rejects.toMatchObject({
      operation: "project.access", phase: "protocol", outcomeUnconfirmed: false,
    });
  });

  it.each([undefined, "invalid", otherId, `${userId}, ${userId}`])("rejects successful access with principal %s", async (principal) => {
    const result = response(access);
    if (principal === undefined) result.headers.delete("Daynight-User-ID");
    else result.headers.set("Daynight-User-ID", principal);
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(result)).getProjectAccess(projectId)).rejects.toMatchObject({
      operation: "project.access", phase: "protocol", outcomeUnconfirmed: false,
    });
  });

  it("preserves current access refusal without falling back to the roster", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ error: {
      code: "not_found", message: "Project does not exist.", requestId: "access-refused",
    } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    await expect(api(fetch).getProjectAccess(projectId)).rejects.toMatchObject({
      operation: "project.access", phase: "response", status: 404, code: "not_found", confirmedRefusal: true, outcomeUnconfirmed: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
