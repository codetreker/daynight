import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { parseApiJson, stringifyApiJson } from "../src/api/json";
import { addTaskStep, editTaskStep, getTaskSteps, moveTaskStep, parseTaskSteps, setTaskStepStatus } from "../src/api/task-steps";

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
  it("sends one scoped status write with the exact version and request identity", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(resource)); vi.stubGlobal("fetch", fetcher);
    const owner = { ...admission(), onWriteConfirmed: vi.fn() }; const signal = new AbortController().signal;
    await expect(setTaskStepStatus(projectId, taskId, "0000000A", "skipped", resource.version, signal, owner, "request-id")).resolves.toEqual(resource);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a/status`, expect.objectContaining({ method: "PUT", body: '{"version":9223372036854775807,"status":"skipped"}', headers: expect.objectContaining({ "X-Request-ID": "request-id" }) }));
    expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it("preserves Steps capacity details and the service message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "steps_limit_exceeded", message: "Resource too large.", requestId: "r1", details: { encodedBytes: 67108865, maxEncodedBytes: 67108864 } } }, 409)));
    await expect(setTaskStepStatus(projectId, taskId, "0000000a", "todo", 1n, new AbortController().signal, admission(), "id")).rejects.toMatchObject({ kind: "server", code: "steps_limit_exceeded", serverMessage: "Resource too large.", stepsLimit: { encodedBytes: 67108865, maxEncodedBytes: 67108864 } });
  });
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

describe("append Steps transport", () => {
  const input = { id: "0000000A", title: " New 😀 ", description: "[draft](file.md)", status: "in_progress" as const, version: 5n };
  const added = { ...step, id: "0000000a", title: input.title, description: input.description, status: input.status };
  const result = { ...resource, version: 6n, steps: [added] };
  const created = (body: unknown, location = `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a`) => new Response(stringifyApiJson(body), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, Location: location } });
  it("sends an exact scoped append with preselected identity and validates the receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(created(result)); vi.stubGlobal("fetch", fetcher);
    const owner = { ...admission(), onWriteConfirmed: vi.fn() };
    await expect(addTaskStep(projectId, taskId, input, new AbortController().signal, owner, "request-id")).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/steps`, expect.objectContaining({ method: "POST", body: '{"version":5,"id":"0000000a","title":" New 😀 ","description":"[draft](file.md)","status":"in_progress"}', headers: expect.objectContaining({ "X-Request-ID": "request-id" }) }));
    expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it.each([
    [result, "/wrong"], [{ ...result, version: 5n }, `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a`],
    [{ ...result, steps: [{ ...added, title: "wrong" }] }, `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a`],
    [{ ...result, steps: [{ ...added, updatedAt: "2026-11-03T12:34:57Z" }] }, `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a`],
  ])("rejects malformed or mismatched 201 evidence %#", async (body, location) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(created(body, location as string)));
    const owner = { ...admission(), onWriteConfirmed: vi.fn() };
    await expect(addTaskStep(projectId, taskId, input, new AbortController().signal, owner, "r")).rejects.toMatchObject({ kind: "protocol" });
    expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it.each([{ ...input, title: "  " }, { ...input, description: "\0" }, { ...input, title: "\ud800" }, { ...input, id: "bad" }])("rejects invalid input without dispatch %#", async (bad) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(addTaskStep(projectId, taskId, bad, new AbortController().signal, admission(), "r")).rejects.toMatchObject({ kind: "protocol" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe("Step position transport", () => {
  it.each([{ position: "first" } as const, { position: "last" } as const, { before: "0000000B" } as const, { after: "0000000B" } as const])("sends the scoped placement with exact version %#", async (placement) => {
    const fetcher = vi.fn().mockResolvedValue(response(resource)); vi.stubGlobal("fetch", fetcher);
    const owner = { ...admission(), onWriteConfirmed: vi.fn() };
    await expect(moveTaskStep(projectId, taskId, "0000000A", placement, resource.version, new AbortController().signal, owner, "request-id")).resolves.toEqual(resource);
    const normalized = "before" in placement ? { before: "0000000b" } : "after" in placement ? { after: "0000000b" } : placement;
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a/position`, expect.objectContaining({ method: "PUT", body: stringifyApiJson({ version: resource.version, ...normalized }), headers: expect.objectContaining({ "X-Request-ID": "request-id" }) }));
    expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it("preserves self-reference and missing-anchor refusals from the service", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ error: { code: "invalid_input", message: "self", requestId: "r1" } }, 400)).mockResolvedValueOnce(response({ error: { code: "not_found", message: "missing", requestId: "r2" } }, 404)); vi.stubGlobal("fetch", fetcher);
    await expect(moveTaskStep(projectId, taskId, step.id, { before: step.id }, 1n, new AbortController().signal, admission(), "id")).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(moveTaskStep(projectId, taskId, step.id, { after: "ffffffff" }, 1n, new AbortController().signal, admission(), "id")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Step content transport", () => {
  it("sends both fields atomically with the scoped ID, exact version and request identity", async () => {
    const changed = { ...step, title: " New 😀 ", description: "" };
    const result = { ...resource, version: 6n, steps: [changed] };
    const fetcher = vi.fn().mockResolvedValue(response(result)); vi.stubGlobal("fetch", fetcher);
    const owner = { ...admission(), onWriteConfirmed: vi.fn() };
    await expect(editTaskStep(projectId, taskId, "0000000A", changed.title, "", 5n, new AbortController().signal, owner, "request-id")).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a`, expect.objectContaining({ method: "PATCH", body: '{"version":5,"title":" New 😀 ","description":""}', headers: expect.objectContaining({ "X-Request-ID": "request-id" }) }));
    expect(owner.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it.each([
    { ...resource, version: 7n }, { ...resource, version: 6n, steps: [] },
    { ...resource, version: 6n, steps: [{ ...step, title: "wrong", description: "" }] },
    { ...resource, version: 6n, steps: [{ ...step, title: "new", description: "wrong" }] },
  ])("rejects a mismatched success receipt %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    await expect(editTaskStep(projectId, taskId, step.id, "new", "", 5n, new AbortController().signal, admission(), "id")).rejects.toMatchObject({ kind: "protocol" });
  });
  it.each([["  ", ""], ["ok", "\0"], ["\ud800", ""]])("rejects invalid text before dispatch %#", async (title, description) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(editTaskStep(projectId, taskId, step.id, title, description, 5n, new AbortController().signal, admission(), "id")).rejects.toMatchObject({ kind: "protocol" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
