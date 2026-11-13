import { directAccessFixture } from "./helpers/taskSync";
import { describe, expect, it, vi } from "vitest";
import { ApiError, assertResponsePrincipal, cancelAuthNetworkRequests, getTaskSync, invalidateAuthRequests, pauseAuthRequests, subscribeUnauthorized } from "../src/api/client";
import { parseTaskSummary, parseTaskSync } from "../src/api/task-sync";
import { wireResponse } from "./helpers/wireJson";
import * as taskSyncParser from "../src/api/task-sync";
import * as jsonSource from "../src/api/json-source";

const projectId = "10000000-0000-0000-0000-000000000001";
const taskId = "20000000-0000-0000-0000-000000000001";
const userId = "30000000-0000-0000-0000-000000000001";
const epoch = "40000000-0000-0000-0000-000000000001";
const time = "2026-10-20T12:34:56.123456789Z";
const project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: "Project", repoUrl: "git@example.test/project", settings: { version: 9_223_372_036_854_775_807n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = { type: "task", parentId: null, assignedTo: null, tags: [], id: taskId, version: "9007199254740993", properties: {}, titlePreview: "Task", titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const dependencyStates = { [taskId]: { taskVersion: task.version, blockedBy: [], ready: true } };
const sync = { assigneeVersions: [{ userId, version: "a".repeat(64), hasProjectAccess: true }], actorAccess: directAccessFixture(projectId, userId), mode: "snapshot", epoch, project, observedAt: time, tasks: [task], dependencyStates, sessions: {} };
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, principal: string | null = userId) => wireResponse(value, { status, headers: principal === null ? {} : { "Daynight-User-ID": principal } });

it("loads exact wire versions and encodes only epoch and the unmodified maximum timestamp", async () => {
  const fetch = vi.fn().mockResolvedValue(response(sync)); vi.stubGlobal("fetch", fetch);
  const result = await getTaskSync(projectId, { epoch, since: time }, userId, signal());
  expect(result.sync.tasks[0]!.version).toBe(9_007_199_254_740_993n);
  expect(result.sync.project.settings.version).toBe(9_223_372_036_854_775_807n);
  const requested = new URL(fetch.mock.calls[0]![0] as string, "https://example.test");
  expect(requested.pathname).toBe(`/api/v1/projects/${projectId}/task-sync`);
  expect([...requested.searchParams]).toEqual([["epoch", epoch], ["since", time]]);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
});

it("reads the server's authoritative dependency states with exact versions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(sync)));
  const result = await getTaskSync(projectId, {}, userId, signal());
  expect(result.sync).toEqual(parseTaskSync(sync, projectId, userId));
  expect(result.sync.dependencyStates[taskId]).toEqual({ taskVersion: 9_007_199_254_740_993n, blockedBy: [], ready: true });
  expect(result.sync.tasks[0]!.version).toBe(9_007_199_254_740_993n);
});

it("requests a first snapshot and preserves known empty epochs without inventing since", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({ ...sync, tasks: [], dependencyStates: {} }))); vi.stubGlobal("fetch", fetch);
  await getTaskSync(projectId, {}, userId, signal());
  await getTaskSync(projectId, { epoch }, userId, signal());
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([`/api/v1/projects/${projectId}/task-sync`, `/api/v1/projects/${projectId}/task-sync?epoch=${epoch}`]);
});

describe("complete lightweight Session snapshot", () => {
  it("requires the map even when no Session contributes, and accepts exactly four states", () => {
    expect(parseTaskSync(sync, projectId).sessions).toEqual({});
    for (const state of ["working", "notice", "warning", "pending"]) {
      expect(parseTaskSync({ ...sync, sessions: { [taskId]: state } }, projectId).sessions).toEqual({ [taskId]: state });
    }
    const { sessions: _sessions, ...missing } = sync;
    expect(() => parseTaskSync(missing, projectId)).toThrow("invalid response");
  });
  it.each([undefined, null, [], "working", 1, new Date(), { invalid: "working" }, { ["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"]: "working" },
    { [taskId]: null }, { [taskId]: "unknown" }, { [taskId]: {} }, { [taskId]: { state: "working" } }, { [taskId]: false },
  ])("rejects malformed Session maps %#", (sessions) => {
    expect(() => parseTaskSync({ ...sync, sessions }, projectId)).toThrow("invalid response");
  });
  it("preserves every Task and Session in a complete snapshot", () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `20000000-0000-0000-0000-${index.toString().padStart(12, "0")}`);
    const tasks = ids.map((id, index) => ({ ...task, id, dependsOn: ids.slice(Math.max(0, index - 6), index) }));
    const sessions = Object.fromEntries(ids.map((id) => [id, "pending"]));
    const dependencyStates = Object.fromEntries(ids.map((id) => [id, { taskVersion: task.version, blockedBy: [], ready: true }]));
    const result = parseTaskSync({ ...sync, tasks, dependencyStates, sessions }, projectId);
    expect(result.tasks).toEqual(tasks.map((task) => ({ ...task, version: 9_007_199_254_740_993n })));
    expect(result.sessions).toEqual(sessions);
  });
});

it("captures the body receipt before JSON decoding, source scanning and validation delays", async () => {
  const body = response({ ...sync, sessions: { [taskId]: "pending" } });
  const originalText = body.text.bind(body);
  const pending = Promise.withResolvers<string>();
  const text = await originalText();
  vi.spyOn(body, "text").mockReturnValue(pending.promise);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body));
  let clock = 0;
  const events: string[] = [];
  const now = vi.spyOn(performance, "now").mockImplementation(() => { events.push("receipt"); return clock; });
  const decode = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementation((...args) => { events.push("decode"); clock += 5000; return decode(...args); });
  const sources = jsonSource.jsonObjectSources;
  vi.spyOn(jsonSource, "jsonObjectSources").mockImplementation((...args) => { events.push("source"); clock += 5000; return sources(...args); });
  const validate = taskSyncParser.parseTaskSync;
  vi.spyOn(taskSyncParser, "parseTaskSync").mockImplementation((...args) => { events.push("validate"); clock += 5000; return validate(...args); });
  const read = getTaskSync(projectId, {}, userId, signal());
  await Promise.resolve(); await Promise.resolve();
  expect(now).not.toHaveBeenCalled();
  clock = 17;
  events.push("body"); pending.resolve(text);
  const result = await read;
  expect(events.slice(0, 3)).toEqual(["body", "receipt", "decode"]);
  expect(events).toContain("source"); expect(events.at(-1)).toBe("validate");
  expect(now).toHaveBeenCalledOnce();
  expect(result.receivedMonotonic).toBe(17);
  expect(clock).toBeGreaterThan(30_000);
  expect(result.sync.sessions).toEqual({ [taskId]: "pending" });
});

it.each(["resolve", "reject"])("does not publish a sync body that %ss after shared cancellation", async (outcome) => {
  const body = response(sync);
  const originalText = await body.text();
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<string>();
  vi.spyOn(body, "text").mockImplementation(() => { started.resolve(); return held.promise; });
  let runningSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { runningSignal = init.signal as AbortSignal; return Promise.resolve(body); }));
  const parse = vi.spyOn(taskSyncParser, "parseTaskSync");
  const pending = getTaskSync(projectId, {}, userId, signal()).catch((error: unknown) => error);
  await started.promise;
  cancelAuthNetworkRequests();
  if (outcome === "resolve") held.resolve(originalText); else held.reject(new Error("body failed"));
  expect(await pending).toBe(runningSignal?.reason);
  expect(runningSignal?.reason).toMatchObject({ name: "AbortError" });
  expect(parse).not.toHaveBeenCalled();
});

it("keeps error bodies unwrapped and never creates a Session receipt for a failure", async () => {
  const now = vi.spyOn(performance, "now");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "not_found", message: "Missing", requestId: "req-source" } }, 404)));
  await expect(getTaskSync(projectId, {}, userId, signal())).rejects.toMatchObject({ kind: "server", code: "not_found", requestId: "req-source" });
  expect(now).not.toHaveBeenCalled();
});

describe("assignee version manifest", () => {
  it("retains content versions and project qualification independently", () => {
    const versions = [{ userId, version: "a".repeat(64), hasProjectAccess: false }];
    expect(parseTaskSync({ ...sync, assigneeVersions: versions }, projectId).assigneeVersions).toEqual(versions);
    expect(parseTaskSync({ ...sync, assigneeVersions: [] }, projectId).assigneeVersions).toEqual([]);
  });

  it.each([
    undefined, null, {}, [null],
    [{ userId, version: "a".repeat(64), hasProjectAccess: true }, { userId, version: "b".repeat(64), hasProjectAccess: false }],
    [{ userId: "invalid", version: "a".repeat(64), hasProjectAccess: true }],
    ...[undefined, null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64)].map((version) => [{ userId, version, hasProjectAccess: true }]),
    [{ userId, version: "a".repeat(64) }],
    [{ userId, version: "a".repeat(64), hasProjectAccess: "true" }],
    [{ userId, version: "a".repeat(64), hasProjectAccess: true, name: "Unexpected profile" }],
  ])("rejects malformed or duplicate versions %#", (assigneeVersions) => {
    expect(() => parseTaskSync({ ...sync, assigneeVersions }, projectId)).toThrow("invalid response");
  });
});

describe("strict summary protocol", () => {
  it("requires and preserves resource type and parent fields", () => {
    expect(parseTaskSummary({ ...task, parentId: projectId })).toMatchObject({ type: "task", parentId: projectId });
    expect(parseTaskSummary({ ...task, type: "goal", allowAgents: false })).toMatchObject({ type: "goal", parentId: null });
    for (const change of [{ type: undefined }, { type: "other" }, { parentId: undefined }, { type: "goal", parentId: projectId }]) {
      expect(() => parseTaskSummary({ ...task, ...change })).toThrow("invalid response");
    }
  });
  it("preserves proposed in complete sync facts without treating it as executable", () => {
    const result = parseTaskSync({ ...sync, tasks: [{ ...task, status: "proposed" }], dependencyStates: { [taskId]: { ...dependencyStates[taskId], ready: false } } }, projectId);
    expect(result.tasks[0]!.status).toBe("proposed");
  });

  it.each([undefined, null, 1, 1n, "", "0", "-1", "+1", "01", "1.0", "1e1", "9223372036854775808"])("rejects noncanonical versions %#", (version) => {
    expect(() => parseTaskSummary({ ...task, version })).toThrow("invalid response");
  });
  it.each(["requiredPlatform", "startedAt", "completedAt", "externalDependsOn", "allowAgents", "updatedAt", "version", "properties"])("requires %s", (field) => {
    const incomplete: Record<string, unknown> = { ...task }; delete incomplete[field];
    expect(() => parseTaskSummary(incomplete)).toThrow("invalid response");
  });
  it.each([
    { properties: null }, { properties: [] }, { properties: 17 },
    { status: "pending" }, { requiredPlatform: "android" }, { dependsOn: [taskId, taskId] },
    { externalDependsOn: [projectId] }, { updatedAt: "2026-02-30T00:00:00Z" },
    { createdAt: "2026-10-20T00:00:00.1234567890Z" }, { startedAt: "2026-10-20T00:00:00+00:00" },
  ])("rejects malformed summary fields %#", (change) => expect(() => parseTaskSummary({ ...task, ...change })).toThrow());
  it("rejects duplicate IDs, invalid envelopes and foreign projects", () => {
    for (const changed of [{ tasks: [task, task] }, { epoch: "bad" }, { mode: "other" }, { project: { ...project, id: taskId } }, { observedAt: undefined }]) {
      expect(() => parseTaskSync({ ...sync, ...changed }, projectId)).toThrow();
    }
  });
});

describe("dependency state protocol", () => {
  it("accepts state-only delta patches and a Goal without a state", () => {
    expect(parseTaskSync({ ...sync, mode: "delta", tasks: [] }, projectId).dependencyStates[taskId]?.taskVersion).toBe(9_007_199_254_740_993n);
    expect(parseTaskSync({ ...sync, tasks: [{ ...task, type: "goal", allowAgents: false }], dependencyStates: {} }, projectId).tasks[0]?.type).toBe("goal");
  });
  it.each([undefined, null, [], { invalid: dependencyStates[taskId] }, { ["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"]: dependencyStates[taskId] },
    { [taskId]: null }, { [taskId]: { taskVersion: "0", blockedBy: [], ready: true } },
    { [taskId]: { taskVersion: "9223372036854775808", blockedBy: [], ready: true } },
    { [taskId]: { taskVersion: task.version, blockedBy: [projectId, projectId], ready: false } },
    { [taskId]: { taskVersion: task.version, blockedBy: [], ready: "true" } },
  ])("rejects malformed state maps %#", (states) => expect(() => parseTaskSync({ ...sync, dependencyStates: states }, projectId)).toThrow("invalid response"));
  it.each([
    {}, { [taskId]: { ...dependencyStates[taskId], taskVersion: "1" } },
    { [taskId]: { ...dependencyStates[taskId], ready: false } },
    { [taskId]: { ...dependencyStates[taskId], blockedBy: [projectId], ready: false } },
    { ...dependencyStates, [projectId]: dependencyStates[taskId] },
  ])("rejects incomplete or inconsistent snapshot projections %#", (states) => expect(() => parseTaskSync({ ...sync, dependencyStates: states }, projectId)).toThrow("invalid response"));
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
  expect(result.sync.tasks[0]!.properties).toEqual(properties);
  expect(result.sync.tasks[0]!.properties.future).toMatchObject({ version: 42 });
  expect(result.sync.tasks[0]!.version).toBe(9_007_199_254_740_993n);
  expect(parseTaskSummary({ ...task, properties: {} }).properties).toEqual({});
});


it("rejects malformed worker claims at the summary decoding boundary", () => {
  expect(() => parseTaskSummary({ ...task, properties: { worker: null } })).toThrow("invalid response");
  expect(() => parseTaskSummary({ ...task, properties: { worker: { machine: { name: "host" } } } })).toThrow("invalid response");
});

it("requires cancellation time and rejects invalid status/time combinations", () => {
  for (const change of [{ cancelledAt: undefined }, { status: "cancelled", cancelledAt: null }, { cancelledAt: time }, { status: "cancelled", cancelledAt: "invalid" }]) {
    expect(() => parseTaskSummary({ ...task, ...change })).toThrow("invalid response");
  }
  expect(parseTaskSummary({ ...task, status: "cancelled", cancelledAt: time, completedAt: time })).toMatchObject({ status: "cancelled", cancelledAt: time, completedAt: time });
});

it("strictly reads active, completed and absent Worker ownership in summaries", () => {
  const worker = { claimId: taskId, state: "active", userId, workerId: projectId, machine: { id: epoch, name: "host" }, platform: "linux", agent: "codex", agentControlMode: "web", worktreeId: epoch, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time };
  const active = { ...task, status: "in_progress", properties: { worker } };
  expect(parseTaskSummary(active).properties.worker).toEqual(worker);
  expect(parseTaskSummary({ ...task, properties: { worker: { ...worker, state: "completed" } } }).properties.worker).toMatchObject({ state: "completed" });
  expect(parseTaskSummary(task).properties.worker).toBeUndefined();
  for (const state of ["released", "unknown"]) {
    expect(() => parseTaskSummary({ ...task, properties: { worker: { ...worker, state } } })).toThrow("invalid response");
  }
  expect(() => parseTaskSummary({ ...task, properties: { worker } })).toThrow("invalid response");
});
