import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { connectGitHub, disconnectGitHub, discoverGitHubInstallation, getGitHubPullRequestCounts, getGitHubStatus, saveGitHubSettings, updateGitHubSync } from "../src/api/github-integration";
import { wireResponse } from "./helpers/wireJson";

const project = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const version = "9007199254740993";
const status = (overrides: Record<string, unknown> = {}) => ({
  projectId: project, version, revision: "0", serviceAvailable: true, syncEnabled: false, connection: "not_connected", repository: null, installation: null,
  pollIntervalMinutes: 5, initializing: false,
  poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null },
  webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null }, ...overrides,
});
const candidate = { installation: { id: "9007199254740995", accountLogin: "different-owner" }, repository: { id: "9007199254740997", fullName: "owner/repo", private: true } };
const wire = (body: unknown, code = 200, principal = userId) => wireResponse(body, { status: code, headers: { "Daynight-User-ID": principal } });
const admission = () => ({ userId, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
const signal = () => new AbortController().signal;

beforeEach(() => invalidateAuthRequests());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub integration transport", () => {
  it("preserves large decimal IDs, binds responses to the project and authenticating user", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status())).mockResolvedValueOnce(wire(candidate));
    vi.stubGlobal("fetch", fetcher);
    const access = admission();
    expect(await getGitHubStatus(project, signal(), access)).toMatchObject({ version, revision: "0", pollIntervalMinutes: 5 });
    expect(await discoverGitHubInstallation(project, signal(), access)).toEqual(candidate);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`/api/v1/projects/${project}/github`, `/api/v1/projects/${project}/github/installation`]);
    fetcher.mockResolvedValueOnce(wire(status(), 200, other));
    await expect(getGitHubStatus(project, signal(), access)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(access.onPrincipalMismatch).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(wire(status({ projectId: other })));
    await expect(getGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("sends exact write versions and verifies the returned settings and connection", async () => {
    const connected = status({ version: "9007199254740994", connection: "connected", initializing: true, ...candidate });
    const fetcher = vi.fn().mockResolvedValueOnce(wire(connected)).mockResolvedValueOnce(wire({ ...connected, version: "9007199254740995", pollIntervalMinutes: 10 })).mockResolvedValueOnce(wire({ ...connected, connection: "disconnected", initializing: false }));
    vi.stubGlobal("fetch", fetcher);
    const access = admission();
    await connectGitHub(project, { version, installationId: candidate.installation.id }, signal(), access);
    await saveGitHubSettings(project, { version: "9007199254740994", pollIntervalMinutes: 10 }, signal(), access);
    await disconnectGitHub(project, { version: "9007199254740994" }, signal(), access);
    expect(fetcher.mock.calls.map(([, init]) => [init.method, init.body])).toEqual([
      ["POST", `{"version":"${version}","installationId":"9007199254740995"}`],
      ["PATCH", '{"version":"9007199254740994","pollIntervalMinutes":10}'],
      ["POST", '{"version":"9007199254740994"}'],
    ]);
    expect(access.onWriteConfirmed).toHaveBeenCalledTimes(3);
    expect(access.onDispatch).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed or inconsistent success without confirming a write", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(wire(status({ pollIntervalMinutes: 8 }))).mockResolvedValueOnce(wire(status({ version: "9007199254740995", pollIntervalMinutes: 10 }))).mockResolvedValueOnce(wire(status(), 201));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    await expect(saveGitHubSettings(project, { version, pollIntervalMinutes: 10 }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(saveGitHubSettings(project, { version, pollIntervalMinutes: 10 }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(disconnectGitHub(project, { version }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onWriteConfirmed).not.toHaveBeenCalled();
    expect(() => saveGitHubSettings(project, { version: "01", pollIntervalMinutes: 10 }, signal(), access)).toThrow();
    expect(() => saveGitHubSettings(project, { version, pollIntervalMinutes: 2147483648 }, signal(), access)).toThrow();
    expect(() => connectGitHub(project, { version, installationId: "9223372036854775808" }, signal(), access)).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("exposes a version refusal separately from a confirmed write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wire({ error: { code: "version_conflict", message: "conflict", requestId: "r" } }, 409)));
    const access = admission();
    await expect(disconnectGitHub(project, { version }, signal(), access)).rejects.toMatchObject({ kind: "server", status: 409, code: "version_conflict" });
    expect(access.onWriteConfirmed).not.toHaveBeenCalled(); expect(access.onWriteRejected).toHaveBeenCalledOnce();
  });

  it("requires a boolean sync setting and sends an independent versioned mutation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(wire(status({ syncEnabled: undefined })))
      .mockResolvedValueOnce(wire(status({ syncEnabled: null })))
      .mockResolvedValueOnce(wire(status({ syncEnabled: "false" })))
      .mockResolvedValueOnce(wire(status({ version: "9007199254740994", syncEnabled: true })))
      .mockResolvedValueOnce(wire(status({ version: "9007199254740994", syncEnabled: false })));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    for (let i = 0; i < 3; i++) await expect(getGitHubStatus(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(await updateGitHubSync(project, { version, syncEnabled: true }, signal(), access)).toMatchObject({ syncEnabled: true });
    expect(fetcher.mock.calls[3]![0]).toBe(`/api/v1/projects/${project}/github/sync`);
    expect(fetcher.mock.calls[3]![1]).toMatchObject({ method: "PATCH", body: `{"version":"${version}","syncEnabled":true}` });
    await expect(updateGitHubSync(project, { version, syncEnabled: true }, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    expect(access.onWriteConfirmed).toHaveBeenCalledOnce();
  });

  it("checks exact coherent retained counts without interpreting read failures as empty", async () => {
    const page = { projectId: project, revision: "7", items: [{}], total: "9007199254740995", counts: { active: "9007199254740993", closed: "1", merged: "1", all: "9007199254740995" }, nextCursor: "next", previousCursor: null };
    const fetcher = vi.fn().mockResolvedValueOnce(wire(page)).mockResolvedValueOnce(wire({ ...page, counts: { ...page.counts, all: "0" } })).mockResolvedValueOnce(wire({ error: { code: "forbidden", message: "denied", requestId: "r" } }, 403));
    vi.stubGlobal("fetch", fetcher); const access = admission();
    expect(await getGitHubPullRequestCounts(project, signal(), access)).toMatchObject({ revision: "7", counts: page.counts });
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/projects/${project}/pull-requests?state=all&limit=1`);
    await expect(getGitHubPullRequestCounts(project, signal(), access)).rejects.toMatchObject({ kind: "protocol" });
    await expect(getGitHubPullRequestCounts(project, signal(), access)).rejects.toMatchObject({ status: 403 });
  });

  it("starts the discovery deadline on dispatch after identity checks and aborts at 50 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const resume = pauseAuthRequests(), access = admission();
    const pending = discoverGitHubInstallation(project, signal(), access);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000); expect(access.onDispatch).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(49_999); expect(access.onDispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await rejected;
  });
});
