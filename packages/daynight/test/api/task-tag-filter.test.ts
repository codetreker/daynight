import { describe, expect, it } from "vitest";
import { parseTaskTagFilter, parseTaskTagFilterKey, taskTagFilterKey, type WorkerTaskTagFilter } from "../../src/api/task-tag-filter.js";
import { ProtocolError } from "../../src/api/validation.js";

describe("Task tag filter value", () => {
  it("retains the first display spelling and orders comparison keys by Unicode scalar", () => {
    expect(parseTaskTagFilter({ names: [" urgent ", "Backend", "backend", "URGENT", "𐀀", "\ue000"], match: "all" })).toEqual({ names: ["Backend", "urgent", "\ue000", "𐀀"], match: "all" });
    expect(parseTaskTagFilter({ names: [], match: "all" })).toEqual({ names: [], match: "any" });
    expect(parseTaskTagFilter({ names: ["😀".repeat(64), "\ufeff"], match: "any" }).names).toHaveLength(2);
  });

  const vectors: readonly [WorkerTaskTagFilter["match"], readonly string[], string][] = [
    ["any", ["backend", "urgent"], "d6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2"],
    ["any", ["URGENT", "Backend", "backend", " urgent "], "d6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2"],
    ["all", ["backend", "urgent"], "b60f83f3c95a35685b5ceedbcd54b0aea405fef15c3f8bb11203002f0eca3ab6"],
    ["any", [], "f394e6e6411d7ce2e190d62c0ec2bf0b03248a80ccbc81665757f672f28da1b4"],
    ["all", [], "f394e6e6411d7ce2e190d62c0ec2bf0b03248a80ccbc81665757f672f28da1b4"],
    ["any", ["<>&", "html"], "7d57ff477191df9dee039686b3fd0b5b08760c8c59a038d2c61f951f4ac8e7d0"],
    ["all", ['a"b', "a\\b"], "8bd5284adbc84a702f90b9083eaa6052b1c94077529dd16d621259803f0f854b"],
    ["any", ["后端", "紧急"], "66b4554122a75ae7c8bf7ff9906ce07d841c4a2392a1d07b041cd6de84e3f0ed"],
    ["all", ["𐀀", "\ue000", "😀", "a"], "66f47f2cf0f7735832daa25f2ab12ed6dd6e16e20ac5ab52dbc552fd6b36f56c"],
    ["any", ["É"], "b3b98251fee79ee896b3ed60eb8745f31796009ca8e31f2356a26f36186bad59"],
    ["any", ["é"], "f4c47b9a36cdc0d6ca7fff7292dabdbe2a7e76de600bf080fa109e7e89954f02"],
    ["any", ["e\u0301"], "307fbb6c5220ab4ca91a4a9e5d3de6733d175d7934cb72b2133631370c6e5c13"],
    ["any", ["\u2003Ab C\u00a0", "backend"], "41957b95de93facb7581788d9da48b8c5e5250bd0c49d7c0842df4f8d69e0088"],
    ["any", ["ab  c", "ab c"], "bf81f6373a3af7677668b2ca53e5b437878c9170b90091e4437bf1f9c2ab4b1c"],
  ];
  it.each(vectors)("shares the service digest for %s / %j", (match, names, digest) => {
    expect(taskTagFilterKey({ names, match })).toBe(digest);
    expect(parseTaskTagFilterKey(digest)).toBe(digest);
  });

  it.each([
    null, {}, { names: [], match: "ANY" }, { names: null, match: "any" }, { names: [2], match: "any" },
    { names: [], match: "any", future: true },
    ...["", " \u0085\u2003 ", "😀".repeat(65), "a\0b", "a\u007fb", "a\u2028b", "a\u2029b", "\ud800", "\udfff"].map(name => ({ names: [name], match: "any" })),
  ])("rejects malformed or invalid filter %j", value => {
    expect(() => parseTaskTagFilter(value)).toThrow(ProtocolError);
  });

  it.each([null, true, 12, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])("rejects noncanonical digest %j", value => {
    expect(() => parseTaskTagFilterKey(value)).toThrow(ProtocolError);
  });
});
