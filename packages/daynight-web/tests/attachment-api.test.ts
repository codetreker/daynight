import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, attachmentPageUrl, checkAttachmentPreview, attachmentContentType, attachmentDownloadUrl, attachmentPreviewRoot, attachmentPreviewUrl, listAttachments, putAttachment, readAttachmentText, removeAttachment } from "../src/api/client";
import { isAttachmentPath, parseAttachment, parseAttachmentPage } from "../src/api/parse";

const project = "10000000-0000-0000-0000-00000000000a";
const task = "20000000-0000-0000-0000-00000000000b";
const time = "2026-10-21T12:34:56.123456Z";
const item = { path: "docs/设计%?#.md", contentType: "text/markdown; charset=utf-8", sizeBytes: 7, createdAt: time, updatedAt: time };
const base = `/api/v1/projects/${project}/tasks/${task}`;
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const mock = (response: Response) => {
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
afterEach(() => vi.unstubAllGlobals());

describe("attachment DTOs and paths", () => {
  it("preserves the exact case, Unicode path and scoped DTO fields", () => {
    expect(parseAttachment({ ...item, id: "ignored", taskId: task })).toEqual(item);
    expect(parseAttachmentPage({ items: [item], nextCursor: "opaque+/?" })).toEqual({ items: [item], nextCursor: "opaque+/?" });
    expect(parseAttachmentPage({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(isAttachmentPath("Caps/😀 %?#.md")).toBe(true);
  });
  it.each(["", "/file", "file/", "a//b", ".", "..", "a/../b", "a/./b", "a\\b", "a\0b", "a\u007fb", "a\u0085b", "a\ud800b", "C:/absolute", "c:/absolute"])("rejects invalid path %j", (path) => {
    expect(isAttachmentPath(path)).toBe(false);
    expect(() => parseAttachment({ ...item, path })).toThrow("invalid response");
  });
  it.each([
    null, [], {}, { ...item, path: null }, { ...item, contentType: "" }, { ...item, contentType: "broken" },
    { ...item, sizeBytes: -1 }, { ...item, sizeBytes: 0.5 }, { ...item, sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...item, createdAt: "yesterday" }, { ...item, updatedAt: null },
  ])("rejects malformed metadata %#", (data) => expect(() => parseAttachment(data)).toThrow("invalid response"));
  it.each([{}, { items: null, nextCursor: null }, { items: [item, item], nextCursor: null }, { items: [], nextCursor: "" }])("rejects malformed pages %#", (data) => {
    expect(() => parseAttachmentPage(data)).toThrow("invalid response");
  });
});

describe("attachment transport", () => {
  it("encodes every path segment exactly once with canonical scope IDs", () => {
    const encoded = "docs/%E8%AE%BE%E8%AE%A1%25%3F%23.md";
    expect(attachmentDownloadUrl(project.toUpperCase(), task.toUpperCase(), item.path)).toBe(`${base}/attachments/files/${encoded}`);
    expect(attachmentPageUrl(project.toUpperCase(), task.toUpperCase(), item.path)).toBe(`/projects/${project}/tasks/${task}/attachments/${encoded}`);
    expect(attachmentPageUrl(project, task, "%2F")).toBe(`/projects/${project}/tasks/${task}/attachments/%252F`);
    expect(() => attachmentPageUrl("bad", task, "file")).toThrow(ApiError);
    expect(() => attachmentPageUrl(project, task, "a/../file")).toThrow(ApiError);
    expect(attachmentPreviewRoot(project, task)).toBe(`${base}/preview/`);
    expect(attachmentPreviewUrl(project, task, item.path)).toBe(`${base}/preview/${encoded}`);
    expect(attachmentDownloadUrl(project, task, "%2F")).toBe(`${base}/attachments/files/%252F`);
    expect(() => attachmentDownloadUrl("bad", task, "file")).toThrow(ApiError);
  });
  it("lists metadata with opaque cursors and no-store", async () => {
    const fetcher = mock(json({ items: [item], nextCursor: null }));
    const abortSignal = signal();
    await expect(listAttachments(project, task, { limit: 2, cursor: "opaque+/? &" }, abortSignal)).resolves.toEqual({ items: [item], nextCursor: null });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${base}/attachments?limit=2&cursor=opaque%2B%2F%3F+%26`, { signal: expect.any(AbortSignal), cache: "no-store", credentials: "same-origin", redirect: "error", headers: { Accept: "application/json" } });
    fetcher.mockResolvedValue(json({ items: [], nextCursor: null }));
    await listAttachments(project, task, {}, signal());
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${base}/attachments`);
  });
  it("rejects invalid inputs without sending a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const limit of [0, 101, 0.5, NaN]) expect(() => listAttachments(project, task, { limit }, signal())).toThrow(ApiError);
    expect(() => listAttachments(project, task, { cursor: "" }, signal())).toThrow(ApiError);
    await expect(putAttachment(project, task, "../file", new File(["x"], "file"), signal())).rejects.toBeInstanceOf(ApiError);
    await expect(removeAttachment(project, task, "a\\b", signal())).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([200, 201])("sends raw File bytes without retrying and accepts PUT %i", async (status) => {
    const fetcher = mock(json(item, status));
    const file = new File([new Uint8Array([0, 255, 1, 128])], "local.bin", { type: "application/octet-stream" });
    const abortSignal = signal();
    await expect(putAttachment(project, task, item.path, file, abortSignal)).resolves.toEqual(item);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(attachmentDownloadUrl(project, task, item.path), {
      method: "PUT", body: file, signal: expect.any(AbortSignal), cache: "no-store", credentials: "same-origin", redirect: "error", headers: { Accept: "application/json", "Content-Type": "text/markdown" },
    });
    expect(attachmentContentType("new.JSON")).toBe("application/json");
    expect(attachmentContentType("unknown.unregistered-extension")).toBe("application/octet-stream");
  });
  it("rejects successful PUT metadata for a different target or an unexpected success status", async () => {
    const fetcher = mock(json({ ...item, path: "other.md" }));
    await expect(putAttachment(project, task, item.path, new File(["x"], "x"), signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    fetcher.mockResolvedValue(json(item, 202));
    await expect(putAttachment(project, task, item.path, new File(["x"], "x"), signal())).rejects.toMatchObject({ kind: "protocol", status: 202 });
  });
  it("accepts a bodyless DELETE 204 without invoking JSON parsing", async () => {
    const response = new Response(null, { status: 204 });
    const parse = vi.spyOn(response, "json");
    const fetcher = mock(response);
    const abortSignal = signal();
    await expect(removeAttachment(project, task, item.path, abortSignal)).resolves.toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(attachmentDownloadUrl(project, task, item.path), { method: "DELETE", signal: expect.any(AbortSignal), cache: "no-store", credentials: "same-origin", redirect: "error" });
    fetcher.mockResolvedValue(new Response("unexpected", { status: 200 }));
    await expect(removeAttachment(project, task, item.path, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });
  it.each(["remove", "read", "put"] as const)("retains structured server errors from %s", async (operation) => {
    const fetcher = mock(json({ error: { code: "path_conflict", message: "private SQL", requestId: "attachment-1" } }, 409));
    const promise = operation === "remove" ? removeAttachment(project, task, item.path, signal()) : operation === "read" ? readAttachmentText(project, task, item.path, signal()) : putAttachment(project, task, item.path, new File(["x"], "x"), signal());
    await expect(promise).rejects.toMatchObject({ kind: "server", status: 409, code: "path_conflict", requestId: "attachment-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reads text as raw content, including JSON-looking content and line endings", async () => {
    const content = '{"raw":true}\r\n\0';
    const response = new Response(content, { headers: { "Content-Type": "application/json" } });
    const parse = vi.spyOn(response, "json");
    mock(response);
    await expect(readAttachmentText(project, task, "data.json", signal())).resolves.toBe(content);
    expect(parse).not.toHaveBeenCalled();
  });
  it("rejects raw read failures and cancellation without inventing empty text", async () => {
    const response = new Response("text");
    vi.spyOn(response, "text").mockRejectedValue(new Error("private failure"));
    const fetcher = mock(response);
    await expect(readAttachmentText(project, task, item.path, signal())).rejects.toMatchObject({ kind: "network", status: 200 });
    fetcher.mockResolvedValue(new Response("pending", { status: 202 }));
    await expect(readAttachmentText(project, task, item.path, signal())).rejects.toMatchObject({ kind: "protocol", status: 202 });
    const controller = new AbortController();
    fetcher.mockResolvedValue({ ok: true, status: 200, text: async () => { controller.abort(); return "stale"; } });
    const error = await readAttachmentText(project, task, item.path, controller.signal).catch((failure: unknown) => failure);
    expect(error).toBe(controller.signal.reason);
    const aborted = new DOMException("Aborted", "AbortError");
    fetcher.mockResolvedValue({ ok: true, status: 200, text: async () => { throw aborted; } });
    await expect(readAttachmentText(project, task, item.path, signal())).rejects.toBe(aborted);
  });
});

describe("native preview availability", () => {
  it("checks the fixed preview URL with bodyless HEAD and cancellation", async () => {
    const response = new Response(null);
    const parse = vi.spyOn(response, "json");
    const fetcher = mock(response);
    const abortSignal = signal();
    await expect(checkAttachmentPreview(project, task, item.path, abortSignal)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(attachmentPreviewUrl(project, task, item.path), { method: "HEAD", signal: expect.any(AbortSignal), cache: "no-store", credentials: "same-origin", redirect: "error" });
    expect(parse).not.toHaveBeenCalled();
  });
  it("retains status and safe request IDs without expecting an error response body", async () => {
    const response = new Response(null, { status: 500, headers: { "X-Request-ID": "preview-1" } });
    const parse = vi.spyOn(response, "json");
    const fetcher = mock(response);
    await expect(checkAttachmentPreview(project, task, item.path, signal())).rejects.toMatchObject({ kind: "server", status: 500, code: "server", requestId: "preview-1" });
    expect(parse).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response(null, { status: 404, headers: { "X-Request-ID": "invalid request id" } }));
    await expect(checkAttachmentPreview(project, task, item.path, signal())).rejects.toMatchObject({ kind: "server", status: 404, requestId: null });
    fetcher.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(checkAttachmentPreview(project, task, item.path, signal())).rejects.toMatchObject({ kind: "server", status: 404, requestId: null });
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(checkAttachmentPreview(project, task, item.path, signal())).rejects.toMatchObject({ kind: "protocol", status: 204 });
  });
});

describe("upload target MIME inference", () => {
  it.each([
    ["mockup/index.html", "text/html"], ["mockup/app.mjs", "text/javascript"], ["mockup/style.css", "text/css"],
    ["mockup/assets/font.woff2", "font/woff2"], ["mockup/assets/module.wasm", "application/wasm"],
    ["docs/architecture.MD", "text/markdown"], ["data/custom.unknown-extension", "application/octet-stream"],
  ])("infers %s as %s", (target, expected) => {
    expect(attachmentContentType(target)).toBe(expected);
  });
  it("uses a renamed target path rather than the local file's name or declared MIME", async () => {
    const target = "mockup/assets/module.wasm";
    const item = { path: target, contentType: "application/wasm", sizeBytes: 4, createdAt: time, updatedAt: time };
    const fetcher = mock(json(item, 201));
    const file = new File([new Uint8Array([0, 97, 115, 109])], "generated.tmp", { type: "text/plain" });
    await expect(putAttachment(project, task, target, file, signal())).resolves.toEqual(item);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: file, headers: { "Content-Type": "application/wasm" } });
  });
});
