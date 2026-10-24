import { TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getTask, getTaskGraph, isAbortError, listProjects } from "../src/api/client";
import { canonicalId, parseProjectPage, parseServerError, parseTaskDetail, parseTaskGraph } from "../src/api/parse";
import { stringifyWireJson } from "./helpers/wireJson";
import { createProject } from "../src/api/auth";
import { decodeProjectJson, decodeProjectPageJson, decodeTaskGraphJson } from "../src/api/project-json";
import { project as parseProject } from "../src/api/parse";

const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const projectId = "10000000-0000-0000-0000-00000000000a";
const taskId = "20000000-0000-0000-0000-00000000000b";
const otherId = "30000000-0000-0000-0000-00000000000c";
const time = "2026-10-20T12:34:56.123456Z";
const project = { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: "Core project", repoUrl: "git@github.com:org/repo.git", createdAt: time, updatedAt: time };
const task = { requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null,
  id: taskId, projectId, title: "A task", description: "", properties: { worker: null, pullRequests: [] }, status: "todo", version: 9007199254740993n,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time,
};
const graphTask = { requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null,
  id: taskId, titlePreview: "A task", titleTruncated: false, status: "todo",
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time,
};
const summary = { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 };
const graph = { observedAt: "2026-10-20T12:00:00Z", project, summary, tasks: [graphTask] };
const rawProject = (version: string): string => `${JSON.stringify({ ...project, settings: undefined }).slice(0, -1)},"settings":{"version":${version},"executionWarningMinutes":60}}`;
const rawGraph = (projectSource: string): string => `${JSON.stringify({ ...graph, project: undefined }).slice(0, -1)},"project":${projectSource}}`;
const signal = (): AbortSignal => new AbortController().signal;
const response = (value: unknown, status = 200): Response => new Response(stringifyWireJson(value), {
  status, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json; charset=utf-8" }),
});
const mockResponse = (value: unknown, status = 200) => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(value, status)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe("response parsing", () => {
  it("requires the external subset on both full tasks and graph nodes", () => {
    const { externalDependsOn: _fullSubset, ...missingTask } = task;
    const { externalDependsOn: _graphSubset, ...missingNode } = graphTask;
    expect(() => parseTaskDetail(missingTask, projectId, taskId)).toThrow("invalid response");
    expect(() => parseTaskGraph({ ...graph, tasks: [missingNode] }, projectId)).toThrow("invalid response");
    expect(parseTaskDetail(task, projectId, taskId).externalDependsOn).toEqual([]);
    expect(parseTaskGraph(graph, projectId).tasks[0]!.externalDependsOn).toEqual([]);
  });

  it.each([
    undefined, null, "", otherId, false, 1, {}, [null], [1], [""], ["invalid"],
    [otherId, otherId], [otherId, otherId.toUpperCase()], [projectId],
  ])("rejects malformed or out-of-set external subsets %#", (externalDependsOn) => {
    const dependencies = { dependsOn: [otherId], externalDependsOn, blockedBy: [otherId], ready: false };
    expect(() => parseTaskDetail({ ...task, ...dependencies }, projectId, taskId)).toThrow("invalid response");
    expect(() => parseTaskGraph({ ...graph, tasks: [{ ...graphTask, ...dependencies }] }, projectId)).toThrow("invalid response");
  });

  it("preserves canonical mixed dependency data, exact versions, timing and project settings", () => {
    const dependencies = { dependsOn: [projectId, otherId.toUpperCase()], externalDependsOn: [otherId.toUpperCase()], blockedBy: [otherId], ready: false };
    const expected = { ...dependencies, dependsOn: [projectId, otherId], externalDependsOn: [otherId] };
    const parsed = parseTaskDetail({ ...task, ...dependencies, startedAt: time }, projectId, taskId);
    expect(parsed).toMatchObject({ ...expected, version: 9_007_199_254_740_993n, startedAt: time, completedAt: null });
    const input = { ...graph, project: { ...project, settings: { ...project.settings, version: 9_223_372_036_854_775_807n } },
      tasks: [{ ...graphTask, ...dependencies, startedAt: time }] };
    const parsedGraph = parseTaskGraph(input, projectId);
    expect(parsedGraph.tasks[0]).toMatchObject({ ...expected, startedAt: time, completedAt: null });
    expect(parsedGraph.observedAt).toBe(graph.observedAt);
    expect(parsedGraph.project.settings.version).toBe(9_223_372_036_854_775_807n);
  });

  it("accepts an all-external prerequisite set without changing its blocked state", () => {
    const dependencies = { dependsOn: [otherId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false };
    expect(parseTaskDetail({ ...task, ...dependencies }, projectId, taskId)).toMatchObject(dependencies);
    expect(parseTaskGraph({ ...graph, tasks: [{ ...graphTask, ...dependencies }] }, projectId).tasks[0]).toMatchObject(dependencies);
  });

  it("requires complete positive project settings without inventing defaults", () => {
    const { settings: _settings, ...missing } = project;
    expect(() => parseProject(missing)).toThrow("invalid response");
    for (const settings of [null, undefined, [], {}, { version: 1n }, { executionWarningMinutes: 60 }]) {
      expect(() => parseProject({ ...project, settings })).toThrow("invalid response");
    }
    for (const version of [undefined, null, 1, "1", 0n, -1n, 9_223_372_036_854_775_808n]) {
      expect(() => parseProject({ ...project, settings: { ...project.settings, version } })).toThrow("invalid response");
    }
    for (const executionWarningMinutes of [undefined, null, "60", 0, -1, 0.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseProject({ ...project, settings: { ...project.settings, executionWarningMinutes } })).toThrow("invalid response");
    }
    for (const executionWarningMinutes of [1, 2_147_483_647]) {
      expect(parseProject({ ...project, settings: { ...project.settings, executionWarningMinutes } }).settings.executionWarningMinutes).toBe(executionWarningMinutes);
    }
  });

  it("accepts page data, canonicalizes identities, and keeps opaque cursors", () => {
    expect(parseProjectPage({ items: [{ ...project, id: projectId.toUpperCase() }], nextCursor: "opaque+/= token" }))
      .toEqual({ items: [project], nextCursor: "opaque+/= token" });
    expect(parseProjectPage({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(canonicalId(`{${projectId}}`)).toBeNull();
  });

  it.each([
    undefined, null, [], {}, { items: null, nextCursor: null }, { items: [] }, { items: [], nextCursor: "" },
    { items: [project, { ...project, id: projectId.toUpperCase() }], nextCursor: null },
    ...["id", "name", "repoUrl", "createdAt", "updatedAt"].map((field) => ({ items: [{ ...project, [field]: null }], nextCursor: null })),
    ...["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+01:00", "invalid"].map((createdAt) =>
      ({ items: [{ ...project, createdAt }], nextCursor: null })),
    { items: [{ ...project, name: "   " }], nextCursor: null },
    { items: [{ ...project, repoUrl: "bad\0text" }], nextCursor: null },
  ])("rejects malformed pages %# without invented defaults", (value) => {
    expect(() => parseProjectPage(value)).toThrow("invalid response");
  });

  it("accepts UTC timestamps with seconds and nanoseconds", () => {
    for (const createdAt of ["2026-10-20T12:34:56Z", "0001-01-01T00:00:00Z", "2026-10-20T12:34:56.123456789Z"]) {
      expect(parseProjectPage({ items: [{ ...project, createdAt }], nextCursor: null }).items[0]?.createdAt).toBe(createdAt);
    }
  });

  it("parses complete graph fields and preserves the exact full-task int64 version", () => {
    expect(parseTaskGraph(graph, projectId)).toEqual(graph);
    expect(parseTaskGraph({ ...graph, tasks: [{ ...graphTask, titlePreview: " ".repeat(160), titleTruncated: true }] }, projectId).tasks[0]?.titlePreview)
      .toBe(" ".repeat(160));
    expect(parseTaskDetail(task, projectId, taskId)).toEqual(task);
    expect(parseTaskDetail({ ...task, status: "done", ready: false, dependsOn: [otherId], blockedBy: [] }, projectId, taskId).status).toBe("done");
    expect(parseTaskDetail({ ...task, status: "in_progress" }, projectId, taskId).status).toBe("in_progress");
  });

  it.each([
    { startedAt: null, completedAt: null },
    { startedAt: "2026-10-20T12:00:00.123456789Z", completedAt: null },
    { startedAt: "2026-10-20T12:00:00.123456789Z", completedAt: time },
    { startedAt: null, completedAt: time },
  ])("preserves known and unknown execution timestamps %#", (timing) => {
    expect(parseTaskDetail({ ...task, ...timing }, projectId, taskId)).toMatchObject(timing);
    expect(parseTaskGraph({ ...graph, tasks: [{ ...graphTask, ...timing }] }, projectId).tasks[0]).toMatchObject(timing);
  });

  it.each(["startedAt", "completedAt"] as const)("requires a valid UTC timestamp or explicit null for %s", (field) => {
    const { [field]: _taskTiming, ...missingTask } = task;
    const { [field]: _graphTiming, ...missingNode } = graphTask;
    expect(() => parseTaskDetail(missingTask, projectId, taskId)).toThrow("invalid response");
    expect(() => parseTaskGraph({ ...graph, tasks: [missingNode] }, projectId)).toThrow("invalid response");
    for (const invalid of [undefined, 0, false, {}, "", "invalid", "2026-02-30T00:00:00Z", "2026-10-20T12:00:00+01:00"]) {
      expect(() => parseTaskDetail({ ...task, [field]: invalid }, projectId, taskId)).toThrow("invalid response");
      expect(() => parseTaskGraph({ ...graph, tasks: [{ ...graphTask, [field]: invalid }] }, projectId)).toThrow("invalid response");
    }
  });

  it("requires and preserves the database graph observation timestamp", () => {
    const observedAt = "2026-10-20T12:34:56.123456789Z";
    expect(parseTaskGraph({ ...graph, observedAt }, projectId).observedAt).toBe(observedAt);
    const { observedAt: _observation, ...missing } = graph;
    expect(() => parseTaskGraph(missing, projectId)).toThrow("invalid response");
    for (const invalid of [undefined, null, 0, "", "invalid", "2026-02-30T00:00:00Z", "2026-10-20T12:00:00+01:00"]) {
      expect(() => parseTaskGraph({ ...graph, observedAt: invalid }, projectId)).toThrow("invalid response");
    }
  });

  it("rejects the removed proposed state in graph and detail responses", () => {
    for (const ready of [false, true]) {
      const legacy = { ...graphTask, status: "proposed", ready };
      expect(() => parseTaskGraph({ ...graph, tasks: [legacy] }, projectId)).toThrow("invalid response");
      expect(() => parseTaskDetail({ ...task, ...legacy }, projectId, taskId)).toThrow("invalid response");
    }
  });

  it("preserves complete ordered PR strings and duplicates without interpreting their content", () => {
    const pullRequests = [
      { url: '', title: '' },
      { url: '  arbitrary\0URL\n\t', title: '<script>文本</script>\n\0' },
      { url: 'javascript:alert(1)', title: '  ' },
      { url: '  arbitrary\0URL\n\t', title: '<script>文本</script>\n\0' },
    ];
    expect(parseTaskDetail({ ...task, properties: { worker: null, pullRequests } }, projectId, taskId).properties)
      .toEqual({ pullRequests, worker: null });
    expect(parseTaskDetail({ ...task, properties: { worker: null, pullRequests, futureField: true } }, projectId, taskId).properties)
      .toEqual({ pullRequests, worker: null });
    expect(parseTaskGraph({ ...graph, tasks: [{ ...graphTask, properties: { worker: null, pullRequests } }] }, projectId)).toEqual(graph);
  });

  it.each([
    undefined, null, [], {}, { pullRequests: null }, { pullRequests: {} }, { pullRequests: [null] },
    { pullRequests: [[]] }, { pullRequests: [{}] }, { pullRequests: [{ url: '' }] },
    { pullRequests: [{ title: '' }] }, { pullRequests: [{ url: null, title: '' }] },
    { pullRequests: [{ url: '', title: 1 }] },
  ])("rejects missing or malformed task properties without a legacy fallback %#", (properties) => {
    expect(() => parseTaskDetail({ ...task, properties }, projectId, taskId)).toThrow('invalid response');
  });

  it.each([
    { ...graph, project: { ...project, id: otherId } },
    { ...graph, tasks: null },
    { ...graph, tasks: [graphTask, graphTask] },
    { ...graph, summary: null },
    { ...graph, summary: { ...summary, ready: 0 } },
    ...["total", "todo", "inProgress", "done", "ready", "blocked"].flatMap((field) => [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map((value) =>
      ({ ...graph, summary: { ...summary, [field]: value } }))),
    ...["titlePreview", "titleTruncated", "ready", "status", "dependsOn", "blockedBy", "id", "createdAt", "updatedAt"].map((field) =>
      ({ ...graph, tasks: [{ ...graphTask, [field]: null }] })),
    { ...graph, tasks: [{ ...graphTask, status: "pending" }] },
    { ...graph, tasks: [{ ...graphTask, dependsOn: [otherId, otherId.toUpperCase()] }] },
    { ...graph, tasks: [{ ...graphTask, blockedBy: [42] }] },
    { ...graph, tasks: [{ ...graphTask, id: "bad" }] },
  ])("rejects malformed graphs %#", (value) => {
    expect(() => parseTaskGraph(value, projectId)).toThrow("invalid response");
  });

  it.each([
    { ...task, projectId: otherId }, { ...task, id: otherId }, { ...task, title: "" },
    { ...task, description: undefined }, { ...task, status: "pending" }, { ...task, ready: 1 },
    { ...task, dependsOn: undefined }, { ...task, blockedBy: [null] },
  ])("rejects malformed or mismatched task details %#", (value) => {
    expect(() => parseTaskDetail(value, projectId, taskId)).toThrow("invalid response");
  });

  it("validates error metadata while discarding raw messages and unneeded details", () => {
    expect(parseServerError({ error: { code: "not_found", message: "secret SQL", requestId: "Request_1.2-3", details: { taskIds: [taskId] } } }))
      .toEqual({ code: "not_found", requestId: "Request_1.2-3" });
    expect(parseServerError({ error: { code: "graph_limit_exceeded", message: "secret", requestId: "r1", details: {
      nodeCount: 1001, edgeCount: 3, maxNodes: 1000, maxEdges: 5000,
    } } })).toEqual({ code: "graph_limit_exceeded", requestId: "r1", graphLimit: {
      nodeCount: 1001, edgeCount: 3, maxNodes: 1000, maxEdges: 5000,
    } });
  });

  it.each([
    {}, { error: null }, { error: { code: "Bad Code", message: "x", requestId: "r1" } },
    { error: { code: "not_found", message: "x", requestId: "\nsecret" } },
    { error: { code: "not_found", requestId: "r1" } },
    { error: { code: "graph_limit_exceeded", message: "x", requestId: "r1" } },
    { error: { code: "graph_limit_exceeded", message: "x", requestId: "r1", details: { nodeCount: 1, edgeCount: 2, maxNodes: 1000, maxEdges: null } } },
  ])("rejects malformed error envelopes %#", (value) => {
    expect(() => parseServerError(value)).toThrow("invalid response");
  });
});

describe("targeted project JSON decoding", () => {
  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])("retains nested numeric settings version %s in Project, page and graph envelopes", async (version) => {
    const source = rawProject(version.toString());
    const value = { ...project, settings: { ...project.settings, version } };
    expect(parseProject(await decodeProjectJson(new Response(source)))).toEqual(value);
    expect(parseProjectPage(await decodeProjectPageJson(new Response(`{"items":[${source}],"nextCursor":null}`))).items).toEqual([value]);
    expect(parseTaskGraph(await decodeTaskGraphJson(new Response(rawGraph(source))), projectId).project).toEqual(value);
  });

  it.each(["null", "0", "-1", "1.0", "1e0", "9223372036854775808", '"1"'])("rejects invalid numeric version source %s across project envelopes", async (source) => {
    const value = rawProject(source);
    const single = await decodeProjectJson(new Response(value));
    const page = await decodeProjectPageJson(new Response(`{"items":[${value}],"nextCursor":null}`));
    const taskGraph = await decodeTaskGraphJson(new Response(rawGraph(value)));
    expect(() => parseProject(single)).toThrow("invalid response");
    expect(() => parseProjectPage(page)).toThrow("invalid response");
    expect(() => parseTaskGraph(taskGraph, projectId)).toThrow("invalid response");
  });

  it("preserves whitespace, escaped keys, duplicate-key replacement and unknown nested values", async () => {
    const fields = JSON.stringify({ ...project, settings: undefined }).slice(0, -1);
    const source = String.raw`${fields},"settings":null,"\u0073ettings":{"version":1e0,"ver\u0073ion": 9223372036854775807 ,"executionWarningMinutes":60,"unknown":{"version":9007199254740993}},"unknown":{"settings":{"version":9007199254740993}}}`;
    const decoded = await decodeProjectJson(new Response(source)) as Record<string, unknown>;
    const native = JSON.parse(source) as Record<string, unknown>;
    expect(parseProject(decoded).settings.version).toBe(9_223_372_036_854_775_807n);
    expect((decoded.settings as Record<string, unknown>).unknown).toEqual((native.settings as Record<string, unknown>).unknown);
    expect(decoded.unknown).toEqual(native.unknown);
    const replaced = `${fields},"settings":{"version":9223372036854775807,"executionWarningMinutes":60},"settings":null}`;
    expect(await decodeProjectJson(new Response(replaced))).toEqual(JSON.parse(replaced));
    const lastPage = String.raw`{"items":null,"it\u0065ms":[${rawProject('9007199254740993')}],"nextCursor":null}`;
    expect(parseProjectPage(await decodeProjectPageJson(new Response(lastPage))).items[0]?.settings.version).toBe(9_007_199_254_740_993n);
    const lastGraph = `${rawGraph(rawProject('9007199254740993')).slice(0, -1)},"project":null}`;
    expect(await decodeTaskGraphJson(new Response(lastGraph))).toEqual(JSON.parse(lastGraph));
  });

  it("leaves unrelated roots under native JSON semantics and preserves syntax errors", async () => {
    for (const decode of [decodeProjectJson, decodeProjectPageJson, decodeTaskGraphJson]) {
      for (const source of ['null', 'true', '1', '[]', '{"unknown":{"version":9007199254740993}}']) {
        expect(await decode(new Response(source))).toEqual(JSON.parse(source));
      }
      for (const source of ['{"settings":', '{"project":null,}', '{"items":[]} trailing']) {
        await expect(decode(new Response(source))).rejects.toBeInstanceOf(SyntaxError);
      }
    }
  });

  it("reads high settings versions without a native JSON reviver context", async () => {
    const nativeParse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => nativeParse(text, reviver === undefined
      ? undefined : function (key, value) { return reviver.call(this, key, value); }));
    try {
      expect(parseProject(await decodeProjectJson(new Response(rawProject('9223372036854775807')))).settings.version).toBe(9_223_372_036_854_775_807n);
    } finally { spy.mockRestore(); }
  });
});

describe("API requests", () => {
  it("uses targeted decoders for project creation, project pages and task graphs", async () => {
    const version = 9_007_199_254_740_993n;
    const source = rawProject(version.toString());
    const fetcher = vi.fn().mockResolvedValue(new Response(source, { status: 201, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
    vi.stubGlobal("fetch", fetcher);
    expect((await createProject({ name: project.name, repoUrl: project.repoUrl }, signal())).settings.version).toBe(version);
    fetcher.mockResolvedValue(new Response(`{"items":[${source}],"nextCursor":null}`, { headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
    expect((await listProjects({}, signal())).items[0]?.settings.version).toBe(version);
    fetcher.mockResolvedValue(new Response(rawGraph(source), { headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
    expect((await getTaskGraph(projectId, signal())).project.settings.version).toBe(version);
  });
  it("uses relative URLs, explicit signal, no-store, and safely encoded opaque cursor", async () => {
    const fetchMock = mockResponse({ items: [project], nextCursor: "next" });
    const abortSignal = signal();
    await expect(listProjects({ limit: 50, cursor: "opaque+/= &?" }, abortSignal)).resolves.toEqual({ items: [project], nextCursor: "next" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/v1/projects?limit=50&cursor=opaque%2B%2F%3D+%26%3F", {
      signal: abortSignal, headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    await listProjects({}, abortSignal);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/projects");
  });

  it("normalizes requested IDs and binds resource responses to requests", async () => {
    const fetchMock = mockResponse(graph);
    await expect(getTaskGraph(projectId.toUpperCase(), signal())).resolves.toEqual(graph);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/task-graph`);
    fetchMock.mockResolvedValue(response(task));
    await expect(getTask(projectId.toUpperCase(), taskId.toUpperCase(), signal(), admission)).resolves.toMatchObject({ id: taskId, projectId });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}`);
    fetchMock.mockResolvedValue(response({ ...graph, project: { ...project, id: otherId } }));
    await expect(getTaskGraph(projectId, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    fetchMock.mockResolvedValue(response({ ...task, id: otherId }));
    await expect(getTask(projectId, taskId, signal(), admission)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("rejects invalid request arguments before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const limit of [0, 101, 1.5, Number.NaN]) expect(() => listProjects({ limit }, signal())).toThrow(ApiError);
    expect(() => listProjects({ cursor: "" }, signal())).toThrow(ApiError);
    expect(() => getTaskGraph("not-a-uuid", signal())).toThrow(ApiError);
    await expect(getTask(projectId, "../../secret", signal(), admission)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports safe network failures without raw exception text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("credentials secret")));
    await expect(listProjects({}, signal())).rejects.toMatchObject({ kind: "network", status: null, requestId: null });
    await expect(listProjects({}, signal())).rejects.not.toThrow("secret");
  });

  it.each([
    new Response("<html>credentials</html>", { headers: { "Content-Type": "text/html" } }),
    new Response("{}"),
    new Response("not-json", { headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }),
    response({ items: null, nextCursor: null }),
    response({ error: { code: "internal_error", message: "secret", requestId: null } }, 500),
  ])("reports safe protocol failures %#", async (raw) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(raw));
    await expect(listProjects({}, signal())).rejects.toMatchObject({ kind: "protocol" });
  });

  it.each([
    [404, "not_found", "The requested resource was not found."],
    [500, "internal_error", "Unable to load the requested data. Please try again."],
    [503, "unrecognized_code", "Unable to load the requested data. Please try again."],
  ] as const)("exposes sanitized server metadata for %i/%s", async (status, code, message) => {
    mockResponse({ error: { code, message: "SQL password=secret", requestId: "req-1" } }, status);
    await expect(listProjects({}, signal())).rejects.toMatchObject({ kind: "server", status, code, requestId: "req-1", message });
  });

  it("preserves graph-limit details for a useful refusal", async () => {
    const graphLimit = { nodeCount: 1001, edgeCount: 5, maxNodes: 1000, maxEdges: 5000 };
    mockResponse({ error: { code: "graph_limit_exceeded", message: "raw text", requestId: "req2", details: graphLimit } }, 409);
    await expect(getTaskGraph(projectId, signal())).rejects.toMatchObject({ kind: "server", status: 409, graphLimit,
      message: "This project's task graph exceeds the supported size." });
  });

  it("does not fetch for pre-aborted signals, preserving the abort reason", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(listProjects({}, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves in-flight cancellation including custom reasons", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by route generation");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      controller.abort(reason);
      return Promise.reject(new TypeError("fetch failed"));
    }));
    await expect(listProjects({}, controller.signal)).rejects.toBe(reason);
  });

  it("preserves abort errors even when the signal is not marked aborted", async () => {
    const reason = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(reason));
    await expect(listProjects({}, signal())).rejects.toBe(reason);
    const text = vi.fn().mockRejectedValue(reason);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ headers: new Headers({ "Content-Type": "application/json" }), status: 200, text }));
    await expect(listProjects({}, signal())).rejects.toBe(reason);
    expect(isAbortError(reason)).toBe(true);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(new Error("other"))).toBe(false);
  });

  it("rejects an otherwise successful fetch after its signal was cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(response({ items: [], nextCursor: null }));
    }));
    await expect(listProjects({}, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it("rejects cancellation during body parsing", async () => {
    const controller = new AbortController();
    const text = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve('{"items":[],"nextCursor":null}');
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ headers: new Headers({ "Content-Type": "application/json" }), status: 200, text }));
    const error: unknown = await listProjects({}, controller.signal).catch((failure: unknown) => failure);
    expect(error).toBe(controller.signal.reason);
  });
});
