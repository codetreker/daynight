import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import { actorId, claimId, inspection, projectId, sessionId, taskId, time } from "../fixtures/task-observation.js";

const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });
const fixture = (body: unknown, status = 200) => {
  const operation = createOperation(); operations.push(operation);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(stringifyApiJson(body), { status, headers: { "content-type": "application/json", "Daynight-User-ID": actorId } }));
  return { api: createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }), fetch };
};
const entryId = "55555555-5555-4555-8555-555555555555";
const body = { entryId, entrySeq: "9007199254740993", revision: "2", kind: "assistant_message", content: [{ type: "text", text: "A\n中\u001b[31m" }] };
const item = { entryId, entrySeq: "9007199254740993", revision: "2", kind: "assistant_message", role: "assistant", timestamp: null, body, truncated: false, contentRef: null, resources: [], resourcesTruncated: false };
const page = { sessionId, historyEpoch: "epoch-1", source: "live", items: [item], beforeCursor: "older-cursor", hasMoreBefore: true, coverage: { state: "complete", reason: null }, observedAt: time };
const directoryItem = { sessionId, claimId, executionGeneration: "9007199254740993", agentControlMode: "web", contentKind: "native_timeline", createdAt: time, endedAt: null, currentBinding: false, archive: { state: "ready", sha256: "a".repeat(64), byteLength: "567", completeness: "complete" } };

describe("Task Session read API", () => {
  it("negotiates current inspection and never falls back to historical Sessions", async () => {
    const empty = { status: "not_registered", claimId, agentControlMode: "web", session: null };
    const f = fixture(empty);
    expect(await f.api.currentTaskSession(projectId, taskId)).toEqual(empty);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions/current`);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("view")).toBe("inspection");
  });

  it("retains the registered current execution and content-read capability", async () => {
    const value = { status: "registered", claimId, agentControlMode: "web", session: { ...inspection, contentReadVersion: 1 } };
    const f = fixture(value);
    expect(await f.api.currentTaskSession(projectId, taskId)).toEqual(value);
  });

  it("reads one directory page with explicit currentBinding and unchanged continuation", async () => {
    const result = { items: [directoryItem], nextCursor: "more-directory" };
    const f = fixture(result);
    expect(await f.api.listTaskSessions(projectId, taskId, { limit: 20, cursor: "previous-directory" })).toEqual(result);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(Object.fromEntries(new URL(String(f.fetch.mock.calls[0]![0])).searchParams)).toEqual({ view: "inspection", limit: "20", cursor: "previous-directory" });
  });

  it("reads one recent page, retaining exact sequences, null time and complete body", async () => {
    const f = fixture(page);
    expect(await f.api.readTaskSession(projectId, taskId, sessionId, { limit: 20 })).toEqual(page);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions/${sessionId}/messages`);
    expect(Object.fromEntries(new URL(String(f.fetch.mock.calls[0]![0])).searchParams)).toEqual({ limit: "20" });
  });

  it("forwards before and conversation without fetching more for an empty filtered page", async () => {
    const empty = { ...page, items: [] };
    const f = fixture(empty);
    expect(await f.api.readTaskSession(projectId, taskId, sessionId, { limit: 4, before: "exact-cursor", conversation: true })).toEqual(empty);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(Object.fromEntries(new URL(String(f.fetch.mock.calls[0]![0])).searchParams)).toEqual({ limit: "4", before: "exact-cursor", conversation: "true" });
  });

  it("retains the oldest boundary cursor when the final page has no earlier entries", async () => {
    const finalPage = { ...page, hasMoreBefore: false };
    const f = fixture(finalPage);
    expect(await f.api.readTaskSession(projectId, taskId, sessionId)).toEqual(finalPage);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("retains explicit content references instead of treating metadata as full text", async () => {
    const large = { ...item, body: null, truncated: true, contentRef: { cursor: "entry-start", sha256: "a".repeat(64), byteLength: "500000" } };
    const f = fixture({ ...page, items: [large] });
    expect((await f.api.readTaskSession(projectId, taskId, sessionId)).items).toEqual([large]);
  });

  it("reads only one fixed-version UTF-8 entry fragment", async () => {
    const chunk = { sessionId, historyEpoch: "epoch-1", source: "live", entryId, revision: "2", sha256: "a".repeat(64), byteLength: "19", offset: "0", fragment: "{\"text\":\"中文", nextCursor: "next-chunk", eof: false, observedAt: time };
    const f = fixture(chunk);
    expect(await f.api.readTaskSessionEntry(projectId, taskId, sessionId, "entry-start")).toEqual(chunk);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions/${sessionId}/message-content`);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("cursor")).toBe("entry-start");
  });

  it.each([
    { sessionId: taskId }, { historyEpoch: "" }, { source: "worker-file" }, { hasMoreBefore: true, beforeCursor: null },
    { items: [{ ...item, body: null }] }, { items: [{ ...item, revision: "3" }] },
    { items: [{ ...item, body: { ...body, content: [{ type: "binary", data: "base64" }] } }] },
    { items: [item, item] }, { coverage: { state: "partial", reason: null, secret: "bad" } },
  ])("rejects malformed or mixed-identity message data %#", async changes => {
    const f = fixture({ ...page, ...changes });
    await expect(f.api.readTaskSession(projectId, taskId, sessionId)).rejects.toMatchObject({ phase: "protocol" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each(["reset_required", "content_changed", "upgrade_required", "history_pending", "history_unavailable", "source_corrupt", "forbidden", "unsupported_mode"]) ("preserves %s without an implicit retry or current lookup", async code => {
    const f = fixture({ error: { code, message: "Read refused.", requestId: "read-refused" } }, code === "forbidden" ? 403 : 409);
    await expect(f.api.readTaskSession(projectId, taskId, sessionId)).rejects.toMatchObject({ code, phase: "response" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains the dedicated encoded transport limit with principal binding %s", async bound => {
    const f = fixture({ ...page, items: [{ ...item, body: { ...body, content: [{ type: "text", text: "x".repeat(262144) }] } }] });
    const api = bound ? f.api.withExpectedUserId(actorId) : f.api;
    await expect(api.readTaskSession(projectId, taskId, sessionId)).rejects.toMatchObject({ phase: "response", cause: { kind: "response_limit" } });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
