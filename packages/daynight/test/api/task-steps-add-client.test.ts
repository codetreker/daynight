import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { AddTaskStepInput, StepsResource, TaskStep } from "../../src/api/types.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333", otherUser = "dddddddd-4444-4444-8444-444444444444";
const requestId = "12345678-1111-4111-8111-111111111111";
const input: AddTaskStepInput = { version: 9_007_199_254_740_993n, id: "00abcdef", title: "  <原值&>😀\uFEFF  " };
const stamp = "2026-11-04T10:11:12.123456Z";
const added: TaskStep = { id: input.id, title: input.title, description: "", status: "todo", createdAt: stamp, updatedAt: stamp };
const old: TaskStep = { ...added, id: "00000000", title: "same", description: "old Markdown", createdAt: "2026-01-01T01:02:03Z", updatedAt: "2026-01-02T03:04:05.654321Z" };
const previous: StepsResource = { projectId, taskId, version: input.version, steps: [old] };
const result: StepsResource = { ...previous, version: input.version + 1n, steps: [old, added] };
const location = `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${input.id}`;
const json = (value: unknown, status = 201, headers: Record<string, string> = {}) => new Response(`${stringifyApiJson(value)}\n`, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Location": location, "X-Request-ID": "observed-request", ...headers } });
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); disposals.push(() => operation.dispose()); return { operation, api: createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch }) }; };
const faults = (cause: unknown, seen = new Set<unknown>()): unknown[] => {
  if (!(cause instanceof Error) || seen.has(cause)) return []; seen.add(cause);
  return [cause, ...(cause instanceof AggregateError ? cause.errors.flatMap((error: unknown) => faults(error, seen)) : []), ...faults(cause.cause, seen)];
};

describe("Steps Add receipt and transport", () => {
  it("sends one correlated POST, canonical identity and exact int64 without hidden reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    const { api } = fixture(fetch);
    expect(await api.addTaskStep(projectId.toUpperCase(), taskId.toUpperCase(), { ...input, id: "00ABCDEF" }, { requestId })).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "manual", headers: { "X-Request-ID": requestId, Authorization: "Bearer fixture-token", "Content-Type": "application/json" } });
    expect(parseApiJson(String(options!.body))).toEqual(input);
  });
  it.each(["todo", "in_progress", "done", "skipped"] as const)("confirms raw paired fields and explicit status %s", async (status) => {
    const fields = { description: " # Markdown\r\n\"\\\u2028\u2029 �  ", status };
    const expected = { ...result, steps: [old, { ...added, ...fields }] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
    expect(await fixture(fetch).api.addTaskStep(projectId, taskId, { ...input, ...fields }, { requestId, previous })).toEqual(expected);
  });
  it.each(["before", "after"] as const)("confirms only the exact %s placement and complete surviving baseline", async (direction) => {
    const steps = direction === "before" ? [added, old] : [old, added];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, steps }));
    expect(await fixture(fetch).api.addTaskStep(projectId, taskId, { ...input, [direction]: old.id.toUpperCase() }, { requestId, previous })).toEqual({ ...result, steps });
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ ...input, [direction]: old.id });
  });
  it.each([
    { version: 0n }, { id: "bad" }, { title: "\u0085" }, { title: "\ud800" }, { description: "\0" }, { status: "invalid" }, { before: "bad" }, { before: old.id, after: old.id },
  ])("rejects invalid preparation without dispatch while retaining original request identity %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, { ...input, ...changes } as AddTaskStepInput, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", "-invalid", "bad\nid", "x".repeat(65)])("does not dispatch an invalid outbound request ID %#", async (invalidId) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId: invalidId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: invalidId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the actual serialized UTF8 JSON budget inclusively, including escaped characters", async () => {
    const base = { ...input, title: "x", description: "\n\\😀" };
    const padding = 1_048_576 - Buffer.byteLength(stringifyApiJson(base));
    const exact = { ...base, title: "x" + "a".repeat(padding) };
    expect(Buffer.byteLength(stringifyApiJson(exact))).toBe(1_048_576);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, steps: [old, { ...added, title: exact.title, description: exact.description }] }));
    expect((await fixture(fetch).api.addTaskStep(projectId, taskId, exact, { requestId })).steps[1]!.title).toBe(exact.title);
    expect(Buffer.byteLength(String(fetch.mock.calls[0]![1]!.body))).toBe(1_048_576);
    const noDispatch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(noDispatch).api.addTaskStep(projectId, taskId, { ...exact, title: exact.title + "a" }, { requestId })).rejects.toMatchObject({ phase: "prepare", sentRequestId: requestId, outcomeUnconfirmed: false, cause: expect.objectContaining({ kind: "request_limit" }) });
    expect(noDispatch).not.toHaveBeenCalled();
  });
  it.each(["", location + "/", location.toUpperCase(), location + "?x=1", "https://unrelated.invalid" + location])("does not confirm malformed canonical Location %s", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result, 201, { Location: value }));
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, stepId: input.id, status: 201, phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { version: input.version }, { version: input.version + 2n }, { taskId: projectId }, { steps: [old] }, { steps: [added, old] }, { steps: [old, added, added] },
    ...[{ title: input.title.trim() }, { description: "default invented" }, { status: "done" }, { createdAt: "2026-01-01T00:00:00Z" }].map((changes) => ({ steps: [old, { ...added, ...changes }] })),
  ])("keeps a dispatched but invalid receipt unknown and never replays %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, ...changes }));
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["before", "after"] as const)("keeps a missing or nonadjacent %s anchor receipt unknown", async (direction) => {
    for (const anchor of ["ffffffff", old.id]) {
      const middle = { ...old, id: "11111111" };
      const steps = [old, middle, added];
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, steps }));
      await expect(fixture(fetch).api.addTaskStep(projectId, taskId, { ...input, [direction]: anchor }, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it("does not dispatch when the supplied actual pre-read has another version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId, previous: { ...previous, version: input.version - 1n } })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: requestId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a receipt that changes baseline survivor content/time/order", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, steps: [{ ...old, description: "changed" }, added] }));
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId, previous })).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });
  it.each([400, 401, 404, 409, 410, 500, 503])("retains parsed status%d and original versus observed IDs without echo-equality gating", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "version_conflict", message: "Public refusal", requestId: "body-request" } }, status));
    await expect(fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ status, sentRequestId: requestId, responseRequestId: "observed-request", requestId: "body-request", serverMessage: "Public refusal", confirmedRefusal: status < 500, outcomeUnconfirmed: status >= 500 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains exact capacity409 details and rejects inconsistent details as untrusted protocol", async () => {
    const details = { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 };
    for (const [invalid, detail] of [[false, details], [true, { ...details, encodedBytes: 1 }], [true, { ...details, maxEncodedBytes: 64 }], [true, { encodedBytes: 67_108_865 }], [true, { ...details, encodedBytes: "67108865" }]] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "steps_limit_exceeded", message: "Capacity exceeded", requestId: "body-capacity", details: detail } }, 409));
      const error = await fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: invalid, confirmedRefusal: !invalid });
      if (!invalid) expect(error).toMatchObject({ code: "steps_limit_exceeded", details });
    }
  });
  it("retains pre-dispatch identity through a network loss without replay or invented confirmation", async () => {
    const failure = new Error("private-network-sentinel");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    const error = await fixture(fetch).api.addTaskStep(projectId, taskId, input, { requestId }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ phase: "request", sentRequestId: requestId, stepId: input.id, outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(faults(error)).toContain(failure);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps cancellation after dispatch unknown in the same aborted Operation", async () => {
    const cancellation = new AbortController(); const operation = createOperation({ signal: cancellation.signal }); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => { cancellation.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable"); });
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true, cause: expect.objectContaining({ kind: "cancelled" }) });
    expect(() => operation.check()).toThrow("Operation cancelled.");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["response", "total"] as const)("keeps dispatched %s-byte failure unknown with actual Operation liveness", async (kind) => {
    const operation = createOperation({ limits: kind === "response" ? { responseBytes: 32 } : { totalBytes: 32 } }); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true, cause: expect.objectContaining({ kind: kind === "response" ? "response_limit" : "total_limit" }) });
    if (kind === "response") expect(() => operation.check()).not.toThrow(); else expect(() => operation.check()).toThrow("Operation response byte budget exceeded.");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("binds principal before a successful malformed body and applies it to the correlated same-session read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("{", { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, Location: location } })).mockResolvedValueOnce(json(result, 200, { "Daynight-User-ID": otherUser }));
    const { api } = fixture(fetch);
    await expect(api.addTaskStep(projectId, taskId, input, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(api.listTaskSteps(projectId, taskId, { requestId: requestId + ".r1" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false, sentRequestId: requestId + ".r1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ "X-Request-ID": requestId + ".r1", Authorization: "Bearer fixture-token" });
  });
  it.each(["confirmed", "refused"] as const)("keeps %s completion facts through cancel and releaseLock failures with original causes", async (kind) => {
    const releaseFailure = new Error("release-private"), cancelFailure = new Error("cancel-private");
    const response = kind === "confirmed" ? json(result) : json({ error: { code: "steps_limit_exceeded", message: "Capacity exceeded", requestId: "body-capacity", details: { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 } } }, 409);
    const reader = response.body!.getReader(), release = reader.releaseLock.bind(reader);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response); const { api, operation } = fixture(fetch);
    Object.defineProperty(reader, "releaseLock", { value: () => { release(); operation.dispose(); throw releaseFailure; } });
    if (kind === "refused") Object.defineProperty(reader, "cancel", { value: async () => { throw cancelFailure; } });
    Object.defineProperty(response.body, "getReader", { value: () => reader });
    const error = await api.addTaskStep(projectId, taskId, input, { requestId }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: false, ...(kind === "confirmed" ? { confirmedMutationId: input.id, status: 201 } : { confirmedRefusal: true, code: "steps_limit_exceeded", status: 409, requestId: "body-capacity", details: { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 } }) });
    expect(faults(error)).toContain(releaseFailure);
    if (kind === "refused") expect(faults(error)).toContain(cancelFailure);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
