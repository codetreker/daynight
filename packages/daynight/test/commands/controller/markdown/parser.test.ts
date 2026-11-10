import { expect, test } from "vitest";
import { parseMarkdownImages } from "../../../../src/commands/controller/markdown/parser.js";

test("only CommonMark image nodes supply ordered exact UTF-16 ranges", async () => {
  const text = "😀 ![first](a.png) [![linked][PIC]](https://example.com)\r\n\r\n[PIC]: b.png\r\n[PIC]: ignored.png\r\n";
  const nodes = await parseMarkdownImages(text);
  expect(nodes.map(n => ({ ...n, source: text.slice(n.start, n.end) }))).toEqual([
    { start: 3, end: 18, destination: "a.png", label: "first", linkHref: null, source: "![first](a.png)" },
    { start: 20, end: 34, destination: "b.png", label: "linked", linkHref: "https://example.com", source: "![linked][PIC]" },
  ]);
});

test("code, HTML, escaped syntax, plain paths and unresolved references do not register sources", async () => {
  expect(await parseMarkdownImages("`![x](a)`\n\n```\n![x](b)\n```\n\n    ![x](c)\n\n\\![x](d) [x](e) ./f.png ![unknown]\n\n<div>\n![x](g)\n</div>\n<img src='h'>")).toEqual([]);
});

test("reference normalization, shortcut/collapsed and repeated destinations keep separate nodes", async () => {
  const nodes = await parseMarkdownImages("![foo][] ![FOO] ![x](same) ![y](same)\n\n[foo]: <a%20b.png>\n");
  expect(nodes.map(n => [n.destination, n.label])).toEqual([["a%20b.png", "foo"], ["a%20b.png", "FOO"], ["same", "x"], ["same", "y"]]);
  expect(new Set(nodes.map(n => n.start)).size).toBe(4);
});

test("parser failure is atomic and never returns a truncated image collection", async () => {
  await expect(parseMarkdownImages("![x](a) ".repeat(1001))).rejects.toThrow("source_unavailable");
});
