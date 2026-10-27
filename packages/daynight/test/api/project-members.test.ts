import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, ProjectMember } from "../../src/api/index.js";

const projectId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const time = "2026-10-27T00:00:00Z";
const member: ProjectMember = { projectId, userId, email: null, name: null, avatarUrl: null, role: "admin", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation();
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
};
const response = (value: unknown, principal = userId) => new Response(stringifyApiJson(value), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("project membership authorization input", () => {
  it("reads actual roles from the existing member route with exact versions and current principal", async () => {
    const members = [member, { ...member, userId: otherId, role: "member" }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: members }));
    await expect(api(fetch).listProjectMembers(projectId.toUpperCase())).resolves.toEqual(members);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(`http://localhost:8787/api/v1/projects/${projectId}/members`), expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it.each([
    {}, { items: null }, { items: [member, member] }, { items: [{ ...member, projectId: otherId }] },
    { items: [{ ...member, role: "owner" }] }, { items: [{ ...member, userId: "invalid" }] },
    { items: [{ ...member, version: 0 }] }, { items: [{ ...member, role: undefined }] },
    { items: [{ ...member, extra: true }] }, { items: [], nextCursor: "partial" },
  ])("rejects malformed, duplicate or incomplete membership evidence case %#", async (value) => {
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value))).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
  });

  it("rejects membership evidence from a changed authenticated account", async () => {
    await expect(api(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [member] }, otherId))).listProjectMembers(projectId)).rejects.toMatchObject({ operation: "project.members", phase: "protocol", outcomeUnconfirmed: false });
  });
});
