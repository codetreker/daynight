import { describe, expect, it } from "vitest";
import { configurationDesiredSourcesComparable, configurationJsonSourcesEqual, decodeWorkerConfigurationSource, parseReceivedWorkerConfigurationResource, parseReceivedWorkerConfigurationReportReceipt, receiveWorkerDesired, validateWorkerRemoteObservation } from "../../src/api/worker-configuration-source.js";

const time = "2026-11-04T00:00:00Z";
const value = { maxConcurrent: 2, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [] };
const desired = JSON.stringify({ revision: "1", updatedAt: time, value });
const future = '{"negative":-2,"fraction":1.25,"exponent":1e999999999999999999,"integer":9007199254740993,"array":[true,null,{"__proto__":{"x":1}}]}';
const expanded = desired.replace('"value":{', `"future":${future},"value":{"future":${future},`).replace('"agent":"codex"', `"agent":"codex","future":${future}`);

describe("Worker configuration source documents", () => {
  it("retains complete desired source while deriving a strict nested known view", () => {
    expect(receiveWorkerDesired(expanded)).toEqual({ json: expanded, known: JSON.parse(desired) });
    const resource = `{"future":${future},"desired":${expanded},"observationRevision":"0","observation":null}`;
    expect(parseReceivedWorkerConfigurationResource(decodeWorkerConfigurationSource(resource))).toEqual({ json: resource, desired: { json: expanded, known: JSON.parse(desired) }, observationRevision: "0", observationJson: null });
  });
  it("decodes large known configuration trees within bounded JSON operations", () => {
    const large = { revision: "1", updatedAt: time, value: { ...value, native: { ...value.native, args: Array.from({ length: 100 }, () => "x".repeat(4096)) } } };
    const source = JSON.stringify(large), parse = JSON.parse, stringify = JSON.stringify;
    let received: ReturnType<typeof receiveWorkerDesired>;
    try {
      JSON.parse = ((source: string, ...args: unknown[]) => {
        if (source.length > 65_536) throw new RangeError("parse text budget exceeded");
        return Reflect.apply(parse, JSON, [source, ...args]) as unknown;
      }) as typeof JSON.parse;
      JSON.stringify = ((...args: unknown[]) => {
        const result = Reflect.apply(stringify, JSON, args) as string | undefined;
        if (result !== undefined && result.length > 65_536) throw new RangeError("stringify text budget exceeded");
        return result;
      }) as typeof JSON.stringify;
      received = receiveWorkerDesired(source);
    } finally { JSON.parse = parse; JSON.stringify = stringify; }
    expect(received).toEqual({ json: source, known: large });
  });
  it("projects unknown native overrides, tools and choice members without admitting invalid known fields", () => {
    const source = JSON.stringify({ revision: "1", updatedAt: time, value: { ...value, native: { ...value.native, future: true }, projects: [{ projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nativeOverrides: { model: null, future: -2 }, future: [] }], toolPaths: { codex: { kind: "auto", future: true }, copilot: null, herdr: { kind: "path", path: "/bin/herdr", future: {} }, future: false } } });
    const result = receiveWorkerDesired(source);
    expect(result.known.value.toolPaths).toEqual({ codex: { kind: "auto" }, copilot: null, herdr: { kind: "path", path: "/bin/herdr" } });
    expect(result.known.value.projects[0]!.nativeOverrides).toEqual({ model: null });
    expect(() => receiveWorkerDesired(source.replace('"agent":"codex"', '"agent":"unknown"'))).toThrow();
    expect(() => receiveWorkerDesired(source.replace('"maxConcurrent":2', '"maxConcurrent":2.0'))).toThrow();
    expect(() => receiveWorkerDesired(source.replace('"path":"/bin/herdr"', '"path":true'))).toThrow();
    expect(() => receiveWorkerDesired(source.replace('"kind":"auto"', '"kind":"auto","path":"/bin/x"'))).toThrow();
    expect(() => receiveWorkerDesired(source, false)).toThrow();
    const mode = desired.replace('"value":{', '"value":{"agentControlMode":"web",');
    expect(receiveWorkerDesired(mode).known.value.agentControlMode).toBe("web");
    expect(() => receiveWorkerDesired(mode, false)).toThrow();
  });
  it("retains remote unknown observation kinds without importing them into a local report", () => {
    const observation = `{"baseRevision":"0","desiredRevision":"1","reportedAt":"${time}","items":[{"key":{"kind":"future"},"appliedValue":${future},"future":true}]}`;
    const source = `{"desired":${expanded},"observationRevision":"1","observation":${observation}}`;
    expect(parseReceivedWorkerConfigurationResource({ json: source }).observationJson).toBe(observation);
    const malformed = observation.replace('"kind":"future"', '"kind":"maxConcurrent"');
    expect(() => parseReceivedWorkerConfigurationResource({ json: source.replace(observation, malformed) })).toThrow();
    expect(() => parseReceivedWorkerConfigurationResource({ json: source.replace('"observationRevision":"1"', '"observationRevision":"2"') })).toThrow();
    expect(() => parseReceivedWorkerConfigurationResource({ json: source.replace('"kind":"future"', '"kind":"agentControlMode"') }, false)).toThrow();
  });
  it("preserves source in ordinary report receipts", () => {
    const configuration = `{"future":${future},"desired":${expanded},"observationRevision":"0","observationAccepted":false}`;
    const receipt = parseReceivedWorkerConfigurationReportReceipt({ json: `{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${configuration}}` });
    expect(receipt.configuration.json).toBe(configuration);
    expect(receipt.configuration.desired?.json).toBe(expanded);
  });
  it("validates stored remote observations independently of a later authority", () => {
    const observation = JSON.stringify({ baseRevision: "7", desiredRevision: "9", reportedAt: time, items: [{ key: { kind: "maxConcurrent" }, targetRevision: "9", appliedValue: 2, state: "applied", error: null, lastFailure: null, nextAttemptAt: null }] });
    expect(() => validateWorkerRemoteObservation(observation, "8")).not.toThrow();
    expect(() => validateWorkerRemoteObservation(observation, "9")).toThrow();
    expect(() => validateWorkerRemoteObservation(observation.replace('"appliedValue":2', '"appliedValue":false'), "8")).toThrow();
    expect(() => validateWorkerRemoteObservation(observation.replace(time, "0001-01-01T00:00:00Z"), "8")).toThrow();
  });
  it("rejects duplicate decoded keys, invalid JSON and excess depth in unknown content", () => {
    for (const invalid of ['{"a":1,"\\u0061":2}', '{"x":NaN}', '{"x":01}', '{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}']) {
      expect(() => receiveWorkerDesired(desired.replace('"value":{', `"unknown":${invalid},"value":{`))).toThrow();
    }
  });
  it("compares numeric meaning without floating point or expanding huge exponents", () => {
    expect(configurationJsonSourcesEqual('{"a":1e3,"b":[-0,1.2300,1e999999999999999999]}', '{"b":[0,123e-2,10e999999999999999998],"a":1000}')).toBe(true);
    expect(configurationJsonSourcesEqual('{"a":9007199254740993}', '{"a":9007199254740992}')).toBe(false);
    expect(configurationJsonSourcesEqual('{"a":[1,2]}', '{"a":[2,1]}')).toBe(false);
    expect(configurationJsonSourcesEqual('{"__proto__":1,"text":"a"}', '{"text":"\\u0061","__proto__":1.0}')).toBe(true);
  });
  it("compares only common negotiated fields while retaining strict unknown comparison", () => {
    const mode = expanded.replace('"value":{', '"value":{"agentControlMode":"web",');
    const tools = mode.replace('"value":{', '"value":{"toolPaths":{"codex":null,"copilot":null,"herdr":null,"future":9007199254740993},');
    expect(configurationDesiredSourcesComparable(expanded, mode)).toBe(true);
    expect(configurationDesiredSourcesComparable(mode, tools)).toBe(true);
    expect(configurationDesiredSourcesComparable(tools, mode)).toBe(true);
    expect(configurationDesiredSourcesComparable(tools, tools.replace("9007199254740993", "9007199254740992"))).toBe(false);
    expect(configurationDesiredSourcesComparable(expanded, mode.replace('"negative":-2', '"negative":-3'))).toBe(false);
  });
});
