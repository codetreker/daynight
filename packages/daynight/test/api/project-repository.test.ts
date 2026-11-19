import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { Operation, ProjectRepositoryPreview } from "../../src/api/index.js";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const preview: ProjectRepositoryPreview = { projectId, projectName: "Project", currentRepoUrl: "https://example.com/a", repoUrl: "https://example.com/b", repositoryVersion: "9007199254740993", ownershipVersion: "9223372036854775807", classification: "unverified", targetGitHubRepositoryId: null, unverifiedReason: "no_github_access", bindingsInvalidated: true };
const receipt = { projectId, repoUrl: preview.repoUrl, repositoryVersion: "9007199254740994", changed: true, bindingsInvalidated: true };
const response = (value: unknown, principal = user, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal, ...(status >= 400 ? { "X-Request-ID": "request" } : {}) } });
const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
afterEach(() => operations.splice(0).forEach((operation) => operation.dispose()));

describe("project repository protocol", () => {
  it("submits the exact preview and principal, preserves decimal int64 strings and validates the receipt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response(receipt));
    const api = client(fetch);
    const observed = await api.previewProjectRepository(user, projectId, preview.repoUrl);
    expect(await api.setProjectRepository(user, projectId, observed, true, "request-1")).toEqual(receipt);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/repository/preview`);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ repoUrl: preview.repoUrl, expectedUserId: user });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ repoUrl: preview.repoUrl, expectedUserId: user, repositoryVersion: "9007199254740993", ownershipVersion: "9223372036854775807", classification: "unverified", targetGitHubRepositoryId: null, treatUnverifiedAsSwitch: true });
    expect(fetch.mock.calls[1]![1]?.method).toBe("PATCH");
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("X-Request-ID")).toBe("request-1");
  });
  it.each([
    { ...preview, projectId: other }, { ...preview, repoUrl: "other" }, { ...preview, repositoryVersion: "01" },
    { ...preview, repositoryVersion: "9223372036854775808" }, { ...preview, ownershipVersion: 1 },
    { ...preview, targetGitHubRepositoryId: "0" }, { ...preview, unverifiedReason: null },
    { ...preview, classification: "different_repository", unverifiedReason: "no_github_access" },
    { ...preview, bindingsInvalidated: false }, { ...preview, extra: true },
  ])("rejects malformed or mismatched preview %#", async (bad) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(bad))).previewProjectRepository(user, projectId, preview.repoUrl)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it.each([
    { ...receipt, projectId: other }, { ...receipt, repoUrl: "other" }, { ...receipt, repositoryVersion: preview.repositoryVersion },
    { ...receipt, changed: false }, { ...receipt, bindingsInvalidated: false }, { ...receipt, repositoryVersion: 9007199254740994 },
  ])("does not confirm inconsistent receipts %#", async (bad) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(bad))).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("supports unchanged and same-repository results without invalidation", async () => {
    for (const same of [true, false]) {
      const observed: ProjectRepositoryPreview = { ...preview, currentRepoUrl: same ? preview.repoUrl : preview.currentRepoUrl, classification: same ? "unchanged" : "same_repository", unverifiedReason: null, bindingsInvalidated: false, targetGitHubRepositoryId: same ? null : "9007199254740993" };
      const result = { ...receipt, repositoryVersion: same ? preview.repositoryVersion : receipt.repositoryVersion, changed: !same, bindingsInvalidated: false };
      expect(await client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(result))).setProjectRepository(user, projectId, observed, false, "request")).toEqual(result);
    }
  });
  it("preserves a proven different repository ID and confirms invalidation", async () => {
    const observed: ProjectRepositoryPreview = { ...preview, classification: "different_repository", unverifiedReason: null, targetGitHubRepositoryId: "9223372036854775807" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(observed)).mockResolvedValueOnce(response(receipt));
    const api = client(fetch);
    const read = await api.previewProjectRepository(user, projectId, preview.repoUrl);
    expect(await api.setProjectRepository(user, projectId, read, false, "request")).toEqual(receipt);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).targetGitHubRepositoryId).toBe("9223372036854775807");
  });
  it("refuses an unverified write without explicit choice before dispatch", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).setProjectRepository(user, projectId, preview, false, "request")).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes confirmed conflict, unknown write and failed preview without retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ error: { code: "version_conflict", message: "conflict", requestId: "request" } }, user, 409)).mockRejectedValueOnce(new Error("lost receipt")).mockRejectedValueOnce(new Error("offline"));
    const api = client(fetch);
    await expect(api.setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ code: "version_conflict", confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(api.previewProjectRepository(user, projectId, preview.repoUrl)).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("treats a server-reported unknown commit as unconfirmed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "write_outcome_unknown", message: "unknown", requestId: "request" } }, user, 503));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ code: "write_outcome_unknown", outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400, "invalid_input"], [403, "forbidden"], [404, "not_found"], [409, "version_conflict"],
    [409, "project_repository_conflict"], [409, "version_exhausted"], [409, "identity_mismatch"],
  ])("confirms a matching authenticated refusal: %s %s", async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code, message: "refused", requestId: "request" } }, user, status));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ code, confirmedRefusal: true, outcomeUnconfirmed: false });
  });
  it("confirms a matched authentication refusal without an authenticated principal", async () => {
    const body = JSON.stringify({ error: { code: "unauthenticated", message: "refused", requestId: "request" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 401, headers: { "content-type": "application/json", "X-Request-ID": "request" } }));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ confirmedRefusal: true, outcomeUnconfirmed: false });
  });
  it.each([
    { status: 409, code: "version_conflict", principal: user, headerId: "other", bodyId: "request" },
    { status: 409, code: "version_conflict", principal: user, headerId: "request", bodyId: "other" },
    { status: 409, code: "version_conflict", principal: user, headerId: null, bodyId: "request" },
    { status: 409, code: "version_conflict", principal: null, headerId: "request", bodyId: "request" },
    { status: 409, code: "version_conflict", principal: other, headerId: "request", bodyId: "request" },
    { status: 409, code: "invented", principal: user, headerId: "request", bodyId: "request" },
    { status: 403, code: "version_conflict", principal: user, headerId: "request", bodyId: "request" },
    { status: 500, code: "internal_error", principal: user, headerId: "request", bodyId: "request" },
    { status: 401, code: "unauthenticated", principal: other, headerId: "request", bodyId: "request" },
  ])("does not confirm an uncorrelated or unsupported refusal %#", async ({ status, code, principal, headerId, bodyId }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (principal !== null) headers["Daynight-User-ID"] = principal;
    if (headerId !== null) headers["X-Request-ID"] = headerId;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: "refused", requestId: bodyId } }), { status, headers }));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ confirmedRefusal: false, outcomeUnconfirmed: true });
  });
  it.each([
    '{"error":{"code":"version_conflict","code":"version_conflict","message":"refused","requestId":"request"}}',
    '{"error":{"code":"version_conflict","message":"refused","requestId":"request"},"extra":true}',
    '{"error":{"code":"version_conflict","message":"refused","requestId":"request","details":{"unknown":true}}}',
  ])("treats malformed error envelopes as unknown", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 409, headers: { "content-type": "application/json", "X-Request-ID": "request", "Daynight-User-ID": user } }));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ confirmedRefusal: false, outcomeUnconfirmed: true });
  });
  it("does not infer rollback from an internal error with a not-committed claim", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "internal_error", message: "failed", requestId: "request", details: { writeOutcome: "not_committed" } } }, user, 500));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ confirmedRefusal: false, outcomeUnconfirmed: true });
  });
  it("rejects responses from another user", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(preview, other)).mockResolvedValueOnce(response(receipt, other));
    const api = client(fetch);
    await expect(api.previewProjectRepository(user, projectId, preview.repoUrl)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("rejects duplicate fields in an otherwise valid receipt", async () => {
    const body = JSON.stringify(receipt).replace('"changed":true', '"changed":false,"changed":true');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": user } }));
    await expect(client(fetch).setProjectRepository(user, projectId, preview, true, "request")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
});
