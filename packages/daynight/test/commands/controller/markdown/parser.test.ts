import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { parseMarkdownImages } from "../../../../src/commands/controller/markdown/parser.js";
const controlled = vi.hoisted(() => ({ worker: null as import("node:worker_threads").Worker | null }));
vi.mock("node:worker_threads", async importOriginal => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  return { ...original, Worker: class {
    constructor(...args: ConstructorParameters<typeof original.Worker>) { return controlled.worker ?? new original.Worker(...args); }
  } };
});
afterEach(() => { controlled.worker = null; vi.useRealTimers(); });
const controlWorker = () => {
  vi.useFakeTimers();
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 0) });
  controlled.worker = worker as unknown as import("node:worker_threads").Worker; return worker;
};

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
  await expect(parseMarkdownImages("![x](a) ".repeat(1001))).rejects.toMatchObject({ code: "source_unavailable", reason: "node_limit" });
});

test("parser execution receives its full budget after bounded worker module startup", async () => {
  const worker = controlWorker(), result = parseMarkdownImages("readable body");
  await vi.advanceTimersByTimeAsync(9000);
  expect(worker.postMessage).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
  worker.emit("message", { ready: true });
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ parse: true });
  await vi.advanceTimersByTimeAsync(1999);
  worker.emit("message", { nodes: [] });
  await expect(result).resolves.toEqual([]);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["startup_timeout", "parse_timeout"] as const)("%s terminates the worker and preserves a safe distinct diagnostic", async reason => {
  const worker = controlWorker(), result = parseMarkdownImages("private source");
  const checked = expect(result).rejects.toMatchObject({ code: "source_unavailable", reason });
  if (reason === "parse_timeout") worker.emit("message", { ready: true });
  await vi.advanceTimersByTimeAsync(reason === "startup_timeout" ? 10_000 : 2000);
  await checked; expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["error", "exit", "invalid"])("worker %s cannot publish a result or leak private details", async event => {
  const worker = controlWorker(), result = parseMarkdownImages("private source");
  const checked = expect(result).rejects.toMatchObject({ reason: "worker_failure" });
  if (event === "error") worker.emit("error", new Error("private path and source"));
  else if (event === "exit") worker.emit("exit", 0);
  else worker.emit("message", { nodes: [] });
  await checked; expect(worker.terminate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
