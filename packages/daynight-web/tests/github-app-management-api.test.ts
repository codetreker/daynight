import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { createGitHubApp, getGitHubApp, getGitHubAppRemovalImpact, listGitHubAppRemovalProjects, listGitHubApps, removeGitHubApp, updateGitHubApp } from "../src/api/github-app-management";
import { wireResponse } from "./helpers/wireJson";

const appId = "00000000-0000-4000-8000-000000000001", user = "00000000-0000-4000-8000-000000000002", team = "00000000-0000-4000-8000-000000000003", project = "00000000-0000-4000-8000-000000000004";
const version = "9007199254740993", next = "9007199254740994";
const app = { id: appId, githubAppId: version, name: "My App", githubName: "GitHub App", githubSlug: "app", version, administrators: "1", authorizedTeams: "1", connectedProjects: "2", webhookUrl: `https://daynight.example/api/v1/github/apps/${appId}/webhook`, createdAt: "2026-11-16T10:00:00Z", updatedAt: "2026-11-16T10:00:00Z" };
const impact = { appId, grantId: null, version, impactVersion: next, totalProjects: "2", visibleProjects: "1", hiddenProjects: "1", teams: [{ team: { id: team, kind: "ordinary", name: "Team" }, projects: "2" }], nextCursor: null };
const wire = (body: unknown, status = 200, principal = user) => wireResponse(body, { status, headers: { "Daynight-User-ID": principal } });
const admission = () => ({ userId: user, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
const signal = () => new AbortController().signal;
const create = { id: appId, name: "My App", githubAppId: version, privateKeyPem: "private-key", webhookSecret: "secret" };
beforeEach(() => invalidateAuthRequests());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub App management API", () => {
  it("reads paginated metadata without secrets and preserves exact decimals", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ items: [app], nextCursor: "next" })).mockResolvedValueOnce(wire(app));
    vi.stubGlobal("fetch", fetcher);
    expect(await listGitHubApps(null, signal(), admission())).toEqual({ items: [app], nextCursor: "next" });
    expect(await getGitHubApp(appId, signal(), admission())).toEqual(app);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/github/apps?limit=50", `/api/v1/github/apps/${appId}`]);
    expect(() => listGitHubApps("", signal(), admission())).toThrow();
  });
  it("rejects malformed or leaked metadata, mismatched targets and principal", async () => {
    const bad = [{ ...app, privateKeyPem: "leak" }, { ...app, version: "9223372036854775808" }, { ...app, version: "01" }, { ...app, webhookUrl: "https://evil.example/" }, { ...app, id: team }];
    const fetcher = vi.fn(); bad.forEach(item => fetcher.mockResolvedValueOnce(wire(item))); fetcher.mockResolvedValueOnce(wire(app, 200, team));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    for (const _ of bad) await expect(getGitHubApp(appId, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(getGitHubApp(appId, signal(), access)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(access.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it("submits exact create and update inputs, and checks receipts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(app, 201)).mockResolvedValueOnce(wire({ ...app, version: next, name: "Renamed" })).mockResolvedValueOnce(wire({ ...app, version: "42" }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await createGitHubApp(create, signal(), access)).toEqual(app);
    expect(await updateGitHubApp(appId, { version, name: "Renamed", webhookSecret: "replacement" }, signal(), access)).toMatchObject({ version: next });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ...create, expectedUserId: user });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ version, name: "Renamed", webhookSecret: "replacement", expectedUserId: user });
    await expect(updateGitHubApp(appId, { version, name: "My App" }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onWriteConfirmed).toHaveBeenCalledTimes(2);
    expect(() => updateGitHubApp(appId, { version }, signal(), access)).toThrow();
    expect(() => updateGitHubApp(appId, { version, privateKeyPem: "" }, signal(), access)).toThrow();
    expect(() => createGitHubApp({ ...create, githubAppId: "0" }, signal(), access)).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("exposes paginated impact and only server-visible projects with hidden count", async () => {
    const page = { items: [{ id: project, name: "Visible", repoUrl: "https://github.com/o/r" }], hiddenProjects: "1", nextCursor: "next" };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(impact)).mockResolvedValueOnce(wire(page)).mockResolvedValueOnce(wire({ ...impact, totalProjects: "3" })).mockResolvedValueOnce(wire({ ...page, items: [{ ...page.items[0], private: true }] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await getGitHubAppRemovalImpact(appId, null, signal(), admission())).toEqual(impact);
    expect(await listGitHubAppRemovalProjects(appId, null, signal(), admission())).toEqual(page);
    await expect(getGitHubAppRemovalImpact(appId, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
    await expect(listGitHubAppRemovalProjects(appId, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("binds deletion to observed versions and preserves unknown and refusal", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ appId, removed: true })).mockResolvedValueOnce(wire({ error: { code: "impact_changed", message: "changed", requestId: "x" } }, 409)).mockResolvedValueOnce(wire({ error: { code: "github_write_outcome_unknown", message: "unknown", requestId: "x" } }, 503));
    vi.stubGlobal("fetch", fetcher); const access = admission(); const versions = { version, impactVersion: next };
    expect(await removeGitHubApp(appId, versions, signal(), access)).toEqual({ appId, removed: true });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ...versions, expectedUserId: user });
    await expect(removeGitHubApp(appId, versions, signal(), access)).rejects.toMatchObject({ code: "impact_changed" });
    await expect(removeGitHubApp(appId, versions, signal(), access)).rejects.toMatchObject({ code: "github_write_outcome_unknown" });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("starts its timeout after identity admission and never replays", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal("fetch", fetcher); const resume = pauseAuthRequests(), access = admission();
    const pending = createGitHubApp(create, signal(), access), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(50_000); await rejected; expect(fetcher).toHaveBeenCalledOnce(); expect(access.onDispatch).toHaveBeenCalledOnce();
  });
});
