import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decodeSessionText, readSessionText, validateSessionText } from "../../../../src/commands/task/session/input.js";
let root: string;
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-input-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it("preserves BOM, whitespace, CRLF and final newline from every input source", async () => {
  const text = "\ufeff  /compact 中文😀\r\n\n";
  const file = path.join(root, "input"); await writeFile(file, text);
  expect(await readSessionText({ text }, new AbortController().signal)).toBe(text);
  expect(await readSessionText({ file }, new AbortController().signal)).toBe(text);
  const stream = new PassThrough(); const read = readSessionText({ stdin: true }, new AbortController().signal, stream); stream.end(Buffer.from(text)); expect(await read).toBe(text);
});
it("rejects malformed, empty, whitespace, NUL and over-limit text without echoing input", () => {
  for (const text of ["", " \t\r\n\u2003", "SECRET\0", "SECRET\ud800", "x".repeat(1_048_577)]) expect(() => validateSessionText(text)).toThrow("Message input must");
  expect(() => decodeSessionText(Buffer.from([0xc3, 0x28]))).toThrow("Message input must");
  expect(validateSessionText("x".repeat(1_048_576))).toHaveLength(1_048_576);
});
it("rejects directories, symlinks and unselected or conflicting sources", async () => {
  await expect(readSessionText({ file: root }, new AbortController().signal)).rejects.toThrow();
  if (process.platform !== "win32") {
    const link = path.join(root, "link"); await symlink(path.join(root, "input"), link);
    await expect(readSessionText({ file: link }, new AbortController().signal)).rejects.toThrow();
  }
  for (const input of [{}, { text: "a", stdin: true }, { file: "unused", text: "a" }]) await expect(readSessionText(input, new AbortController().signal)).rejects.toThrow("Select exactly one");
});
it("cancels a pending stdin read and releases its listeners", async () => {
  const stream = new PassThrough(), controller = new AbortController();
  const read = readSessionText({ stdin: true }, controller.signal, stream); controller.abort(new Error("cancelled"));
  await expect(read).rejects.toThrow("cancelled"); for (const event of ["data", "end", "error"]) expect(stream.listenerCount(event)).toBe(0);
});
it.skipIf(process.platform === "win32")("rejects FIFO and device inputs without blocking", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const fifo = path.join(root, "fifo"); await promisify(execFile)("mkfifo", [fifo], { timeout: 5_000 });
  const start = performance.now(); await expect(readSessionText({ file: fifo }, new AbortController().signal)).rejects.toThrow(); expect(performance.now() - start).toBeLessThan(500);
  await expect(readSessionText({ file: "/dev/null" }, new AbortController().signal)).rejects.toThrow();
});
