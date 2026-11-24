import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureLinuxControllerLaunch, createLinuxControllerLaunchObserver, inspectLinuxControllerLaunch,
  isLinuxControllerLaunch, parseLinuxControllerLaunch, parseLinuxControllerLaunchArgv,
  type LinuxControllerLaunchObserverDependencies,
} from "../../../src/commands/controller/linux-controller-launch.js";

const launchId = "12345678-1234-4234-8234-123456789abc";
const otherId = "abcdefab-1234-4234-8234-123456789abc";
const pid = 1234;
const launch = { kind: "linux-controller-launch" as const, pid, launchId };
const args = ["/usr/bin/node", "/app/controller-bootstrap.js", "/app/main.js", "codex", "--launch-id", launchId, "/tmp/controller.log"];
const argv = (values: string[]) => Buffer.from(`${values.join("\0")}\0`);
const stat = (group = pid, state = "S", flags = 0, parent = 2) => Buffer.from(`${pid} (node ) odd) ${state} ${parent} ${group} 0 0 0 ${flags}\n`);

it("validates complete records without accepting legacy or malformed identities", () => {
  expect(parseLinuxControllerLaunch(launch)).toEqual(launch);
  for (const value of [null, {}, { ...launch, pid: 0 }, { ...launch, pid: 1.5 }, { ...launch, pid: 2_147_483_648 },
    { ...launch, launchId: launchId.toUpperCase() }, { ...launch, launchId: "bad" }, { ...launch, kind: "legacy" }, { ...launch, extra: true }]) {
    expect(isLinuxControllerLaunch(value)).toBe(false);
    expect(() => parseLinuxControllerLaunch(value)).toThrow();
  }
});

it("matches only the complete fixed NUL-delimited bootstrap layout", () => {
  expect(parseLinuxControllerLaunchArgv(argv(args))).toBe(launchId);
  const invalid = [[], args.slice(0, -1), [...args, "--launch-id", launchId], [args[0]!, args[1]!, args[2]!, args[3]!, "--launch-id=" + launchId, args[6]!],
    args.map((x, i) => i === 1 ? "/app/other.js" : x), args.map((x, i) => i === 2 ? "/app/other.js" : x),
    args.map((x, i) => i === 3 ? "unknown" : x), args.map((x, i) => i === 5 ? launchId.toUpperCase() : x),
    args.map((x, i) => i === 6 ? "" : x)];
  for (const value of invalid) expect(parseLinuxControllerLaunchArgv(argv(value))).toBeNull();
  expect(parseLinuxControllerLaunchArgv(argv(args).subarray(0, -1))).toBeNull();
  expect(parseLinuxControllerLaunchArgv(Buffer.from([0xff, 0]))).toBeNull();
  expect(parseLinuxControllerLaunchArgv(Buffer.alloc(131_073))).toBeNull();
});

function controlled(read: LinuxControllerLaunchObserverDependencies["read"], probe: LinuxControllerLaunchObserverDependencies["probe"] = () => {}) {
  return createLinuxControllerLaunchObserver({ read, probe });
}

it("checks group and stable argv, without depending on parent or birth", async () => {
  let statReads = 0;
  const observer = controlled(async file => file.endsWith("/stat") ? stat(pid, "S", 0, ++statReads) : argv(args));
  expect(await observer.capture(pid, launchId)).toEqual(launch);
  expect(await observer.inspect(launch)).toBe("running");
  const wrongGroup = controlled(async file => file.endsWith("/stat") ? stat(pid + 1) : argv(args));
  expect(await wrongGroup.inspect(launch)).toBe("mismatch");
  await expect(wrongGroup.capture(pid, launchId)).rejects.toThrow(/group/);
  const wrongId = controlled(async file => file.endsWith("/stat") ? stat() : argv(args.map((x, i) => i === 5 ? otherId : x)));
  expect(await wrongId.inspect(launch)).toBe("mismatch");
  let reads = 0;
  const changing = controlled(async file => file.endsWith("/stat") ? stat() : argv(++reads === 1 ? args : args.map((x, i) => i === 6 ? "/other.log" : x)));
  expect(await changing.inspect(launch)).toBe("mismatch");
  let groupReads = 0;
  const changingGroup = controlled(async file => file.endsWith("/stat") ? stat(++groupReads === 1 ? pid : pid + 1) : argv(args));
  await expect(changingGroup.inspect(launch)).rejects.toThrow(/could not be established/);
});

it("treats a zombie as stopped and waits for an exiting process within its budget", async () => {
  const zombie = controlled(async () => stat(pid, "Z"));
  expect(await zombie.inspect(launch)).toBe("stopped");
  let samples = 0;
  const exitsDuringRead = controlled(async file => file.endsWith("/stat") ? stat(pid, ++samples === 1 ? "S" : "Z") : Buffer.alloc(0));
  expect(await exitsDuringRead.inspect(launch)).toBe("stopped");
  let calls = 0;
  const transitioning = controlled(async file => file.endsWith("/stat") ? stat(pid, ++calls === 1 ? "S" : "Z", calls === 1 ? 4 : 0) : argv(args));
  expect(await transitioning.inspect(launch, 1000)).toBe("stopped");
  const exiting = controlled(async () => stat(pid, "S", 4));
  await expect(exiting.inspect(launch, 30)).rejects.toThrow(/could not be established/);
});

it("requires independent absence evidence when reads fail and bounds hanging reads", async () => {
  const failure = async () => { throw Object.assign(new Error("unreadable"), { code: "ENOENT" }); };
  const present = controlled(failure);
  await expect(present.inspect(launch)).rejects.toThrow(/could not be established/);
  const denied = controlled(failure, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  await expect(denied.inspect(launch)).rejects.toThrow(/could not be established/);
  const missing = controlled(failure, () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); });
  expect(await missing.inspect(launch)).toBe("stopped");
  const hanging = controlled(async () => new Promise<Uint8Array>(() => {}));
  await expect(hanging.inspect(launch, 30)).rejects.toThrow(/could not be established/);
  const malformed = controlled(async () => Buffer.from(`${pid} (node) S 1 invalid`));
  await expect(malformed.inspect(launch)).rejects.toThrow(/could not be established/);
  await expect(present.inspect(launch, 0)).rejects.toThrow(/timeout/);
});

it.skipIf(process.platform !== "linux")("observes a real detached bootstrap through procfs and confirms its exit", async () => {
  const root = path.resolve("../../.tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "controller-launch-"));
  const bootstrap = path.join(dir, "controller-bootstrap.js");
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    await writeFile(bootstrap, "process.send('ready'); setInterval(() => {}, 1000);\n");
    child = spawn(process.execPath, [bootstrap, path.join(dir, "main.js"), "codex", "--launch-id", launchId, path.join(dir, "controller.log")], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    closed = once(child, "close");
    await Promise.race([once(child, "message"), new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap readiness timeout")), 3000).unref())]);
    const proof = await captureLinuxControllerLaunch(child.pid!, launchId);
    expect(await inspectLinuxControllerLaunch(proof)).toBe("running");
    expect(await inspectLinuxControllerLaunch({ ...proof, launchId: otherId })).toBe("mismatch");
    child.kill("SIGKILL");
    await closed;
    expect(await inspectLinuxControllerLaunch(proof)).toBe("stopped");
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (closed !== undefined) await closed;
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
