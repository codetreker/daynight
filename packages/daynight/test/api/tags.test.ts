import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";

const project = "11111111-1111-4111-8111-111111111111";
const otherProject = "22222222-2222-4222-8222-222222222222";
const firstId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const epoch = "55555555-5555-4555-8555-555555555555";
const version = 9_007_199_254_740_993n;
const tag = (id = firstId, extra: Record<string, unknown> = {}) => ({
  id, projectId: project, name: "Project tag", version, createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-02T03:04:05Z", usage: { tasks: 4, goals: 2 }, ...extra,
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const cleanups: (() => void)[] = [];
const client = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
};
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("project tag catalog API", () => {
  it("collects all pages using the same parameters and preserves exact versions and epoch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: [tag()], catalogEpoch: epoch, nextCursor: "cursor +/" })).mockResolvedValueOnce(json({ items: [tag(secondId)], catalogEpoch: epoch, nextCursor: null }));
    const result = await client(fetch).listTags(project.toUpperCase(), { query: "Label +", limit: 1 });
    expect(result).toEqual({ items: [tag(), tag(secondId)], catalogEpoch: epoch, nextCursor: null });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      const target = new URL(String(url));
      expect(target.pathname).toBe(`/api/v1/projects/${project}/tags`);
      expect(target.searchParams.get("query")).toBe("Label +");
      expect(target.searchParams.get("limit")).toBe("1");
      expect(options?.headers).toMatchObject({ Accept: "application/json", Authorization: "Bearer fixture-token" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("cursor")).toBe("cursor +/");
  });

  it("preserves an explicitly supplied cursor and returns an empty catalog", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ items: [], catalogEpoch: epoch, nextCursor: null }));
    expect(await client(fetch).listTags(project, { cursor: "start" })).toEqual({ items: [], catalogEpoch: epoch, nextCursor: null });
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("cursor")).toBe("start");
  });

  it.each(["epoch", "identity", "cursor"])("rejects inconsistent pagination (%s) rather than returning a partial result", async kind => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: [tag()], catalogEpoch: epoch, nextCursor: "next" })).mockResolvedValueOnce(json({ items: [tag(kind === "identity" ? firstId : secondId)], catalogEpoch: kind === "epoch" ? otherProject : epoch, nextCursor: kind === "cursor" ? "next" : null }));
    await expect(client(fetch).listTags(project)).rejects.toMatchObject({ phase: "pagination" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates a catalog change on a later page without replay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: [tag()], catalogEpoch: epoch, nextCursor: "next" })).mockResolvedValueOnce(json({ error: { code: "catalog_changed", message: "Catalog changed", requestId: "request-1" } }, 409));
    await expect(client(fetch).listTags(project)).rejects.toMatchObject({ phase: "response", code: "catalog_changed", status: 409 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("constructs scoped reads and writes with exact int64 versions and stable receipts", async () => {
    const created = tag(firstId, { version: 1n, name: "New" });
    const renamed = tag(firstId, { version: version + 1n, name: "Renamed" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(tag())).mockResolvedValueOnce(json(created, 201, { Location: `/api/v1/projects/${project}/tags/${firstId}` })).mockResolvedValueOnce(json(renamed)).mockResolvedValueOnce(json({ projectId: project, tagId: firstId, deleted: true }));
    const api = client(fetch);
    expect(await api.getTag(project, firstId.toUpperCase())).toEqual(tag());
    expect(await api.createTag(project, " New ")).toEqual(created);
    expect(await api.renameTag(project, firstId, "Renamed", version)).toEqual(renamed);
    expect(await api.deleteTag(project, firstId, version)).toEqual({ projectId: project, tagId: firstId, deleted: true });
    expect(fetch.mock.calls.map(([url, opts]) => [String(url), opts!.method, opts!.body])).toEqual([
      [`http://localhost:8787/api/v1/projects/${project}/tags/${firstId}`, "GET", undefined],
      [`http://localhost:8787/api/v1/projects/${project}/tags`, "POST", '{"name":" New "}'],
      [`http://localhost:8787/api/v1/projects/${project}/tags/${firstId}`, "PATCH", '{"version":9007199254740993,"name":"Renamed"}'],
      [`http://localhost:8787/api/v1/projects/${project}/tags/${firstId}`, "DELETE", '{"version":9007199254740993,"confirm":true}'],
    ]);
  });

  it.each([{ projectId: otherProject }, { id: secondId }, { version: 0 }, { usage: { tasks: -1, goals: 0 } }, { name: " trailing " }])("rejects malformed or mismatched tag responses: %#", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(tag(firstId, changes)));
    await expect(client(fetch).getTag(project, firstId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([{ status: 409, code: "version_conflict", confirmed: true }, { status: 409, code: "tag_name_conflict", confirmed: true }, { status: 403, code: "forbidden", confirmed: true }, { status: 503, code: "write_outcome_unknown", confirmed: false }])("propagates $code without replay", async ({ status, code, confirmed }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: "Refused", requestId: "request-2" } }, status));
    await expect(client(fetch).renameTag(project, firstId, "Name", version)).rejects.toMatchObject({ status, code, confirmedRefusal: confirmed, outcomeUnconfirmed: !confirmed });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("treats a wrong deletion receipt as an unconfirmed mutation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ projectId: project, tagId: secondId, deleted: true }));
    await expect(client(fetch).deleteTag(project, firstId, version)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
