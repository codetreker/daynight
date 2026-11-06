import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvitation, createTeamInvitation, listInvitations, listTeamInvitations, revokeTeamInvitation } from "../src/api/auth";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";

const teamId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";
const otherId = "30000000-0000-4000-8000-000000000003";
const invitationId = "40000000-0000-4000-8000-000000000004";
const time = "2026-01-01T00:00:00Z";
const metadata = { id: invitationId, teamId, createdBy: userId, createdAt: time, expiresAt: time, consumedBy: null, consumedAt: null, revokedAt: null };
const secret = `dnteam_${"a".repeat(42)}A`;
const link = `${window.location.origin}/team-invitations#${secret}`;
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200, principal: string | null = userId) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const mock = (body: unknown, status = 200) => { const fetcher = vi.fn().mockResolvedValue(response(body, status)); vi.stubGlobal("fetch", fetcher); return fetcher; };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("scoped invitation management API", () => {
  it("lists metadata and binds creation and revocation to the current identity", async () => {
    const fetcher = mock({ items: [metadata] });
    const mismatch = vi.fn(), dispatch = vi.fn();
    expect(await listTeamInvitations(teamId.toUpperCase(), signal(), { userId, onPrincipalMismatch: mismatch })).toEqual([metadata]);
    fetcher.mockResolvedValueOnce(response({ ...metadata, link }, 201));
    expect(await createTeamInvitation(teamId, userId, signal(), mismatch, dispatch)).toEqual({ ...metadata, link });
    expect(fetcher.mock.calls[1]).toEqual([`/api/v1/teams/${teamId}/invitations`, expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUserId: userId }) })]);
    expect(dispatch).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(response({ teamId, invitationId, changed: false }));
    expect(await revokeTeamInvitation(teamId, invitationId, userId, signal(), mismatch, dispatch)).toEqual({ teamId, invitationId, changed: false });
    expect(fetcher.mock.calls[2]).toEqual([`/api/v1/teams/${teamId}/invitations/${invitationId}`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedUserId: userId }) })]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { items: [{ ...metadata, link }] }, { items: [{ ...metadata, teamId: otherId }] },
    { items: [metadata, metadata] }, { items: [{ ...metadata, consumedBy: userId }] },
    { items: [], link },
  ])("rejects malformed or secret-bearing lists %#", async (body) => {
    mock(body);
    await expect(listTeamInvitations(teamId, signal(), { userId, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: "protocol" });
  });

  it.each([
    { ...metadata, createdBy: otherId, link }, { ...metadata, teamId: otherId, link },
    { ...metadata, link: `https://example.com/team-invitations#dnteam_secret` },
    { ...metadata, link: `${window.location.origin}/invitations#dnteam_secret` },
    { ...metadata, link: `${link}?query`, extra: "unexpected" },
    { ...metadata, link, revokedAt: time },
  ])("rejects unsafe or inconsistent creation results %#", async (body) => {
    mock(body, 201);
    const failure = await createTeamInvitation(teamId, userId, signal(), vi.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "protocol" });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(secret);
  });

  it.each([
    "dninvite_" + "a".repeat(42) + "A",
    "dnteam_" + "a".repeat(41) + "A",
    "dnteam_" + "a".repeat(42) + "B",
    "dnteam_" + "a".repeat(42) + "A=",
    "dnteam_" + "a".repeat(41) + "+A",
    "dnteam_" + "a".repeat(42) + "%41",
  ])("rejects malformed or noncanonical secret fragments without retaining them %#", async (fragment) => {
    mock({ ...metadata, link: `${window.location.origin}/team-invitations#${fragment}` }, 201);
    const failure = await createTeamInvitation(teamId, userId, signal(), vi.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "protocol", status: 201 });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(fragment);
  });

  it("rejects mismatched receipts and principals without replay, and sanitizes secret causes", async () => {
    const fetcher = mock({ teamId, invitationId: otherId, changed: true });
    const mismatch = vi.fn();
    await expect(revokeTeamInvitation(teamId, invitationId, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValueOnce(response({ ...metadata, link }, 201, otherId));
    await expect(createTeamInvitation(teamId, userId, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
    fetcher.mockRejectedValueOnce(new Error("dnteam_secret"));
    const failure = await createTeamInvitation(teamId, userId, signal(), mismatch).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "network" });
    expect(failure).not.toHaveProperty("cause");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports an identity mismatch denial without replaying the write", async () => {
    const fetcher = mock({ error: { code: "identity_mismatch", message: "private", requestId: "request-1" } }, 409);
    const mismatch = vi.fn();
    await expect(revokeTeamInvitation(teamId, invitationId, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "server", status: 409, code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("marks dispatch only after identity waits, including Project creation", async () => {
    const fetcher = mock({ ...metadata, link }, 201);
    const release = pauseAuthRequests(), dispatch = vi.fn();
    const operation = createTeamInvitation(teamId, userId, signal(), vi.fn(), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    release();
    await operation;
    expect(dispatch).toHaveBeenCalledOnce();
    const projectMetadata = { ...metadata, projectId: teamId, link: `${window.location.origin}/invitations#dninvite_secret` };
    const { teamId: _teamId, ...project } = projectMetadata;
    fetcher.mockResolvedValueOnce(response(project, 201));
    await createInvitation(teamId, userId, signal(), vi.fn(), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects a project list that attempts to return the secret", async () => {
    const { teamId: _teamId, ...common } = metadata;
    mock({ items: [{ ...common, projectId: teamId, link }] });
    await expect(listInvitations(teamId, signal(), { userId, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: "protocol" });
  });

  it("does not retain secret-bearing malformed JSON in either scope's error cause", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(`{"link":"${secret}",broken`, {
      status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId },
    })));
    vi.stubGlobal("fetch", fetcher);
    for (const create of [createTeamInvitation, createInvitation]) {
      const failure = await create(teamId, userId, signal(), vi.fn()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: "protocol", status: 201 });
      expect(failure).not.toHaveProperty("cause");
      expect(String(failure)).not.toContain(secret);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
