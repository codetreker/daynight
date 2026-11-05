import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const another = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-11-04T00:00:00Z";
const team = (id = teamId) => ({ id, kind: "ordinary", name: " Name ", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time, membership: { teamId: id, userId: user, role: "member", version: 9_223_372_036_854_775_807n, createdAt: time, updatedAt: time } });
const me = { id: user, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: another, kind: "personal", name: null } };
const project = { id: another, name: "Project", repoUrl: "git@example.test:org/repo", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: time, updatedAt: time };
const response = (value: unknown, principal: string | undefined = user, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "content-type": "application/json", ...(principal === undefined ? {} : { "Daynight-User-ID": principal }) } });
const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("Team read protocol", () => {
  it("binds /me and every page to the current principal and preserves versions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(me)).mockResolvedValueOnce(response({ items: [team()], nextCursor: "cursor" })).mockResolvedValueOnce(response({ items: [team(another)], nextCursor: null }));
    const api = client(fetch);
    expect(await api.getTeamCurrentUser()).toEqual(me);
    expect(await api.listTeams(user)).toEqual([team(), team(another)]);
    expect(new URL(String(fetch.mock.calls[2]![0])).searchParams.get("cursor")).toBe("cursor");
    expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it.each([undefined, other, user.toUpperCase()])("rejects wrong or absent /me principal %s", async (principal) => {
    const actual = principal === undefined ? new Response(stringifyApiJson(me), { headers: { "content-type": "application/json" } }) : response(me, principal);
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(actual)).getTeamCurrentUser()).rejects.toMatchObject({ phase: "protocol" });
  });
  it("rejects a changed principal even on an error response", async () => {
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ code: "not_found", message: "not found", requestId: "request" }, other, 404)));
    await expect(api.getTeam(user, teamId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("preserves authentication errors without a principal", async () => {
    const body = { error: { code: "unauthenticated", message: "login", requestId: "request" } };
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(api.getTeam(user, teamId)).rejects.toMatchObject({ phase: "response", code: "unauthenticated" });
  });
  it("preserves a non-401 Team refusal when the principal header is absent", async () => {
    const body = { error: { code: "not_found", message: "not found", requestId: "request" } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(client(fetch).getTeam(user, teamId)).rejects.toMatchObject({ phase: "response", status: 404, code: "not_found", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a 401 Team response that names another principal", async () => {
    const body = { error: { code: "unauthenticated", message: "login", requestId: "request" } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, other, 401));
    await expect(client(fetch).getTeam(user, teamId)).rejects.toMatchObject({ phase: "protocol", status: 401, confirmedRefusal: false, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...team(), id: another },
    { ...team(), membership: { ...team().membership, userId: other } },
    { ...team(), membership: { ...team().membership, teamId: another } },
    { ...team(), version: "1" },
  ])("rejects inconsistent Team bodies %#", async (bad) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(bad))).getTeam(user, teamId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it.each(["duplicate", "cursor", "principal"])('rejects pagination failure %s without returning a partial result', async (failure) => {
    const first = { items: [team()], nextCursor: "one" };
    const second = failure === "duplicate" ? { items: [team()], nextCursor: null } : { items: [team(another)], nextCursor: failure === "cursor" ? "one" : null };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second, failure === "principal" ? other : user));
    await expect(client(fetch).listTeams(user)).rejects.toThrow();
  });
  it("filters Team projects and rejects wrong ownership", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ items: [project], nextCursor: null })).mockResolvedValueOnce(response({ items: [{ ...project, ownership: { teamId: another, version: 1n } }], nextCursor: null }));
    const api = client(fetch);
    expect(await api.listTeamProjects(user, teamId)).toEqual([project]);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get("teamId")).toBe(teamId);
    await expect(api.listTeamProjects(user, teamId)).rejects.toMatchObject({ phase: "protocol" });
  });
});
