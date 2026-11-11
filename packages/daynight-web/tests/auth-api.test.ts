import { directAccessFixture } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptTeamInvitation, inspectTeamInvitation, acceptInvitation, createInvitation, createProject, createToken, getAuthConfig, inspectInvitation, listInvitations, listMembers, listTokens, logout, me, removeMember, revokeInvitation, revokeToken, setMemberRole } from "../src/api/auth";
import { ApiError, cancelAuthNetworkRequests, checkAttachmentPreview, deleteTask, getTask, invalidateAuthRequests, listProjects, pauseAuthRequests, readAttachmentText, request, subscribeUnauthorized } from "../src/api/client";

const projectId = "10000000-0000-0000-0000-00000000000a";
const userId = "20000000-0000-0000-0000-00000000000b";
const tokenId = "30000000-0000-0000-0000-00000000000c";
const inviteId = "40000000-0000-0000-0000-00000000000d";
const otherId = "50000000-0000-0000-0000-00000000000e";
const time = "2026-10-22T12:34:56.123456789Z";
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: userId, email: null, emailVerified: false, name: "Member", avatarUrl: null };
const pat = { id: tokenId, name: "Developer machine", createdAt: time, expiresAt: time };
const member = { projectId, userId, email: null, name: "Member", avatarUrl: null, role: "admin", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const { email: memberEmail, name: memberName, avatarUrl: memberAvatar, ...grant } = member;
const participant = { inheritedFrom: null, userId, profile: { email: memberEmail, name: memberName, avatarUrl: memberAvatar }, effectiveRole: member.role, directGrant: grant };
const invitation = { id: inviteId, projectId, createdBy: userId, createdAt: time, expiresAt: time, consumedBy: null, consumedAt: null, revokedAt: null };
const project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: "New project", repoUrl: "git@github.com:org/repo.git", createdAt: time, updatedAt: time };
const creationReceipt = { ...project, access: { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin", canTransfer: true } };
const signal = () => new AbortController().signal;
const rawJson = JSON as unknown as { rawJSON: (text: string) => unknown };
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? rawJson.rawJSON(item.toString()) : item), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const refusal = (status: number, code: string): Response => response({ error: { code, message: "sensitive-token-must-not-escape", requestId: "auth-1", details: { token: "sensitive-token-must-not-escape" } } }, status);
const mock = (value: Response) => {
  const fetcher = vi.fn().mockResolvedValue(value);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
afterEach(() => { vi.unstubAllGlobals(); invalidateAuthRequests(); });

describe("current-user HTTP cache", () => {
  it("rejects a raw 304 instead of treating absent browser cache content as a profile", async () => {
    mock(new Response(null, { status: 304 }));
    await expect(me(signal())).rejects.toMatchObject({ kind: "protocol", status: 304 });
  });
});

describe("identity revalidation request pause", () => {
  it("dispatches ordinary requests synchronously when identity is already confirmed", async () => {
    const fetcher = mock(response(user));
    const pending = request("/api/v1/me/tokens", signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await pending;
  });

  it.each([
    ["GET", "/api/v1/me/tokens"],
    ["POST", "/api/v1/invitations/accept"],
    ["PUT", `/api/v1/projects/${projectId}/tasks/${tokenId}/attachments/files/guide.md`],
    ["PATCH", `/api/v1/projects/${projectId}/members/${userId}`],
    ["DELETE", `/api/v1/me/tokens/${tokenId}`],
  ])("holds %s %s until the current identity is confirmed", async (method, url) => {
    const fetcher = mock(response(user));
    const resume = pauseAuthRequests();
    const pending = request(url, signal(), { method });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(me(signal())).resolves.toEqual(user);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me", expect.anything());
    resume();
    await pending;
    expect(fetcher.mock.calls[1]?.[0]).toBe(url);
    expect(fetcher.mock.calls[1]?.[1].method).toBe(method);
  });

  it("allows logout while normal requests are paused and cancels the queued requests on session invalidation", async () => {
    const fetcher = mock(new Response(null, { status: 204 }));
    pauseAuthRequests();
    const pending = request("/api/v1/invitations/accept", signal(), { method: "POST" });
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await logout(signal());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/logout", expect.anything());
    invalidateAuthRequests();
    await cancelled;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves a queued request's abort reason and removes its listener before later release", async () => {
    const fetcher = mock(response(user));
    const resume = pauseAuthRequests();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = request("/api/v1/me/tokens", controller.signal);
    const reason = new Error("Closed account view");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    resume();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps queued requests paused when a superseded check tries to release them", async () => {
    const fetcher = mock(response(user));
    const staleResume = pauseAuthRequests();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = request("/api/v1/me/tokens", controller.signal);
    const currentResume = pauseAuthRequests();
    staleResume();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    currentResume();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("discards an old identity's queued request without releasing a later identity check", async () => {
    const fetcher = mock(response(user));
    const staleResume = pauseAuthRequests();
    const previous = request("/api/v1/invitations/accept", signal(), { method: "POST" });
    const cancelled = expect(previous).rejects.toMatchObject({ name: "AbortError" });
    invalidateAuthRequests();
    const currentResume = pauseAuthRequests();
    const current = request("/api/v1/me/tokens", signal());
    staleResume();
    await cancelled;
    expect(fetcher).not.toHaveBeenCalled();
    currentResume();
    await current;
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me/tokens", expect.anything());
  });

  it("waits for another identity check started before a released request resumes", async () => {
    const fetcher = mock(response(user));
    const resume = pauseAuthRequests();
    const pending = request("/api/v1/me/tokens", signal());
    resume();
    const resumeLatest = pauseAuthRequests();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    resumeLatest();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("ordinary network cancellation", () => {
  it("cancels dispatched fetches with the shared reason and installs the next lifetime before abort callbacks", async () => {
    let firstSignal: AbortSignal | undefined;
    let replacement: Promise<Response> | undefined;
    const fetcher = vi.fn((url: string, init: RequestInit) => {
      const current = init.signal as AbortSignal;
      if (url === "/old") {
        firstSignal = current;
        return new Promise<Response>((_resolve, reject) => current.addEventListener("abort", () => {
          replacement = request("/replacement", signal());
          reject(current.reason);
        }, { once: true }));
      }
      expect(current.aborted).toBe(false);
      return Promise.resolve(response(user));
    });
    vi.stubGlobal("fetch", fetcher);
    const old = request("/old", signal());
    const cancelled = old.catch((error: unknown) => error);
    cancelAuthNetworkRequests();
    expect(firstSignal?.aborted).toBe(true);
    expect(await cancelled).toBe(firstSignal?.reason);
    expect(firstSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(replacement).toBeDefined();
    await expect(replacement).resolves.toBeInstanceOf(Response);
    await expect(request("/later", signal())).resolves.toBeInstanceOf(Response);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/old", "/replacement", "/later"]);
  });

  it("preserves a caller cancellation independently of the shared lifetime", async () => {
    let dispatched: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      dispatched = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => dispatched!.addEventListener("abort", () => reject(dispatched!.reason), { once: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    const caller = new AbortController();
    const pending = request("/caller", caller.signal).catch((error: unknown) => error);
    const reason = new Error("caller cancelled");
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(dispatched?.reason).toBe(reason);
    fetcher.mockImplementationOnce(async () => response(user));
    await expect(request("/next", signal())).resolves.toBeInstanceOf(Response);
  });

  it.each(["resolve", "reject"])("keeps shared cancellation when an aborted fetch later %ss", async (outcome) => {
    const fetchGate = Promise.withResolvers<Response>();
    let runningSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return fetchGate.promise; }));
    const unauthorized = vi.fn();
    const unsubscribe = subscribeUnauthorized(unauthorized);
    const pending = request("/late", signal()).catch((error: unknown) => error);
    cancelAuthNetworkRequests();
    if (outcome === "resolve") fetchGate.resolve(refusal(401, "unauthenticated")); else fetchGate.reject(new TypeError("transport failed"));
    expect(await pending).toBe(runningSignal?.reason);
    expect(unauthorized).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("leaves paused requests queued until resume and gives them the new lifetime", async () => {
    let runningSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      runningSignal = init.signal as AbortSignal;
      return Promise.resolve(response(user));
    });
    vi.stubGlobal("fetch", fetcher);
    const resume = pauseAuthRequests();
    const pending = request("/queued", signal());
    expect(fetcher).not.toHaveBeenCalled();
    cancelAuthNetworkRequests();
    expect(fetcher).not.toHaveBeenCalled();
    resume();
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(runningSignal?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not cancel an in-flight request merely because the identity gate pauses", async () => {
    const responseGate = Promise.withResolvers<Response>();
    let runningSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return responseGate.promise; }));
    const pending = request("/running", signal());
    const resume = pauseAuthRequests();
    expect(runningSignal?.aborted).toBe(false);
    responseGate.resolve(response(user));
    await expect(pending).resolves.toBeInstanceOf(Response);
    resume();
  });

  it("keeps /me and logout on their independent caller signals", async () => {
    const pendingMe = Promise.withResolvers<Response>();
    const pendingLogout = Promise.withResolvers<Response>();
    const meController = new AbortController(), logoutController = new AbortController();
    const fetcher = vi.fn((url: string, _init: RequestInit) => url === "/api/v1/me" ? pendingMe.promise : pendingLogout.promise);
    vi.stubGlobal("fetch", fetcher);
    const userRead = me(meController.signal);
    const logoutWrite = logout(logoutController.signal);
    cancelAuthNetworkRequests();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: meController.signal });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ signal: logoutController.signal });
    expect(meController.signal.aborted).toBe(false);
    expect(logoutController.signal.aborted).toBe(false);
    pendingMe.resolve(response(user)); pendingLogout.resolve(new Response(null, { status: 204 }));
    await expect(userRead).resolves.toEqual(user);
    await expect(logoutWrite).resolves.toBeUndefined();
  });

  it("does not publish an attachment body that completes after shared cancellation", async () => {
    const body = new Response("old text");
    const readStarted = Promise.withResolvers<void>();
    const textGate = Promise.withResolvers<string>();
    vi.spyOn(body, "text").mockImplementation(() => { readStarted.resolve(); return textGate.promise; });
    let runningSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return Promise.resolve(body); }));
    const pending = readAttachmentText(projectId, tokenId, "guide.md", signal()).catch((error: unknown) => error);
    await readStarted.promise;
    cancelAuthNetworkRequests();
    textGate.resolve("old text");
    expect(await pending).toBe(runningSignal?.reason);
  });

  it("does not confirm a 204 response after cancellation between fetch and response consumption", async () => {
    const fetchGate = Promise.withResolvers<Response>();
    let runningSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return fetchGate.promise; }));
    const confirmed = vi.fn(), mismatch = vi.fn();
    const pending = deleteTask(projectId, tokenId, 1n, undefined, signal(), { userId, onPrincipalMismatch: mismatch, onWriteConfirmed: confirmed }).catch((error: unknown) => error);
    fetchGate.resolve(new Response(null, { status: 204, headers: { "Daynight-User-ID": userId } }));
    queueMicrotask(cancelAuthNetworkRequests);
    expect(await pending).toBe(runningSignal?.reason);
    expect(runningSignal?.aborted).toBe(true);
    expect(confirmed).not.toHaveBeenCalled();
    expect(mismatch).not.toHaveBeenCalled();
  });

  it("does not report a principal mismatch after cancellation between fetch and response consumption", async () => {
    const fetchGate = Promise.withResolvers<Response>();
    let runningSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return fetchGate.promise; }));
    const mismatch = vi.fn();
    const pending = getTask(projectId, tokenId, signal(), { userId, onPrincipalMismatch: mismatch }).catch((error: unknown) => error);
    fetchGate.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": otherId } }));
    queueMicrotask(cancelAuthNetworkRequests);
    expect(await pending).toBe(runningSignal?.reason);
    expect(runningSignal?.aborted).toBe(true);
    expect(mismatch).not.toHaveBeenCalled();
  });
});

describe("session and personal credentials API", () => {
  it("loads the current nullable profile and the configured provider list from relative endpoints", async () => {
    const fetcher = mock(response(user));
    const abortSignal = signal();
    expect(await me(abortSignal)).toEqual(user);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me", {
      signal: abortSignal, cache: "no-cache", credentials: "same-origin", redirect: "error", headers: { Accept: "application/json" },
    });
    fetcher.mockResolvedValue(response({ providers: ["github", "microsoft"] }));
    expect(await getAuthConfig(abortSignal)).toEqual({ providers: ["github", "microsoft"] });
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/auth/providers");
    fetcher.mockResolvedValue(response({ providers: [] }));
    expect(await getAuthConfig(abortSignal)).toEqual({ providers: [] });
  });

  it("lists only credential metadata and returns the created secret only from the create response", async () => {
    const fetcher = mock(response({ items: [{ ...pat, token: "unexpected-list-secret" }] }));
    expect(await listTokens(signal(), userId, vi.fn())).toEqual([pat]);
    fetcher.mockResolvedValue(response({ ...pat, token: "opaque-created-token" }, 201));
    expect(await createToken({ name: pat.name, expiresAt: time }, signal())).toEqual({ ...pat, token: "opaque-created-token" });
    expect(fetcher.mock.calls[1]).toEqual(["/api/v1/me/tokens", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: pat.name, expiresAt: time }), credentials: "same-origin", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    })]);
    fetcher.mockResolvedValue(response({ ...pat, token: "default-lifetime-token" }, 201));
    await createToken({ name: "Default lifetime", expiresAt: null }, signal());
    expect(fetcher.mock.calls[2]?.[1].body).toBe('{"name":"Default lifetime","expiresAt":null}');
  });

  it("accepts names using the server's Unicode code point and control-character rules", async () => {
    const fetcher = mock(response({ ...pat, token: "created-token" }, 201));
    fetcher.mockImplementation(() => Promise.resolve(response({ ...pat, token: "created-token" }, 201)));
    for (const name of ["😀".repeat(100), "line\nname", "tab\tname"]) {
      await createToken({ name, expiresAt: null }, signal());
      expect(fetcher.mock.lastCall?.[1].body).toBe(JSON.stringify({ name, expiresAt: null }));
    }
  });

  it.each([
    ...["", "   ", "😀".repeat(101), "name\0value", "name\ud800value"].map((name) => ({ name, expiresAt: null })),
    ...["", "invalid", "2026-02-30T00:00:00Z", "2026-11-20T12:34:56+01:00"].map((expiresAt) => ({ name: "name", expiresAt })),
  ])("rejects invalid credential input before network I/O %#", (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => createToken(input, signal())).toThrow(input.expiresAt === null ? ApiError : /^The server returned an invalid response\.$/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revokes personal credentials and logs out without parsing a body or adding a second request", async () => {
    const fetcher = mock(new Response(null, { status: 204 }));
    await revokeToken(tokenId.toUpperCase(), signal());
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/me/tokens/${tokenId}`, expect.objectContaining({ method: "DELETE" })]);
    await logout(signal());
    expect(fetcher.mock.calls[1]).toEqual(["/api/v1/auth/logout", expect.objectContaining({ method: "POST" })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("private project and membership API", () => {
  it("creates a project through the existing endpoint and requires the documented creation status", async () => {
    const fetcher = mock(response(creationReceipt, 201));
    expect(await createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: userId }, signal(), vi.fn())).toEqual(project);
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: project.name, repoUrl: project.repoUrl, expectedUserId: userId }) })]);
    fetcher.mockResolvedValue(response(creationReceipt, 200));
    await expect(createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: userId }, signal(), vi.fn())).rejects.toMatchObject({ name: "ProjectCreationUnknown", cause: { kind: "protocol", status: 200 } });
  });

  it("sends an explicit team and validates the creation ownership and grant", async () => {
    const fetcher = mock(response(creationReceipt, 201));
    const teamId = project.ownership.teamId;
    const input = { name: project.name, repoUrl: project.repoUrl, expectedUserId: userId.toUpperCase(), teamId: teamId.toUpperCase() };
    await expect(createProject(input, signal(), vi.fn())).resolves.toEqual(project);
    expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify({ ...input, expectedUserId: userId, teamId }));
    for (const access of [
      { ...creationReceipt.access, ownership: { ...creationReceipt.access.ownership, version: 2n } },
      { ...creationReceipt.access, directGrant: null },
      { ...creationReceipt.access, directGrant: { ...creationReceipt.access.directGrant!, userId: otherId } },
    ]) {
      fetcher.mockResolvedValueOnce(response({ ...project, access }, 201));
      await expect(createProject(input, signal(), vi.fn())).rejects.toMatchObject({ name: "ProjectCreationUnknown" });
    }
  });

  it("preserves original project text and rejects mismatched successful principals without replay", async () => {
    const input = { name: "  Project 名称  ", repoUrl: "git@github.com:org/repo.git", expectedUserId: userId };
    const mismatch = vi.fn();
    const fetcher = mock(new Response(stringifyWireJson({ ...project, name: input.name }), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": otherId } }));
    await expect(createProject(input, signal(), mismatch)).rejects.toMatchObject({ name: "ProjectCreationUnknown", cause: { kind: "protocol", code: "principal_mismatch" } });
    expect(mismatch).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify(input));
  });

  it("revalidates identity on an explicit creation refusal without replay", async () => {
    const mismatch = vi.fn(), fetcher = mock(refusal(409, "identity_mismatch"));
    await expect(createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: userId }, signal(), mismatch)).rejects.toMatchObject({ kind: "server", code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ name: "", repoUrl: "repo" }, { name: "name", repoUrl: " " }, { name: "bad\0name", repoUrl: "repo" }, { name: "name", repoUrl: "bad\0repo" }])("rejects malformed project input before requests %#", (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => createProject({ ...input, expectedUserId: userId }, signal(), vi.fn())).toThrow(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves full int64 member observations in responses and PATCH/DELETE numeric bodies", async () => {
    const maximum = 9_223_372_036_854_775_807n;
    const fetcher = mock(response({ actorAccess: directAccessFixture(projectId, userId), items: [participant] }));
    expect((await listMembers(projectId.toUpperCase(), signal())).items).toEqual([participant]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/members`);
    fetcher.mockResolvedValue(response({ ...grant, role: "member", version: maximum }));
    expect(await setMemberRole(projectId, userId.toUpperCase(), { version: member.version, role: "member", expectedUserId: userId }, signal(), vi.fn())).toEqual({ ...grant, role: "member", version: maximum });
    expect(fetcher.mock.calls[1]?.[1].body).toBe(`{"version":9007199254740993,"role":"member","expectedUserId":"${userId}"}`);
    fetcher.mockResolvedValue(new Response(null, { status: 204, headers: { "Daynight-User-ID": userId } }));
    await removeMember(projectId, userId, { version: maximum, expectedUserId: userId }, signal(), vi.fn());
    expect(fetcher.mock.calls[2]).toEqual([`/api/v1/projects/${projectId}/members/${userId}`, expect.objectContaining({ method: "DELETE", body: `{"version":9223372036854775807,"expectedUserId":"${userId}"}`, headers: { Accept: "application/json", "Content-Type": "application/json" } })]);
  });

  it.each(["9007199254740993", "9223372036854775807"])("parses the original numeric member version lexeme %s", async (version) => {
    const text = stringifyWireJson({ actorAccess: directAccessFixture(projectId, userId), items: [{ ...participant, directGrant: { ...grant, version: 999 } }] }).replace('"version":999', `"version":${version}`);
    mock(new Response(text, { headers: { "Content-Type": "application/json" } }));
    expect((await listMembers(projectId, signal())).items[0]?.directGrant?.version).toBe(BigInt(version));
  });

  it.each(["0", "-1", "1.5", "1e3", "9223372036854775808", '"9007199254740993"'])("rejects invalid membership numeric representations %s", async (version) => {
    const text = stringifyWireJson({ actorAccess: directAccessFixture(projectId, userId), items: [{ ...participant, directGrant: { ...grant, version: 999 } }] }).replace('"version":999', `"version":${version}`);
    mock(new Response(text, { headers: { "Content-Type": "application/json" } }));
    await expect(listMembers(projectId, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it("binds membership responses to both requested IDs", async () => {
    const fetcher = mock(response({ actorAccess: directAccessFixture(projectId, userId), items: [{ ...participant, directGrant: { ...grant, projectId: otherId } }] }));
    await expect(listMembers(projectId, signal())).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValue(response({ ...grant, userId: otherId }));
    await expect(setMemberRole(projectId, userId, { version: 1n, role: "admin", expectedUserId: userId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects invalid observed versions before writes %s", (version) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => setMemberRole(projectId, userId, { version, role: "member", expectedUserId: userId }, signal(), vi.fn())).toThrow();
    expect(() => removeMember(projectId, userId, { version, expectedUserId: userId }, signal(), vi.fn())).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("invitation API", () => {
  const mismatch = vi.fn();
  const admission = { userId, onPrincipalMismatch: mismatch };
  const access = { ...directAccessFixture(projectId, userId, "admin"), directGrant: grant };
  it("binds creation and revocation to the current identity and returns the one-time link", async () => {
    const fetcher = mock(response({ items: [invitation] }));
    expect(await listInvitations(projectId.toUpperCase(), signal(), admission)).toEqual([invitation]);
    const created = { ...invitation, link: `${window.location.origin}/invitations#opaque-invitation` };
    fetcher.mockResolvedValue(response(created, 201));
    expect(await createInvitation(projectId, userId, signal(), mismatch)).toEqual(created);
    expect(fetcher.mock.calls[1]).toEqual([`/api/v1/projects/${projectId}/invitations`, expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUserId: userId }) })]);
    fetcher.mockResolvedValue(new Response(null, { status: 204, headers: { "Daynight-User-ID": userId } }));
    await revokeInvitation(projectId, inviteId.toUpperCase(), userId, signal(), mismatch);
    expect(fetcher.mock.calls[2]).toEqual([`/api/v1/projects/${projectId}/invitations/${inviteId}`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedUserId: userId }) })]);
  });

  it("keeps secrets in bodies and verifies direct grant and effective access without rounding", async () => {
    const secret = "invitation-only-in-body";
    const empty = { projectId, projectName: project.name, directGrant: null, access: null };
    const fetcher = mock(response(empty));
    expect(await inspectInvitation(secret, userId, signal(), mismatch)).toEqual(empty);
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/invitations/inspect", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: secret }) })]);
    fetcher.mockResolvedValue(response({ ...empty, directGrant: grant, access }));
    expect((await inspectInvitation(secret, userId, signal(), mismatch)).directGrant).toEqual(grant);
    const accepted = { projectId, directGrant: grant, access, joined: true, consumed: true };
    fetcher.mockResolvedValue(response(accepted));
    expect(await acceptInvitation(secret, projectId, userId, signal(), mismatch)).toEqual(accepted);
    expect(fetcher.mock.calls[2]).toEqual(["/api/v1/invitations/accept", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: secret, expectedUserId: userId }) })]);
    for (const [url] of fetcher.mock.calls) expect(url).not.toContain(secret);
  });

  it("rejects wrong principals and malformed acceptance results without replay or secret causes", async () => {
    const secret = "secret-in-error";
    const fetcher = mock(new Response(JSON.stringify({ projectId }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": otherId } }));
    await expect(acceptInvitation(secret, projectId, userId, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalled();
    fetcher.mockResolvedValue(response({ projectId, directGrant: { ...grant, userId: otherId }, access, joined: true, consumed: true }));
    await expect(acceptInvitation(secret, projectId, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockRejectedValue(new Error(secret));
    for (const call of [() => inspectInvitation(secret, userId, signal(), mismatch), () => acceptInvitation(secret, projectId, userId, signal(), mismatch)]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).not.toHaveProperty("cause");
      expect(String(failure)).not.toContain(secret);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["", "secret\nvalue", "secret value", "secret\0value", "secret\ud800value"])("rejects malformed invitation secrets without exposing them %#", (secret) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const call of [() => inspectInvitation(secret, userId, signal(), mismatch), () => acceptInvitation(secret, projectId, userId, signal(), mismatch)]) {
      try { call(); expect.unreachable(); } catch (error) { expect(error).toBeInstanceOf(ApiError); if (secret !== "") expect(String(error)).not.toContain(secret); }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("auth API failures", () => {
  it("uses the generic safe message for unknown error codes that match object prototype keys", () => {
    expect(new ApiError("server", 500, "constructor", "request-1").message).toBe("Unable to load the requested data. Please try again.");
  });

  it.each([[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [409, "version_conflict"], [410, "invitation_unavailable"]] as const)("preserves %i/%s without retaining raw server messages or retrying writes", async (status, code) => {
    const fetcher = mock(refusal(status, code));
    const failure = await setMemberRole(projectId, userId, { version: 1n, role: "member", expectedUserId: userId }, signal(), vi.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "server", status, code, requestId: "auth-1" });
    expect(String(failure)).not.toContain("sensitive-token-must-not-escape");
    expect(failure).not.toHaveProperty("cause");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves structured errors for bodyless operations and rejects unexpected successful statuses", async () => {
    const fetcher = mock(refusal(403, "forbidden"));
    await expect(revokeToken(tokenId, signal())).rejects.toMatchObject({ kind: "server", status: 403, code: "forbidden" });
    fetcher.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(logout(signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it("discards malformed secret-bearing success responses and network diagnostics", async () => {
    const secret = "sensitive-token-must-not-escape";
    const fetcher = mock(response({ ...pat, token: `${secret}\n` }, 201));
    const failure = await createToken({ name: "name", expiresAt: null }, signal()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "protocol", status: 201 });
    expect(String(failure)).not.toContain(secret);
    expect(failure).not.toHaveProperty("cause");
    fetcher.mockRejectedValue(new Error(secret));
    const networkFailure = await createToken({ name: "name", expiresAt: null }, signal()).catch((error: unknown) => error);
    expect(networkFailure).toMatchObject({ kind: "network", status: null });
    expect(networkFailure).not.toHaveProperty("cause");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation identity while sanitizing auth request errors", async () => {
    const reason = new Error("identity changed");
    const controller = new AbortController();
    const fetcher = mock(new Response());
    fetcher.mockImplementation(async () => { controller.abort(reason); throw new TypeError("transport detail"); });
    await expect(createToken({ name: "name", expiresAt: null }, controller.signal)).rejects.toBe(reason);
  });
});

describe("shared unauthorized notifications", () => {
  it("notifies on an actual 401 even when its JSON body is malformed, including attachment HEAD", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnauthorized(listener);
    try {
      const fetcher = mock(new Response("malformed", { status: 401, headers: { "Content-Type": "application/json" } }));
      await expect(me(signal())).rejects.toMatchObject({ kind: "protocol", status: 401 });
      expect(listener).toHaveBeenCalledTimes(1);
      fetcher.mockResolvedValue(new Response(null, { status: 401, headers: { "X-Request-ID": "head-1" } }));
      await expect(checkAttachmentPreview(projectId, userId, "index.html", signal())).rejects.toMatchObject({ kind: "server", status: 401, code: "unauthenticated", requestId: "head-1" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it.each([403, 404, 409, 410, 500])("does not turn HTTP %i into a global identity change", async (status) => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnauthorized(listener);
    try { mock(refusal(status, "not_found")); await expect(me(signal())).rejects.toMatchObject({ status }); expect(listener).not.toHaveBeenCalled(); }
    finally { unsubscribe(); }
  });

  it.each(["abort", "new identity"])("suppresses a stale 401 after %s", async (transition) => {
    let complete!: (value: Response) => void;
    const controller = new AbortController();
    const listener = vi.fn();
    const unsubscribe = subscribeUnauthorized(listener);
    mock(new Response());
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    try {
      const pending = me(controller.signal);
      if (transition === "abort") controller.abort(); else invalidateAuthRequests();
      complete(refusal(401, "unauthenticated"));
      await expect(pending).rejects.toBeDefined();
      expect(listener).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("unsubscribes listeners and never notifies for a network error", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnauthorized(listener);
    unsubscribe();
    const fetcher = mock(refusal(401, "unauthenticated"));
    await expect(me(signal())).rejects.toMatchObject({ status: 401 });
    fetcher.mockRejectedValue(new Error("401 secret"));
    await expect(listProjects({}, signal())).rejects.toMatchObject({ kind: "network" });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("identity-bound grant mutation responses", () => {
  it.each(["role", "remove"] as const)("checks principal before reading %s success or refusal", async (operation) => {
    for (const status of operation === "role" ? [200, 409] : [204, 409]) {
      const body = status === 204 ? new Response(null, { status }) : response(status === 200 ? grant : { error: { code: "version_conflict", message: "Refused", requestId: "safe-id" } }, status);
      body.headers.set("Daynight-User-ID", otherId);
      const text = vi.spyOn(body, "text"), mismatch = vi.fn();
      const fetcher = mock(body);
      const pending = operation === "role" ? setMemberRole(projectId, userId, { version: 1n, role: "admin", expectedUserId: userId }, signal(), mismatch)
        : removeMember(projectId, userId, { version: 1n, expectedUserId: userId }, signal(), mismatch);
      await expect(pending).rejects.toMatchObject({ kind: "protocol", code: "principal_mismatch" });
      expect(mismatch).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("routes a declared identity mismatch separately from grant version conflict", async () => {
    const mismatch = vi.fn(), fetcher = mock(refusal(409, "identity_mismatch"));
    await expect(setMemberRole(projectId, userId, { version: 1n, role: "member", expectedUserId: userId }, signal(), mismatch)).rejects.toMatchObject({ kind: "server", code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects flat legacy mutation success and malformed grant observations without replay", async () => {
    const fetcher = mock(response(member));
    await expect(setMemberRole(projectId, userId, { version: 1n, role: "member", expectedUserId: userId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});


describe("Team invitation API", () => {
  const team = { id: projectId, kind: "ordinary", name: "Team" };
  const membership = { teamId: projectId, userId, role: "member", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
  it("checks identity, precise membership versions and the target of an acceptance", async () => {
    const fetcher = mock(response({ team, membership }));
    expect(await inspectTeamInvitation("dnteam_secret", userId, signal(), vi.fn())).toEqual({ team, membership });
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/team-invitations/inspect", expect.objectContaining({ body: JSON.stringify({ token: "dnteam_secret" }) })]);
    fetcher.mockResolvedValueOnce(response({ team, membership, joined: true, consumed: true }));
    expect(await acceptTeamInvitation("dnteam_secret", projectId, userId, signal(), vi.fn())).toEqual({ team, membership, joined: true, consumed: true });
    fetcher.mockResolvedValueOnce(response({ team, membership: { ...membership, userId: otherId }, joined: true, consumed: true }));
    await expect(acceptTeamInvitation("dnteam_secret", projectId, userId, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValueOnce(response({ team, membership, joined: true, consumed: false }));
    await expect(acceptTeamInvitation("dnteam_secret", projectId, userId, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValueOnce(response({ team: { ...team, id: otherId }, membership, joined: true, consumed: true }));
    await expect(acceptTeamInvitation("dnteam_secret", projectId, userId, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });
});
