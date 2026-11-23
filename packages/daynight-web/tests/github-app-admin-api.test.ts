import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { acceptGitHubAppAdminInvitation, createGitHubAppAdminInvitation, inspectGitHubAppAdminInvitation, listGitHubAppAdminInvitations, listGitHubAppAdmins, removeGitHubAppAdmin, revokeGitHubAppAdminInvitation } from "../src/api/github-app-admin";
import { wireResponse } from "./helpers/wireJson";

const app = "00000000-0000-4000-8000-000000000001", actor = "00000000-0000-4000-8000-000000000002", other = "00000000-0000-4000-8000-000000000003", invitationId = "00000000-0000-4000-8000-000000000004";
const version = "9007199254740993", stamp = "2026-11-16T10:00:00Z", expiry = "2026-11-23T10:00:00Z", token = `dn_gai_${"A".repeat(43)}`;
const member = { appId: app, userId: actor, membershipVersion: version, createdAt: stamp, updatedAt: stamp };
const administrator = { ...member, profile: { name: "Alice", email: null, avatarUrl: null } };
const invite = { id: invitationId, appId: app, createdBy: actor, issuerMembershipVersion: version, createdAt: stamp, expiresAt: expiry, revokedAt: null, consumedAt: null, consumedBy: null, available: true };
const identity = { id: app, githubAppId: version, name: "App", githubName: "GitHub App", githubSlug: "app" };
const link = () => `${window.location.origin}/github-app-admin-invitations#${token}`;
const wire = (body: unknown, status = 200, principal = actor) => wireResponse(body, { status, headers: { "Daynight-User-ID": principal } });
const admission = () => ({ userId: actor, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
const signal = () => new AbortController().signal;
beforeEach(() => invalidateAuthRequests());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub App administrator API", () => {
  it("reads bounded administrator and invitation pages with exact versions and no secret", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ items: [administrator], nextCursor: "more" })).mockResolvedValueOnce(wire({ items: [invite], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    expect(await listGitHubAppAdmins(app, null, signal(), admission())).toEqual({ items: [administrator], nextCursor: "more" });
    expect(await listGitHubAppAdminInvitations(app, "cursor", signal(), admission())).toEqual({ items: [invite], nextCursor: null });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`/api/v1/github/apps/${app}/admins?limit=50`, `/api/v1/github/apps/${app}/admin-invitations?limit=50&cursor=cursor`]);
    expect(() => listGitHubAppAdmins(app, "", signal(), admission())).toThrow();
  });
  it("rejects duplicated, cross-App, imprecise, inconsistent and leaked page entries", async () => {
    const bad = [
      { items: [administrator, administrator], nextCursor: null },
      { items: [{ ...administrator, appId: other }], nextCursor: null },
      { items: [{ ...administrator, membershipVersion: "9007199254740993x" }], nextCursor: null },
    ];
    const fetcher = vi.fn(); bad.forEach(item => fetcher.mockResolvedValueOnce(wire(item)));
    fetcher.mockResolvedValueOnce(wire({ items: [{ ...invite, link: link() }], nextCursor: null })).mockResolvedValueOnce(wire({ items: [{ ...invite, consumedBy: actor }], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    for (const _ of bad) await expect(listGitHubAppAdmins(app, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
    await expect(listGitHubAppAdminInvitations(app, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
    await expect(listGitHubAppAdminInvitations(app, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("returns the one-time link only from a valid creation receipt", async () => {
    const created = { ...invite, link: link() }, fetcher = vi.fn().mockResolvedValueOnce(wire(created, 201)).mockResolvedValueOnce(wire({ ...created, link: `https://elsewhere.test/github-app-admin-invitations#${token}` }, 201)).mockResolvedValueOnce(wire({ ...created, createdBy: other }, 201));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await createGitHubAppAdminInvitation(app, signal(), access)).toEqual(created);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ expectedUserId: actor });
    await expect(createGitHubAppAdminInvitation(app, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(createGitHubAppAdminInvitation(app, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(access.onDispatch).toHaveBeenCalledTimes(3);
  });
  it("validates exact member versions and self-removal receipt without a follow-up read", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ appId: app, userId: actor, removed: true, actorIsAdmin: false })).mockResolvedValueOnce(wire({ appId: app, userId: other, removed: true, actorIsAdmin: false }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await removeGitHubAppAdmin(app, actor, version, signal(), access)).toEqual({ appId: app, userId: actor, removed: true, actorIsAdmin: false });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ membershipVersion: version, expectedUserId: actor });
    await expect(removeGitHubAppAdmin(app, other, version, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(() => removeGitHubAppAdmin(app, other, "9223372036854775808", signal(), access)).toThrow();
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("distinguishes confirmed, refused and unknown revocation without replay", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ appId: app, invitationId, changed: false })).mockResolvedValueOnce(wire({ error: { code: "last_admin", message: "last", requestId: "x" } }, 409)).mockResolvedValueOnce(wire({ error: { code: "github_write_outcome_unknown", message: "unknown", requestId: "x" } }, 503));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await revokeGitHubAppAdminInvitation(app, invitationId, signal(), access)).toEqual({ appId: app, invitationId, changed: false });
    await expect(removeGitHubAppAdmin(app, actor, version, signal(), access)).rejects.toMatchObject({ code: "last_admin", status: 409 });
    await expect(revokeGitHubAppAdminInvitation(app, invitationId, signal(), access)).rejects.toMatchObject({ code: "github_write_outcome_unknown", status: 503 });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("inspects and accepts only the confirmed App and current account", async () => {
    const inspection = { app: identity, expiresAt: expiry, membership: member }, acceptance = { appId: app, membership: member, joined: false };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(inspection)).mockResolvedValueOnce(wire(acceptance)).mockResolvedValueOnce(wire({ ...acceptance, appId: other })).mockResolvedValueOnce(wire({ ...inspection, membership: { ...member, userId: other } }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await inspectGitHubAppAdminInvitation(token, signal(), access)).toEqual(inspection);
    expect(await acceptGitHubAppAdminInvitation(token, app, signal(), access)).toEqual(acceptance);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ token });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ token, expectedUserId: actor });
    await expect(acceptGitHubAppAdminInvitation(token, app, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(inspectGitHubAppAdminInvitation(token, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it("preserves unavailable invitation and mismatched principal results", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ error: { code: "invitation_unavailable", message: "unavailable", requestId: "x" } }, 404)).mockResolvedValueOnce(wire({ app: identity, expiresAt: expiry, membership: null }, 200, other));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    await expect(inspectGitHubAppAdminInvitation("bad", signal(), access)).rejects.toMatchObject({ kind: "server", status: 404, code: "invitation_unavailable" });
    await expect(inspectGitHubAppAdminInvitation(token, signal(), access)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(access.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it("starts write timeout after identity admission and never replays", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal("fetch", fetcher); const resume = pauseAuthRequests(), access = admission();
    const pending = createGitHubAppAdminInvitation(app, signal(), access), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(20_000); await rejected; expect(fetcher).toHaveBeenCalledOnce(); expect(access.onDispatch).toHaveBeenCalledOnce();
  });
});
