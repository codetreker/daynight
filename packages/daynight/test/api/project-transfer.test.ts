import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, ProjectTransferPreview } from "../../src/api/index.js";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const source = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "ordinary" as const, name: "Source" };
const target = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", kind: "ordinary" as const, name: "Target", version: 9_007_199_254_740_993n };
const preview: ProjectTransferPreview = { sourceTeam: source, targetTeam: target, ownership: { teamId: source.id, version: 9_007_199_254_740_994n }, actorRole: null };
const receipt = { projectId, changed: true, sourceTeam: source, ownerTeam: { id: target.id, kind: target.kind, name: target.name }, ownership: { teamId: target.id, version: preview.ownership.version + 1n }, actorAccess: null };
const response = (value: unknown, principal = user, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
afterEach(() => operations.splice(0).forEach((operation) => operation.dispose()));

describe("project transfer protocol", () => {
  it("preserves exact versions, submits the preview and accepts loss of access without another GET", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response(receipt));
    const api = client(fetch);
    const seen = await api.previewProjectTransfer(user, projectId, target.id);
    expect(seen).toEqual(preview);
    expect(await api.transferProject(user, projectId, seen, "transfer-1")).toEqual(receipt);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ targetTeamId: target.id });
    expect(String(fetch.mock.calls[1]![1]?.body)).toBe(`{"ownership":{"teamId":"${source.id}","version":9007199254740994},"targetTeam":{"id":"${target.id}","version":9007199254740993},"expectedUserId":"${user}"}`);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("X-Request-ID")).toBe("transfer-1");
  });
  it("validates same-owner no-op and nullable result", async () => {
    const same = { ...preview, targetTeam: { ...source, version: 5n }, actorRole: "admin" as const };
    const result = { ...receipt, changed: false, ownerTeam: source, ownership: same.ownership };
    expect(await client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(result))).transferProject(user, projectId, same, "same")).toEqual(result);
  });
  it("accepts a source rename and validates retained access from the receipt", async () => {
    const access = { projectId, ownerTeam: receipt.ownerTeam, ownership: receipt.ownership, effectiveRole: "member", teamRole: "member", directGrant: null, canTransfer: false };
    const result = { ...receipt, sourceTeam: { ...source, name: "Renamed" }, actorAccess: access };
    expect(await client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(result))).transferProject(user, projectId, preview, "retained")).toEqual(result);
  });
  it.each([
    { ...preview, ownership: { ...preview.ownership, teamId: target.id } },
    { ...preview, targetTeam: { ...target, id: other } },
    { ...preview, actorRole: "owner" },
    { ...preview, targetTeam: { ...target, version: "9007199254740993" } },
    { ...preview, extra: true },
  ])("rejects malformed or inconsistent previews %#", async (bad) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(bad))).previewProjectTransfer(user, projectId, target.id)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it.each([
    { ...receipt, projectId: other },
    { ...receipt, changed: false },
    { ...receipt, sourceTeam: target },
    { ...receipt, ownerTeam: { ...receipt.ownerTeam, name: "changed" } },
    { ...receipt, ownership: { ...receipt.ownership, version: 1n } },
    { ...receipt, actorAccess: { projectId, ownerTeam: receipt.ownerTeam, ownership: receipt.ownership, effectiveRole: "admin", teamRole: "admin", directGrant: null, canTransfer: false } },
  ])("leaves a malformed receipt unconfirmed %#", async (bad) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(bad))).transferProject(user, projectId, preview, "request")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("rejects another principal on success and refusal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(preview, other)).mockResolvedValueOnce(response({ error: { code: "version_conflict", message: "conflict", requestId: "request" } }, other, 409));
    const api = client(fetch);
    await expect(api.previewProjectTransfer(user, projectId, target.id)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.transferProject(user, projectId, preview, "request")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("distinguishes confirmed conflict, unknown response and read-only preview failure without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ error: { code: "version_conflict", message: "conflict", requestId: "request" } }, user, 409)).mockRejectedValueOnce(new Error("lost receipt")).mockRejectedValueOnce(new Error("preview offline"));
    const api = client(fetch);
    await expect(api.transferProject(user, projectId, preview, "conflict")).rejects.toMatchObject({ code: "version_conflict", confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.transferProject(user, projectId, preview, "lost")).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(api.previewProjectTransfer(user, projectId, target.id)).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("binds an explicit project read to the chosen user", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "not_found", message: "missing", requestId: "request" } }, other, 404));
    await expect(client(fetch).getProject(projectId, user)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("binds each project discovery page and error to the chosen user", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ items: [], nextCursor: "next" })).mockResolvedValueOnce(response({ items: [], nextCursor: null }, other)).mockResolvedValueOnce(response({ error: { code: "not_found", message: "missing", requestId: "request" } }, other, 404));
    const api = client(fetch);
    await expect(api.listProjects(user)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.listProjects(user)).rejects.toMatchObject({ phase: "protocol" });
  });
});
