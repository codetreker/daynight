import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import { actorId, claimId, inspection, observation, projectId, sessionId, task, taskId, time } from "../fixtures/task-observation.js";

const operations: Operation[] = [];
const response = (body: unknown, status = 200, principal = actorId): Response => new Response(stringifyApiJson(body), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const client = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
};
const refusal = (code: string, status = 400) => response({ error: { code, message: "query contains an unknown parameter", requestId: "observation-test" } }, status);
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

describe("Task Session observation reads", () => {
  it("negotiates an observation while retaining exact Task and execution versions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...task, session: observation }));
    const result = await client(fetch).getObservedTask(projectId, taskId);
    expect(result.version).toBe(9_007_199_254_740_993n);
    expect(result.session).toEqual(observation);
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("include")).toBe("session");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 2, "1"].map(schemaVersion => ({ schemaVersion }))) ("rejects a malformed Session DTO without falling back %#", async ({ schemaVersion }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...task, session: { ...observation, schemaVersion } }));
    await expect(client(fetch).getObservedTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { send: { allowed: "yes", mode: "start", reason: "allowed" } }, { connectionEpoch: 3 }, { sessionId: "native-id" },
    { observation: "healthy" }, { observedAt: "yesterday" }, { nativeSessionId: undefined }, { currentTurnId: undefined },
    { error: { code: "broken", message: "safe", secret: "not-allowed" } }, { unexpected: true },
  ])("rejects malformed present observation fields %#", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...task, session: { ...observation, ...changes } }));
    await expect(client(fetch).getObservedTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("labels an old successful Task response unsupported without inventing timestamps", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(task));
    const result = await client(fetch).getObservedTask(projectId, taskId);
    expect(result.session).toMatchObject({ observation: "unsupported", registration: "unknown", sessionId: null, observedAt: null, freshUntil: null, send: { allowed: null, mode: null } });
    expect(result.title).toBe("Task");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["invalid_input", "unsupported"]) ("performs one plain read after an explicit %s negotiation refusal", async code => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(refusal(code)).mockResolvedValueOnce(response(task));
    const result = await client(fetch).getObservedTask(projectId, taskId);
    expect(result.session.observation).toBe("unsupported");
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.has("include"))).toEqual([true, false]);
  });

  it.each([["unauthenticated", 401], ["forbidden", 403], ["internal_error", 500], ["invalid_input", 409]] as const) ("does not mask %s as unsupported", async (code, status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(refusal(code, status));
    await expect(client(fetch).getObservedTask(projectId, taskId)).rejects.toMatchObject({ status, code });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not turn a network failure into a plain fallback read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unavailable"));
    await expect(client(fetch).getObservedTask(projectId, taskId)).rejects.toMatchObject({ phase: "request" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads every observed list page without replacing each Task with a current request", async () => {
    const secondId = "55555555-5555-4555-8555-555555555555";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [{ ...task, session: observation }], observedAt: time, partial: false, nextCursor: "page-two" }))
      .mockResolvedValueOnce(response({ items: [{ ...task, id: secondId, session: { ...observation, observation: "unavailable", error: { code: "unavailable", message: "Observation failed" }, send: { allowed: null, mode: null, reason: "unknown" } } }], observedAt: time, partial: true, nextCursor: null }));
    const result = await client(fetch).listObservedTasks(projectId, { assignedTo: "me" });
    expect(result.items.map(item => item.id)).toEqual([taskId, secondId]);
    expect(result.partial).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("include"))).toEqual(["session", "session"]);
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("cursor")).toBe("page-two");
  });

  it("preserves list principal binding and refuses repeated IDs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [{ ...task, session: observation }], observedAt: time, partial: false, nextCursor: "page-two" }))
      .mockResolvedValueOnce(response({ items: [{ ...task, session: observation }], observedAt: time, partial: false, nextCursor: null }));
    await expect(client(fetch).listObservedTasks(projectId, { assignedTo: "me" })).rejects.toMatchObject({ phase: "pagination" });
  });

  it("retains partial knowledge for an empty old-service result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(refusal("invalid_input")).mockResolvedValueOnce(response({ items: [], nextCursor: null }));
    await expect(client(fetch).listObservedTasks(projectId)).resolves.toMatchObject({ items: [], partial: true, unsupported: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates later page metadata even after the first page was partial", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [{ ...task, session: observation }], observedAt: time, partial: true, nextCursor: "next" }))
      .mockResolvedValueOnce(response({ items: [], observedAt: time, partial: "false", nextCursor: null }));
    await expect(client(fetch).listObservedTasks(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([{ observedAt: "yesterday" }, { observedAt: undefined }, { partial: undefined }])("rejects malformed observed list metadata %#", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [{ ...task, session: observation }], observedAt: time, partial: false, nextCursor: null, ...changes }));
    await expect(client(fetch).listObservedTasks(projectId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads inspection by the exact project, Task and Session and preserves its fence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(inspection));
    const result = await client(fetch).inspectTaskSession(projectId, taskId, sessionId);
    expect(result).toEqual(inspection);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions/${sessionId}/inspection`);
  });

  it.each([
    { taskId: claimId }, { sessionId: claimId }, { fence: { ...inspection.fence, claimId: taskId } },
    { source: "native-file" }, { currentBinding: null },
  ])("refuses an inspection identity or shape mismatch %#", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...inspection, ...changes }));
    await expect(client(fetch).inspectTaskSession(projectId, taskId, sessionId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
