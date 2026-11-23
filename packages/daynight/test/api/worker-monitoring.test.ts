import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { createOperation } from "../../src/api/operation.js";
import type { DirectObservation } from "../../src/commands/worker/monitoring/types.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const worker = uuid(1), user = uuid(2), requestId = uuid(3);
const now = "2026-01-01T00:00:00Z", expiresAt = "2026-01-01T01:00:00Z";
const observation: DirectObservation = { capturedAt: now, lifecycle: "starting", scheduler: { phase: "initializing", coverage: "unknown", cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null }, capacity: null, admission: { observedAt: now, coverage: "unknown", reasons: [] }, reservations: [], activities: [], currentFailures: [], lastRecovery: null, detailCoverage: "complete", delivery: { lastSucceededAt: null, lastFailure: null } };
const response = (value: unknown, status = 200, principal = user): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); disposals.push(() => operation.dispose()); return createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation, fetch }); };

describe("worker monitoring HTTP contract", () => {
  it("posts the current observation directly with a correlation ID", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ receivedAt: now, expiresAt }));
    expect(await fixture(fetch).writeWorkerMonitoring(worker, observation, requestId)).toEqual({ receivedAt: now, expiresAt });
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/me/workers/${worker}/monitoring`);
    expect(options!.method).toBe("POST");
    expect(new Headers(options!.headers).get("x-request-id")).toBe(requestId);
    expect(JSON.parse(String(options!.body))).toEqual(observation);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { receivedAt: now }, { receivedAt: now, expiresAt, revision: uuid(4) },
    { receivedAt: "2026-02-30T00:00:00Z", expiresAt },
    { receivedAt: now, expiresAt: "2026-01-01T01:00:00.001Z" },
    { receivedAt: "2026-01-01T00:00:00.000000001Z", expiresAt },
  ])("rejects malformed or inconsistent receipts", async body => {
    await expect(fixture(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body))).writeWorkerMonitoring(worker, observation, requestId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("validates principal and duplicate fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ receivedAt: now, expiresAt }, 200, uuid(9))).mockResolvedValueOnce(new Response(`{"receivedAt":"${now}","receivedAt":"${now}","expiresAt":"${expiresAt}"}`, { headers: { "content-type": "application/json", "Daynight-User-ID": user } }));
    const api = fixture(fetch);
    await expect(api.writeWorkerMonitoring(worker, observation, requestId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.writeWorkerMonitoring(worker, observation, requestId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("recognizes a confirmed monitoring unavailable response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "monitoring_unavailable", message: "unavailable", requestId } }, 503));
    await expect(fixture(fetch).writeWorkerMonitoring(worker, observation, requestId)).rejects.toMatchObject({ status: 503, confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("leaves a 503 write outcome unknown without fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "monitoring_write_outcome_unknown", message: "unavailable", requestId } }, 503));
    await expect(fixture(fetch).writeWorkerMonitoring(worker, observation, requestId)).rejects.toMatchObject({ status: 503, outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
