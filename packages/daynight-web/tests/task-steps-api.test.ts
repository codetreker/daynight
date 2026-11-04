import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { parseApiJson, stringifyApiJson } from "../src/api/json";
import { getTaskSteps, parseTaskSteps } from "../src/api/task-steps";

const projectId = "10000000-0000-0000-0000-00000000000a";
const taskId = "20000000-0000-0000-0000-00000000000b";
const userId = "30000000-0000-0000-0000-00000000000c";
const time = "2026-11-03T12:34:56.123456Z";
const step = { id: "0000000a", title: " 设计 😀\n", description: "[结果](result.md)", status: "skipped", createdAt: time, updatedAt: time };
const resource = { projectId, taskId, version: 9_223_372_036_854_775_807n, steps: [step] };
const response = (data: unknown, status = 200, principal: string | null = userId) => new Response(stringifyApiJson(data), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const admission = () => ({ userId, onPrincipalMismatch: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe("complete Steps resources", () => {
  it("preserves exact int64, source text, leading zero IDs, order and empty collections", () => {
    expect(parseTaskSteps(parseApiJson(stringifyApiJson(resource)), projectId, taskId)).toEqual(resource);
    expect(parseTaskSteps({ ...resource, steps: [] }, projectId, taskId).steps).toEqual([]);
    for (const status of ["todo", "in_progress", "done", "skipped"]) expect(parseTaskSteps({ ...resource, steps: [{ ...step, status, title: "\ufeff", description: "" }] }, projectId, taskId).steps[0]?.status).toBe(status);
  });
  it.each([null, [], {}, { ...resource, projectId: taskId }, { ...resource, taskId: projectId }, { ...resource, version: 1 }, { ...resource, version: 0n }, { ...resource, version: -1n }, { ...resource, version: 9_223_372_036_854_775_808n }, { ...resource, steps: null }, { ...resource, steps: {} }, { ...resource, steps: [step, step] }])("rejects malformed or mismatched collections %#", (value) => {
    expect(() => parseTaskSteps(value, projectId, taskId)).toThrow("invalid response");
  });
  it.each([null, {}, ...Object.keys(step).map((field) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== field))),
    { ...step, id: "0000000A" }, { ...step, id: "000000a" }, { ...step, title: "\u0085\u2003\n " }, { ...step, title: "a\0b" }, { ...step, title: "\ud800" }, { ...step, description: "\udfff" }, { ...step, description: "\0" }, { ...step, status: "blocked" }, { ...step, createdAt: "yesterday" }, { ...step, updatedAt: "2026-02-30T12:00:00Z" }, { ...step, createdAt: "0001-01-01T00:00:00Z" }, { ...step, createdAt: "0000-01-01T00:00:00Z" }, { ...step, updatedAt: "2026-11-03T12:34:56.1234567Z" }])("rejects incomplete or invalid steps without dropping rows %#", (value) => {
    expect(() => parseTaskSteps({ ...resource, steps: [value] }, projectId, taskId)).toThrow("invalid response");
  });
});

describe("Steps transport", () => {
  it("uses canonical scope, credentials, no-store, exact version and one GET", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(resource));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(getTaskSteps(projectId.toUpperCase(), taskId.toUpperCase(), signal, admission())).resolves.toEqual(resource);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/steps`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error", headers: { Accept: "application/json", "Daynight-Worker-Protocol": "2" } });
  });
  it.each([null, taskId])("rejects a missing or different response principal %s", async (principal) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(resource, 200, principal)));
    const owner = admission();
    await expect(getTaskSteps(projectId, taskId, new AbortController().signal, owner)).rejects.toBeInstanceOf(ApiError);
    expect(owner.onPrincipalMismatch).toHaveBeenCalledTimes(principal === null ? 0 : 1);
  });
  it.each([201, 202])("rejects unexpected successful status %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(resource, status)));
    await expect(getTaskSteps(projectId, taskId, new AbortController().signal, admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("keeps failures and request IDs visible without treating 404 as an empty collection", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: { code: "not_found", message: "private diagnostics", requestId: "steps-read" } }, 404));
    vi.stubGlobal("fetch", fetcher);
    await expect(getTaskSteps(projectId, taskId, new AbortController().signal, admission())).rejects.toMatchObject({ kind: "server", status: 404, code: "not_found", requestId: "steps-read" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch invalid scope IDs or an aborted request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(getTaskSteps("bad", taskId, new AbortController().signal, admission())).rejects.toBeInstanceOf(ApiError);
    const controller = new AbortController(); controller.abort();
    await expect(getTaskSteps(projectId, taskId, controller.signal, admission())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
