import { expect, test } from "vitest";
import { historySyncHttpError } from "../../../src/commands/controller/media/history-sync-error.js";

const base = "Controller history synchronization GET status failed (409).";
const observe = (response: Response, signal = new AbortController().signal) => historySyncHttpError(response, "GET status", signal);
const response = (value: unknown) => Response.json(value, { status: 409 });

test("history HTTP diagnostics expose only bounded identifiers from the nested error envelope", async () => {
  const error = await observe(response({ error: { code: "archive_conflict", requestId: "Request_123-abc", message: "private-message-canary", detail: "private-detail-canary" }, private: "private-body-canary" }));
  expect(error).toMatchObject({ status: 409, message: "Controller history synchronization GET status failed (409; code=archive_conflict; requestId=Request_123-abc)." });
  expect(String(error)).not.toContain("canary");
  expect(error.cause).toBeUndefined();
});

test.each(["", "UPPER", "bad-code", "bad code", "bad\ncode", "é", "a".repeat(65), 1, null, {}, ["valid"]])("history HTTP diagnostics omit invalid code %#", async code => {
  const error = await observe(response({ error: { code, requestId: "safe" } }));
  expect(error.message).toBe("Controller history synchronization GET status failed (409; requestId=safe).");
});

test.each(["", ".leading", "_leading", "-leading", "bad id", "bad/id", "bad\nid", "é", "x".repeat(65), 1, null, {}, ["valid"]])("history HTTP diagnostics omit invalid request ID %#", async requestId => {
  const error = await observe(response({ error: { code: "safe", requestId } }));
  expect(error.message).toBe("Controller history synchronization GET status failed (409; code=safe).");
});

test.each([1, 64])("history HTTP diagnostic code accepts its %i-character boundary", async length => {
  const code = "a".repeat(length), requestId = "R".repeat(length);
  expect((await observe(response({ error: { code, requestId } }))).message).toContain(`code=${code}; requestId=${requestId}`);
});

test.each(["abc.def", "0._-", "Z", "a".repeat(64)])("history HTTP diagnostics accept server-compatible request ID %s", async requestId => {
  expect((await observe(response({ error: { requestId } }))).message).toBe(`Controller history synchronization GET status failed (409; requestId=${requestId}).`);
});

test.each([null, [], {}, { code: "unscoped", requestId: "unscoped" }, { error: [] }, { error: "private-error-canary" }, { error: { code: { code: "nested" }, requestId: { requestId: "nested" } } }])("history HTTP diagnostics do not search malformed or nested values %#", async value => {
  expect((await observe(response(value))).message).toBe(base);
});

test.each(["", "private-non-json-canary", '{"error":{"code":"unfinished"', '[{"error":{"code":"array"}}]'])("history HTTP diagnostics retain the HTTP failure for malformed text %#", async text => {
  expect(await observe(new Response(text, { status: 409 }))).toMatchObject({ status: 409, message: base });
});

test("history HTTP diagnostics accept exactly 16 KiB but discard and cancel an oversized stream", async () => {
  const json = JSON.stringify({ error: { code: "bounded" } });
  expect((await observe(new Response(json.padEnd(16 * 1024, " "), { status: 409 }))).message).toContain("code=bounded");
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(json.padEnd(16 * 1024 + 1, " "))); },
    cancel() { canceled++; },
  });
  expect(await observe(new Response(stream, { status: 409 }))).toMatchObject({ status: 409, message: base });
  expect(canceled).toBe(1);
});

test("history HTTP diagnostics count byte length across chunks and ignore response headers", async () => {
  let canceled = 0;
  const bytes = new TextEncoder().encode("é".repeat(8193));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.subarray(0, 100)); controller.enqueue(bytes.subarray(100)); },
    cancel() { canceled++; },
  });
  expect((await observe(new Response(stream, { status: 409, headers: { "X-Request-ID": "private-header-canary" } }))).message).toBe(base);
  expect(canceled).toBe(1);
});

test("history HTTP diagnostics preserve the failure when a body errors or has invalid UTF-8", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-stream-canary")); } });
  expect(await observe(new Response(stream, { status: 409 }))).toMatchObject({ status: 409, message: base });
  expect((await observe(new Response(new Uint8Array([0xff]), { status: 409 }))).message).toBe(base);
});

test("history HTTP diagnostics cancel a stalled body on the original request signal", async () => {
  const abort = new AbortController(), reading = Promise.withResolvers<void>(); let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { canceled++; },
  });
  const pending = observe(new Response(stream, { status: 409 }), abort.signal);
  await reading.promise; abort.abort(new Error("private-abort-canary"));
  expect(await pending).toMatchObject({ status: 409, message: base });
  expect(canceled).toBe(1);
});

test("history HTTP diagnostics obey a request deadline without waiting for stream cancellation", async () => {
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled++; return new Promise<void>(() => {}); } });
  expect(await observe(new Response(stream, { status: 409 }), AbortSignal.timeout(10))).toMatchObject({ status: 409, message: base });
  expect(canceled).toBe(1);
});

test("history HTTP diagnostics retain HTTP status for absent, locked, or pre-aborted bodies", async () => {
  expect((await observe(new Response(null, { status: 409 }))).message).toBe(base);
  const locked = new Response("private-locked-canary", { status: 409 }), reader = locked.body!.getReader();
  try { expect((await observe(locked)).message).toBe(base); } finally { await reader.cancel(); reader.releaseLock(); }
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled++; throw new Error("private-cancel-canary"); } });
  expect((await observe(new Response(stream, { status: 409 }), AbortSignal.abort())).message).toBe(base);
  expect(canceled).toBe(1);
});
