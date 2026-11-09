import { expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const teamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-10-27T00:00:00Z";
const ownerTeam = { id: teamId, kind: "ordinary", name: "Owner" };
const ownership = { teamId, version: 2n };
const grant = (role: "admin" | "member") => ({ projectId, userId, role, version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time });

it.each([
  { name: "canonical profile", direct: "admin", team: "admin", profile: { name: "User", email: "user@example.test", avatarUrl: "https://example.test/avatar" } },
  { name: "nullable profile", direct: "admin", team: "admin", profile: { name: null, email: null, avatarUrl: null } },
  { name: "direct only", direct: "admin", team: null, profile: { name: "User", email: "user@example.test", avatarUrl: null } },
  { name: "inherited only", direct: null, team: "admin", profile: { name: "User", email: "user@example.test", avatarUrl: null } },
  { name: "mixed roles", direct: "member", team: "admin", profile: { name: "User", email: "user@example.test", avatarUrl: null } },
] as const)("keeps participant and actor access evidence for $name", async ({ direct, team, profile }) => {
  const directGrant = direct === null ? null : grant(direct);
  const inheritedFrom = team === null ? null : { team: ownerTeam, role: team };
  const current = { userId, profile, effectiveRole: "admin", inheritedFrom, directGrant };
  const other = { userId: otherId, profile: { name: null, email: null, avatarUrl: null }, effectiveRole: "admin", inheritedFrom: { team: ownerTeam, role: "admin" }, directGrant: null };
  const items = team === null ? [current, other] : [current];
  const actorAccess = { projectId, ownerTeam, ownership, effectiveRole: "admin", teamRole: team, directGrant, canTransfer: team === "admin" };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ actorAccess, items }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  const operation = createOperation();
  try {
    const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
    expect(await api.listProjectMembers(projectId)).toEqual(items);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/projects/${projectId}/members`);
    expect(init!.method).toBe("GET");
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer fixture-token");
  } finally { operation.dispose(); }
});
