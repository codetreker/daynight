import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, OperationError } from "../../src/api/index.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const invitationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secret = `dnteam_${Buffer.alloc(32, 7).toString("base64url")}`;
const link = `https://daynight.example/team-invitations#${secret}`;
const metadata = { id: invitationId, teamId, createdBy: userId, createdAt: "2026-11-04T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });
const client = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "https://daynight.example", operation, fetch });
};
const response = (body: string, status = 200, principal = userId, location?: string, headers?: Record<string, string>) => new Response(body, { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal, ...(location === undefined ? {} : { Location: location }), ...headers } });
const location = `/api/v1/teams/${teamId}/invitations/${invitationId}`;

describe("Team invitation API", () => {
  it("creates once, lists only metadata, and retains both revoke outcomes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(JSON.stringify({ ...metadata, link }), 201, userId, location))
      .mockResolvedValueOnce(response(JSON.stringify({ items: [metadata] })))
      .mockResolvedValueOnce(response(JSON.stringify({ teamId, invitationId, changed: true })))
      .mockResolvedValueOnce(response(JSON.stringify({ teamId, invitationId, changed: false })));
    const api = client(fetch);
    await expect(api.createTeamInvitation(userId, teamId, "request-id")).resolves.toEqual({ ...metadata, link });
    await expect(api.listTeamInvitations(userId, teamId)).resolves.toEqual([metadata]);
    await expect(api.revokeTeamInvitation(userId, teamId, invitationId, "request-id")).resolves.toEqual({ teamId, invitationId, changed: true });
    await expect(api.revokeTeamInvitation(userId, teamId, invitationId, "request-id")).resolves.toEqual({ teamId, invitationId, changed: false });
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET", "DELETE", "DELETE"]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ expectedUserId: userId });
    expect(JSON.parse(String(fetch.mock.calls[2]![1]!.body))).toEqual({ expectedUserId: userId });
  });
  it("parses complete consumed and revoked metadata without returning a secret", async () => {
    const consumed = { ...metadata, consumedBy: otherId, consumedAt: "2026-11-05T00:00:00Z" };
    const revoked = { ...metadata, id: otherId, revokedAt: "2026-11-06T00:00:00Z" };
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(JSON.stringify({ items: [consumed, revoked] }))));
    await expect(api.listTeamInvitations(userId, teamId)).resolves.toEqual([consumed, revoked]);
  });
  it.each([`{"items":[{"link":"${secret}",`, JSON.stringify({ error: { code: "forbidden", message: secret, requestId: secret } })])("does not leak malformed or hostile list diagnostics", async (body) => {
    const failure = body.startsWith('{"error"');
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, failure ? 403 : 200, userId, undefined, { "X-Request-ID": secret })));
    let error: unknown;
    try { await api.listTeamInvitations(userId, teamId); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
  });
  it.each([
    { items: [{ ...metadata, link }] },
    { items: [metadata, metadata] },
    { items: [{ ...metadata, teamId: otherId }] },
    { items: [{ ...metadata, consumedAt: metadata.createdAt }] },
  ])("rejects malformed or secret-bearing metadata", async (body) => {
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(JSON.stringify(body))));
    await expect(api.listTeamInvitations(userId, teamId)).rejects.toThrow();
  });
  it.each([
    JSON.stringify({ ...metadata, link: `${link}?bad` }),
    JSON.stringify({ ...metadata, link: link.replace("https://daynight.example", "https://evil.example") }),
    JSON.stringify({ ...metadata, link, createdBy: otherId }),
    `{"link":"${secret}",`,
    JSON.stringify({ error: { code: "identity_mismatch", message: secret, requestId: secret } }),
  ])("does not leak malformed or hostile secret responses in any diagnostic cause", async (body) => {
    const failure = body.startsWith('{"error"');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, failure ? 409 : 201, userId, location, { "X-Request-ID": secret }));
    const api = client(fetch);
    let error: unknown;
    try { await api.createTeamInvitation(userId, teamId, "request-id"); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ outcomeUnconfirmed: !failure, ...(failure ? { code: "identity_mismatch", confirmedRefusal: true } : {}) });
  });
  it("does not leak stream failures or cleanup errors after a secret response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error(secret)); },
    });
    const broken = new Response(stream, { status: 201, headers: { "content-type": "application/json", "Daynight-User-ID": userId, Location: location } });
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(broken));
    let error: unknown;
    try { await api.createTeamInvitation(userId, teamId, "request-id"); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ outcomeUnconfirmed: true });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
  });
  it.each(["cancelled", "request_timeout", "deadline"] as const)("preserves the safe %s classification and nested error structure", async (kind) => {
    const network = Object.assign(new Error(secret), { code: "ECONNRESET" });
    const original = new AggregateError([new OperationError(kind, { cause: new Error(secret) }), new TypeError(secret, { cause: network })], secret, { cause: new SyntaxError(secret) });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(original);
    let error: unknown;
    try { await client(fetch).createTeamInvitation(userId, teamId, "request-id"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ApiError);
    const cause = (error as ApiError).cause as AggregateError;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause.errors[0]).toMatchObject({ kind });
    expect(cause.errors[0]).toBeInstanceOf(OperationError);
    expect(cause.errors[1]).toBeInstanceOf(TypeError);
    expect((cause.errors[1] as TypeError).cause).toMatchObject({ code: "ECONNRESET" });
    expect(cause.cause).toBeInstanceOf(SyntaxError);
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([true, false])("sends a list request ID and retains only a matching server ID: %s", async (matches) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const sent = new Headers(init?.headers).get("X-Request-ID");
      expect(sent).toMatch(/^[a-f0-9-]{36}$/);
      const requestId = matches ? sent! : secret;
      return response(JSON.stringify({ error: { code: "internal_error", message: secret, requestId } }), 500, userId, undefined, { "X-Request-ID": requestId });
    });
    let error: unknown;
    try { await client(fetch).listTeamInvitations(userId, teamId); } catch (caught) { error = caught; }
    const sent = new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Request-ID");
    expect(error).toMatchObject({ code: "internal_error", sentRequestId: sent, requestId: matches ? sent : "withheld" });
    expect((error as ApiError).responseRequestId).toBe(matches ? sent : undefined);
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
  });
  it("retains only the locally matched response request ID", async () => {
    const body = JSON.stringify({ error: { code: "identity_mismatch", message: secret, requestId: "request-id" } });
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, 409, userId, undefined, { "X-Request-ID": "request-id" })));
    await expect(api.createTeamInvitation(userId, teamId, "request-id")).rejects.toMatchObject({ code: "identity_mismatch", requestId: "request-id", responseRequestId: "request-id", confirmedRefusal: true });
  });
  it.each(["create", "revoke"] as const)("recognizes an actual-principal identity_mismatch refusal for %s without replay", async (action) => {
    const body = JSON.stringify({ error: { code: "identity_mismatch", message: secret, requestId: "request-id" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, 409, otherId));
    const api = client(fetch);
    let error: unknown;
    try {
      if (action === "create") await api.createTeamInvitation(userId, teamId, "request-id");
      else await api.revokeTeamInvitation(userId, teamId, invitationId, "request-id");
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ phase: "response", code: "identity_mismatch", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["create", "revoke"] as const)("treats ambiguous or forged wrong-principal %s responses as unknown", async (action) => {
    const errors = [
      response(JSON.stringify({ error: { code: "forbidden", message: secret, requestId: "request-id" } }), 409, otherId),
      response(JSON.stringify({ error: { code: "identity_mismatch", message: secret, requestId: "request-id" } }), 403, otherId),
      response(JSON.stringify({ error: { code: "identity_mismatch", message: secret } }), 409, otherId),
      response(`{"error":{"code":"identity_mismatch","code":"identity_mismatch","message":"${secret}","requestId":"request-id"}}`, 409, otherId),
      response(JSON.stringify({ error: { code: "identity_mismatch", message: secret, requestId: "request-id" } }), 201, otherId),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(); errors.forEach((value) => fetch.mockResolvedValueOnce(value));
    const api = client(fetch);
    for (const _ of errors) {
      let error: unknown;
      try {
        if (action === "create") await api.createTeamInvitation(userId, teamId, "request-id");
        else await api.revokeTeamInvitation(userId, teamId, invitationId, "request-id");
      } catch (caught) { error = caught; }
      expect(error).toMatchObject({ outcomeUnconfirmed: true, confirmedRefusal: false });
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    }
    expect(fetch).toHaveBeenCalledTimes(errors.length);
  });
  it("rejects wrong principal and preserves unknown after a lost response without replay", async () => {
    const wrong = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(JSON.stringify({ ...metadata, link }), 201, otherId, location));
    await expect(client(wrong).createTeamInvitation(userId, teamId, "request-id")).rejects.toMatchObject({ outcomeUnconfirmed: true });
    const lost = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(secret));
    let error: unknown;
    try { await client(lost).createTeamInvitation(userId, teamId, "request-id"); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ outcomeUnconfirmed: true });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    expect(lost).toHaveBeenCalledOnce();
  });
  it("checks revoke receipt identity and response principal", async () => {
    const wrongReceipt = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(JSON.stringify({ teamId, invitationId: otherId, changed: true })));
    await expect(client(wrongReceipt).revokeTeamInvitation(userId, teamId, invitationId, "request-id")).rejects.toMatchObject({ outcomeUnconfirmed: true });
    const wrongPrincipal = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(JSON.stringify({ items: [] }), 200, otherId));
    await expect(client(wrongPrincipal).listTeamInvitations(userId, teamId)).rejects.toThrow();
  });
});
