import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseAuthRequests } from "../src/api/client";
import { createProjectTag, deleteProjectTag, getProjectTag, listProjectTags, normalizeTagName, renameProjectTag, resolveProjectTags, tagNameKey } from "../src/api/task-tags";

const project = "10000000-0000-4000-8000-000000000001", user = "20000000-0000-4000-8000-000000000001";
const tag = "30000000-0000-4000-8000-000000000001", other = "30000000-0000-4000-8000-000000000002", epoch = "40000000-0000-4000-8000-000000000001";
const time = "2026-11-13T12:00:00Z";
const resource = `{"id":"${tag}","projectId":"${project}","name":"Alpha","version":9223372036854775807,"createdAt":"${time}","updatedAt":"${time}","usage":{"tasks":3,"goals":2}}`;
const reply = (body: string, status = 200, principal = user) => new Response(body, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const signal = () => new AbortController().signal;
const admission = () => ({ userId: user, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn(), onWriteConfirmed: vi.fn(), onWriteRejected: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe("project tag API", () => {
  it("reads a scoped page and preserves the exact nested int64", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(`{"items":[${resource}],"catalogEpoch":"${epoch}","nextCursor":"next"}`)); vi.stubGlobal("fetch", fetcher);
    const page = await listProjectTags(project, { query: "a & 中", limit: 50, cursor: "cursor" }, signal(), admission());
    expect(page.items[0]).toMatchObject({ id: tag, projectId: project, version: 9223372036854775807n, usage: { tasks: 3, goals: 2 } });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tags?query=a+%26+%E4%B8%AD&limit=50&cursor=cursor`, expect.anything());
  });
  it("omits an empty search while retaining pagination", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(`{"items":[${resource}],"catalogEpoch":"${epoch}","nextCursor":null}`)); vi.stubGlobal("fetch", fetcher);
    await expect(listProjectTags(project, { query: "", limit: 50, cursor: "cursor" }, signal(), admission())).resolves.toMatchObject({ items: [{ id: tag }] });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tags?limit=50&cursor=cursor`, expect.anything());
  });
  it("retains catalog_changed instead of treating an error as an empty page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply('{"error":{"code":"catalog_changed","message":"changed","requestId":"r"}}', 409)));
    await expect(listProjectTags(project, { query: "", limit: 50, cursor: "old" }, signal(), admission())).rejects.toMatchObject({ kind: "server", code: "catalog_changed" });
  });
  it("checks principal, identity and full resource shape", async () => {
    const mismatch = admission(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(resource, 200, other)));
    await expect(getProjectTag(project, tag, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol", code: "principal_mismatch" });
    expect(mismatch.onPrincipalMismatch).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(resource.replace(project, other))));
    await expect(getProjectTag(project, tag, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("sends an observed exact version and explicit deletion confirmation once", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(`{"projectId":"${project}","tagId":"${tag}","deleted":true}`)); vi.stubGlobal("fetch", fetcher);
    const owner = admission();
    await expect(deleteProjectTag(project, tag, 9223372036854775807n, signal(), owner)).resolves.toEqual({ projectId: project, tagId: tag, deleted: true });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tags/${tag}`, expect.objectContaining({ method: "DELETE", body: '{"version":9223372036854775807,"confirm":true}' }));
    expect(owner.onDispatch).toHaveBeenCalledOnce(); expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it("reports a version conflict and does not retry or replace the submitted version", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply('{"error":{"code":"version_conflict","message":"changed","requestId":"r"}}', 409)); vi.stubGlobal("fetch", fetcher);
    const owner = admission();
    await expect(renameProjectTag(project, tag, " Beta ", 7n, signal(), owner)).rejects.toMatchObject({ code: "version_conflict" });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tags/${tag}`, expect.objectContaining({ method: "PATCH", body: '{"version":7,"name":"Beta"}' }));
    expect(owner.onWriteConfirmed).not.toHaveBeenCalled(); expect(owner.onWriteRejected).toHaveBeenCalledOnce();
  });
  it("distinguishes a cancelled identity wait from dispatched unknown", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetcher);
    const owner = admission(), controller = new AbortController(), resume = pauseAuthRequests();
    try {
      const waiting = createProjectTag(project, "Alpha", controller.signal, owner); controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" }); expect(owner.onDispatch).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    } finally { resume(); }
    await expect(createProjectTag(project, "Alpha", signal(), owner)).rejects.toMatchObject({ kind: "network" });
    expect(owner.onDispatch).toHaveBeenCalledOnce(); expect(owner.onWriteConfirmed).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("resolves all requested IDs, including those outside the page, or reports failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(JSON.stringify({ items: [{ id: other, name: "Other" }, { id: tag, name: "Alpha" }] }))); vi.stubGlobal("fetch", fetcher);
    await expect(resolveProjectTags(project, [tag, other], signal(), admission())).resolves.toEqual([{ id: other, name: "Other" }, { id: tag, name: "Alpha" }]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tags/resolve`, expect.objectContaining({ body: JSON.stringify({ tagIds: [tag, other] }) }));
    fetcher.mockResolvedValue(reply(JSON.stringify({ items: [{ id: tag, name: "Alpha" }] })));
    await expect(resolveProjectTags(project, [tag, other], signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("validates trimmed Unicode names and ASCII-only folding", () => {
    expect(normalizeTagName("  名😀  ")).toBe("名😀"); expect(normalizeTagName("😀".repeat(64))).not.toBeNull();
    expect(normalizeTagName("😀".repeat(65))).toBeNull(); expect(normalizeTagName("a\nb")).toBeNull(); expect(normalizeTagName("\ud800")).toBeNull();
    expect(tagNameKey("ÄABC")).toBe("Äabc");
  });
});
