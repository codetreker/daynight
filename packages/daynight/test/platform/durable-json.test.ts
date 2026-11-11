import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDurableJson } from "../../src/platform/durable-json.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const directories: string[] = [];
afterEach(() => {
  vi.mocked(fsyncSync).mockRestore(); vi.mocked(renameSync).mockRestore(); vi.mocked(unlinkSync).mockRestore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/durable-json");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "run-")); directories.push(directory);
  return { directory, file: path.join(directory, "value.json") };
};

test("cleans its temporary file and preserves the publication error", () => {
  const { directory, file } = fixture(), failure = new Error("rename failed");
  vi.mocked(renameSync).mockImplementationOnce(() => { throw failure; });
  expect(() => writeDurableJson(file, { value: 1 })).toThrow(failure);
  expect(readdirSync(directory)).toEqual([]);
});

test("cleans its temporary file when its file barrier fails", () => {
  const { directory, file } = fixture(), failure = new Error("file sync failed");
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw failure; });
  expect(() => writeDurableJson(file, { value: 1 })).toThrow(failure);
  expect(readdirSync(directory)).toEqual([]);
});

test("retains both the publication and cleanup failures", () => {
  const { file } = fixture(), failure = new Error("rename failed"), cleanup = new Error("unlink failed");
  vi.mocked(renameSync).mockImplementationOnce(() => { throw failure; });
  vi.mocked(unlinkSync).mockImplementationOnce(() => { throw cleanup; });
  try { writeDurableJson(file, { value: 1 }); throw new Error("publication unexpectedly succeeded"); }
  catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure, cleanup]);
    expect((error as Error).cause).toBe(failure);
  }
});

test.skipIf(process.platform === "win32")("retains the published file when the parent barrier fails", () => {
  const { file } = fixture(), failure = new Error("parent sync failed"), sync = vi.mocked(fsyncSync).getMockImplementation()!;
  vi.mocked(fsyncSync).mockImplementationOnce(sync).mockImplementationOnce(() => { throw failure; });
  expect(() => writeDurableJson(file, { value: 1 })).toThrow(failure);
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ value: 1 });
});
