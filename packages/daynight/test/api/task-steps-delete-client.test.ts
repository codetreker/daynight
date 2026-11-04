import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { DeleteTaskStepInput, StepsResource, TaskStep } from "../../src/api/types.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333", otherUser = "dddddddd-4444-4444-8444-444444444444";
const requestId = "12345678-1111-4111-8111-111111111111", stepId = "00abcdef";
const input: DeleteTaskStepInput = { version: 9_007_199_254_740_993n };
const stamp = "2026-11-04T10:11:12.123456Z";
const target: TaskStep = { id: stepId, title: "delete target", description: "[Keep reference](plan.md)", status: "todo", createdAt: stamp, updatedAt: stamp };
const first: TaskStep = { ...target, id: "00000000", title: "  <raw&>😀  ", description: "surviving Markdown\r\n", status: "done", createdAt: "2026-01-01T01:02:03Z", updatedAt: "2026-01-02T03:04:05.654321Z" };
const last: TaskStep = { ...first, id: "ffffffff", status: "skipped" };
const previous: StepsResource = { projectId, taskId, version: input.version, steps: [first, target, last] };
const result: StepsResource = { ...previous, version: input.version + 1n, steps: [first, last] };
const endpoint = `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${stepId}`;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(`${stringifyApiJson(value)}\n`, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "X-Request-ID": "observed-request", ...headers } });
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); disposals.push(() => operation.dispose()); return { operation, api: createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch }) }; };
const faults = (cause: unknown, seen = new Set<unknown>()): unknown[] => {
  if (!(cause instanceof Error) || seen.has(cause)) return []; seen.add(cause);
  return [cause, ...(cause instanceof AggregateError ? cause.errors.flatMap((error: unknown) => faults(error, seen)) : []), ...faults(cause.cause, seen)];
};

describe("Steps Delete receipt and transport", () => {
  it("sends one correlated canonical JSON DELETE with exact int64 and no hidden reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    expect(await fixture(fetch).api.deleteTaskStep(projectId.toUpperCase(), taskId.toUpperCase(), stepId.toUpperCase(), input, { requestId })).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787${endpoint}`);
    expect(options).toMatchObject({ method: "DELETE", cache: "no-store", redirect: "manual", headers: { "X-Request-ID": requestId, Authorization: "Bearer fixture-token", "Content-Type": "application/json" } });
    expect(parseApiJson(String(options!.body))).toEqual(input);
    expect(String(options!.body)).toBe('{"version":9007199254740993}');
  });
  it.each(["todo", "in_progress", "done", "skipped"] as const)("confirms deletion of %s without changing survivors", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    const baseline = { ...previous, steps: [first, { ...target, status }, last] };
    expect(await fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId, previous: baseline })).toEqual(result);
  });
  it("confirms deletion of the last record as an explicit empty collection", async () => {
    const empty = { ...result, steps: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(empty));
    expect(await fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId, previous: { ...previous, steps: [target] } })).toEqual(empty);
  });
  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects invalid version %s without dispatch", async (version) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, { version }, { requestId })).rejects.toMatchObject({ operation: "task.step.delete", sentRequestId: requestId, stepId, phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", "prefix", "000000000", "00abcde\n"])("does not dispatch invalid Step identity %#", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, id, input, { requestId })).rejects.toMatchObject({ operation: "task.step.delete", sentRequestId: requestId, phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", "-invalid", "bad\nid", "x".repeat(65)])("does not dispatch invalid request identity %#", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId: id })).rejects.toMatchObject({ sentRequestId: id, phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ version: input.version - 1n }, { taskId: projectId }, { steps: [target, target] }])("rejects an invalid supplied baseline before dispatch %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId, previous: { ...previous, ...changes } })).rejects.toMatchObject({ sentRequestId: requestId, phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { version: input.version }, { version: input.version + 2n }, { taskId: projectId }, { projectId: taskId }, { steps: [first, target, last] }, { steps: null }, { steps: [first, first] },
  ])("retains an invalid successful receipt as unknown without replay %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, ...changes }));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ operation: "task.step.delete", sentRequestId: requestId, stepId, status: 200, phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [last, first], [first], [first, last, { ...last, id: "11111111" }], [{ ...first, title: "changed" }, last],
    [{ ...first, description: "changed" }, last], [{ ...first, status: "todo" }, last], [{ ...first, createdAt: stamp }, last], [{ ...first, updatedAt: stamp }, last],
  ])("requires complete survivor content, order and timestamps against the actual baseline %#", async (...steps) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, steps }));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId, previous })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not invent evidence that the target existed in a supplied baseline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId, previous: { ...previous, steps: [first, last] } })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([201, 202, 204])("rejects a non-contract success status %s as unknown", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(status === 204 ? new Response(null, { status }) : json(result, status));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ status, sentRequestId: requestId, outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 404, 409, 410, 500, 503])("retains parsed status%s and distinct original/server request identities", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: status === 410 ? "task_deleted" : status === 404 ? "not_found" : "version_exhausted", message: "Public refusal", requestId: "body-request" } }, status));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ status, sentRequestId: requestId, responseRequestId: "observed-request", requestId: "body-request", serverMessage: "Public refusal", confirmedRefusal: status < 500, outcomeUnconfirmed: status >= 500 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains parsed capacity details from a refusal", async () => {
    const details = { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "steps_limit_exceeded", message: "Capacity exceeded", requestId: "body-capacity", details } }, 409));
    await expect(fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ code: "steps_limit_exceeded", details, confirmedRefusal: true, outcomeUnconfirmed: false });
  });
  it("preserves network loss and original identity without retrying", async () => {
    const failure = new Error("private-network-sentinel");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    const error = await fixture(fetch).api.deleteTaskStep(projectId, taskId, stepId, input, { requestId }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ phase: "request", sentRequestId: requestId, stepId, outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(faults(error)).toContain(failure); expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps cancellation after dispatch unknown in the same aborted Operation", async () => {
    const cancellation = new AbortController(); const operation = createOperation({ signal: cancellation.signal }); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => { cancellation.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable"); });
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true, cause: expect.objectContaining({ kind: "cancelled" }) });
    expect(() => operation.check()).toThrow("Operation cancelled."); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["response", "total"] as const)("keeps dispatched %s-byte failure unknown with actual Operation liveness", async (kind) => {
    const operation = createOperation({ limits: kind === "response" ? { responseBytes: 32 } : { totalBytes: 32 } }); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: true, cause: expect.objectContaining({ kind: kind === "response" ? "response_limit" : "total_limit" }) });
    if (kind === "response") expect(() => operation.check()).not.toThrow(); else expect(() => operation.check()).toThrow("Operation response byte budget exceeded.");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("binds principal before a malformed success and keeps correlated observation in the same identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("{", { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } })).mockResolvedValueOnce(json(result, 200, { "Daynight-User-ID": otherUser }));
    const { api } = fixture(fetch);
    await expect(api.deleteTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(api.listTaskSteps(projectId, taskId, { requestId: requestId + ".r1" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false, sentRequestId: requestId + ".r1" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["confirmed", "refused"] as const)("preserves %s facts and error chains when stream cleanup fails", async (kind) => {
    const releaseFailure = new Error("release-private"), cancelFailure = new Error("cancel-private");
    const response = kind === "confirmed" ? json(result) : json({ error: { code: "version_exhausted", message: "Version exhausted", requestId: "body-refusal" } }, 409);
    const reader = response.body!.getReader(), release = reader.releaseLock.bind(reader);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response); const { api, operation } = fixture(fetch);
    Object.defineProperty(reader, "releaseLock", { value: () => { release(); operation.dispose(); throw releaseFailure; } });
    if (kind === "refused") Object.defineProperty(reader, "cancel", { value: async () => { throw cancelFailure; } });
    Object.defineProperty(response.body, "getReader", { value: () => reader });
    const error = await api.deleteTaskStep(projectId, taskId, stepId, input, { requestId }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ sentRequestId: requestId, outcomeUnconfirmed: false, ...(kind === "confirmed" ? { confirmedMutationId: stepId, status: 200 } : { confirmedRefusal: true, code: "version_exhausted", status: 409 }) });
    expect(faults(error)).toContain(releaseFailure); if (kind === "refused") expect(faults(error)).toContain(cancelFailure);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
