import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, stringifyApiJson, validateAttachmentPath } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const timestamp = "2026-10-20T01:02:03.123456789Z";
const attachment = { path: "docs/设计 #?%.bin", contentType: "application/octet-stream", sizeBytes: 4, createdAt: timestamp, updatedAt: timestamp };
const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json" } });
const refusal = { error: { code: "not_found", message: "Attachment missing.", requestId: "req-1" } };
const cleanups: (() => void | Promise<void>)[] = [];
const operation = (options: Parameters<typeof createOperation>[0] = {}): Operation => {
  const result = createOperation(options);
  cleanups.push(() => result.dispose());
  return result;
};
const client = (fetch: typeof globalThis.fetch, op = operation()) => createApiClient({ serverUrl: "http://127.0.0.1:8787", operation: op, fetch });
const body = (bytes = new Uint8Array([0, 255, 128, 1])) => new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(bytes); controller.close(); } });
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    created.close((error) => error === undefined ? resolve() : reject(error));
    created.closeAllConnections();
  }));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing server address.");
  return `http://127.0.0.1:${address.port}`;
};
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

describe("task attachment transport", () => {
  it.each([200, 201])("streams PUT bytes with encoded path and accepts metadata status %i", async (status) => {
    const bytes = new Uint8Array(150_000).fill(255);
    const chunks: Uint8Array[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
      const stream = options!.body as ReadableStream<Uint8Array>;
      for await (const chunk of stream) chunks.push(chunk);
      return json({ ...attachment, sizeBytes: bytes.byteLength }, status);
    });
    const metadataBytes = Buffer.byteLength(stringifyApiJson({ ...attachment, sizeBytes: bytes.byteLength }));
    const result = await client(fetch, operation({ limits: { responseBytes: metadataBytes, totalBytes: metadataBytes } })).putTaskAttachment(projectId, taskId, attachment.path, { body: body(bytes), contentType: attachment.contentType });
    expect(result).toEqual({ ...attachment, sizeBytes: bytes.byteLength });
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(65_536);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://127.0.0.1:8787/api/v1/projects/${projectId}/tasks/${taskId}/attachments/files/docs/%E8%AE%BE%E8%AE%A1%20%23%3F%25.bin`);
    expect(options).toMatchObject({ method: "PUT", redirect: "manual", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/octet-stream" }, duplex: "half" });
  });

  it("returns raw invalid UTF-8, NUL and empty bytes without JSON limits or added output", async () => {
    const bytes = new Uint8Array(150_000).fill(255); bytes[1] = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(new Response(null));
    const api = client(fetch, operation({ limits: { responseBytes: 1, totalBytes: 1 } }));
    const chunks: Uint8Array[] = [];
    await api.readTaskAttachment(projectId, taskId, attachment.path, async (chunk) => { chunks.push(chunk); });
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(65_536);
    const empty = vi.fn(async () => {});
    await api.readTaskAttachment(projectId, taskId, "empty", empty);
    expect(empty).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every((call) => call[1]?.cache === "no-store")).toBe(true);
  });

  it("retains metadata and error JSON budgets after unrestricted binary transfer", async () => {
    const metadataBytes = Buffer.byteLength(stringifyApiJson(attachment));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(new Uint8Array(metadataBytes * 2)))
      .mockResolvedValueOnce(json(attachment)).mockResolvedValueOnce(json(attachment));
    const api = client(fetch, operation({ limits: { responseBytes: metadataBytes, totalBytes: metadataBytes } }));
    await api.readTaskAttachment(projectId, taskId, attachment.path, async () => {});
    await expect(api.putTaskAttachment(projectId, taskId, attachment.path, { body: body(), contentType: attachment.contentType })).resolves.toEqual(attachment);
    await expect(api.putTaskAttachment(projectId, taskId, attachment.path, { body: body(), contentType: attachment.contentType })).rejects.toMatchObject({ outcomeUnconfirmed: true, cause: { kind: "total_limit" } });
    const errorFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(refusal, 404));
    await expect(client(errorFetch, operation({ limits: { responseBytes: 1 } })).readTaskAttachment(projectId, taskId, "missing", async () => {})).rejects.toMatchObject({ cause: { kind: "response_limit" } });
  });

  it("uses empty 204 DELETE and parses JSON refusals without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json(refusal, 404)).mockResolvedValueOnce(json(refusal, 500));
    const api = client(fetch);
    await expect(api.removeTaskAttachment(projectId, taskId, attachment.path)).resolves.toBeUndefined();
    await expect(api.removeTaskAttachment(projectId, taskId, "missing")).rejects.toMatchObject({ status: 404, code: "not_found", confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.removeTaskAttachment(projectId, taskId, "failed")).rejects.toMatchObject({ status: 500, code: "not_found", outcomeUnconfirmed: true });
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["DELETE", "DELETE", "DELETE"]);
  });

  it.each([201, 204, 302])("rejects raw read status %i before writing output", async (status) => {
    const consume = vi.fn(async () => {});
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(status === 204 ? new Response(null, { status }) : json({}, status));
    await expect(client(fetch).readTaskAttachment(projectId, taskId, attachment.path, consume)).rejects.toBeInstanceOf(ApiError);
    expect(consume).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("lists all pages by path without invented IDs", async () => {
    const next = { ...attachment, path: "another/file.bin" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: [attachment], nextCursor: "next?+/=" })).mockResolvedValueOnce(json({ items: [next], nextCursor: null }));
    expect(await client(fetch).listTaskAttachments(projectId, taskId)).toEqual([attachment, next]);
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("cursor")).toBe("next?+/=");
    expect(fetch.mock.calls.every((call) => call[1]?.cache === "no-store")).toBe(true);
  });

  it.each(["same page", "later page", "cursor loop", "later failure"])("rejects %s without a partial metadata list", async (failure) => {
    const first = failure === "same page" ? [attachment, attachment] : [attachment];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ items: first, nextCursor: "next" })).mockResolvedValueOnce(failure === "later failure" ? json(refusal, 500) : json({ items: [{ ...attachment, path: failure === "later page" ? attachment.path : "another" }], nextCursor: failure === "cursor loop" ? "next" : null }));
    await expect(client(fetch).listTaskAttachments(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
  });

  it.each(["", "/file", "a//b", ".", "a/../b", "a\\b", "a\u0000b", "a\u007fb", "C:/file", "bad\ud800"])("rejects invalid path %j before dispatch", (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => validateAttachmentPath(path)).toThrow();
    expect(() => client(fetch).removeTaskAttachment(projectId, taskId, path)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid metadata identity and attributes", async () => {
    for (const value of [{ ...attachment, path: "other" }, { ...attachment, path: "../file" }, { ...attachment, sizeBytes: -1 }, { ...attachment, sizeBytes: 1.5 }, { ...attachment, contentType: "" }, { ...attachment, updatedAt: "bad" }]) {
      await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value))).putTaskAttachment(projectId, taskId, attachment.path, { body: body(), contentType: attachment.contentType })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    }
  });

  it("retains request deadlines until the sink has flushed and cancels a blocked sink", async () => {
    let sinkSignal: AbortSignal | undefined;
    const consume = vi.fn((_chunk: Uint8Array, signal: AbortSignal) => { sinkSignal = signal; return new Promise<void>(() => {}); });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array([1])), cancel }, { highWaterMark: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
    await expect(client(fetch, operation({ limits: { requestMs: 20 } })).readTaskAttachment(projectId, taskId, attachment.path, consume)).rejects.toMatchObject({ cause: { kind: "request_timeout" } });
    expect(sinkSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves sink errors and cancels its response immediately", async () => {
    const failure = Object.assign(new Error("Broken stdout pipe."), { code: "EPIPE" });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array([0])), cancel }, { highWaterMark: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
    await expect(client(fetch).readTaskAttachment(projectId, taskId, attachment.path, async () => { throw failure; })).rejects.toMatchObject({ cause: failure });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a stalled upload source on cancellation without resending the mutation", async () => {
    const source = new AbortController();
    const cancel = vi.fn();
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const upload = new ReadableStream<Uint8Array>({ pull: started, cancel }, { highWaterMark: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
      for await (const _chunk of options!.body as ReadableStream<Uint8Array>) { /* Wait for cancellation. */ }
      return json(attachment);
    });
    const pending = client(fetch, operation({ signal: source.signal })).putTaskAttachment(projectId, taskId, attachment.path, { body: upload, contentType: attachment.contentType });
    await reading; source.abort();
    await expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: true, cause: { kind: "cancelled" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upload.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("propagates real HTTP upload source failure and never retries", async () => {
    let mutations = 0;
    const serverUrl = await server((request, response) => { mutations++; request.on("error", () => {}); request.resume(); request.on("end", () => { response.writeHead(201, { "Content-Type": "application/json" }); response.end(stringifyApiJson(attachment)); }); });
    const failure = new Error("Upload file read failed.");
    let reads = 0;
    const upload = new ReadableStream<Uint8Array>({ pull: (controller) => { if (reads++ === 0) controller.enqueue(new Uint8Array([1])); else controller.error(failure); } }, { highWaterMark: 0 });
    const api = createApiClient({ serverUrl, operation: operation() });
    const error = await api.putTaskAttachment(projectId, taskId, attachment.path, { body: upload, contentType: attachment.contentType }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ outcomeUnconfirmed: true });
    expect((error as ApiError).cause).toMatchObject({ cause: failure });
    expect(mutations).toBeLessThanOrEqual(1);
    expect(upload.locked).toBe(false);
  });
});
