import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: io.exec }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), readFile: io.read }));
import { captureProcessProof, confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses } from "../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const boot = "876b21c9-30d7-48c0-a2ab-287291e903a7";
const pid = 4101;
const stat = (ticks = "26140755", parent = 4000, group = pid, state = "S") =>
  `${pid} (node (worker)) ${[state, parent, group, ...Array(16).fill(0), ticks, 0, 0].join(" ")}\n`;
let ticks: string, bootId: string, wallTime: string, command: string, group: number, parent: number, state: string, present: boolean;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  ticks = "26140755"; bootId = boot; wallTime = "Thu Nov 19 19:43:08 2026";
  command = "node main.js --launch-id original"; group = pid; parent = 4000; state = "S"; present = true;
  io.read.mockReset().mockImplementation(async (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
    if (path === `/proc/${pid}/stat`) return stat(ticks, parent, group, state);
    throw new Error(`Unexpected process identity read: ${path}`);
  });
  io.exec.mockReset().mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => {
    if (args.includes("-A")) { callback(null, present ? `${pid} ${group} ${state}\n` : ""); return; }
    callback(null, `${pid} ${parent} ${group} ${state} ${args.includes("lstart=") ? `${wallTime} ` : ""}${command}\n`);
  });
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (!present) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    if (signal === "SIGTERM") present = false;
    return true;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });

it("keeps the same Linux process running and stoppable when only ps wall-clock birth drifts", async () => {
  const proof = await captureProcessProof(pid);
  wallTime = "Thu Nov 19 19:43:32 2026";
  expect(await inspectProcessProof(proof)).toBe("running");
  expect(proof.startedAt).toBe(`linux:v1:${boot}:26140755`);
  await stopControllerProcesses(proof, [], Date.now() + 5000);
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(true);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
});

it.each(["ticks", "boot"] as const)("does not signal a reused PID with a different %s identity", async difference => {
  const proof = await captureProcessProof(pid);
  if (difference === "ticks") ticks = "26140756";
  else bootId = "187b21c9-30d7-48c0-a2ab-287291e903a7";
  expect(await inspectProcessProof(proof)).toBe("replaced");
  await expect(stopControllerProcesses(proof, [], Date.now() + 5000)).rejects.toThrow(/no original/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("retains an old live Linux proof without upgrading it from the current PID", async () => {
  const proof = { pid, parentPid: parent, processGroupId: group, startedAt: wallTime, commandHash: createHash("sha256").update(command).digest("hex") };
  const original = structuredClone(proof);
  await expect(inspectProcessProof(proof)).rejects.toThrow(/(?:legacy|stable|birth)/i);
  await expect(stopControllerProcesses(proof, [], Date.now() + 5000)).rejects.toThrow(/(?:legacy|stable|birth)/i);
  await expect(confirmControllerProcessesStopped(proof, [])).rejects.toThrow(/(?:legacy|stable|birth)/i);
  expect(proof).toEqual(original);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  present = false;
  expect(await inspectProcessProof(proof)).toBe("stopped");
});

it.each(["command", "group"] as const)("retains a same-birth %s conflict instead of declaring the original stopped", async difference => {
  const proof = await captureProcessProof(pid);
  if (difference === "command") command = "node unexpected.js";
  else group = 9999;
  expect(await inspectProcessProof(proof)).toBe("replaced");
  await expect(confirmControllerProcessesStopped(proof, [])).rejects.toThrow(/conflicting identity/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("preserves kernel tick precision beyond the JavaScript safe integer range", async () => {
  ticks = "9007199254740993";
  const proof = await captureProcessProof(pid);
  expect(proof.startedAt).toBe(`linux:v1:${boot}:${ticks}`);
  ticks = "9007199254740992";
  expect(await inspectProcessProof(proof)).toBe("replaced");
});

it.each(["ticks", "boot", "parent", "group"] as const)("rejects a %s change during identity acquisition", async difference => {
  let statReads = 0, bootReads = 0;
  io.read.mockImplementation(async (path: string) => {
    if (path.endsWith("boot_id")) return `${difference === "boot" && ++bootReads === 2 ? "187b21c9-30d7-48c0-a2ab-287291e903a7" : boot}\n`;
    if (path === `/proc/${pid}/stat`) {
      const changed = ++statReads === 2;
      return stat(difference === "ticks" && changed ? "26140756" : ticks,
        difference === "parent" && changed ? 1 : parent, difference === "group" && changed ? 9999 : group);
    }
    throw new Error(`Unexpected read: ${path}`);
  });
  await expect(captureProcessProof(pid)).rejects.toThrow();
  expect(process.kill).not.toHaveBeenCalled();
});

it.each(["ENOENT", "EACCES", "EIO"])("propagates a proc read failure (%s) without producing partial proof", async code => {
  io.read.mockRejectedValue(Object.assign(new Error(`proc read failed: ${code}`), { code }));
  await expect(captureProcessProof(pid)).rejects.toThrow();
  expect(process.kill).not.toHaveBeenCalled();
});

it("rejects command replacement between the two ps observations", async () => {
  let reads = 0;
  io.exec.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => {
    callback(null, `${pid} ${parent} ${group} S ${args.includes("lstart=") ? `${wallTime} ` : ""}${++reads === 1 ? command : "node replacement.js"}\n`);
  });
  await expect(captureProcessProof(pid)).rejects.toThrow();
});

it("allows reparenting between observations while preserving the original birth and group", async () => {
  const proof = await captureProcessProof(pid);
  parent = 1;
  expect(await inspectProcessProof(proof)).toBe("running");
  state = "Z"; command = "[node] <defunct>";
  expect(await inspectProcessProof(proof)).toBe("stopped");
  await expect(captureProcessProof(pid)).rejects.toThrow(/exiting/);
});

it.each(["linux:v2:876b21c9-30d7-48c0-a2ab-287291e903a7:1", "linux:v1:invalid:1", `linux:v1:${boot}:01`, `linux:v1:${boot}:18446744073709551616`])("refuses an unsupported or malformed Linux birth token (%s)", async startedAt => {
  const proof = { pid, parentPid: parent, processGroupId: group, startedAt, commandHash: createHash("sha256").update(command).digest("hex") };
  await expect(inspectProcessProof(proof)).rejects.toThrow();
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("rejects ps ownership that conflicts with the bracketing proc observations", async () => {
  io.read.mockImplementation(async (path: string) => path.endsWith("boot_id") ? `${boot}\n` : stat(ticks, parent, 9999));
  await expect(captureProcessProof(pid)).rejects.toThrow();
});

it("does not capture running proof when the process becomes a zombie during sampling", async () => {
  let reads = 0;
  io.read.mockImplementation(async (path: string) => path.endsWith("boot_id") ? `${boot}\n` : stat(ticks, parent, group, ++reads === 1 ? "S" : "Z"));
  await expect(captureProcessProof(pid)).rejects.toThrow();
});

it.each(["-1", "1.5", "18446744073709551616"])("rejects invalid kernel start ticks (%s)", async invalid => {
  ticks = invalid;
  await expect(captureProcessProof(pid)).rejects.toThrow();
});

it("uses one monotonic acquisition budget even when wall time moves backwards", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const wall = vi.spyOn(Date, "now").mockReturnValue(10_000);
  io.read.mockImplementation(async (path: string) => {
    elapsed += 51; wall.mockReturnValue(1);
    return path.endsWith("boot_id") ? `${boot}\n` : stat();
  });
  await expect(captureProcessProof(pid, 100)).rejects.toThrow(/deadline|timeout/i);
  expect(io.exec).not.toHaveBeenCalled();
});

it("does not signal after the identity acquisition consumes its operation budget", async () => {
  const proof = await captureProcessProof(pid);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  io.read.mockImplementation(async (path: string) => {
    elapsed += 100;
    return path.endsWith("boot_id") ? `${boot}\n` : stat();
  });
  await expect(stopControllerProcesses(proof, [], Date.now() + 100)).rejects.toThrow(/deadline|timeout/i);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("does not send KILL when the group has a replacement birth after TERM", async () => {
  vi.useFakeTimers();
  vi.mocked(process.kill).mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") ticks = "26140756";
    return true;
  });
  const proof = await captureProcessProof(pid);
  const stopped = stopControllerProcesses(proof, [], Date.now() + 5000).catch(error => error);
  await vi.runAllTimersAsync();
  expect((await stopped).message).toMatch(/no original/);
  expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
  expect(vi.mocked(process.kill).mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
});
