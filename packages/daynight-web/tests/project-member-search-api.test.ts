import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests } from "../src/api/client";
import { addExistingProjectMember, searchProjectMemberCandidates } from "../src/api/project-member-search";
import { directAccessFixture } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const actor = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const target = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const time = "2026-10-20T09:00:00Z";
const profile = { name: null, email: "person@example.com", avatarUrl: null };
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, principal: string | null = actor) => new Response(stringifyWireJson(value), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const access = () => ({ ...directAccessFixture(project, actor, "admin"), ownership: { teamId: "00000000-0000-4000-8000-000000000701", version: 9223372036854775807n } });
const grant = () => ({ projectId: project, userId: target, role: "member", version: 9007199254740993n, createdAt: time, updatedAt: time });
const participant = () => ({ userId: target, profile, effectiveRole: "member", directGrant: grant(), inheritedFrom: null });
const receipt = () => ({ added: true, participant: participant(), actorAccess: access() });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("project member search and addition API", () => {
  it("sends the scoped candidate request and verifies the returned identity", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ items: [{ userId: target, profile }], nextCursor: "next", actorRole: "admin" })); vi.stubGlobal("fetch", fetch);
    expect(await searchProjectMemberCandidates(project, actor, " Chen ", "opaque", signal(), vi.fn())).toEqual({ items: [{ userId: target, profile }], nextCursor: "next", actorRole: "admin" });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${project}/member-candidates/search`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedUserId: actor, query: " Chen ", limit: 20, cursor: "opaque" });
    const mismatch = vi.fn(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [], nextCursor: null, actorRole: "admin" }, 200, other)));
    await expect(searchProjectMemberCandidates(project, actor, "a", null, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
  });

  it("sends only the expected actor and retains exact participant and ownership versions", async () => {
    const fetch = vi.fn().mockResolvedValue(response(receipt())); vi.stubGlobal("fetch", fetch);
    const dispatch = vi.fn();
    const result = await addExistingProjectMember(actor, project, target, signal(), vi.fn(), dispatch);
    expect(result.participant.directGrant?.version).toBe(9007199254740993n);
    expect(result.actorAccess.ownership.version).toBe(9223372036854775807n);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${project}/members/${target}`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedUserId: actor });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("accepts an existing inherited administrator without creating or changing a grant", async () => {
    const inherited = { team: access().ownerTeam, role: "admin" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...receipt(), added: false, participant: { ...participant(), directGrant: null, inheritedFrom: inherited, effectiveRole: "admin" } })));
    const result = await addExistingProjectMember(actor, project, target, signal(), vi.fn(), vi.fn());
    expect(result).toMatchObject({ added: false, participant: { effectiveRole: "admin", directGrant: null, inheritedFrom: inherited } });
  });

  it("rejects inconsistent targets, projects, sources, roles and malformed responses", async () => {
    const base = receipt();
    const cases = [
      { ...base, participant: { ...participant(), userId: other } },
      { ...base, participant: { ...participant(), directGrant: { ...grant(), projectId: other } } },
      { ...base, participant: { ...participant(), directGrant: { ...grant(), userId: other } } },
      { ...base, participant: { ...participant(), inheritedFrom: { team: { ...access().ownerTeam, id: other }, role: "member" } } },
      { ...base, participant: { ...participant(), effectiveRole: "admin" } },
      { ...base, participant: { ...participant(), directGrant: { ...grant(), role: "admin" }, effectiveRole: "admin" } },
      { ...base, actorAccess: directAccessFixture(project, actor, "member") },
      { ...base, actorAccess: directAccessFixture(project, other, "admin") },
      { ...base, actorAccess: directAccessFixture(other, actor, "admin") },
      { ...base, added: "true" }, { ...base, extra: true },
    ];
    for (const body of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(addExistingProjectMember(actor, project, target, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(base, 200, null)));
    await expect(addExistingProjectMember(actor, project, target, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });

  it("reports a definite refusal and never replays a lost write response", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: { code: "user_not_found", message: "missing", requestId: "r" } }, 404)).mockRejectedValueOnce(new TypeError("lost response")); vi.stubGlobal("fetch", fetch);
    const dispatch = vi.fn();
    await expect(addExistingProjectMember(actor, project, target, signal(), vi.fn(), dispatch)).rejects.toMatchObject({ kind: "server", code: "user_not_found" });
    await expect(addExistingProjectMember(actor, project, target, signal(), vi.fn(), dispatch)).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
