import { expect, test } from "vitest";
import { jsonPieces } from "../../src/session/json-pieces.js";

test("encodes bounded pieces identical to JSON.stringify across escaping and surrogate boundaries", () => {
  const value = { entries: [{ text: `${"a".repeat(65535)}😀\n\"\\\ud800\udc00\udfff汉字${"z".repeat(2 * 1024 * 1024)}` }], ignored: undefined, numbers: [0, -1, null] };
  const pieces = [...jsonPieces(value)];
  expect(pieces.join("")).toBe(JSON.stringify(value));
  expect(Buffer.concat(pieces.map(piece => Buffer.from(piece))).equals(Buffer.from(JSON.stringify(value)))).toBe(true);
  expect(Math.max(...pieces.map(piece => piece.length))).toBeLessThan(400000);
  expect([...jsonPieces({ b: 1, a: 2 }, true)].join("")).toBe('{"a":2,"b":1}');
});
