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
])("preserves Windows traversal after proving ordinary parents for %s", async (raw, expected) => {
  await resolveGitFile("D:\\repo\\admin", raw);
  await resolveGitDirectory("D:\\repo\\admin", raw);
  expect(lstat).toHaveBeenCalledWith(expected);
  expect(realpath).toHaveBeenNthCalledWith(1, expected);
  expect(realpath).toHaveBeenNthCalledWith(2, expected);
});

// A final lookup can succeed after Win32 has erased an unsafe component.
// Its result alone does not prove that the collapsed component was safe.
it.each(["junction", "missing", "file", "io"])("rejects a Windows parent traversal over %s before the final lookup", async kind => {
  const ordinary = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, nlink: 1 };
  const cause = Object.assign(new Error("Cannot observe collapsed directory"), { code: kind === "missing" ? "ENOENT" : "EIO" });
  vi.mocked(lstat).mockImplementation(async target => {
    if (String(target) === "C:\\repo\\alias") {
      if (kind === "missing" || kind === "io") throw cause;
      return { ...ordinary, isDirectory: () => kind !== "file", isSymbolicLink: () => kind === "junction" } as Awaited<ReturnType<typeof lstat>>;
    }
    return ordinary as Awaited<ReturnType<typeof lstat>>;
  });
  for (const resolve of [resolveGitFile, resolveGitDirectory]) {
    await expect(resolve("C:\\repo", "alias/../target")).rejects.toThrow();
  }
  expect(lstat).not.toHaveBeenCalledWith("C:\\repo\\alias/../target");
  expect(realpath).not.toHaveBeenCalled();
});

it("checks a junction exposed by an earlier ordinary parent traversal", async () => {
  vi.mocked(lstat).mockImplementation(async target => ({
    isFile: () => true, isDirectory: () => true, isSymbolicLink: () => String(target) === "C:\\repo\\alias", nlink: 1,
  }) as Awaited<ReturnType<typeof lstat>>);
  await expect(resolveGitFile("C:\\repo", "alias/ordinary/../../.git")).rejects.toThrow();
  expect(lstat).toHaveBeenCalledWith("C:\\repo\\alias\\ordinary");
  expect(lstat).toHaveBeenCalledWith("C:\\repo\\alias");
  expect(realpath).not.toHaveBeenCalled();
});

it("allows ordinary relative parent traversal without changing the final Windows lookup", async () => {
  await expect(resolveGitFile("D:\\repo\\admin", "../../task/.git")).resolves.toEqual({ path: "D:\\repo\\admin\\../../task/.git", missing: false });
  expect(lstat).toHaveBeenCalledWith("D:\\repo\\admin");
  expect(lstat).toHaveBeenCalledWith("D:\\repo");
  expect(realpath).toHaveBeenCalledWith("D:\\repo\\admin\\../../task/.git");
});
