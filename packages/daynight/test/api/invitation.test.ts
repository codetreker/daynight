import { afterEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const target = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-11-04T00:00:00Z";
const projectToken = `dninvite_${Buffer.alloc(32, 1).toString("base64url")}`;
const teamToken = `dnteam_${Buffer.alloc(32, 2).toString("base64url")}`;
const grant = { projectId: target, userId: user, role: "member", version: 9223372036854775807n, createdAt: time, updatedAt: time };
const team = { id: target, kind: "ordinary", name: "Team" };
const member = { teamId: target, userId: user, role: "member", version: 9007199254740993n, createdAt: time, updatedAt: time };
const access = { projectId: target, ownerTeam: { id: other, kind: "ordinary", name: "Owner" }, ownership: { teamId: other, version: 1n }, effectiveRole: "admin", teamRole: "admin", directGrant: grant, canTransfer: true };
const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
const response = (data: unknown, principal: string | null = user, status = 200) => new Response(stringifyApiJson(data), { status, headers: { "content-type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
afterEach(() => operations.splice(0).forEach((operation) => operation.dispose()));

describe("invitation API", () => {
  it("inspects both scopes and accepts only the confirmed target and current user", async () => {
    const projectInspection = { projectId: target, projectName: "Project", directGrant: null, access: { ...access, directGrant: null } };
    const projectAcceptance = { projectId: target, directGrant: grant, access, joined: true, consumed: true };
    const teamInspection = { team, membership: null };
    const teamAcceptance = { team, membership: member, joined: true, consumed: true };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(projectInspection)).mockResolvedValueOnce(response(projectAcceptance)).mockResolvedValueOnce(response(teamInspection)).mockResolvedValueOnce(response(teamAcceptance));
    const api = client(fetch);
    expect(await api.inspectInvitation("project", projectToken, user)).toEqual(projectInspection);
    expect(await api.acceptInvitation("project", projectToken, user, target, request)).toEqual(projectAcceptance);
    expect(await api.inspectInvitation("team", teamToken, user)).toEqual(teamInspection);
    expect(await api.acceptInvitation("team", teamToken, user, target, request)).toEqual(teamAcceptance);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/invitations/inspect", "/api/v1/invitations/accept", "/api/v1/team-invitations/inspect", "/api/v1/team-invitations/accept"]);
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([{ token: projectToken }, { token: projectToken, expectedUserId: user }, { token: teamToken }, { token: teamToken, expectedUserId: user }]);
  });
  it("preserves existing membership and refuses mismatched principal, target and inconsistent receipts", async () => {
    const existing = { team, membership: { ...member, role: "admin" }, joined: false, consumed: false };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(existing)).mockResolvedValueOnce(response(existing, other)).mockResolvedValueOnce(response({ ...existing, team: { ...team, id: other }, membership: { ...member, teamId: other } })).mockResolvedValueOnce(response({ ...existing, consumed: true }));
    const api = client(fetch);
    expect(await api.acceptInvitation("team", teamToken, user, target, request)).toEqual(existing);
    for (let i = 0; i < 3; i++) await expect(api.acceptInvitation("team", teamToken, user, target, request)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("retains safe refusal and unknown classifications without replay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ error: { code: "identity_mismatch", message: teamToken, requestId: teamToken, details: { taskIds: [user] } } }, user, 409)).mockRejectedValueOnce(new Error(teamToken));
    const api = client(fetch);
    const refusal = await api.acceptInvitation("team", teamToken, user, target, request).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "identity_mismatch", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(inspect(refusal, { depth: 20 })).not.toContain(teamToken);
    const unknown = await api.acceptInvitation("team", teamToken, user, target, request).catch((error: unknown) => error);
    expect(unknown).toMatchObject({ outcomeUnconfirmed: true });
    expect(inspect(unknown, { depth: 20 })).not.toContain(teamToken);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("recognizes the service's identity mismatch refusal from the actual principal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ error: { code: "identity_mismatch", message: "identity changed", requestId: request } }, other, 409))
      .mockResolvedValueOnce(response({ error: { code: "invitation_unavailable", message: "unavailable", requestId: request } }, other, 409));
    const api = client(fetch);
    await expect(api.acceptInvitation("team", teamToken, user, target, request)).rejects.toMatchObject({ phase: "response", code: "identity_mismatch", confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.acceptInvitation("team", teamToken, user, target, request)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires a matching principal on other refusals and preserves unavailable invitations", async () => {
    const unavailable = { error: { code: "invitation_unavailable", message: "unavailable", requestId: request } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(unavailable, user, 404)).mockResolvedValueOnce(response(unavailable, null, 404)).mockResolvedValueOnce(response(unavailable, other, 404));
    const api = client(fetch);
    await expect(api.acceptInvitation("project", projectToken, user, target, request)).rejects.toMatchObject({ code: "invitation_unavailable", confirmedRefusal: true, outcomeUnconfirmed: false });
    for (let i = 0; i < 2; i++) await expect(api.acceptInvitation("project", projectToken, user, target, request)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("preserves an existing direct Project grant without consumption", async () => {
    const existing = { ...grant, role: "admin" };
    const receipt = { projectId: target, directGrant: existing, access: { ...access, directGrant: existing }, joined: false, consumed: false };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    expect(await client(fetch).acceptInvitation("project", projectToken, user, target, request)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects leaked success data and malformed JSON without retaining the secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ team: { ...team, name: teamToken }, membership: null })).mockResolvedValueOnce(new Response(`{\"${teamToken}\":`, { headers: { "content-type": "application/json", "Daynight-User-ID": user } }));
    const api = client(fetch);
    for (let i = 0; i < 2; i++) {
      const error = await api.inspectInvitation("team", teamToken, user).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
      expect(inspect(error, { depth: 20 })).not.toContain(teamToken);
    }
  });
  it("withholds secret-bearing stream read, cancellation and release errors", async () => {
    const body = { getReader: () => ({ closed: Promise.resolve(), read: async () => { throw new Error(teamToken); }, cancel: async () => { throw new Error(teamToken); }, releaseLock: () => { throw new Error(teamToken); } }) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({ status: 200, headers: new Headers({ "content-type": "application/json", "Daynight-User-ID": user }), body } as unknown as Response);
    const error = await client(fetch).acceptInvitation("team", teamToken, user, target, request).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ outcomeUnconfirmed: true });
    expect(inspect(error, { depth: 20 })).not.toContain(teamToken);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
