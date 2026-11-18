import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { connectProjectGitHub, disconnectProjectGitHub, discoverProjectGitHubInstallation, getProjectGitHubStatus, listTeamGitHubApps, saveProjectGitHubSettings, updateProjectGitHubSync, updateProjectWebhook } from "../src/api/github-consumption";
import { wireResponse } from "./helpers/wireJson";

const project = "00000000-0000-4000-8000-000000000001", user = "00000000-0000-4000-8000-000000000002", team = "00000000-0000-4000-8000-000000000003", appId = "00000000-0000-4000-8000-000000000004", grantId = "00000000-0000-4000-8000-000000000005";
const version = "9007199254740993", next = "9007199254740994";
const app = { id: appId, githubAppId: version, name: "App", githubSlug: "app" };
const grant = { grantId, app: { ...app, version }, createdAt: "2026-11-16T10:00:00Z" };
const candidate = { installation: { id: version, accountLogin: "account" }, repository: { id: next, fullName: "owner/repo", private: true } };
const status = (overrides: Record<string, unknown> = {}) => ({ projectId: project, version, revision: "0", serviceAvailable: true, syncEnabled: false, connection: "not_connected", repository: null, installation: null,
  pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null }, canManageConnection: true, app: null, grantId: null, ...overrides });
const connected = (overrides: Record<string, unknown> = {}) => status({ version: next, connection: "connected", app, grantId, ...candidate, ...overrides });
const wire = (body: unknown, code = 200, principal = user) => wireResponse(body, { status: code, headers: { "Daynight-User-ID": principal } });
const admission = () => ({ userId: user, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
const signal = () => new AbortController().signal;
const selected = { appResourceId: appId, appVersion: version, grantId, ownershipVersion: next };

beforeEach(() => invalidateAuthRequests());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub consumption API", () => {
  it("decodes bounded Team projections with exact string IDs and no admin metadata", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire({ items: [grant], nextCursor: "more" })).mockResolvedValueOnce(wire({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await listTeamGitHubApps(team, null, signal(), access)).toEqual({ items: [grant], nextCursor: "more" });
    expect(await listTeamGitHubApps(team, "more", signal(), access)).toEqual({ items: [], nextCursor: null });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`/api/v1/teams/${team}/github/apps?limit=50`, `/api/v1/teams/${team}/github/apps?limit=50&cursor=more`]);
    expect(() => listTeamGitHubApps(team, "", signal(), access)).toThrow();
  });

  it("rejects malformed, missing, duplicate, or imprecise projections", async () => {
    const invalid = [
      { items: [{ ...grant, app: { ...grant.app, version: "0" } }], nextCursor: null },
      { items: [{ ...grant, app: { ...grant.app, githubAppId: "9223372036854775808" } }], nextCursor: null },
      { items: [{ ...grant, app: { ...grant.app, githubSlug: undefined } }], nextCursor: null },
      { items: [{ ...grant, createdAt: "not a date" }], nextCursor: null },
      { items: [grant, grant], nextCursor: null },
      { items: [], nextCursor: undefined },
    ];
    const fetcher = vi.fn(); invalid.forEach(value => fetcher.mockResolvedValueOnce(wire(value)));
    vi.stubGlobal("fetch", fetcher);
    for (const _ of invalid) await expect(listTeamGitHubApps(team, null, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });

  it("binds every response to principal and project and requires connection fields", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status())).mockResolvedValueOnce(wire(status({ projectId: team }))).mockResolvedValueOnce(wire(status({ canManageConnection: undefined }))).mockResolvedValueOnce(wire(status(), 200, team)).mockResolvedValueOnce(wire(connected({ grantId: undefined })));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await getProjectGitHubStatus(project, signal(), access)).toMatchObject({ version, app: null, canManageConnection: true });
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(access.onPrincipalMismatch).toHaveBeenCalledOnce();
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("sends frozen selection, grant and ownership versions and validates receipts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(candidate)).mockResolvedValueOnce(wire(connected())).mockResolvedValueOnce(wire(status({ version: next, connection: "disconnected" })));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await discoverProjectGitHubInstallation(project, selected, signal(), access)).toEqual(candidate);
    expect(await connectProjectGitHub(project, { ...selected, version, installationId: version }, signal(), access)).toMatchObject({ app, grantId });
    await disconnectProjectGitHub(project, { version, ownershipVersion: next }, signal(), access);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/projects/${project}/github/installation?appResourceId=${appId}&appVersion=${version}&grantId=${grantId}&ownershipVersion=${next}`);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ version, ownershipVersion: next, appResourceId: appId, appVersion: version, grantId, installationId: version });
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ version, ownershipVersion: next });
    expect(access.onWriteConfirmed).toHaveBeenCalledTimes(2);
    expect(() => discoverProjectGitHubInstallation(project, { ...selected, appVersion: "01" }, signal(), access)).toThrow();
    expect(() => connectProjectGitHub(project, { ...selected, version, installationId: "0" }, signal(), access)).toThrow();
    expect(() => disconnectProjectGitHub(project, { version, ownershipVersion: "9223372036854775808" }, signal(), access)).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not confirm inconsistent receipts, server refusal or unknown writes", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(connected({ grantId: team }))).mockResolvedValueOnce(wire({ error: { code: "github_grant_changed", message: "conflict", requestId: "x" } }, 409)).mockResolvedValueOnce(wire({ error: { code: "github_write_outcome_unknown", message: "unknown", requestId: "x" } }, 503));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    await expect(connectProjectGitHub(project, { ...selected, version, installationId: version }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(connectProjectGitHub(project, { ...selected, version, installationId: version }, signal(), access)).rejects.toMatchObject({ code: "github_grant_changed", status: 409 });
    await expect(disconnectProjectGitHub(project, { version, ownershipVersion: next }, signal(), access)).rejects.toMatchObject({ code: "github_write_outcome_unknown", status: 503 });
    expect(access.onWriteConfirmed).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("validates Project admin settings separately from connection control", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status({ version: next, canManageConnection: false, pollIntervalMinutes: 10 }))).mockResolvedValueOnce(wire(status({ version: next, canManageConnection: false, syncEnabled: true })));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    await saveProjectGitHubSettings(project, { version, pollIntervalMinutes: 10 }, signal(), access);
    await updateProjectGitHubSync(project, { version, syncEnabled: true }, signal(), access);
    expect(fetcher.mock.calls.map(([, init]) => [init.method, JSON.parse(init.body)])).toEqual([["PATCH", { version, pollIntervalMinutes: 10 }], ["PATCH", { version, syncEnabled: true }]]);
    expect(access.onWriteConfirmed).toHaveBeenCalledTimes(2);
    expect(() => saveProjectGitHubSettings(project, { version, pollIntervalMinutes: 0 }, signal(), access)).toThrow();
  });

  it("starts discovery timeout after identity admission and never replays", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal("fetch", fetcher); const resume = pauseAuthRequests(), access = admission();
    const pending = discoverProjectGitHubInstallation(project, selected, signal(), access), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(50_000); await rejected; expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads optional subscription status and sends independently versioned writes without exposing the secret", async () => {
    const hook = { version: null, enabled: false, repositoryId: null, lastReceivedAt: null, webhookUrl: `https://daynight.example/api/v1/github/projects/${project}/webhook`, state: 'unconfigured' };
    const configured = { ...hook, version: '1', enabled: true, repositoryId: next, state: 'waiting' };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status())).mockResolvedValueOnce(wire(status({ projectWebhook: hook }))).mockResolvedValueOnce(wire(configured));
    vi.stubGlobal('fetch', fetcher); const access = admission();
    expect((await getProjectGitHubStatus(project, signal(), access)).projectWebhook).toBeNull();
    expect((await getProjectGitHubStatus(project, signal(), access)).projectWebhook).toEqual(hook);
    expect(await updateProjectWebhook(project, { version: null, enabled: true, repositoryId: next, secret: 'exact secret' }, signal(), access)).toEqual(configured);
    expect(fetcher.mock.calls[2]![0]).toBe(`/api/v1/projects/${project}/github/webhook`);
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ expectedUserId: user, version: null, enabled: true, repositoryId: next, secret: 'exact secret' });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce();
  });

  it("rejects malformed or inconsistent subscription status and write receipts", async () => {
    const hook = { version: '1', enabled: true, repositoryId: '42', lastReceivedAt: null, webhookUrl: `https://daynight.example/api/v1/github/projects/${project}/webhook`, state: 'waiting' };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status({ projectWebhook: { ...hook, webhookUrl: 'https://other.example/secret' } }))).mockResolvedValueOnce(wire(status({ projectWebhook: { ...hook, state: 'received' } }))).mockResolvedValueOnce(wire({ ...hook, version: '3' }));
    vi.stubGlobal('fetch', fetcher); const access = admission();
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getProjectGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(updateProjectWebhook(project, { version: '1', enabled: true }, signal(), access)).rejects.toMatchObject({ kind: 'protocol' });
    expect(access.onWriteConfirmed).not.toHaveBeenCalled();
    expect(() => updateProjectWebhook(project, { version: '1', enabled: true, secret: '' }, signal(), access)).toThrow();
    expect(() => updateProjectWebhook(project, { version: '1', enabled: true, secret: 'x'.repeat(4097) }, signal(), access)).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
