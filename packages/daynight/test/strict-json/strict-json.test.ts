import { describe, expect, it } from "vitest";
import { decodeStrictJson } from "../../src/strict-json.js";

const decode = (input: string | Uint8Array, limit = 1024) => decodeStrictJson(input, limit);

describe("strict JSON", () => {
  it("rejects malformed or duplicate decoded keys at any depth", () => {
    for (const raw of ['{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":1}}', '{"x":[{"a":1,"a":2}]}', '[1,]', '{"a":1,}', 'true false', 'NaN', '1e9999', '"\\udc00"', '"\\ud800x"', '\ufeff{}', '['.repeat(66) + '0' + ']'.repeat(66)]) expect(() => decode(raw)).toThrow();
    expect(decode('{"__proto__":{"x":1},"s":"\\ud83d\\ude00"}')).toEqual({ ["__proto__"]: { x: 1 }, s: "😀" });
  });
  it("enforces byte limits and UTF-8 before parsing", () => {
    expect(decode(' '.repeat(1020) + 'null')).toBeNull();
    expect(() => decode(' '.repeat(1021) + 'null')).toThrow();
    expect(() => decode(new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]))).toThrow();
    expect(() => decode(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});
