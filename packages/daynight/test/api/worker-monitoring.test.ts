import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../src/api/client.js";
import { createOperation } from "../../src/api/operation.js";
import type { Observation } from "../../src/commands/worker/monitoring/types.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const worker = uuid(1), user = uuid(2), requestId = uuid(3), runId = uuid(4), revision = uuid(5);
const now = "2026-01-01T00:00:00Z", expiresAt = "2026-01-01T01:00:00Z";
const observation: Observation = { runId, sequence: "1", capturedAt: now, lifecycle: "starting", scheduler: { phase: "initializing", coverage: "unknown", cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null }, capacity: null, admission: { observedAt: now, coverage: "unknown", reasons: [] }, reservations: [], activities: [], currentFailures: [], lastRecovery: null, detailCoverage: "complete", delivery: { lastSucceededAt: null, lastFailure: null } };
const absent = { observedAt: now, state: "absent", revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage: "complete", permissionProjection: "current" };
const available = { ...absent, state: "available", revision, runId, sequence: "1", receivedAt: now, expiresAt, data: observation };
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": user } });
const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); disposals.push(() => operation.dispose()); return createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation, fetch }); };

describe("worker monitoring HTTP contract", () => {
  it("sends the revision and current observation with its own request ID, and validates the receipt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ revision, runId, sequence: "1", receivedAt: now, expiresAt }));
    const result = await fixture(fetch).writeWorkerMonitoring(worker, null, observation, requestId);
    expect(result.revision).toBe(revision);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/me/workers/${worker}/monitoring`);
    expect(options!.method).toBe("PUT"); expect(new Headers(options!.headers).get("x-request-id")).toBe(requestId);
    expect(JSON.parse(String(options!.body))).toEqual({ expectedRevision: null, observation });
  });
  it("decodes absent and available responses with exact metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(absent)).mockResolvedValueOnce(response(available));
    const api = fixture(fetch);
    expect(await api.readWorkerMonitoring(worker, requestId)).toEqual({ state: "absent" });
    expect(await api.readWorkerMonitoring(worker, requestId)).toEqual({ state: "available", revision, runId, sequence: "1" });
  });
  it("decodes projected scoped activity and rejects missing association", async () => {
    const activity = { kind: "execution", phase: "executing", operationId: uuid(6), status: "running", scope: { kind: "claim", projectId: uuid(7), taskId: uuid(8), claimId: uuid(9) }, startedAt: now, lastProgressAt: now, elapsedMs: 42, deadlineAt: null, waitReason: null, nextAttemptAt: null, association: { kind: "task", projectName: "Project", title: "Task" } };
    const without = { ...activity } as Partial<typeof activity>; delete without.association;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ ...available, data: { ...observation, activities: [activity] } })).mockResolvedValueOnce(response({ ...available, data: { ...observation, activities: [without] } }));
    const api = fixture(fetch);
    await expect(api.readWorkerMonitoring(worker, requestId)).resolves.toMatchObject({ state: "available", runId });
    await expect(api.readWorkerMonitoring(worker, requestId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it.each([
    { ...absent, revision }, { ...available, sequence: "01" }, { ...available, data: { ...observation, unexpected: true } },
    { ...available, data: { ...observation, activities: [{ kind: "invented" }] } },
  ])("rejects malformed or contradictory state", async body => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    await expect(fixture(fetch).readWorkerMonitoring(worker, requestId)).rejects.toMatchObject({ phase: "protocol" });
  });
  it("exposes a confirmed CAS conflict and leaves 503 write outcome unknown", async () => {
    const error = (code: string) => ({ error: { code, message: "unavailable", requestId } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(error("monitoring_revision_conflict"), 409)).mockResolvedValueOnce(response(error("monitoring_write_outcome_unknown"), 503));
    const api = fixture(fetch);
    const conflict = await api.writeWorkerMonitoring(worker, revision, observation, requestId).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError); expect(conflict).toMatchObject({ status: 409, code: "monitoring_revision_conflict", outcomeUnconfirmed: false });
    const unknown = await api.writeWorkerMonitoring(worker, revision, observation, requestId).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ status: 503, outcomeUnconfirmed: true });
  });
});
