import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptInvitation, createInvitation, createProject, createToken, getAuthConfig, inspectInvitation, listInvitations, listMembers, listTokens, logout, me, removeMember, revokeInvitation, revokeToken, setMemberRole } from "../src/api/auth";
import { ApiError, checkAttachmentPreview, invalidateAuthRequests, listProjects, pauseAuthRequests, request, subscribeUnauthorized } from "../src/api/client";

const projectId = "10000000-0000-0000-0000-00000000000a";
const userId = "20000000-0000-0000-0000-00000000000b";
const tokenId = "30000000-0000-0000-0000-00000000000c";
const inviteId = "40000000-0000-0000-0000-00000000000d";
const otherId = "50000000-0000-0000-0000-00000000000e";
const time = "2026-10-22T12:34:56.123456789Z";
const user = { id: userId, email: null, emailVerified: false, name: "Member", avatarUrl: null };
const pat = { id: tokenId, name: "Developer machine", createdAt: time, expiresAt: time };
const member = { projectId, userId, email: null, name: "Member", avatarUrl: null, role: "admin", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const invitation = { id: inviteId, projectId, createdBy: userId, createdAt: time, expiresAt: time, consumedBy: null, consumedAt: null, revokedAt: null };
const project = { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: "New project", repoUrl: "git@github.com:org/repo.git", createdAt: time, updatedAt: time };
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

describe("session and personal credentials API", () => {
  it("loads the current nullable profile and the configured provider list from relative endpoints", async () => {
    const fetcher = mock(response(user));
    const abortSignal = signal();
    expect(await me(abortSignal)).toEqual(user);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/me", {
      signal: abortSignal, cache: "no-store", credentials: "same-origin", redirect: "error", headers: { Accept: "application/json" },
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
    const fetcher = mock(response(project, 201));
    expect(await createProject({ name: project.name, repoUrl: project.repoUrl }, signal())).toEqual(project);
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: project.name, repoUrl: project.repoUrl }) })]);
    fetcher.mockResolvedValue(response(project, 200));
    await expect(createProject({ name: project.name, repoUrl: project.repoUrl }, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it.each([{ name: "", repoUrl: "repo" }, { name: "name", repoUrl: " " }, { name: "bad\0name", repoUrl: "repo" }, { name: "name", repoUrl: "bad\0repo" }])("rejects malformed project input before requests %#", (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => createProject(input, signal())).toThrow(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves full int64 member observations in responses and PATCH/DELETE numeric bodies", async () => {
    const maximum = 9_223_372_036_854_775_807n;
    const fetcher = mock(response({ items: [member] }));
    expect(await listMembers(projectId.toUpperCase(), signal())).toEqual([member]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/members`);
    fetcher.mockResolvedValue(response({ ...member, role: "member", version: maximum }));
    expect(await setMemberRole(projectId, userId.toUpperCase(), { version: member.version, role: "member" }, signal())).toEqual({ ...member, role: "member", version: maximum });
    expect(fetcher.mock.calls[1]?.[1].body).toBe('{"version":9007199254740993,"role":"member"}');
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await removeMember(projectId, userId, maximum, signal());
    expect(fetcher.mock.calls[2]).toEqual([`/api/v1/projects/${projectId}/members/${userId}`, expect.objectContaining({ method: "DELETE", body: '{"version":9223372036854775807}', headers: { "Content-Type": "application/json" } })]);
  });

  it.each(["9007199254740993", "9223372036854775807"])("parses the original numeric member version lexeme %s", async (version) => {
    const text = JSON.stringify({ items: [{ ...member, version: 1 }] }).replace('"version":1', `"version":${version}`);
    mock(new Response(text, { headers: { "Content-Type": "application/json" } }));
    expect((await listMembers(projectId, signal()))[0]?.version).toBe(BigInt(version));
  });

  it.each(["0", "-1", "1.5", "1e3", "9223372036854775808", '"9007199254740993"'])("rejects invalid membership numeric representations %s", async (version) => {
    const text = JSON.stringify({ items: [{ ...member, version: 1 }] }).replace('"version":1', `"version":${version}`);
    mock(new Response(text, { headers: { "Content-Type": "application/json" } }));
    await expect(listMembers(projectId, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it("binds membership responses to both requested IDs", async () => {
    const fetcher = mock(response({ items: [{ ...member, projectId: otherId }] }));
    await expect(listMembers(projectId, signal())).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValue(response({ ...member, userId: otherId }));
    await expect(setMemberRole(projectId, userId, { version: 1n, role: "admin" }, signal())).rejects.toMatchObject({ kind: "protocol" });
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects invalid observed versions before writes %s", (version) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => setMemberRole(projectId, userId, { version, role: "member" }, signal())).toThrow();
    expect(() => removeMember(projectId, userId, version, signal())).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("invitation API", () => {
  it("lists invitations and returns only the current origin's one-time link from creation", async () => {
    const fetcher = mock(response({ items: [invitation] }));
    expect(await listInvitations(projectId.toUpperCase(), signal())).toEqual([invitation]);
    const created = { ...invitation, link: `${window.location.origin}/invitations#opaque-invitation` };
    fetcher.mockResolvedValue(response(created, 201));
    expect(await createInvitation(projectId, signal())).toEqual(created);
    expect(fetcher.mock.calls[1]).toEqual([`/api/v1/projects/${projectId}/invitations`, expect.objectContaining({ method: "POST", body: "{}" })]);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await revokeInvitation(projectId, inviteId.toUpperCase(), signal());
    expect(fetcher.mock.calls[2]).toEqual([`/api/v1/projects/${projectId}/invitations/${inviteId}`, expect.objectContaining({ method: "DELETE" })]);
  });

  it("sends invitation secrets only in JSON bodies and explicitly separates inspection from acceptance", async () => {
    const secret = "invitation-only-in-body";
    const fetcher = mock(response({ projectId, projectName: project.name }));
    expect(await inspectInvitation(secret, signal())).toEqual({ projectId, projectName: project.name });
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/invitations/inspect", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: secret }) })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(response({ projectId, projectName: project.name, member }));
    expect((await inspectInvitation(secret, signal())).member).toEqual(member);
    fetcher.mockResolvedValue(response(member));
    expect(await acceptInvitation(secret, signal())).toEqual(member);
    expect(fetcher.mock.calls[2]).toEqual(["/api/v1/invitations/accept", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: secret }) })]);
    for (const [url] of fetcher.mock.calls) expect(url).not.toContain(secret);
  });

  it.each(["", "secret\nvalue", "secret value", "secret\0value", "secret\ud800value"])("rejects malformed invitation secrets without exposing them %#", (secret) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const call of [inspectInvitation, acceptInvitation]) {
      try { call(secret, signal()); expect.unreachable(); }
      catch (error) { expect(error).toBeInstanceOf(ApiError); if (secret !== "") expect(String(error)).not.toContain(secret); }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("auth API failures", () => {
  it("uses the generic safe message for unknown error codes that match object prototype keys", () => {
    expect(new ApiError("server", 500, "constructor", "request-1").message).toBe("Unable to load the requested data. Please try again.");
  });

  it.each([[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [409, "version_conflict"], [409, "last_admin"], [410, "invitation_unavailable"]] as const)("preserves %i/%s without retaining raw server messages or retrying writes", async (status, code) => {
    const fetcher = mock(refusal(status, code));
    const failure = await setMemberRole(projectId, userId, { version: 1n, role: "member" }, signal()).catch((error: unknown) => error);
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
