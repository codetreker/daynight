import { describe, expect, it } from "vitest";
import { parseTaskProperties, readPullRequests, readWorkerClaim, sameTaskProperties } from "../../src/api/task-properties.js";

describe("generic task properties", () => {
  it("retains unknown keys, nested version fields and value presence", () => {
    const raw = { future: { version: 7, enabled: true, nested: [null, "value"] }, empty: [], nullable: null };
    expect(parseTaskProperties(raw)).toEqual(raw);
    const absent = parseTaskProperties({});
    expect(absent).toEqual({});
    expect(Object.hasOwn(absent, "pullRequests")).toBe(false);
    expect(Object.hasOwn(absent, "worker")).toBe(false);
  });

  it("preserves JSON object names without assigning their values to the prototype", () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"future":"value"}');
    const properties = parseTaskProperties(raw);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(properties.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
  });

  it.each([undefined, null, [], "properties", false, { invalid: undefined }, { invalid: Infinity }, { invalid: 1n }])("rejects a non-JSON object envelope or value %#", (value) => {
    expect(() => parseTaskProperties(value)).toThrow("invalid response");
  });

  it("compares complete property objects without relying on object key order", () => {
    expect(sameTaskProperties({ future: { first: 1, second: ["a", "b"] }, another: true }, { another: true, future: { second: ["a", "b"], first: 1 } })).toBe(true);
    expect(sameTaskProperties({}, { pullRequests: [] })).toBe(false);
    expect(sameTaskProperties({ future: null }, {})).toBe(false);
    expect(sameTaskProperties({ future: ["a", "b"] }, { future: ["b", "a"] })).toBe(false);
    expect(sameTaskProperties({ future: { value: 1 } }, { future: { value: 2 } })).toBe(false);
  });
});

describe("typed property consumers", () => {
  it("distinguishes a missing PR property from an explicitly empty array", () => {
    expect(readPullRequests({})).toBeUndefined();
    expect(readPullRequests({ pullRequests: [] })).toEqual([]);
    const values = [{ url: "\0 arbitrary text", title: "" }, { url: "\0 arbitrary text", title: "" }];
    expect(readPullRequests({ pullRequests: values })).toEqual(values);
  });

  it.each([null, {}, [null], [{}], [{ url: 1, title: "" }], [{ url: "", title: "", extra: true }]])("rejects a malformed present PR value when consumed %#", (pullRequests) => {
    expect(() => readPullRequests(parseTaskProperties({ pullRequests }))).toThrow("invalid response");
  });

  it("distinguishes absent worker ownership from an invalid present null", () => {
    expect(readWorkerClaim({})).toBeUndefined();
    expect(() => readWorkerClaim({ worker: null })).toThrow("invalid response");
  });
});
