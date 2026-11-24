import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: io.exec }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), readFile: io.read }));
import { captureProcessProof, confirmControllerProcessesStopped, ControllerProcessWaitDeadlineError, inspectProcessProof, isControllerProcessObservationDeadline, stopControllerProcesses } from "../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const boot = "876b21c9-30d7-48c0-a2ab-287291e903a7";
const pid = 4101;
const stat = (ticks = "26140755", parent = 4000, group = pid, state = "S", flags = "0") =>
  `${pid} (node (worker)) ${[state, parent, group, 0, 0, 0, flags, ...Array(12).fill(0), ticks, 0, 0].join(" ")}\n`;
let ticks: string, bootId: string, wallTime: string, command: string, group: number, parent: number, state: string, flags: string, present: boolean;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  ticks = "26140755"; bootId = boot; wallTime = "Thu Nov 19 19:43:08 2026";
  command = "node main.js --launch-id original"; group = pid; parent = 4000; state = "S"; flags = "0"; present = true;
  io.read.mockReset().mockImplementation(async (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
    if (path === `/proc/${pid}/stat`) return stat(ticks, parent, group, state, flags);
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

it("recognizes only the actual proc read abort and rejects modified evidence", async () => {
  io.read.mockImplementation((_path: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted", { cause: options.signal.reason }), { name: "AbortError" })), { once: true });
  }));
  const error = await captureProcessProof(pid, 20).catch(cause => cause);
  expect(isControllerProcessObservationDeadline(error)).toBe(true);
  error.cause.message = "changed";
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
});

it("does not classify a proc read error merely because it resembles an abort", async () => {
  const failure = Object.assign(new Error("aborted"), { name: "AbortError" });
  io.read.mockRejectedValue(failure);
  const error = await captureProcessProof(pid, 20).catch(cause => cause);
  expect(error).toBe(failure);
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
});

it("keeps the same Linux process running and stoppable when only ps wall-clock birth drifts", async () => {
  const proof = await captureProcessProof(pid);
  wallTime = "Thu Nov 19 19:43:32 2026";
  expect(await inspectProcessProof(proof)).toBe("running");
  expect(proof.startedAt).toBe(`linux:v1:${boot}:26140755`);
  await stopControllerProcesses(proof, [], Date.now() + 5000);
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(true);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
});

it("retires an otherwise empty command guardian without waiting through the graceful interval", async () => {
  vi.useFakeTimers();
  const proof = await captureProcessProof(pid);
  vi.mocked(process.kill).mockImplementation((_pid, signal) => {
    if (!present) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    if (signal === "SIGKILL") present = false;
    return true;
  });
  // No timer advancement: a command with only its guardian must settle before
  // needing either the normal grace timer or a later escalation deadline.
  await stopControllerProcesses(proof, [], Date.now() + 1000, undefined, { guardian: true });
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGKILL");
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(true);
});

it.each([{ deadline: 100, phase: "term", killed: false }, { deadline: 2100, phase: "kill", killed: true }] as const)("classifies only a completed $phase signal followed by a group wait deadline", async ({ deadline, phase, killed }) => {
  vi.useFakeTimers();
  const proof = await captureProcessProof(pid);
  vi.mocked(process.kill).mockReturnValue(true);
  const pending = stopControllerProcesses(proof, [], Date.now() + deadline).catch(error => error);
  await vi.advanceTimersByTimeAsync(deadline);
  const error = await pending;
  expect(error).toBeInstanceOf(ControllerProcessWaitDeadlineError);
  expect(error.phase).toBe(phase);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
  expect(vi.mocked(process.kill).mock.calls.some(([target, signal]) => target === -pid && signal === "SIGKILL")).toBe(killed);
});

it("keeps signal failure independent from the wait deadline", async () => {
  const proof = await captureProcessProof(pid), failure = new Error("signal denied");
  vi.mocked(process.kill).mockImplementation((_pid, signal) => { if (signal === "SIGTERM") throw failure; return true; });
  const error = await stopControllerProcesses(proof, [], Date.now() + 1000).catch(cause => cause);
  expect(error).toBe(failure);
  expect(error).not.toBeInstanceOf(ControllerProcessWaitDeadlineError);
});

it("keeps KILL failure independent after TERM", async () => {
  vi.useFakeTimers();
  const proof = await captureProcessProof(pid), failure = new Error("kill denied");
  vi.mocked(process.kill).mockImplementation((_pid, signal) => { if (signal === "SIGKILL") throw failure; return true; });
  const pending = stopControllerProcesses(proof, [], Date.now() + 5000).catch(cause => cause);
  await vi.advanceTimersByTimeAsync(2100);
  expect(await pending).toBe(failure);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGKILL");
});

it.each(["before", "at"] as const)("keeps a failed group observation independent $0 its deadline after TERM", async when => {
  if (when === "at") vi.useFakeTimers();
  const proof = await captureProcessProof(pid), failure = new Error("group inventory failed");
  vi.mocked(process.kill).mockReturnValue(true);
  const original = io.exec.getMockImplementation()!;
  let inventories = 0; const deadline = Date.now() + 1000;
  io.exec.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, output: string) => void) => {
    if (args.includes("-A") && ++inventories === 2) {
      if (when === "at") vi.setSystemTime(deadline);
      callback(failure, ""); return;
    }
    original(file, args, options, callback);
  });
  const error = await stopControllerProcesses(proof, [], deadline).catch(cause => cause);
  if (when === "at") expect(error).toMatchObject({ cause: failure, errors: expect.arrayContaining([failure]) });
  else expect(error).toBe(failure);
  expect(error).not.toBeInstanceOf(ControllerProcessWaitDeadlineError);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
});

it("still authenticates the original guardian before an early final kill", async () => {
  const proof = await captureProcessProof(pid);
  vi.mocked(process.kill).mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") ticks = "26140756";
    return true;
  });
  await expect(stopControllerProcesses(proof, [], Date.now() + 1000, undefined, { guardian: true })).rejects.toThrow(/no original/);
  expect(process.kill).toHaveBeenCalledWith(-pid, "SIGTERM");
  expect(vi.mocked(process.kill).mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
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

it("confirms disappearance when the original proc stat open is missing and liveness also reports ESRCH", async () => {
  const proof = await captureProcessProof(pid);
  const read = io.read.getMockImplementation()!;
  io.read.mockImplementation(async (file: string, options: unknown) => {
    if (file === `/proc/${pid}/stat`) {
      present = false;
      throw Object.assign(new Error("stat open failed"), { code: "ENOENT", syscall: "open", path: file });
    }
    return read(file, options);
  });
  expect(await inspectProcessProof(proof)).toBe("stopped");
});

it("retains a boot read failure even if the process disappears", async () => {
  const proof = await captureProcessProof(pid);
  const failure = Object.assign(new Error("boot open failed"), { code: "ENOENT", syscall: "open", path: "/proc/sys/kernel/random/boot_id" });
  io.read.mockImplementation(async () => { present = false; throw failure; });
  await expect(inspectProcessProof(proof)).rejects.toBe(failure);
});

it("retains a boot identity conflict when stat is missing and the process disappears", async () => {
  const proof = await captureProcessProof(pid);
  const read = io.read.getMockImplementation()!;
  bootId = "187b21c9-30d7-48c0-a2ab-287291e903a7";
  io.read.mockImplementation(async (file: string, options: unknown) => {
    if (file === `/proc/${pid}/stat`) {
      present = false;
      throw Object.assign(new Error("stat open failed"), { code: "ENOENT", syscall: "open", path: file });
    }
    return read(file, options);
  });
  const error = await inspectProcessProof(proof).catch(cause => cause);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0]).toMatchObject({ code: "ENOENT", path: `/proc/${pid}/stat` });
  expect(error.errors[1].message).toMatch(/conflicts/);
});

it.each(["exit", "signal", "parse"] as const)("retains ps %s failure even if the process disappears", async kind => {
  const proof = await captureProcessProof(pid);
  const failure = Object.assign(new Error("ps failed"), kind === "signal" ? { signal: "SIGTERM", code: null } : { code: 1 });
  io.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => {
    present = false;
    callback(kind === "parse" ? null : failure, kind === "parse" ? "malformed" : "");
  });
  const error = await inspectProcessProof(proof).catch(cause => cause);
  if (kind === "parse") expect(error.message).toMatch(/command identity/);
  else expect(error).toBe(failure);
});

it("retains a partial identity conflict if ps fails and the process disappears", async () => {
  const proof = await captureProcessProof(pid);
  group++;
  const failure = Object.assign(new Error("ps failed"), { code: 1 });
  io.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error, output: string) => void) => {
    present = false; callback(failure, "");
  });
  const error = await inspectProcessProof(proof).catch(cause => cause);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toContain(failure);
  expect(error.errors[1].message).toMatch(/conflicts/);
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

// Each setup starts a fresh observation of the same kernel process. The first
// stat precedes exit; the final stat reports Z after reparenting and argv loss.
const observeExit = (exitBeforePs: 0 | 1 | 2, options: { changed?: "ticks" | "boot"; changedGroupAt?: 0 | 1 | 2 | 3; liveMember?: boolean } = {}) => {
  let statReads = 0, psReads = 0, bootReads = 0;
  const sampledGroup = (sample: number) => options.changedGroupAt === sample ? 9999 : pid;
  io.read.mockImplementation(async (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") {
      return `${options.changed === "boot" && ++bootReads === 2 ? "187b21c9-30d7-48c0-a2ab-287291e903a7" : boot}\n`;
    }
    if (path === `/proc/${pid}/stat`) {
      const final = ++statReads === 2;
      return stat(options.changed === "ticks" && final ? "26140756" : ticks,
        final ? 1 : parent, sampledGroup(final ? 3 : 0), final ? "Z" : "S");
    }
    throw new Error(`Unexpected process identity read: ${path}`);
  });
  io.exec.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => {
    if (args.includes("-A")) {
      callback(null, `${pid} ${pid} Z\n${options.liveMember ? `4202 ${pid} S\n` : ""}`);
      return;
    }
    const exited = psReads >= exitBeforePs;
    const observedGroup = sampledGroup(++psReads);
    callback(null, `${pid} ${exited ? 1 : parent} ${observedGroup} ${exited ? "Z" : "S"} ${wallTime} ${exited ? "[node] <defunct>" : command}\n`);
  });
};

it.each([0, 1, 2] as const)("recognizes only the original exited PID when exit occurs before ps observation %s", async exitBeforePs => {
  const proof = await captureProcessProof(pid);
  observeExit(exitBeforePs);
  expect(await inspectProcessProof(proof)).toBe("stopped");
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);

  observeExit(exitBeforePs);
  await expect(captureProcessProof(pid)).rejects.toThrow(/exiting/);

  observeExit(exitBeforePs, { liveMember: true });
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(false);
  vi.useFakeTimers();
  observeExit(exitBeforePs, { liveMember: true });
  const pending = stopControllerProcesses(proof, [], Date.now() + 100).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).message).toMatch(/deadline/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["ticks", "boot"] as const)("rejects an exit observation whose %s identity changes during sampling", async changed => {
  const proof = await captureProcessProof(pid);
  observeExit(1, { changed });
  await expect(inspectProcessProof(proof)).rejects.toThrow(/changed during observation/);
  observeExit(1, { changed, liveMember: true });
  await expect(stopControllerProcesses(proof, [], Date.now() + 5000)).rejects.toThrow(/changed during observation/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each([0, 1, 2, 3] as const)("rejects an exited process when group observation %s disagrees", async changedGroupAt => {
  const proof = await captureProcessProof(pid);
  observeExit(1, { changedGroupAt });
  await expect(inspectProcessProof(proof)).rejects.toThrow(/changed during observation/);
  observeExit(1, { changedGroupAt, liveMember: true });
  await expect(stopControllerProcesses(proof, [], Date.now() + 5000)).rejects.toThrow(/changed during observation/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["ticks", "boot", "group"] as const)("does not identify a different stable zombie %s as the saved original", async difference => {
  const proof = await captureProcessProof(pid);
  state = "Z"; parent = 1; command = "[node] <defunct>";
  if (difference === "ticks") ticks = "26140756";
  else if (difference === "boot") bootId = "187b21c9-30d7-48c0-a2ab-287291e903a7";
  else group = 9999;
  expect(await inspectProcessProof(proof)).toBe("replaced");
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["Z", "ESRCH"] as const)("waits for a kernel-exiting original to reach %s before confirming that PID stopped", async terminal => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  flags = "4"; command = "[node] <defunct>"; parent = 1;
  const read = io.read.getMockImplementation()!;
  io.read.mockImplementation(async (path: string) => {
    if (path === `/proc/${pid}/stat` && !present) throw Object.assign(new Error("Process disappeared"), { code: "ENOENT", syscall: "open", path });
    return read(path);
  });
  io.exec.mockClear(); io.read.mockClear();
  let settled = false;
  const pending = inspectProcessProof(proof, 100).then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(io.exec).toHaveBeenCalledTimes(2);
  if (terminal === "Z") state = "Z";
  else present = false;
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toBe("stopped");
  expect(io.read.mock.calls.filter(([path]) => path === "/proc/sys/kernel/random/boot_id").length).toBeGreaterThan(2);
  expect(io.read.mock.calls.filter(([path]) => path === `/proc/${pid}/stat`).length).toBeGreaterThan(2);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("does not create a running proof from the kernel exit flag before the process becomes a zombie", async () => {
  flags = "4";
  await expect(captureProcessProof(pid)).rejects.toThrow(/exiting/);
  expect(process.kill).not.toHaveBeenCalled();
});

it("does not renew the passive exit budget when re-sampling or when wall time moves backwards", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  flags = "4"; command = "[node] <defunct>";
  io.exec.mockClear();
  const started = performance.now();
  let settled = false;
  const pending = inspectProcessProof(proof, 100).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(25);
  expect(settled).toBe(false);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(75);
  expect((await pending).message).toMatch(/deadline.*unconfirmed/i);
  expect(performance.now() - started).toBe(100);
  const timeouts = io.exec.mock.calls.map(([, , options]) => options.timeout as number);
  expect(timeouts[0]).toBe(100);
  expect(timeouts.at(-1)).toBe(25);
  expect(timeouts.every((timeout, index) => index === 0 || timeout <= timeouts[index - 1]!)).toBe(true);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("settles a completed consistent observation that finishes at its deadline", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  let bootReads = 0;
  const read = io.read.getMockImplementation()!;
  io.read.mockImplementation(async (file: string, options: unknown) => {
    const result = await read(file, options);
    if (file.endsWith("boot_id") && ++bootReads === 2) vi.advanceTimersByTime(100);
    return result;
  });
  const error = await inspectProcessProof(proof, 100).catch(cause => cause);
  expect(isControllerProcessObservationDeadline(error)).toBe(true);
});

it("retains a complete conflicting observation even when its deadline expires", async () => {
  const proof = await captureProcessProof(pid);
  command = "unexpected command";
  vi.useFakeTimers();
  let bootReads = 0;
  const read = io.read.getMockImplementation()!;
  io.read.mockImplementation(async (file: string, options: unknown) => {
    const result = await read(file, options);
    if (file.endsWith("boot_id") && ++bootReads === 2) vi.advanceTimersByTime(100);
    return result;
  });
  const error = await inspectProcessProof(proof, 100).catch(cause => cause);
  expect(error.message).toMatch(/conflicting identity/);
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
});

it("retains a malformed final observation even when its deadline expires", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  let bootReads = 0;
  const read = io.read.getMockImplementation()!;
  io.read.mockImplementation(async (file: string, options: unknown) => {
    if (file.endsWith("boot_id") && ++bootReads === 2) { vi.advanceTimersByTime(100); return "invalid"; }
    return read(file, options);
  });
  const error = await inspectProcessProof(proof, 100).catch(cause => cause);
  expect(error.message).toMatch(/boot identity/);
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
});

it("settles an exiting-process wait only after a complete consistent observation", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  flags = "4";
  const pending = inspectProcessProof(proof, 100).catch(cause => cause);
  await vi.advanceTimersByTimeAsync(100);
  expect(isControllerProcessObservationDeadline(await pending)).toBe(true);
});

it.each(["ticks", "boot", "group"] as const)("does not wait on or authorize a kernel-exiting process with a different %s identity", async difference => {
  const proof = await captureProcessProof(pid);
  flags = "4"; command = "[node] <defunct>";
  if (difference === "ticks") ticks = "26140756";
  else if (difference === "boot") bootId = "187b21c9-30d7-48c0-a2ab-287291e903a7";
  else group = 9999;
  io.exec.mockClear();
  expect(await inspectProcessProof(proof, 100)).toBe("replaced");
  expect(io.exec).toHaveBeenCalledTimes(2);
  if (difference === "group") await stopControllerProcesses(proof, [], Date.now() + 100);
  else await expect(stopControllerProcesses(proof, [], Date.now() + 100)).rejects.toThrow(/no original/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("does not send a stop signal to a process that remains in kernel exit until the stop deadline", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  flags = "4";
  const pending = stopControllerProcesses(proof, [], Date.now() + 100).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).message).toMatch(/deadline/);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each([false, true])("refreshes group membership after its only original process exits while being inspected (unattributed survivor=%s)", async survivor => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  flags = "4";
  let inventories = 0;
  const execute = io.exec.getMockImplementation()!;
  io.exec.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, output: string) => void) => {
    if (args.includes("-A")) {
      inventories++;
      callback(null, inventories === 1 ? `${pid} ${pid} S\n` : survivor ? `4202 ${pid} S\n` : "");
      return;
    }
    return execute(file, args, options, callback);
  });
  const started = Date.now();
  let settled = false;
  const pending = stopControllerProcesses(proof, [], started + 100).then(() => { settled = true; return { stopped: true }; }, error => { settled = true; return { error }; });
  await vi.advanceTimersByTimeAsync(0);
  expect(inventories).toBe(1);
  state = "Z"; command = "[node] <defunct>";
  await vi.advanceTimersByTimeAsync(25);
  if (survivor) {
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(75);
    expect(Date.now() - started).toBe(100);
  }
  const result = await pending;
  if (survivor) {
    expect(result).toHaveProperty("error");
    if ("error" in result) expect(result.error.message).toMatch(/deadline/);
    expect(inventories).toBeGreaterThan(2);
  } else expect(result).toEqual({ stopped: true });
  if (!survivor) expect(inventories).toBe(2);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("lets remaining group members exit naturally after every recorded original stopped", async () => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  state = "Z"; command = "[node] <defunct>";
  let survivor = true, inventories = 0, settled = false;
  const execute = io.exec.getMockImplementation()!;
  io.exec.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, output: string) => void) => {
    if (args.includes("-A")) { inventories++; callback(null, survivor ? `4202 ${pid} S\n` : ""); return; }
    return execute(file, args, options, callback);
  });
  const pending = stopControllerProcesses(proof, [], Date.now() + 100).then(() => { settled = true; return { stopped: true }; }, error => { settled = true; return { error }; });
  await vi.advanceTimersByTimeAsync(25);
  expect(settled).toBe(false);
  survivor = false;
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toEqual({ stopped: true });
  expect(inventories).toBeGreaterThan(2);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["birth", "command"] as const)("refuses unproven survivors immediately when an original has conflicting %s evidence", async conflict => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  if (conflict === "birth") ticks = "26140756";
  else command = "node replacement.js";
  const started = performance.now();
  let settled = false;
  const pending = stopControllerProcesses(proof, [], Date.now() + 100).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  expect((await pending).message).toMatch(/no original/);
  expect(performance.now()).toBe(started);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["0", "8"])("does not retry ordinary command replacement without PF_EXITING (flags=%s)", async kernelFlags => {
  const proof = await captureProcessProof(pid);
  flags = kernelFlags; command = "[node] <defunct>";
  io.exec.mockClear();
  expect(await inspectProcessProof(proof, 100)).toBe("replaced");
  expect(io.exec).toHaveBeenCalledTimes(2);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
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
