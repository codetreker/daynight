import { afterEach, expect, test, vi } from "vitest";
import { archiveRetryDelay, readArchiveRequestError, waitForArchiveRetry, ARCHIVE_ERROR_MAX_BYTES } from "../../../src/commands/controller/archive-retry.js";
import { createArchiveRequest } from "../../../src/commands/controller/archive-request.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const now = Date.parse("2026-01-01T00:00:00Z");
const delay = (retry: number, random: number, retryAfter: string | null = null, remainingMs = 60000) => archiveRetryDelay({ retry, random: () => random, retryAfter, now, remainingMs });

test.each([
  { random: 0, expected: [800, 1600, 3200, 6400, 8000, 8000, 8000, 8000] },
  { random: 0.5, expected: [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000] },
  { random: 1, expected: [1200, 2400, 4800, 9600, 12000, 12000, 12000, 12000] },
])("archive delay grows exponentially and keeps jitter after the cap: $random", ({ random, expected }) => {
  expect(expected.map((_, index) => delay(index + 1, random))).toEqual(expected);
});

test("archive retries sample independently and a new request starts at one second", () => {
  const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(0.5);
  const options = { random, retryAfter: null, now, remainingMs: 60000 };
  expect(archiveRetryDelay({ ...options, retry: 1 })).toBe(800);
  expect(archiveRetryDelay({ ...options, retry: 2 })).toBe(2400);
  expect(archiveRetryDelay({ ...options, retry: 1 })).toBe(1000);
  expect(random).toHaveBeenCalledTimes(3);
});

test.each([null, "", "invalid", "-1", "1.5", "1seconds", "99999999999999999999999999999999999x"])("invalid Retry-After preserves the jitter floor: %s", retryAfter => {
  expect(delay(1, 0, retryAfter)).toBe(800);
});
test.each([
  ["0", 800], ["1", 1000], ["7", 7000], ["12", 12000],
  ["Thu, 01 Jan 2026 00:00:09 GMT", 9000], ["Wed, 31 Dec 2025 23:59:59 GMT", 800],
] as const)("Retry-After %s is a minimum wait", (retryAfter, expected) => {
  expect(delay(1, 0, retryAfter)).toBe(expected);
});
test.each(["13", "120", "99999999999999999999999999999999999", "Thu, 01 Jan 2026 00:00:13 GMT"])("Retry-After beyond 12 seconds ends the round: %s", retryAfter => {
  expect(delay(1, 0, retryAfter)).toBeNull();
});
test("a selected delay may not exceed the remaining round budget", () => {
  expect(delay(1, 0, null, 799)).toBeNull();
  expect(delay(1, 0, null, 800)).toBe(800);
  expect(delay(1, 0, "7", 6999)).toBeNull();
});

test.each([
  { status: 429, payload: { error: { code: "resource_busy" } }, busy: true },
  { status: 503, payload: { error: { code: "resource_busy" } }, busy: false },
  { status: 429, payload: { error: { code: "rate_limited" } }, busy: false },
  { status: 429, payload: { error: { code: "RESOURCE_BUSY" } }, busy: false },
  { status: 429, payload: { error: { code: 429 } }, busy: false },
  { status: 429, payload: { code: "resource_busy" }, busy: false },
  { status: 429, payload: ["resource_busy"], busy: false },
])("capacity classification requires exact HTTP status and structured code: $status / $payload", async ({ status, payload, busy }) => {
  const result = await readArchiveRequestError(Response.json(payload, { status }), new AbortController().signal);
  expect(result).toMatchObject({ status, busy });
});

test("malformed or oversized capacity bodies are not accepted as a capacity refusal", async () => {
  for (const body of ["{broken-json", JSON.stringify({ error: { code: "resource_busy", message: "x".repeat(ARCHIVE_ERROR_MAX_BYTES) } })]) {
    expect((await readArchiveRequestError(new Response(body, { status: 429 }), new AbortController().signal)).busy).toBe(false);
  }
});

test("bounded error reading cancels the original stream when it exceeds the limit", async () => {
  const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start: controller => { controller.enqueue(new Uint8Array(ARCHIVE_ERROR_MAX_BYTES + 1)); }, cancel });
  expect((await readArchiveRequestError(new Response(stream, { status: 429 }), new AbortController().signal)).busy).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});

test("body transport failures preserve the unknown outcome", async () => {
  const reason = new Error("Capacity response truncated.");
  const stream = new ReadableStream<Uint8Array>({ start: controller => controller.error(reason) });
  await expect(readArchiveRequestError(new Response(stream, { status: 429 }), new AbortController().signal)).rejects.toBe(reason);
});

test("cancelling the retry wait preserves the parent reason and clears its timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), reason = new Error("Archive owner stopped.");
  const wait = waitForArchiveRetry(12000, controller.signal);
  const failure = expect(wait).rejects.toBe(reason);
  controller.abort(reason);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
  await expect(waitForArchiveRetry(1000, controller.signal)).rejects.toBe(reason);
});

test.each([true, false])("archive transport preserves replay permission and redacted retry diagnostics: %s", async replayable => {
  let elapsed = 0;
  const waits: number[] = [], events: unknown[] = [], body = Uint8Array.from([1, 2, 3]);
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: "resource_busy", message: "private-message" } }, { status: 429, headers: { "X-Request-ID": "capacity-request" } }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "private-token", bodyOnly: () => true, signal: new AbortController().signal, deadline: now + 60000, sessionId: "original-session", retryRuntime: { now: () => now + elapsed, random: () => 0.5, wait: async ms => { elapsed += ms; waits.push(ms); } }, onRetry: event => events.push(event) });
  await expect(call("PUT", "/files/original?offset=0", replayable, body, { "Daynight-Chunk-SHA256": "original-hash" })).rejects.toMatchObject({ status: 429, code: "resource_busy" });
  expect(request).toHaveBeenCalledTimes(replayable ? 9 : 1);
  expect(waits).toEqual(replayable ? [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000] : []);
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe("https://example.test/archive/files/original?offset=0");
    expect(init?.body).toEqual(body);
    expect(new Headers(init?.headers).get("Daynight-Chunk-SHA256")).toBe("original-hash");
  }
  if (replayable) {
    expect(events).toHaveLength(9);
    expect(events.at(-1)).toEqual({ phase: "exhausted", retry: 8, delayMs: null, classification: "resource_busy", requestId: "capacity-request", sessionId: "original-session" });
    expect(JSON.stringify(events)).not.toMatch(/private-token|private-message|original-hash|offset/);
  } else expect(events).toEqual([]);
});

test("a parent cancelled during capacity-body reading stops classification and further requests", async () => {
  const parent = new AbortController(), reason = new Error("Original archive cancelled.");
  let bodyStarted!: () => void;
  const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  const cancelled = vi.fn();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ pull: () => { bodyStarted(); }, cancel: cancelled }), { status: 429 }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "private-token", bodyOnly: () => false, signal: parent.signal, parentSignal: parent.signal, deadline: now + 60000, sessionId: "original-session" });
  const result = call("GET", "", true), failure = expect(result).rejects.toBe(reason);
  await started;
  parent.abort(reason);
  await failure;
  expect(cancelled).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
});

test("the original 15 second attempt deadline bounds a stalled capacity error body", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Attempt timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
  const cancelled = vi.fn(), events: unknown[] = [];
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status: 429 }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "private-token", bodyOnly: () => false, signal: new AbortController().signal, deadline: now + 60000, sessionId: "original-session", onRetry: event => events.push(event) });
  const result = call("GET", "", true), failure = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(14999);
  expect(cancelled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(cancelled).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  expect(events).toEqual([]);
});

test("a recovery 404 without a capability header reports the ambiguous unavailable endpoint and retains response details", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "not_found" } }, { status: 404 }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => true, signal: new AbortController().signal, deadline: now + 60000, sessionId: "original-session" });
  await expect(call("POST", "/source-tail/recover", true, "{}")).rejects.toMatchObject({ status: 404, code: "not_found", payload: { error: { code: "not_found" } }, message: expect.stringContaining("Source-tail recovery is unavailable") });
  expect(request).toHaveBeenCalledOnce();
});

test.each([401, 403, 409, 500])("recovery preserves HTTP %i and its error without a capability header", async status => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "original_error" } }, { status }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => true, signal: new AbortController().signal, deadline: now + 60000, sessionId: "original-session" });
  await expect(call("POST", "/source-tail/recover", true, "{}")).rejects.toMatchObject({ status, code: "original_error", message: `Session archive request failed (${status}).` });
  expect(request).toHaveBeenCalledOnce();
});

test("other archive routes keep their Task body capability check", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "not_found" } }, { status: 404 }));
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => true, signal: new AbortController().signal, deadline: now + 60000, sessionId: "original-session" });
  await expect(call("POST", "/source-tail", true, "{}")).rejects.toThrow("service does not support Task body archives");
});
