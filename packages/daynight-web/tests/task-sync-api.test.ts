import { describe, expect, it, vi } from "vitest";
import { ApiError, assertResponsePrincipal, getTaskSync, invalidateAuthRequests, pauseAuthRequests, subscribeUnauthorized } from "../src/api/client";
import { parseTaskSummary, parseTaskSync } from "../src/api/task-sync";
import { wireResponse } from "./helpers/wireJson";

const projectId = "10000000-0000-0000-0000-000000000001";
const taskId = "20000000-0000-0000-0000-000000000001";
const userId = "30000000-0000-0000-0000-000000000001";
const epoch = "40000000-0000-0000-0000-000000000001";
const time = "2026-10-20T12:34:56.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@example.test/project", settings: { version: 9_223_372_036_854_775_807n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = { id: taskId, version: "9007199254740993", properties: {}, titlePreview: "Task", titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const sync = { mode: "snapshot", epoch, project, observedAt: time, tasks: [task] };
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, principal: string | null = userId) => wireResponse(value, { status, headers: principal === null ? {} : { "Daynight-User-ID": principal } });

it("loads exact wire versions and encodes only epoch and the unmodified maximum timestamp", async () => {
  const fetch = vi.fn().mockResolvedValue(response(sync)); vi.stubGlobal("fetch", fetch);
  const result = await getTaskSync(projectId, { epoch, since: time }, userId, signal());
  expect(result.tasks[0]!.version).toBe(9_007_199_254_740_993n);
  expect(result.project.settings.version).toBe(9_223_372_036_854_775_807n);
  const requested = new URL(fetch.mock.calls[0]![0] as string, "https://example.test");
  expect(requested.pathname).toBe(`/api/v1/projects/${projectId}/task-sync`);
  expect([...requested.searchParams]).toEqual([["epoch", epoch], ["since", time]]);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
});

it("requests a first snapshot and preserves known empty epochs without inventing since", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({ ...sync, tasks: [] }))); vi.stubGlobal("fetch", fetch);
  await getTaskSync(projectId, {}, userId, signal());
  await getTaskSync(projectId, { epoch }, userId, signal());
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([`/api/v1/projects/${projectId}/task-sync`, `/api/v1/projects/${projectId}/task-sync?epoch=${epoch}`]);
});

describe("strict summary protocol", () => {
  it.each([undefined, null, 1, 1n, "", "0", "-1", "+1", "01", "1.0", "1e1", "9223372036854775808"])("rejects noncanonical versions %#", (version) => {
    expect(() => parseTaskSummary({ ...task, version })).toThrow("invalid response");
  });
  it.each(["requiredPlatform", "startedAt", "completedAt", "externalDependsOn", "allowAgents", "updatedAt", "version", "properties"])("requires %s", (field) => {
    const incomplete: Record<string, unknown> = { ...task }; delete incomplete[field];
    expect(() => parseTaskSummary(incomplete)).toThrow("invalid response");
  });
  it.each([
    { properties: null }, { properties: [] }, { properties: 17 },
    { status: "proposed" }, { requiredPlatform: "android" }, { dependsOn: [taskId, taskId] },
    { externalDependsOn: [projectId] }, { updatedAt: "2026-02-30T00:00:00Z" },
    { createdAt: "2026-10-20T00:00:00.1234567890Z" }, { startedAt: "2026-10-20T00:00:00+00:00" },
  ])("rejects malformed summary fields %#", (change) => expect(() => parseTaskSummary({ ...task, ...change })).toThrow());
  it("rejects duplicate IDs, invalid envelopes and foreign projects", () => {
    for (const changed of [{ tasks: [task, task] }, { epoch: "bad" }, { mode: "other" }, { project: { ...project, id: taskId } }, { observedAt: undefined }]) {
      expect(() => parseTaskSync({ ...sync, ...changed }, projectId)).toThrow();
    }
  });
});

it("checks principal before decoding successful or resource-error payloads", async () => {
  const mismatch = vi.fn();
  for (const principal of [null, "invalid", taskId]) {
    const body = response("not a sync body", 404, principal);
    const text = vi.spyOn(body, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body));
    await expect(getTaskSync(projectId, {}, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    expect(text).not.toHaveBeenCalled();
  }
  expect(mismatch).toHaveBeenCalledTimes(1);
  expect(() => assertResponsePrincipal(response({}, 200, userId.toUpperCase()), userId)).not.toThrow();
});

it("retains 401 session clearing and ordinary authenticated errors", async () => {
  const expired = vi.fn(); const unsubscribe = subscribeUnauthorized(expired);
  const error = { error: { code: "unauthenticated", message: "Expired", requestId: "request-1" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(error, 401, null)));
  await expect(getTaskSync(projectId, {}, userId, signal())).rejects.toMatchObject({ kind: "server", status: 401 });
  expect(expired).toHaveBeenCalledOnce(); unsubscribe();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { ...error.error, code: "not_found" } }, 404)));
  await expect(getTaskSync(projectId, {}, userId, signal())).rejects.toMatchObject({ kind: "server", status: 404 });
});

it("blocks invalid query and user identities before network access", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const [query, expected] of [[{ since: time }, userId], [{ epoch: "invalid" }, userId], [{ epoch, since: "invalid" }, userId], [{}, "invalid"]] as const) {
    await expect(getTaskSync(projectId, query, expected, signal())).rejects.toBeInstanceOf(ApiError);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("shares the foreground gate and cancels an old identity's pending read", async () => {
  const fetch = vi.fn().mockResolvedValue(response(sync)); vi.stubGlobal("fetch", fetch);
  const resume = pauseAuthRequests();
  const pending = getTaskSync(projectId, {}, userId, signal());
  await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  invalidateAuthRequests(); resume();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("retains complete generic properties and ordinary nested version fields in sync responses", async () => {
  const properties = { pullRequests: [], future: { version: 42, nested: [null, "\u0000中文", { enabled: true }] } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...sync, tasks: [{ ...task, properties }] })));
  const result = await getTaskSync(projectId, {}, userId, signal());
  expect(result.tasks[0]!.properties).toEqual(properties);
  expect(result.tasks[0]!.properties.future).toMatchObject({ version: 42 });
  expect(result.tasks[0]!.version).toBe(9_007_199_254_740_993n);
  expect(parseTaskSummary({ ...task, properties: {} }).properties).toEqual({});
});
