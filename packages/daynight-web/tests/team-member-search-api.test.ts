import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests } from "../src/api/client";
import { addExistingTeamMember, searchTeamMemberCandidates } from "../src/api/team-member-search";

const actor = "00000000-0000-4000-8000-000000000001";
const team = "00000000-0000-4000-8000-000000000002";
const target = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const time = "2026-10-20T09:00:00Z";
const profile = { name: null, email: "person@example.com", avatarUrl: null };
const signal = () => new AbortController().signal;
const response = (body: string, status = 200, principal = actor) => new Response(body, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const page = (overrides = {}) => JSON.stringify({ items: [{ userId: target, profile }], nextCursor: "next", actorRole: "admin", ...overrides });
const receipt = (role = "member", added = true, userId = target, teamId = team) => `{"membership":{"teamId":"${teamId}","userId":"${userId}","role":"${role}","version":9223372036854775807,"createdAt":"${time}","updatedAt":"${time}","profile":${JSON.stringify(profile)}},"added":${added},"actorRole":"admin"}`;
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("Team member search", () => {
  it("sends the query and cursor to the scoped search with the expected identity", async () => {
    const fetch = vi.fn().mockResolvedValue(response(page())); vi.stubGlobal("fetch", fetch);
    const result = await searchTeamMemberCandidates(team, actor, " Chen ", "opaque", signal(), vi.fn());
    expect(result).toEqual({ items: [{ userId: target, profile }], nextCursor: "next", actorRole: "admin" });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/teams/${team}/member-candidates/search`);
    expect(fetch.mock.calls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedUserId: actor, query: " Chen ", limit: 20, cursor: "opaque" });
  });

  it("rejects malformed candidate pages and mismatched principals", async () => {
    for (const body of [page({ items: [{ userId: target, profile }, { userId: target, profile }] }), page({ items: [{ userId: target, profile: { ...profile, email: 3 } }] }), page({ items: [{ userId: target, profile: { name: null, email: null } }] }), page({ nextCursor: "" }), page({ nextCursor: "x".repeat(2049) }), page({ actorRole: "member" }), page({ extra: true })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(searchTeamMemberCandidates(team, actor, "a", null, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
    const mismatch = vi.fn(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(page(), 200, other)));
    await expect(searchTeamMemberCandidates(team, actor, "a", null, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
  });

  it("preserves real search errors and rejects invalid input before dispatch", async () => {
    const fetch = vi.fn().mockResolvedValue(response('{"error":{"code":"not_found","message":"missing route","requestId":"r"}}', 404)); vi.stubGlobal("fetch", fetch);
    await expect(searchTeamMemberCandidates(team, actor, "a", null, signal(), vi.fn())).rejects.toMatchObject({ kind: "server", code: "not_found" });
    for (const query of ["\0", "\ud800", "x".repeat(1025)]) expect(() => searchTeamMemberCandidates(team, actor, query, null, signal(), vi.fn())).toThrow();
    expect(() => searchTeamMemberCandidates(team, actor, "a", "", signal(), vi.fn())).toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("adding an existing Team member", () => {
  it("installs exact returned data and preserves an existing admin role", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(receipt())).mockResolvedValueOnce(response(receipt("admin", false))); vi.stubGlobal("fetch", fetch);
    const dispatch = vi.fn();
    const first = await addExistingTeamMember(actor, team, target, signal(), vi.fn(), dispatch);
    expect(first).toMatchObject({ added: true, actorRole: "admin", membership: { teamId: team, userId: target, role: "member", profile, version: 9223372036854775807n } });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/teams/${team}/members/${target}`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedUserId: actor });
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await addExistingTeamMember(actor, team, target, signal(), vi.fn(), vi.fn())).membership.role).toBe("admin");
  });

  it("rejects inconsistent receipts and never retries a lost response", async () => {
    for (const body of [receipt("admin", true), receipt("member", true, other), receipt("member", true, target, other), receipt().replace('"actorRole":"admin"', '"actorRole":"member"'), receipt().replace('"version":9223372036854775807', '"version":0'), receipt().replace('"name":null', '"name":1')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(addExistingTeamMember(actor, team, target, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
    const dispatch = vi.fn(), fetch = vi.fn().mockRejectedValue(new TypeError("lost response")); vi.stubGlobal("fetch", fetch);
    await expect(addExistingTeamMember(actor, team, target, signal(), vi.fn(), dispatch)).rejects.toMatchObject({ kind: "network" });
    expect(dispatch).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("distinguishes a missing target and reports identity mismatches", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response('{"error":{"code":"user_not_found","message":"missing","requestId":"r"}}', 404)).mockResolvedValueOnce(response('{"error":{"code":"identity_mismatch","message":"changed","requestId":"r"}}', 409)); vi.stubGlobal("fetch", fetch);
    const mismatch = vi.fn();
    await expect(addExistingTeamMember(actor, team, target, signal(), mismatch, vi.fn())).rejects.toMatchObject({ code: "user_not_found" });
    await expect(addExistingTeamMember(actor, team, target, signal(), mismatch, vi.fn())).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
