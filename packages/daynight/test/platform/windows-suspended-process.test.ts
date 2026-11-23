import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createSuspendedProcess, quoteWindowsProcessArgument, windowsProcessEnvironment } from "../../src/platform/windows-suspended-process.js";

it("encodes Windows argument and Unicode environment boundaries without shell expansion", () => {
  expect(quoteWindowsProcessArgument('a\\"b')).toBe('"a\\\\\\"b"');
  expect(quoteWindowsProcessArgument("C:\\space dir\\")).toBe('"C:\\space dir\\\\"');
  expect(quoteWindowsProcessArgument("$HOME & x")).toBe('"$HOME & x"');
  expect(windowsProcessEnvironment({ Z: "尾", A: "value", omitted: undefined }).toString("utf16le")).toBe("A=value\0Z=尾\0\0");
  expect(() => windowsProcessEnvironment({ Path: "a", PATH: "b" })).toThrow("duplicate");
  expect(() => quoteWindowsProcessArgument("bad\0arg")).toThrow("NUL");
});

it.skipIf(process.platform !== "win32")("keeps the native thread suspended until its owner resumes and joins it", async () => {
  const base = path.resolve("../../.tmp/windows-suspended-process"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), marker = path.join(root, "marker.txt");
  const child = await createSuspendedProcess({ file: process.execPath, args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], "started"); setInterval(() => {}, 1000)', marker], cwd: root, environment: process.env });
  try {
    expect(child.hasExited()).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => child.close()).toThrow("not exited");
    child.resume();
    await expect.poll(() => readFile(marker, "utf8"), { timeout: 5_000 }).toBe("started");
    expect(() => child.resume()).toThrow("again");
  } finally {
    child.terminate();
    const deadline = Date.now() + 5_000;
    while (!child.hasExited() && Date.now() < deadline) await delay(10);
    expect(child.hasExited()).toBe(true); child.close();
    await rm(root, { recursive: true, force: true });
  }
});
