import { beforeEach, expect, it, vi } from "vitest";
import { lstat, realpath } from "node:fs/promises";
import { resolveGitDirectory, resolveGitFile } from "../../../src/commands/worker/worktree-paths.js";

vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), lstat: vi.fn(), realpath: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, nlink: 1 } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(realpath).mockImplementation(async target => String(target));
});

it.each(["\\foo", "/foo", "\\\\server", "C:foo"])("rejects a Windows pointer without a determined volume: %s", async raw => {
  await expect(resolveGitFile("D:\\repo\\admin", raw)).rejects.toThrow();
  await expect(resolveGitDirectory("D:\\repo\\admin", raw)).rejects.toThrow();
  expect(lstat).not.toHaveBeenCalled();
});

it.each([
  ["C:\\repo\\alias\\..\\.git", "C:\\repo\\alias\\..\\.git"],
  ["\\\\server\\share\\alias\\..\\.git", "\\\\server\\share\\alias\\..\\.git"],
  ["..\\..\\alias\\..\\.git", "D:\\repo\\admin\\..\\..\\alias\\..\\.git"],
])("preserves Windows filesystem traversal for %s", async (raw, expected) => {
  await resolveGitFile("D:\\repo\\admin", raw);
  await resolveGitDirectory("D:\\repo\\admin", raw);
  expect(lstat).toHaveBeenNthCalledWith(1, expected);
  expect(lstat).toHaveBeenNthCalledWith(2, expected);
  expect(realpath).toHaveBeenNthCalledWith(1, expected);
  expect(realpath).toHaveBeenNthCalledWith(2, expected);
});
