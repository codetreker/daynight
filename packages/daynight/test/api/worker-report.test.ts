import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, WorkerReport, WorkerReportReceipt } from "../../src/api/index.js";
import { parseWorkerReportReceipt } from "../../src/api/parse.js";

const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = "2026-10-29T12:34:56.123456789Z";
const receipt: WorkerReportReceipt = { observedAt: time, lastReportedAt: time };
const report: WorkerReport = {
  machine: { id: otherId, name: "Worker machine" }, platform: "linux", workingDirectory: "/workspace", sampledAt: time,
  os: { state: "ok", checkedAt: time, value: { type: "Linux", release: "6.8", version: "test kernel", arch: "x64" } },
  cpu: { state: "ok", checkedAt: time, value: { model: "Test CPU", logicalProcessors: 4, usagePercent: 12.5 } },
  memory: { state: "ok", checkedAt: time, value: { usedBytes: 1024, totalBytes: 4096 } },
  disk: { state: "error", checkedAt: time, code: "permission_denied" },
  versions: {
    daynight: "0.26.0", herdr: { state: "not_running", checkedAt: time },
    codex: { state: "ok", checkedAt: time, value: "0.100.0" }, copilot: { state: "not_installed", checkedAt: time },
  },
  taskInventory: null,
};
const operations: Operation[] = [];
const response = (value: unknown = receipt, status = 200, principal: string | undefined = userId): Response => new Response(stringifyApiJson(value), {
  status, headers: { "Content-Type": "application/json", ...(principal === undefined ? {} : { "Daynight-User-ID": principal }) },
});
const client = (fetch: typeof globalThis.fetch, options: { readonly operation?: Operation; readonly expectedUserId?: string } = {}) => {
  const operation = options.operation ?? createOperation({ limits: { totalMs: 1_000, requestMs: 500 } });
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: options.expectedUserId ?? userId, operation, fetch });
};
afterEach(() => {
  for (const operation of operations.splice(0)) operation.dispose();
  vi.restoreAllMocks();
});

describe("worker report API", () => {
  it.each([null, { observedAt: time, claims: [] }, { observedAt: time, claims: [{ projectId: userId, taskId: otherId, claimId: workerId }] }])("sends the exact report with inventory %j and accepts HTTP 200", async (taskInventory) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const input: WorkerReport = { ...report, taskInventory };
    await expect(client(fetch).reportWorker(workerId.toUpperCase(), input)).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/me/workers/${workerId}/report`);
    expect(options).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer fixture-token" } });
    expect(new Headers(options!.headers).get("Daynight-User-ID")).toBeNull();
    expect(parseApiJson(options!.body as string)).toEqual(input);
  });

  it.each(["", "invalid", "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", ` ${workerId}`, `${workerId}/report`])("rejects malformed worker ID %j before dispatch", (invalidId) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).reportWorker(invalidId, report)).toThrow("hyphenated UUID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "invalid", otherId, `${userId}, ${userId}`])("rejects successful receipt principal %j without replay", async (principal) => {
    const result = response();
    if (principal === undefined) result.headers.delete("Daynight-User-ID");
    else result.headers.set("Daynight-User-ID", principal);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(result);
    await expect(client(fetch).reportWorker(workerId, report)).rejects.toMatchObject({ operation: "worker.report", phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves a confirmed authentication refusal without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "unauthorized", message: "Authentication required.", requestId: "report-auth" } }, 401));
    await expect(client(fetch).reportWorker(workerId, report)).rejects.toMatchObject({ status: 401, code: "unauthorized", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refuses an unexpected POST 201 success without replaying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt, 201));
    await expect(client(fetch).reportWorker(workerId, report)).rejects.toMatchObject({ phase: "protocol", status: 201, outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains an uncertain lost response without replaying the write", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Connection closed"));
    await expect(client(fetch).reportWorker(workerId, report)).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a pending receipt stream when the caller aborts without replaying", async () => {
    const controller = new AbortController();
    const operation = createOperation({ signal: controller.signal });
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull: () => { controller.abort(); }, cancel }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await expect(client(fetch, { operation }).reportWorker(workerId, report)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains the request timeout and response byte budgets without replaying", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    const operation = createOperation({ limits: { totalMs: 500, requestMs: 20 } });
    await expect(client(fetch, { operation }).reportWorker(workerId, report)).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: true, cause: { kind: "request_timeout" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();

    const boundedFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const boundedOperation = createOperation({ limits: { responseBytes: 8 } });
    await expect(client(boundedFetch, { operation: boundedOperation }).reportWorker(workerId, report)).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: true, cause: { kind: "response_limit" } });
    expect(boundedFetch).toHaveBeenCalledOnce();
  });
});

describe("worker report receipt", () => {
  it("retains server timestamp precision", () => {
    expect(parseWorkerReportReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    null, [], {}, { observedAt: time }, { lastReportedAt: time },
    { ...receipt, observedAt: null }, { ...receipt, lastReportedAt: 123 },
    { ...receipt, observedAt: "2026-02-30T00:00:00Z" }, { ...receipt, lastReportedAt: "2026-10-29T12:34:56+00:00" },
    { ...receipt, observedAt: "0001-01-01T00:00:00Z" }, { ...receipt, lastReportedAt: "0001-01-01T00:00:00.000000000Z" },
    { ...receipt, observedAt: "2026-10-29T12:34:56.1234567890Z" }, { ...receipt, workerId },
  ])("rejects a malformed receipt %j without replay", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
    await expect(client(fetch).reportWorker(workerId, report)).rejects.toMatchObject({ operation: "worker.report", phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
