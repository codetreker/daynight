import { describe, expect, it } from "vitest";
import { jsonContainerSources, jsonObjectSources, MAX_JSON_SOURCE_DEPTH } from "../../src/api/json-source.js";

describe("bounded JSON source inspection", () => {
  it("retains raw value spans and decoded object keys", () => {
    const source = ' { "text" : "\\u003c", "\\u0069tems": [ 1, { "body": "a,}\\\"[b" }, true ] } ';
    const fields = jsonObjectSources(source);
    expect([...fields]).toEqual([["text", '"\\u003c"'], ["items", '[ 1, { "body": "a,}\\\"[b" }, true ]']]);
    expect(jsonContainerSources(fields.get("items")!)).toEqual(["1", '{ "body": "a,}\\\"[b" }', "true"]);
    expect(jsonContainerSources('{ "a": 1, "b" : false }')).toEqual(['"a": 1', '"b" : false']);
  });

  it("handles all JSON primitive forms without changing their source", () => {
    const values = ['-12.345e+6', '0', '-0', '1E-2', 'true', 'false', 'null', '"\\\\\\/\\b\\f\\n\\r\\t\\u0041"'];
    expect(jsonContainerSources(`[${values.join(",")}]`)).toEqual(values);
  });

  it.each([
    '{"a":1,"a":2}', '{"Agent":true,"\\u0041gent":false}',
    '{"items":[{"author":{"Agent":true,"Agent":false}}]}',
    '{"error":{"code":"forbidden","code":"invalid_input"}}',
    '{"a":{"b":[{"c":1,"c":2}]}}',
  ])("rejects duplicate members before object construction %s", (source) => {
    expect(() => jsonObjectSources(source)).toThrow(SyntaxError);
  });

  it("uses Maps for arbitrary member names", () => {
    const fields = jsonObjectSources('{"__proto__":{"polluted":true},"constructor":false}');
    expect(fields.get("__proto__")).toBe('{"polluted":true}');
    expect(fields.get("constructor")).toBe("false");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it.each([
    "", " ", "{", "[", '{"a"', '{"a":', '{"a":1', '[1', '{"a":1,}', '[1,]',
    '{"a" 1}', '{"a":1 "b":2}', '{"a":01}', '{"a":1.}', '{"a":1e}',
    '{"a":NaN}', '{"a":undefined}', '{"a":truefalse}', '{"a":[1}}',
    '{"a":"unterminated}', '{"a":"bad\\', '{"a":"\\q"}', '{"a":"\\u123"}',
    '{"a":"\\u12x4"}', '{"a":"raw\nline"}', '{"a":1} {}', '\uFEFF{}',
  ])("rejects malformed or truncated input without an unbounded scan %j", (source) => {
    expect(() => jsonObjectSources(source)).toThrow(SyntaxError);
  });

  it("allows 64 container levels and rejects the next level", () => {
    const nested = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
    expect(jsonContainerSources(nested(MAX_JSON_SOURCE_DEPTH))).toHaveLength(1);
    expect(() => jsonContainerSources(nested(MAX_JSON_SOURCE_DEPTH + 1))).toThrow(SyntaxError);
  });

  it("requires the requested container kind", () => {
    expect(() => jsonObjectSources("[]")).toThrow(SyntaxError);
    expect(() => jsonContainerSources("null")).toThrow(SyntaxError);
  });
});
