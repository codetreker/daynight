import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import type { SessionCommand } from "../../src/session/protocol.js";
import { actorId, claimId, inspection, operationId, operationUrl, receipt, response, sessionId, target } from "../commands/task/session/fixtures.js";
const operations: Operation[] = [];
afterEach(() => operations.splice(0).forEach(operation => operation.dispose()));
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }).withExpectedUserId(actorId); };
const command: SessionCommand = { protocol: "daynight.session.v1", sessionId, claimId, executionGeneration: inspection.fence.executionGeneration, operationId, requestId: operationId, kind: "send_message", payload: { content: [{ type: "text", text: "\ufeff/compact\r\n" }], expectedTurnId: null } };
it("accepts one exact 202 Session command with no retries or redirects", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: receipt(), operationUrl }, 202, actorId, { Location: operationUrl }));
  expect(await client(fetch).sendTaskSessionCommand(target, command)).toMatchObject({ operation: { state: "accepted" } });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(command); expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "manual", method: "POST" });
});
it.each([
  { operation: receipt("accepted", { sessionId: actorId }) }, { operation: receipt("accepted", { operationId: actorId }) },
  { operation: receipt("accepted", { claimId: actorId }) }, { operation: receipt("accepted", { executionGeneration: "2" }) },
  { operation: receipt("accepted", { kind: "cancel" }) }, { operationUrl: "/wrong" },
])("rejects a mismatched receipt without retry %#", async changes => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: receipt(), operationUrl, ...changes }, 202, actorId, { Location: operationUrl }));
  await expect(client(fetch).sendTaskSessionCommand(target, command)).rejects.toMatchObject({ phase: "protocol" }); expect(fetch).toHaveBeenCalledOnce();
});
it("does not widen POST success defaults and rejects a mismatched actor", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: receipt(), operationUrl }, 201, actorId, { Location: operationUrl }));
  await expect(client(fetch).sendTaskSessionCommand(target, command)).rejects.toMatchObject({ phase: "protocol" });
  fetch.mockResolvedValue(response({ operation: receipt(), currentBinding: false }, 200, claimId));
  await expect(client(fetch).readTaskSessionOperation(target)).rejects.toMatchObject({ phase: "protocol" });
});
it("checks actual escaped JSON bytes before POST", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(client(fetch).sendTaskSessionCommand(target, { ...command, payload: { content: [{ type: "text", text: "x" + "\u0001".repeat(400_000) }], expectedTurnId: null } })).rejects.toThrow("2 MiB"); expect(fetch).not.toHaveBeenCalled();
});
it("bounds an in-flight receipt GET by the supplied remaining deadline", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {})); const start = performance.now();
  await expect(client(fetch).readTaskSessionOperation(target, undefined, 30)).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: false });
  expect(performance.now() - start).toBeLessThan(400); expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
});
it("does not expire a receipt request when its timer wakes before the monotonic deadline", async () => {
  const { performance } = await import("node:perf_hooks");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let elapsed = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const operation = createOperation({ limits: { totalMs: 60_000 } });
  let outcome: unknown;
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
  try {
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }).withExpectedUserId(actorId);
    const pending = api.readTaskSessionOperation(target, undefined, 1_000).catch(error => { outcome = error; });
    // The timer queue advances before the monotonic clock, as an early platform wakeup can do.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBeUndefined(); expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    elapsed = 1_000; await vi.advanceTimersByTimeAsync(1_000); await pending;
    expect(outcome).toMatchObject({ cause: { kind: "request_timeout" } });
  } finally { operation.dispose(); clock.mockRestore(); vi.useRealTimers(); }
});
it("attributes a shorter receipt budget to request timeout even when the operation also has a short budget", async () => {
  const operation = createOperation({ limits: { totalMs: 1_000, requestMs: 30_000 } });
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }).withExpectedUserId(actorId);
    await expect(api.readTaskSessionOperation(target, undefined, 30)).rejects.toMatchObject({ cause: { kind: "request_timeout" } });
  } finally { operation.dispose(); }
});
