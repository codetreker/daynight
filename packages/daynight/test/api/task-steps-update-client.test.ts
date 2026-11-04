import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { SetTaskStepStatusInput, StepsResource, TaskStep, UpdateTaskStepInput } from "../../src/api/types.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333", otherUser = "dddddddd-4444-4444-8444-444444444444";
const requestId = "12345678-1111-4111-8111-111111111111", stepId = "00abcdef";
const version = 9_007_199_254_740_993n, maximum = 9_223_372_036_854_775_807n;
const created = "2026-01-01T01:02:03.123456Z", updated = "2026-01-02T03:04:05.654321Z", changed = "2026-11-04T10:11:12.123456Z";
const target: TaskStep = { id: stepId, title: "old title", description: " # old Markdown\n", status: "todo", createdAt: created, updatedAt: updated };
const before: TaskStep = { ...target, id: "00000000", title: "same", status: "in_progress" };
const after: TaskStep = { ...target, id: "ffffffff", title: "same", status: "skipped" };
const previous: StepsResource = { projectId, taskId, version, steps: [before, target, after] };
const title = "  <原值&>😀\uFEFF  ";
const input: UpdateTaskStepInput = { version, title };
const result: StepsResource = { ...previous, version: version + 1n, steps: [before, { ...target, title, updatedAt: changed }, after] };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(`${stringifyApiJson(value)}\n`, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "X-Request-ID": "observed-request", ...headers } });
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); disposals.push(() => operation.dispose()); return { operation, api: createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch }) }; };
const faults = (cause: unknown, seen = new Set<unknown>()): unknown[] => {
  if (!(cause instanceof Error) || seen.has(cause)) return []; seen.add(cause);
  return [cause, ...(cause instanceof AggregateError ? cause.errors.flatMap((error: unknown) => faults(error, seen)) : []), ...faults(cause.cause, seen)];
};

describe("Step update and status receipts", () => {
  it("sends one correlated PATCH with exact int64 and canonical scope without hidden reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    expect(await fixture(fetch).api.updateTaskStep(projectId.toUpperCase(), taskId.toUpperCase(), stepId.toUpperCase(), input, { requestId })).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/${stepId}`);
    expect(options).toMatchObject({ method: "PATCH", cache: "no-store", redirect: "manual", headers: { "X-Request-ID": requestId, Authorization: "Bearer fixture-token", "Content-Type": "application/json" } });
    expect(parseApiJson(String(options!.body))).toEqual(input);
  });
  it.each(["todo", "in_progress", "done", "skipped"] as const)("sets %s independently using one PUT and preserves all other fields", async (status) => {
    for (const original of ["todo", "in_progress", "done", "skipped"] as const) {
      const current = { ...previous, steps: [before, { ...target, status: original }, after] };
      const expected = { ...current, version: version + (original === status ? 0n : 1n), steps: [before, { ...target, status, updatedAt: original === status ? updated : changed }, after] };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
      expect(await fixture(fetch).api.setTaskStepStatus(projectId, taskId, stepId.toUpperCase(), { version, status }, { requestId, previous: current })).toEqual(expected);
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/${stepId}/status`);
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PUT", headers: { "X-Request-ID": requestId } });
      expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version, status });
    }
  });
  it.each([
    { title: "\uFEFF" }, { description: "" }, { description: " # Markdown\r\n\"\\\u2028\u2029 �  " },
    { title, description: "new paired description\n" },
  ])("confirms raw paired or omitted fields without defaulting %#", async (changes) => {
    const expected = { ...result, steps: [before, { ...target, ...changes, updatedAt: changed }, after] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
    expect(await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, { version, ...changes }, { requestId, previous })).toEqual(expected);
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version, ...changes });
  });
  it.each([version, maximum])("confirms same-value no-op at exact version %s without inventing timestamps", async (currentVersion) => {
    const expected = { ...previous, version: currentVersion };
    for (const withPrevious of [false, true]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
      expect(await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, { version: currentVersion, title: target.title, description: target.description }, { requestId, ...(withPrevious ? { previous: expected } : {}) })).toEqual(expected);
      expect(fetch).toHaveBeenCalledOnce();
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
    expect(await fixture(fetch).api.setTaskStepStatus(projectId, taskId, stepId, { version: currentVersion, status: target.status }, { requestId, previous: expected })).toEqual(expected);
  });
  it("requires exact no-op/+1 according to the actual baseline instead of guessing", async () => {
    const cases = [
      { body: { ...result, version }, draft: input },
      { body: { ...previous, version: version + 1n }, draft: { version, title: target.title } },
      { body: { ...result, steps: [before, { ...result.steps[1]!, updatedAt: updated }, after] }, draft: input },
      { body: { ...previous, steps: [before, { ...target, updatedAt: changed }, after] }, draft: { version, title: target.title } },
    ];
    for (const { body, draft } of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
      await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, draft, { requestId, previous })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true, sentRequestId: requestId });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it.each([
    { steps: [before, { ...result.steps[1]!, description: "invented omission" }, after] },
    { steps: [before, { ...result.steps[1]!, status: "done" }, after] },
    { steps: [before, { ...result.steps[1]!, createdAt: changed }, after] },
    { steps: [{ ...before, title: "unrelated change" }, result.steps[1], after] },
    { steps: [before, result.steps[1], { ...after, updatedAt: changed }] },
    { steps: [result.steps[1], before, after] }, { steps: [before, result.steps[1]] },
  ])("keeps receipts that alter omitted fields, identities, times or order unknown %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, ...changes }));
    await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId, previous })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { version: version - 1n }, { version: version + 2n }, { taskId: projectId }, { projectId: taskId }, { steps: [] },
    { steps: [before, target, after] }, { steps: [before, { ...result.steps[1]!, id: stepId.toUpperCase() }, after] },
    { steps: [before, { ...result.steps[1]!, description: undefined }, after] }, { steps: [before, result.steps[1], result.steps[1]] },
  ])("strictly checks target fields and resource even without a baseline %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...result, ...changes }));
    await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId, stepId });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("checks status target and no-op/+1 without a baseline", async () => {
    for (const body of [previous, { ...previous, version: version + 1n }]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
      expect(await fixture(fetch).api.setTaskStepStatus(projectId, taskId, stepId, { version, status: "todo" }, { requestId })).toEqual(body);
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(previous));
    await expect(fixture(fetch).api.setTaskStepStatus(projectId, taskId, stepId, { version, status: "done" }, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId });
  });
  it.each([
    {}, { version: 0n, title }, { title: "\u0085" }, { title: "\ud800" }, { description: "\0" }, { description: null },
  ])("rejects invalid update input without dispatch %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, { version, ...changes } as UpdateTaskStepInput, { requestId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: requestId, stepId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, null, "invalid", "DONE"])("rejects illegal or omitted status %#", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(fetch).api.setTaskStepStatus(projectId, taskId, stepId, { version, status } as SetTaskStepStatusInput, { requestId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: requestId, stepId });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid identity, previous scope/version and request ID before dispatch", async () => {
    for (const [id, options] of [["prefix", { requestId }], [stepId, { requestId: "bad\nid" }], [stepId, { requestId, previous: { ...previous, version: version - 1n } }], [stepId, { requestId, previous: { ...previous, taskId: projectId } }]] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, id, input, options)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: options.requestId });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it("counts actual serialized UTF8 and escapes at the inclusive 1MiB request limit", async () => {
    const base = { version, title: "x", description: "\n\\😀" };
    const padding = 1_048_576 - Buffer.byteLength(stringifyApiJson(base));
    const exact = { ...base, title: "x" + "a".repeat(padding) };
    const expected = { ...result, steps: [before, { ...target, title: exact.title, description: exact.description, updatedAt: changed }, after] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
    expect(await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, exact, { requestId, previous })).toEqual(expected);
    expect(Buffer.byteLength(String(fetch.mock.calls[0]![1]!.body))).toBe(1_048_576);
    const noDispatch = vi.fn<typeof globalThis.fetch>();
    await expect(fixture(noDispatch).api.updateTaskStep(projectId, taskId, stepId, { ...exact, title: exact.title + "a" }, { requestId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: requestId, cause: expect.objectContaining({ kind: "request_limit" }) });
    expect(noDispatch).not.toHaveBeenCalled();
  });
  it.each([400, 401, 404, 409, 410, 500, 503])("preserves status%d refusal or unknown classification without replay", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "version_conflict", message: "Public refusal", requestId: "body-request" } }, status));
    await expect(fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ status, sentRequestId: requestId, stepId, responseRequestId: "observed-request", requestId: "body-request", confirmedRefusal: status < 500, outcomeUnconfirmed: status >= 500 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("preserves capacity details while malformed capacity details remain unknown", async () => {
    for (const invalid of [false, true]) {
      const details = { encodedBytes: invalid ? 1 : 67_108_865, maxEncodedBytes: 67_108_864 };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "steps_limit_exceeded", message: "Capacity exceeded", requestId: "body-capacity", details } }, 409));
      const failure = await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId }).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ sentRequestId: requestId, stepId, outcomeUnconfirmed: invalid, confirmedRefusal: !invalid });
      if (!invalid) expect(failure).toMatchObject({ details, code: "steps_limit_exceeded" });
    }
  });
  it("keeps dispatched network loss and cancellation unknown with original identity", async () => {
    const loss = new Error("private-network-sentinel");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(loss);
    const failure = await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ phase: "request", outcomeUnconfirmed: true, sentRequestId: requestId, stepId });
    expect(faults(failure)).toContain(loss); expect(fetch).toHaveBeenCalledOnce();
    const cancellation = new AbortController(), operation = createOperation({ signal: cancellation.signal }); disposals.push(() => operation.dispose());
    const cancelled = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => { cancellation.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable"); });
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch: cancelled });
    await expect(api.setTaskStepStatus(projectId, taskId, stepId, { version, status: "done" }, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId, stepId, cause: expect.objectContaining({ kind: "cancelled" }) });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each(["response", "total"] as const)("retains unknown after dispatched %s-byte failure", async (kind) => {
    const operation = createOperation({ limits: kind === "response" ? { responseBytes: 32 } : { totalBytes: 32 } }); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.updateTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true, sentRequestId: requestId, cause: expect.objectContaining({ kind: kind === "response" ? "response_limit" : "total_limit" }) });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("binds principal on malformed success before the same-operation read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("{", { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } })).mockResolvedValueOnce(json(result, 200, { "Daynight-User-ID": otherUser }));
    const { api } = fixture(fetch);
    await expect(api.updateTaskStep(projectId, taskId, stepId, input, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(api.listTaskSteps(projectId, taskId, { requestId: requestId + ".r1" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["confirmed", "refused"] as const)("retains %s receipt through local stream-release failure", async (kind) => {
    const loss = new Error("private-release");
    const response = kind === "confirmed" ? json(result) : json({ error: { code: "version_conflict", message: "Stale version", requestId: "body-request" } }, 409);
    const reader = response.body!.getReader(), release = reader.releaseLock.bind(reader);
    Object.defineProperty(reader, "releaseLock", { value: () => { release(); throw loss; } });
    Object.defineProperty(response.body, "getReader", { value: () => reader });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const failure = await fixture(fetch).api.updateTaskStep(projectId, taskId, stepId, input, { requestId, previous }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ sentRequestId: requestId, stepId, outcomeUnconfirmed: false, ...(kind === "confirmed" ? { confirmedMutationId: stepId } : { confirmedRefusal: true, code: "version_conflict" }) });
    expect(faults(failure)).toContain(loss); expect(fetch).toHaveBeenCalledOnce();
  });
});
