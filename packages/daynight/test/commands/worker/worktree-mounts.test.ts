import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertMountPathsOutsideWorktree, assertNoWorktreeMounts, parseLinuxMountInfo } from "../../../src/commands/worker/worktree-mounts.js";

const source = (mount: string): string => `42 21 8:1 / ${mount} rw,relatime shared:1 - ext4 /dev/sda rw\n`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });

describe("worktree mount inventory", () => {
  it("decodes kernel mountinfo escapes without interpreting shell text", () => {
    const text = source("/work/space\\040quote'\\011newline\\012back\\134slash$(touch)") + source("/");
    expect(parseLinuxMountInfo(Buffer.from(text))).toEqual(["/work/space quote'\tnewline\nback\\slash$(touch)", "/"]);
  });

  it("rejects a mount at the target or beneath it but permits siblings and ancestors", () => {
    const target = "/repo/worktree space'$(x)";
    for (const mount of [target, `${target}/child`, `${target}/nested/child`]) {
      expect(() => assertMountPathsOutsideWorktree(target, [mount])).toThrow("mounted filesystem");
    }
    expect(() => assertMountPathsOutsideWorktree(target, ["/", "/repo", `${target}-other`, "/repo/worktree"])).not.toThrow();
  });

  it.each([
    "", source("/work").trimEnd(), source("/work\\777"), source("/work\\"), source("/work/../other"),
    "42 21 8:1 / /work rw - ext4\n", source("/work").replace("42 21", "oops 21"),
  ])("rejects incomplete or malformed mount records", text => {
    expect(() => parseLinuxMountInfo(Buffer.from(text))).toThrow();
  });

  it("rejects undecodable bytes and unsupported platforms", async () => {
    expect(() => parseLinuxMountInfo(Buffer.from([0xff, 0x0a]))).toThrow();
    await expect(assertNoWorktreeMounts("/work", "win32")).rejects.toThrow();
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")("reads the actual native mount inventory and rejects a mounted root", async () => {
    const base = path.resolve("../../.tmp/worktree-mounts-test");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "run-")); roots.push(root);
    await expect(assertNoWorktreeMounts(await realpath(root))).resolves.toBeUndefined();
    await expect(assertNoWorktreeMounts("/")).rejects.toThrow("mounted filesystem");
  });
});
