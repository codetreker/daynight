import { afterEach, describe, expect, it, vi } from "vitest";
import { setTaskStatus, getTask, subscribeUnauthorized } from "../src/api/client";
import { parseApiJson, stringifyApiJson } from "../src/api/json";
import { parseTaskDetail } from "../src/api/parse";

const projectId = "10000000-0000-0000-0000-00000000000a";
const taskId = "20000000-0000-0000-0000-00000000000b";
const otherId = "30000000-0000-0000-0000-00000000000c";
const time = "2026-10-22T12:34:56.123456Z";
const task = { requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null,
  id: taskId, projectId, title: "A task", description: "", properties: { worker: null, pullRequests: [] }, status: "todo",
  version: 1n, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time,
};
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200) => new Response(stringifyApiJson(value), {
  status, headers: { "Content-Type": "application/json" },
});
const rawTask = (version: string) => {
  const { version: _version, ...fields } = task;
  return `${JSON.stringify(fields).slice(0, -1)},"version":${version}}`;
};
const fetchResponse = (value: Response) => {
  const fetcher = vi.fn().mockResolvedValue(value);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

afterEach(() => vi.unstubAllGlobals());

describe("lossless task versions", () => {
  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])("reads the numeric wire version %s without rounding", async (version) => {
    const raw = rawTask(version.toString());
    expect(parseTaskDetail(parseApiJson(raw), projectId, taskId).version).toBe(version);
    const reply = new Response(raw, { headers: { "Content-Type": "application/json" } });
    const nativeJson = vi.spyOn(reply, "json");
    fetchResponse(reply);
    await expect(getTask(projectId, taskId, signal())).resolves.toMatchObject({ version });
    expect(nativeJson).not.toHaveBeenCalled();
  });

  it.each(["null", "0", "-1", "1.5", "1.0", "1e3", "9223372036854775808", '"1"'])
    ("rejects malformed numeric-wire version %s", async (version) => {
      fetchResponse(new Response(rawTask(version), { headers: { "Content-Type": "application/json" } }));
      await expect(getTask(projectId, taskId, signal())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    });

  it("rejects missing versions and Number inputs whose original digits are unavailable", () => {
    const { version: _version, ...missing } = task;
    expect(() => parseTaskDetail(missing, projectId, taskId)).toThrow("invalid response");
    for (const version of [undefined, null, 1, Number.MAX_SAFE_INTEGER + 1, 0n, -1n, 9_223_372_036_854_775_808n]) {
      expect(() => parseTaskDetail({ ...task, version }, projectId, taskId)).toThrow("invalid response");
    }
  });

  it("serializes numeric bigint versions without changing similar-looking ordinary strings", () => {
    const value = { ...task, version: 9_223_372_036_854_775_807n, description: '__daynight_bigint__1 / "version":123 / __daynight_bigint___2' };
    const encoded = stringifyApiJson(value);
    expect(encoded).toContain('"version":9223372036854775807');
    expect(parseApiJson(encoded)).toEqual(value);
    expect(() => stringifyApiJson({ version: 0n })).toThrow("positive 64-bit integer");
  });

  it("uses native serialization for non-version fields and rejects unsupported nested bigint values", () => {
    const fields = { description: '"version":9007199254740993', nested: { version: "9223372036854775807", marker: "__daynight_bigint__1" },
      omitted: undefined, items: [undefined, null, "text"], date: new Date('2026-10-22T00:00:00Z') };
    expect(JSON.parse(stringifyApiJson({ ...fields, version: 1n }))).toEqual({ ...JSON.parse(JSON.stringify(fields)), version: 1 });
    expect(stringifyApiJson(fields)).toBe(JSON.stringify(fields));
    expect(() => stringifyApiJson(undefined)).toThrow(TypeError);
    expect(() => stringifyApiJson({ version: 1n, nested: { version: 2n } })).toThrow(TypeError);
    expect(() => stringifyApiJson([{ version: 1n }])).toThrow(TypeError);
    expect(() => stringifyApiJson({ version: -1n })).toThrow("positive 64-bit integer");
    expect(() => stringifyApiJson({ version: 9_223_372_036_854_775_808n })).toThrow("positive 64-bit integer");
  });

  it("preserves exact versions when JSON.parse supplies no reviver context", () => {
    const nativeParse = JSON.parse;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => nativeParse(text, reviver === undefined
      ? undefined : function (key, value) { return reviver.call(this, key, value); }));
    try {
      expect(parseTaskDetail(parseApiJson(rawTask('9223372036854775807')), projectId, taskId).version).toBe(9_223_372_036_854_775_807n);
      expect(parseTaskDetail(parseApiJson(rawTask('1')), projectId, taskId).version).toBe(1n);
    } finally { parse.mockRestore(); }
  });

  it("recognizes escaped root version keys while leaving complete strings and nested data unchanged", () => {
    const raw = String.raw`{"description":"quoted \\\"version\\\":9223372036854775807 and slash \\\\ and \\u005f_daynight_bigint__1", "nested":[{"version":9007199254740993}],"\u0076ersion":9223372036854775807,"count":1}`;
    const plain = JSON.parse(raw) as { description: string; nested: unknown };
    expect(parseApiJson(raw)).toEqual({ description: plain.description, nested: plain.nested, version: 9_223_372_036_854_775_807n, count: 1 });
    expect(parseApiJson(String.raw`{"version":"\u0039\u0030\u0030\u0037\u0031\u0039\u0039\u0032\u0035\u0034\u0037\u0034\u0030\u0039\u0039\u0033"}`))
      .toEqual({ version: "9007199254740993" });
  });

  it("retains native duplicate-key semantics without converting replaced values", () => {
    expect(parseApiJson('{"task":{"version":9223372036854775807},"task":{"version":1.5}}')).toEqual({ task: { version: 1.5 } });
    expect(parseApiJson('{"task":{"version":9223372036854775807},"task":{"version":"1"}}')).toEqual({ task: { version: "1" } });
    expect(parseApiJson('{"task":{"version":9223372036854775807},"task":null}')).toEqual({ task: null });
    expect(parseApiJson('{"version":1.5,"version":9007199254740993}')).toEqual({ version: 9_007_199_254_740_993n });
    expect(parseApiJson('{"version":9007199254740993,"version":"1"}')).toEqual({ version: "1" });
    expect(parseApiJson('{"version":9007199254740993,"version":1e0}')).toEqual({ version: 1 });
    expect(parseApiJson('{"__proto__":{"version":9007199254740993}}')).toEqual(JSON.parse('{"__proto__":{"version":9007199254740993}}'));
  });

  it.each([
    '{"x":{"0":{"version":9007199254740993}},"x":[{"version":1}]}',
    '{"x":[{"version":9007199254740993}],"x":{"0":{"version":1}}}',
    '{"version":{"version":9007199254740993}}', '[{"version":9007199254740993}]',
    'null', 'true', '1', '"version"',
  ])("leaves nested unknown fields and non-object roots under native JSON semantics %#", (raw) => {
    expect(parseApiJson(raw)).toEqual(JSON.parse(raw));
  });

  it.each(['{"version":01}', '{"version":1,}', '{"version":1} trailing', '{"description":"unterminated}', '[1,,2]'])
    ("preserves JSON syntax failures for %s", (raw) => expect(() => parseApiJson(raw)).toThrow(SyntaxError));
});

describe.each(['todo', 'in_progress', 'done'] as const)('%s status transport', (target) => {
  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_806n])('puts exact numeric version %s and accepts either possible status version', async (version) => {
    for (const delta of [0n, 1n]) {
      const saved = { ...task, version: version + delta, status: target, ready: target === 'todo' };
      const fetcher = fetchResponse(response(saved)); const abortSignal = signal();
      await expect(setTaskStatus(projectId.toUpperCase(), taskId.toUpperCase(), target, version, abortSignal)).resolves.toEqual(saved);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/status`, {
        method: 'PUT', redirect: 'error', signal: abortSignal, cache: 'no-store', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: `{"version":${version},"status":"${target}"}`,
      });
    }
  });
  it.each(['version_conflict', 'dependency_unsatisfied', 'not_found'])('preserves server refusal %s without retrying', async (code) => {
    const fetcher = fetchResponse(response({ error: { code, message: 'internal SQL', requestId: 'status-1' } }, 409));
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'server', status: 409, code, requestId: 'status-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses shared unauthorized notification', async () => {
    const listener = vi.fn(); const unsubscribe = subscribeUnauthorized(listener);
    try {
      fetchResponse(response({ error: { code: 'unauthenticated', message: 'expired', requestId: 'status-auth' } }, 401));
      await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'server', status: 401 });
      expect(listener).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
  it('allows maximum int64 expected version to reach a service refusal', async () => {
    const fetcher = fetchResponse(response({ error: { code: 'internal_error', message: 'overflow', requestId: 'max-version' } }, 500));
    await expect(setTaskStatus(projectId, taskId, target, 9_223_372_036_854_775_807n, signal())).rejects.toMatchObject({ kind: 'server' });
    expect(fetcher.mock.calls[0]?.[1].body).toBe(`{"version":9223372036854775807,"status":"${target}"}`);
  });
  it.each([
    { ...task, projectId: otherId }, { ...task, id: otherId }, { ...task, status: 'proposed' },
    { ...task, version: 3n },
  ])('rejects mismatching response scope, status or version %#', async (fields) => {
    fetchResponse(response(Object.assign({}, task, { status: target, version: 2n }, fields)));
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol', status: 200 });
  });
  it('rejects a different three-state target and unexpected successful status', async () => {
    fetchResponse(response({ ...task, status: target === 'done' ? 'todo' : 'done', version: 2n }));
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol' });
    fetchResponse(response({ ...task, status: target, version: 2n }, 201));
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol', status: 201 });
  });
  it('rejects malformed scope, state and version before I/O', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus('bad', taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(setTaskStatus(projectId, 'bad', target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol' });
    for (const version of [0n, -1n, 9_223_372_036_854_775_808n, 9_007_199_254_740_992 as unknown as bigint]) {
      await expect(setTaskStatus(projectId, taskId, target, version, signal())).rejects.toMatchObject({ kind: 'protocol' });
    }
    await expect(setTaskStatus(projectId, taskId, 'proposed' as never, 1n, signal())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains network/body causes and never replays writes', async () => {
    const failure = new TypeError('response lost'); const fetcher = vi.fn().mockRejectedValue(failure); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'network', cause: failure });
    const reply = response({ ...task, status: target, version: 2n }); vi.spyOn(reply, 'text').mockRejectedValue(failure); fetcher.mockResolvedValue(reply);
    await expect(setTaskStatus(projectId, taskId, target, 1n, signal())).rejects.toMatchObject({ kind: 'protocol', cause: failure });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves cancellation before I/O', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const controller = new AbortController(); const reason = new Error('project changed'); controller.abort(reason);
    await expect(setTaskStatus(projectId, taskId, target, 1n, controller.signal)).rejects.toBe(reason); expect(fetcher).not.toHaveBeenCalled();
  });
});
