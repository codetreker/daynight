import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { createGitHubAppGrant, getGitHubAppGrant, getGitHubAppGrantImpact, listGitHubAppGrantImpactProjects, listGitHubAppGrants, previewGitHubAppGrant, revokeGitHubAppGrant } from "../src/api/github-app-grants";
import { wireResponse } from "./helpers/wireJson";

const app = "00000000-0000-4000-8000-000000000001", actor = "00000000-0000-4000-8000-000000000002", teamId = "00000000-0000-4000-8000-000000000003", grantId = "00000000-0000-4000-8000-000000000004", projectId = "00000000-0000-4000-8000-000000000005";
const version = "9007199254740993", impactVersion = "9007199254740994", time = "2026-11-16T10:00:00Z";
const team = { id: teamId, kind: "personal", name: null, version, personalOwner: { userId: actor, name: "Alice" } };
const grant = { id: grantId, appId: app, team, createdAt: time };
const preview = { appId: app, version, targetTeam: team, grant: null };
const impact = { appId: app, grantId, version, impactVersion, totalProjects: "2", visibleProjects: "1", hiddenProjects: "1", teams: [{ team: { id: teamId, kind: "personal", name: null }, projects: "2" }], nextCursor: null };
const wire = (body: unknown, status = 200, principal = actor) => wireResponse(body, { status, headers: { "Daynight-User-ID": principal } });
const admission = () => ({ userId: actor, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
const signal = () => new AbortController().signal;
beforeEach(() => invalidateAuthRequests());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub App Team grants API", () => {
  it("reads bounded grants with exact Team projection and minimal owner identity", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ items: [grant], nextCursor: "more" })).mockResolvedValueOnce(wire(grant));
    vi.stubGlobal("fetch", fetcher);
    expect(await listGitHubAppGrants(app, null, signal(), admission())).toEqual({ items: [grant], nextCursor: "more" });
    expect(await getGitHubAppGrant(app, grantId, signal(), admission())).toEqual(grant);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`/api/v1/github/apps/${app}/team-grants?limit=50`, `/api/v1/github/apps/${app}/team-grants/${grantId}`]);
    expect(() => listGitHubAppGrants(app, "", signal(), admission())).toThrow();
  });
  it("rejects duplicate identities, cross-App grants and disclosed Personal Team names", async () => {
    const bad = [{ items: [grant, grant], nextCursor: null }, { items: [{ ...grant, appId: teamId }], nextCursor: null }, { items: [{ ...grant, team: { ...team, name: "Private person" } }], nextCursor: null }, { items: [{ ...grant, team: { ...team, version: "9223372036854775808" } }], nextCursor: null }];
    const fetcher = vi.fn(); bad.forEach(item => fetcher.mockResolvedValueOnce(wire(item))); vi.stubGlobal("fetch", fetcher);
    for (const _ of bad) await expect(listGitHubAppGrants(app, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("requires a minimal owner consistent with the Team kind", async () => {
    const { personalOwner: _owner, ...missing } = team;
    const ordinary = { ...team, kind: "ordinary", name: "Engineering", personalOwner: null };
    const valid = [ordinary, ...[null, "", "\u2003", " Alice "].map(name => ({ ...team, personalOwner: { userId: actor, name } }))];
    const invalid = [missing, { ...team, personalOwner: null }, { ...ordinary, personalOwner: team.personalOwner },
      { ...team, personalOwner: { userId: "bad", name: null } }, { ...team, personalOwner: { userId: actor, name: 7 } },
      { ...team, personalOwner: { userId: actor } }, { ...team, personalOwner: { ...team.personalOwner, email: "private" } }];
    const fetcher = vi.fn(); [...valid, ...invalid].forEach(value => fetcher.mockResolvedValueOnce(wire({ ...grant, team: value })));
    vi.stubGlobal("fetch", fetcher);
    for (const value of valid) expect((await getGitHubAppGrant(app, grantId, signal(), admission())).team).toEqual(value);
    for (const _ of invalid) await expect(getGitHubAppGrant(app, grantId, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("rejects a preview whose grant owner differs from its target", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ ...preview, grant: { ...grant, team: { ...team, personalOwner: { ...team.personalOwner, userId: teamId } } } }))
      .mockResolvedValueOnce(wire({ ...preview, grant: { ...grant, team: { ...team, personalOwner: { ...team.personalOwner, name: null } } } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(previewGitHubAppGrant(app, teamId, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
    await expect(previewGitHubAppGrant(app, teamId, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("normalizes the exact preview target and checks current grant against it", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(preview)).mockResolvedValueOnce(wire({ ...preview, grant })).mockResolvedValueOnce(wire({ ...preview, targetTeam: { ...team, id: actor } })).mockResolvedValueOnce(wire({ ...preview, grant: { ...grant, team: { ...team, version: "2" } } }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await previewGitHubAppGrant(app, teamId.toUpperCase(), signal(), access)).toEqual(preview);
    expect(await previewGitHubAppGrant(app, teamId, signal(), access)).toEqual({ ...preview, grant });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ teamId });
    await expect(previewGitHubAppGrant(app, teamId, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(previewGitHubAppGrant(app, teamId, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onDispatch).not.toHaveBeenCalled();
  });
  it("freezes creation identity and both versions and validates the receipt", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(grant, 201)).mockResolvedValueOnce(wire({ ...grant, id: actor }, 201));
    vi.stubGlobal("fetch", fetcher); const access = admission(), input = { id: grantId, version, teamId, teamVersion: version };
    expect(await createGitHubAppGrant(app, input, signal(), access)).toEqual(grant);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ...input, expectedUserId: actor });
    await expect(createGitHubAppGrant(app, input, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(() => createGitHubAppGrant(app, { ...input, teamVersion: "0" }, signal(), access)).toThrow();
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("binds impact to the original grant and exposes only visible Project details", async () => {
    const projects = { items: [{ id: projectId, name: "Visible", repoUrl: "https://github.com/o/r" }], hiddenProjects: "1", nextCursor: "next" };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(impact)).mockResolvedValueOnce(wire(projects)).mockResolvedValueOnce(wire({ ...impact, grantId: actor })).mockResolvedValueOnce(wire({ ...projects, items: [{ ...projects.items[0], private: true }] }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await getGitHubAppGrantImpact(app, grantId, null, signal(), access)).toEqual(impact);
    expect(await listGitHubAppGrantImpactProjects(app, grantId, null, signal(), access)).toEqual(projects);
    await expect(getGitHubAppGrantImpact(app, grantId, null, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(listGitHubAppGrantImpactProjects(app, grantId, null, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
  });
  it("submits observed revocation versions and distinguishes conflict and unknown", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ appId: app, grantId, revoked: true })).mockResolvedValueOnce(wire({ error: { code: "impact_changed", message: "changed", requestId: "x" } }, 409)).mockResolvedValueOnce(wire({ error: { code: "github_write_outcome_unknown", message: "unknown", requestId: "x" } }, 503));
    vi.stubGlobal("fetch", fetcher); const access = admission(), input = { version, impactVersion };
    expect(await revokeGitHubAppGrant(app, grantId, input, signal(), access)).toEqual({ appId: app, grantId, revoked: true });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ...input, expectedUserId: actor });
    await expect(revokeGitHubAppGrant(app, grantId, input, signal(), access)).rejects.toMatchObject({ code: "impact_changed" });
    await expect(revokeGitHubAppGrant(app, grantId, input, signal(), access)).rejects.toMatchObject({ code: "github_write_outcome_unknown" });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("rejects principal mismatches and never confirms a write from another account", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(grant, 201, teamId)); vi.stubGlobal("fetch", fetcher); const access = admission();
    await expect(createGitHubAppGrant(app, { id: grantId, version, teamId, teamVersion: version }, signal(), access)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(access.onPrincipalMismatch).toHaveBeenCalledOnce(); expect(access.onWriteConfirmed).not.toHaveBeenCalled();
  });
  it("starts its timeout after identity admission and never replays", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal("fetch", fetcher); const resume = pauseAuthRequests(), access = admission();
    const pending = createGitHubAppGrant(app, { id: grantId, version, teamId, teamVersion: version }, signal(), access), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(20_000); await rejected; expect(fetcher).toHaveBeenCalledOnce(); expect(access.onDispatch).toHaveBeenCalledOnce();
  });
});
