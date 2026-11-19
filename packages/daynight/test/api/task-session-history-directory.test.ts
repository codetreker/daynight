import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import { actorId, claimId, projectId, sessionId, taskId, time } from "../fixtures/task-observation.js";

const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });
const otherSessionId = "55555555-5555-4555-8555-555555555555";
const oldClaimId = "66666666-6666-4666-8666-666666666666";
const item = {
  taskId, sessionId, claimId, executionGeneration: "9007199254740993", agentControlMode: "web", contentKind: "native_timeline",
  createdAt: time, endedAt: null, currentBinding: false, archiveState: "expired", completeness: "complete",
  expiresAt: time, expiredAt: time, reason: "history_expired", retentionState: "expired", scopeEndedAt: time,
  firstArchivedAt: time, legacyGraceStartedAt: null,
};
const page = { version: 1, graphVersion: "115792089237316195423570985008687907853269984665640564039457584007913129639935", items: [item], nextCursor: "exact-next-cursor", observedAt: time };
const legacyItem = {
  sessionId, claimId, executionGeneration: "1", agentControlMode: "web", contentKind: "native_timeline", createdAt: time, endedAt: null, currentBinding: false,
  archive: { state: "ready", sha256: null, byteLength: null, completeness: "complete" },
};
const fixture = (body: unknown = page, status = 200, directoryVersion: string | null = "1") => {
  const operation = createOperation(); operations.push(operation);
  const headers: Record<string, string> = { "content-type": "application/json", "Daynight-User-ID": actorId };
  if (directoryVersion !== null) headers["Daynight-Task-History-Directory-Version"] = directoryVersion;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(stringifyApiJson(body), { status, headers }));
  return { api: createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }), fetch };
};

describe("Task Session history directory version 1", () => {
  it("uses the separate versioned entry and preserves the full page and exact graph version", async () => {
    const f = fixture();
    expect(await f.api.listTaskSessionHistoryDirectory(projectId, taskId, { limit: 2, cursor: "exact-previous-cursor" })).toEqual(page);
    expect(f.fetch).toHaveBeenCalledOnce();
    const request = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(request.pathname).toBe(`/api/v1/projects/${projectId}/history-directory/tasks/${taskId}/sessions`);
    expect(Object.fromEntries(request.searchParams)).toEqual({ limit: "2", cursor: "exact-previous-cursor" });
  });

  it("retains an old Session and claim beside a different current binding", async () => {
    const value = { ...page, items: [{ ...item, currentBinding: true }, { ...item, sessionId: otherSessionId, claimId: oldClaimId, executionGeneration: "2" }] };
    const f = fixture(value);
    expect(await f.api.listTaskSessionHistoryDirectory(projectId, taskId)).toEqual(value);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each(["pending", "unavailable", "failed", "ready", "partial", "expired"])("retains archive state %s and nullable time facts", async archiveState => {
    const value = { ...page, items: [{ ...item, archiveState, expiresAt: null, expiredAt: null, retentionState: "unknown", reason: "archive_time_unknown", scopeEndedAt: null, firstArchivedAt: null, completeness: null }] };
    expect(await fixture(value).api.listTaskSessionHistoryDirectory(projectId, taskId)).toEqual(value);
  });

  it("preserves Herdr recording identity and its original unavailability reason", async () => {
    const value = { ...page, items: [{ ...item, agentControlMode: "herdr", contentKind: "terminal_recording", archiveState: "unavailable", retentionState: "unknown", reason: "recording_not_enabled", expiresAt: null, expiredAt: null }] };
    expect(await fixture(value).api.listTaskSessionHistoryDirectory(projectId, taskId)).toEqual(value);
  });

  it.each(["createdAt", "endedAt", "expiresAt", "expiredAt", "scopeEndedAt", "firstArchivedAt", "legacyGraceStartedAt"])("preserves valid offset timestamps in %s from non-UTC servers", async field => {
    const value = { ...page, observedAt: "2026-11-19T08:00:00+08:00", items: [{ ...item, [field]: "2026-11-19T03:04:05.123456789-05:30" }] };
    expect(await fixture(value).api.listTaskSessionHistoryDirectory(projectId, taskId)).toEqual(value);
  });

  it.each(["2026-11-19T08:00:00+24:00", "2026-11-19T08:00:00+08:60", "2026-11-19T08:00:00+8:00", "2026-02-30T08:00:00+08:00", "2026-11-19T24:00:00+08:00", "2026-11-19T08:00:00"])("rejects invalid offset timestamp %s", async firstArchivedAt => {
    await expect(fixture({ ...page, items: [{ ...item, firstArchivedAt }] }).api.listTaskSessionHistoryDirectory(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([null, "0", "2", "1, 1"])("rejects missing or unsupported capability %s without legacy fallback", async header => {
    const f = fixture(page, 200, header);
    await expect(f.api.listTaskSessionHistoryDirectory(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { version: 2 }, { version: "1" }, { graphVersion: 123 }, { graphVersion: "01" }, { graphVersion: "-1" },
    { group: {} }, { observedAt: null }, { nextCursor: "" }, { nextCursor: "\n" }, { nextCursor: "a".repeat(4097) },
    { items: [item, item] }, { items: [{ ...item, taskId: projectId }] }, { items: [{ ...item, claimId: "invalid" }] },
    { items: [{ ...item, executionGeneration: "0" }] }, { items: [{ ...item, agentControlMode: "herdr" }] },
    { items: [{ ...item, archiveState: "unknown-state" }] }, { items: [{ ...item, retentionState: "unknown-state" }] },
    { items: [{ ...item, expiresAt: "2026-02-30T00:00:00Z" }] }, { items: [{ ...item, group: {} }] },
    { items: [{ ...item, currentBinding: true }, { ...item, sessionId: otherSessionId, currentBinding: true }] },
  ])("rejects malformed or mixed-identity data %#", async change => {
    const f = fixture({ ...page, ...change });
    await expect(f.api.listTaskSessionHistoryDirectory(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("rejects missing required fields and a response exceeding the requested item count", async () => {
    const { firstArchivedAt: _missing, ...missingField } = item;
    await expect(fixture({ ...page, items: [missingField] }).api.listTaskSessionHistoryDirectory(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(fixture({ ...page, items: [item, { ...item, sessionId: otherSessionId }] }).api.listTaskSessionHistoryDirectory(projectId, taskId, { limit: 1 })).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: "" }, { cursor: "a".repeat(4097) }])("rejects invalid pagination before HTTP %#", async input => {
    const f = fixture();
    await expect(f.api.listTaskSessionHistoryDirectory(projectId, taskId, input)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [409, "reset_required"], [500, "internal_error"]] as const)("preserves %s/%s with no fallback or retry", async (status, code) => {
    const f = fixture({ error: { code, message: "Directory refused.", requestId: "directory-refused" } }, status, null);
    await expect(f.api.listTaskSessionHistoryDirectory(projectId, taskId)).rejects.toMatchObject({ status, code, phase: "response" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([null, "1"])("keeps the legacy list contract with server capability %s", async header => {
    const value = { items: [legacyItem], nextCursor: null };
    const f = fixture(value, 200, header);
    expect(await f.api.listTaskSessions(projectId, taskId)).toEqual(value);
    expect(f.fetch).toHaveBeenCalledOnce();
    const request = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(request.pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions`);
    expect(request.searchParams.get("view")).toBe("inspection");
  });

  it.each([{ group: {} }, { expiresAt: time }])("keeps rejecting new metadata on the legacy endpoint %#", async extra => {
    const f = fixture({ items: [{ ...legacyItem, ...extra }], nextCursor: null });
    await expect(f.api.listTaskSessions(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
